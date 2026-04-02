import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { abs, exists, safeRead, safeWrite } from '../core/fs-utils';
import { commitAll, ensureBranch, git, hasGitRepo, pushBranch, rollbackHard, workingTreeDirty } from '../core/git';
import { debug, log } from '../core/logger';
import { stableTaskSignature, truncate } from '../core/text';
import { createRuntimeLoopContext, delayBetweenCycles, evaluateRuntimePolicy, registerCycleMetric } from './runtime-policy';
import { makePromptHash } from '../security/policy';
import { applyImplementation, containsDangerousContent, isValidImplementation, sanitizeImplementation } from '../execution/implementation';
import { registerFailureAndDecide } from '../execution/failure-policy';
import { selfHeal } from '../execution/self-heal';
import { createRepoStabilizationTask } from '../execution/stabilization';
import { runVerification } from '../execution/verification';
import { getModelProvider } from '../models';
import type { ModelProvider } from '../models/provider';
import { createBacklog, replanTask } from '../planning/planner';
import { buildExecutorPrompt, buildReviewerPrompt } from '../planning/prompts';
import { compareRepoHealth, getRepoHealth } from '../repo/health';
import { buildRepoIndex, buildRepoSnapshot, collectFileContents, loadBlueprint } from '../repo/indexer';
import { updateMainEvolutionDoc } from '../state/evolution';
import { getHotFiles, loadMemory, pushHistory, registerProviderMetrics, rememberSuccess, saveMemory } from '../state/memory';
import type { AgentTask, ExecutionPreview, HumanApprovalResponse, ImplementationPlan, MemoryState, ReviewResult, RuntimeCycleMetric } from '../types';

export interface RunAgentOptions {
  requestHumanApproval?: (preview: ExecutionPreview) => Promise<HumanApprovalResponse>;
  maxCycles?: number;
  runtimeOverrides?: Partial<
    Pick<typeof CONFIG, 'MAX_ITERATIONS' | 'MAX_RUNTIME_MS' | 'LOOP_DELAY_MS' | 'REPLAN_INTERVAL_CYCLES' | 'CRITICAL_FAILURE_REPLAN_THRESHOLD'>
  >;
}

function lockFile(): string {
  return path.join(CONFIG.REPO_PATH, '.agent-lock');
}

function acquireLock(): void {
  if (exists(lockFile())) throw new Error('Já existe outro agente em execução (.agent-lock).');
  safeWrite(lockFile(), String(process.pid));
}

function releaseLock(): void {
  try {
    if (exists(lockFile())) fs.unlinkSync(lockFile());
  } catch {
    // noop
  }
}

function nowDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ensureSafeStart(): void {
  if (!hasGitRepo()) throw new Error('Este diretório não é um repositório git.');
  if (CONFIG.STRICT_CLEAN_START && workingTreeDirty()) {
    throw new Error('Há alterações não commitadas. Limpe o repo antes de iniciar o agente.');
  }
}

function isTaskReady(task: AgentTask, backlogById: Map<string, AgentTask>, successful: Set<string>): boolean {
  const dependencies = Array.isArray(task.depends_on) ? task.depends_on : [];
  if (!dependencies.length) return true;

  return dependencies.every((depId) => {
    const dependency = backlogById.get(depId);
    if (!dependency) return true;
    if (String(dependency.status) === 'done') return true;
    return successful.has(stableTaskSignature(dependency));
  });
}

function pickNextTask(memory: MemoryState): AgentTask | null {
  const backlog = Array.isArray(memory.backlog) ? memory.backlog : [];
  if (!backlog.length) return null;

  const backlogById = new Map(backlog.map((task) => [task.id, task]));
  const hotFiles = new Set(getHotFiles(memory));
  const successful = new Set(memory.learned.successfulTaskSignatures || []);

  const categoryScore: Record<string, number> = {
    security: 100,
    bugfix: 95,
    performance: 90,
    optimization: 85,
    product: 80,
    tests: 75,
    refactor: 60,
    dx: 50
  };
  const priorityScore: Record<string, number> = { high: 30, medium: 20, low: 10 };

  const readyQueue = backlog.filter((task) => {
    if (successful.has(stableTaskSignature(task))) return false;
    return isTaskReady(task, backlogById, successful);
  });

  const candidates = (readyQueue.length ? readyQueue : backlog.filter((task) => !successful.has(stableTaskSignature(task))))
    .sort((a, b) => {
      const aHot = (a.files || []).filter((item) => hotFiles.has(item)).length;
      const bHot = (b.files || []).filter((item) => hotFiles.has(item)).length;
      if (aHot !== bHot) return aHot - bHot;
      const aScore = (categoryScore[String(a.category)] || 0) + (priorityScore[String(a.priority)] || 0);
      const bScore = (categoryScore[String(b.category)] || 0) + (priorityScore[String(b.priority)] || 0);
      return bScore - aScore;
    });

  return candidates[0] || null;
}

function priorityComponents(task: AgentTask, memory: MemoryState): { score: number; hotFileCount: number } {
  const hotFiles = new Set(getHotFiles(memory));
  const categoryScore: Record<string, number> = {
    security: 100,
    bugfix: 95,
    performance: 90,
    optimization: 85,
    product: 80,
    tests: 75,
    refactor: 60,
    dx: 50
  };
  const priorityScore: Record<string, number> = { high: 30, medium: 20, low: 10 };
  const hotFileCount = (task.files || []).filter((item) => hotFiles.has(item)).length;
  const score = (categoryScore[String(task.category)] || 0) + (priorityScore[String(task.priority)] || 0);
  return { score, hotFileCount };
}

export function explainTaskSelection(memory: MemoryState): string {
  const task = pickNextTask(memory);
  if (!task) return 'Nenhuma task elegível no momento.';
  const { score, hotFileCount } = priorityComponents(task, memory);
  const dependencyCount = Array.isArray(task.depends_on) ? task.depends_on.length : 0;
  return [
    `Task priorizada: ${task.title}`,
    `Motivo principal: categoria=${task.category}, prioridade=${task.priority}, score=${score}.`,
    `Arquivos quentes impactados: ${hotFileCount} (quanto menor, melhor para reduzir risco).`,
    `Dependências declaradas: ${dependencyCount}.`,
    `Contexto da task: ${task.why || 'sem descrição de why.'}`
  ].join('\n');
}

function shouldTriggerPeriodicReplan(
  iteration: number,
  memory: MemoryState,
  options?: { replanIntervalCycles?: number; criticalFailureReplanThreshold?: number }
): boolean {
  const replanInterval = Number(options?.replanIntervalCycles ?? CONFIG.REPLAN_INTERVAL_CYCLES);
  const criticalThreshold = Number(options?.criticalFailureReplanThreshold ?? CONFIG.CRITICAL_FAILURE_REPLAN_THRESHOLD);
  const byCycle = iteration % Math.max(1, replanInterval) === 0;
  const byCriticalFailure = Number(memory.runtime.consecutiveCycleFailures || 0) >= criticalThreshold;
  return byCycle || byCriticalFailure;
}

async function refreshBacklogFromPlanner(input: {
  blueprint: ReturnType<typeof loadBlueprint>;
  memory: MemoryState;
  branch: string;
  repoIndex: ReturnType<typeof buildRepoIndex>;
  provider: ModelProvider;
}): Promise<MemoryState> {
  const { blueprint, memory, branch, repoIndex, provider } = input;
  const snapshot = buildRepoSnapshot(repoIndex);
  const generated = await createBacklog({ blueprint, snapshot, memory, branch, repoIndex, config: CONFIG, provider });
  memory.backlog = generated.tasks || [];
  memory.metrics.plannerRuns += 1;
  saveMemory(memory);
  return memory;
}


function removeTaskFromBacklog(memory: MemoryState, taskId: string): void {
  memory.backlog = (memory.backlog || []).filter((task) => task.id !== taskId);
}

function isValidReview(value: unknown): value is ReviewResult {
  return Boolean(value && typeof value === 'object' && typeof (value as ReviewResult).verdict === 'string');
}

async function executeTask(input: {
  task: AgentTask;
  blueprint: ReturnType<typeof loadBlueprint>;
  memory: MemoryState;
  provider: ModelProvider;
  requestHumanApproval?: (preview: ExecutionPreview) => Promise<HumanApprovalResponse>;
}): Promise<{ implementation: ImplementationPlan; review: ReviewResult; repoDelta: ReturnType<typeof compareRepoHealth> }> {
  const { task, blueprint, memory, provider, requestHumanApproval } = input;

  const fileContexts = collectFileContents(task.files || []);
  const baselineHealth = getRepoHealth(CONFIG, log);

  const executorPrompt = buildExecutorPrompt({
    blueprint,
    task,
    fileContexts,
    commands: baselineHealth.commands || {},
    memory
  });

  const promptHash = makePromptHash(executorPrompt);

  let rawImplementation: ImplementationPlan;
  try {
    rawImplementation = await provider.generateJson<ImplementationPlan>({
      model: CONFIG.MODEL_EXECUTOR,
      prompt: executorPrompt,
      label: 'executor',
      validator: isValidImplementation
    });
  } catch {
    rawImplementation = await provider.generateJson<ImplementationPlan>({
      model: CONFIG.MODEL_EXECUTOR_FALLBACK || CONFIG.MODEL_EXECUTOR,
      prompt: executorPrompt,
      label: 'executor:fallback',
      validator: isValidImplementation
    });
  }

  const implementation = sanitizeImplementation(rawImplementation, task).impl;

  if (containsDangerousContent(implementation)) {
    throw new Error('Implementação recusada por conteúdo perigoso.');
  }

  const beforeApplyPreview = buildPreview(task, implementation, 'before_apply');
  await enforceHumanApproval({
    memory,
    preview: beforeApplyPreview,
    requestHumanApproval,
    assistedMode: CONFIG.ASSISTED_MODE
  });

  applyImplementation(implementation, { promptHash });

  const quickChecks = runVerification(memory, { mode: 'fast', logger: log });
  if (!quickChecks.ok) {
    const healed = await selfHeal({ blueprint, task, implementation, memory, baselineHealth, provider });
    if (!healed.ok) {
      throw new Error(healed.lastFailedSummary || quickChecks.summary || 'Self-heal falhou.');
    }
  }

  const finalChecks = runVerification(memory, { mode: 'full', logger: log });
  if (!finalChecks.ok) {
    throw new Error(finalChecks.summary || 'Verificação final falhou.');
  }

  const afterHealth = {
    ok: finalChecks.ok,
    summary: finalChecks.summary,
    signature: finalChecks.summary
  };

  const repoDelta = compareRepoHealth(baselineHealth, afterHealth);

  const reviewPrompt = buildReviewerPrompt({
    blueprint,
    task,
    implementation,
    diff: truncate(git('diff -- .', true), 45000)
  });

  let review: ReviewResult;
  try {
    review = await provider.generateJson<ReviewResult>({
      model: CONFIG.MODEL_REVIEWER,
      prompt: reviewPrompt,
      label: 'review',
      validator: isValidReview
    });
  } catch {
    review = await provider.generateJson<ReviewResult>({
      model: CONFIG.MODEL_REVIEWER_FALLBACK || CONFIG.MODEL_REVIEWER,
      prompt: reviewPrompt,
      label: 'review:fallback',
      validator: isValidReview
    });
  }
  if (String(review.verdict).toUpperCase() !== 'APPROVED') {
    throw new Error(review.reason || 'Reviewer rejeitou a implementação.');
  }

  return { implementation, review, repoDelta };
}

function buildPreview(task: AgentTask, implementation: ImplementationPlan, stage: 'before_apply' | 'before_commit'): ExecutionPreview {
  const files = [...(implementation.files || []).map((item) => item.path), ...(implementation.delete_files || [])];
  const diffSummary = stage === 'before_apply' ? summarizeImplementationDiff(implementation) : summarizeWorkingTreeDiff();

  return {
    stage,
    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      why: task.why,
      priority: task.priority,
      category: task.category
    },
    files,
    diffSummary
  };
}

function summarizeImplementationDiff(implementation: ImplementationPlan): string[] {
  const summary: string[] = [];
  for (const file of implementation.files || []) {
    const full = abs(file.path);
    const current = exists(full) ? safeRead(full, '') : '';
    const currentLines = current ? current.split(/\r?\n/).length : 0;
    const nextLines = String(file.content || '').split(/\r?\n/).length;
    const delta = nextLines - currentLines;
    const operation = exists(full) ? 'update' : 'create';
    summary.push(`${file.path}: ${operation}, linhas ${currentLines} -> ${nextLines} (Δ ${delta >= 0 ? '+' : ''}${delta})`);
  }
  for (const delPath of implementation.delete_files || []) {
    summary.push(`${delPath}: delete`);
  }
  return summary.slice(0, 40);
}

function summarizeWorkingTreeDiff(): string[] {
  const out = git('diff --stat -- .', true);
  return out ? out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40) : ['Sem diff pendente.'];
}

async function enforceHumanApproval(input: {
  memory: MemoryState;
  preview: ExecutionPreview;
  assistedMode: boolean;
  requestHumanApproval?: (preview: ExecutionPreview) => Promise<HumanApprovalResponse>;
}): Promise<void> {
  const { memory, preview, assistedMode, requestHumanApproval } = input;
  if (!assistedMode || !requestHumanApproval) return;

  const response = await requestHumanApproval(preview);
  const decision = String(response?.decision || 'reject').toLowerCase();
  const normalized = decision === 'approve' || decision === 'edit' ? decision : 'reject';
  pushHistory(memory, {
    type: 'human_decision',
    stage: preview.stage,
    decision: normalized,
    notes: response?.notes || '',
    taskId: preview.task.id,
    taskTitle: preview.task.title
  });

  if (normalized === 'approve') {
    memory.metrics.approvals += 1;
    saveMemory(memory);
    return;
  }

  memory.metrics.rejections += 1;
  saveMemory(memory);
  const error = new Error(normalized === 'edit' ? 'Ação pausada para edição humana.' : 'Ação rejeitada por humano.') as Error & { code?: string };
  error.code = normalized === 'edit' ? 'HUMAN_EDIT' : 'HUMAN_REJECTED';
  throw error;
}

export async function runAgent(options: RunAgentOptions = {}): Promise<void> {
  acquireLock();
  const provider = getModelProvider();
  const runtimeConfig = {
    maxIterations: Number(options.runtimeOverrides?.MAX_ITERATIONS ?? CONFIG.MAX_ITERATIONS),
    maxRuntimeMs: Number(options.runtimeOverrides?.MAX_RUNTIME_MS ?? CONFIG.MAX_RUNTIME_MS),
    loopDelayMs: Number(options.runtimeOverrides?.LOOP_DELAY_MS ?? CONFIG.LOOP_DELAY_MS),
    replanIntervalCycles: Number(options.runtimeOverrides?.REPLAN_INTERVAL_CYCLES ?? CONFIG.REPLAN_INTERVAL_CYCLES),
    criticalFailureReplanThreshold: Number(
      options.runtimeOverrides?.CRITICAL_FAILURE_REPLAN_THRESHOLD ?? CONFIG.CRITICAL_FAILURE_REPLAN_THRESHOLD
    )
  };

  try {
    ensureSafeStart();

    const branch = ensureBranch(nowDate());
    log('🚀 AGENT STARTED');
    log('📁 repo:', CONFIG.REPO_PATH);
    log('📘 blueprint:', CONFIG.BLUEPRINT_FILE);
    log('🌿 branch:', branch);
    const runtime = createRuntimeLoopContext();
    const memoryAtStart = loadMemory();
    memoryAtStart.runtime.startedAt = new Date(runtime.startedAtMs).toISOString();
    memoryAtStart.runtime.endedAt = null;
    memoryAtStart.runtime.lastLoopResult = null;
    memoryAtStart.runtime.consecutiveCycleFailures = 0;
    saveMemory(memoryAtStart);

    while (true) {
      if (typeof options.maxCycles === 'number' && options.maxCycles > 0 && runtime.iteration >= options.maxCycles) {
        const memory = loadMemory();
        const nowIso = new Date().toISOString();
        const stopMetric: RuntimeCycleMetric = {
          cycle: runtime.iteration + 1,
          startedAt: nowIso,
          endedAt: nowIso,
          durationMs: 0,
          result: 'stopped',
          reason: `max_cycles_reached:${options.maxCycles}`
        };
        registerCycleMetric(memory, stopMetric);
        memory.runtime.endedAt = nowIso;
        saveMemory(memory);
        break;
      }

      const decision = evaluateRuntimePolicy(runtime, {
        maxIterations: runtimeConfig.maxIterations,
        maxRuntimeMs: runtimeConfig.maxRuntimeMs
      });
      if (!decision.shouldContinue) {
        const memory = loadMemory();
        const nowIso = new Date().toISOString();
        const stopMetric: RuntimeCycleMetric = {
          cycle: runtime.iteration + 1,
          startedAt: nowIso,
          endedAt: nowIso,
          durationMs: 0,
          result: 'stopped',
          reason: decision.reason
        };
        registerCycleMetric(memory, stopMetric);
        memory.runtime.endedAt = nowIso;
        saveMemory(memory);
        log('🛑 runtime policy stop:', decision.reason || 'policy_stop');
        break;
      }

      const cycleStartedAt = Date.now();
      const cycleStartIso = new Date(cycleStartedAt).toISOString();
      runtime.iteration += 1;

      const memory = loadMemory();
      const blueprint = loadBlueprint();
      const repoIndex = buildRepoIndex();

      memory.repoHash = repoIndex.repoHash;
      memory.blueprintHash = blueprint.hash;
      memory.metrics.iterations += 1;
      saveMemory(memory);

      const cycleMetric: RuntimeCycleMetric = {
        cycle: runtime.iteration,
        startedAt: cycleStartIso,
        endedAt: cycleStartIso,
        durationMs: 0,
        result: 'idle'
      };

      try {
        const repoHealth = getRepoHealth(CONFIG, log);
        if (!repoHealth.ok && CONFIG.REPO_STABILIZATION_MODE) {
          const stabilizationTask = createRepoStabilizationTask(repoHealth);
          memory.backlog = [stabilizationTask, ...(memory.backlog || [])];
          saveMemory(memory);
          log('🛠️ repo unhealthy, entering stabilization mode');
        }

        if (
          !memory.backlog.length ||
          shouldTriggerPeriodicReplan(runtime.iteration, memory, {
            replanIntervalCycles: runtimeConfig.replanIntervalCycles,
            criticalFailureReplanThreshold: runtimeConfig.criticalFailureReplanThreshold
          })
        ) {
          await refreshBacklogFromPlanner({ blueprint, memory, branch, repoIndex, provider });
        }

        const latestMemory = loadMemory();
        const task = pickNextTask(latestMemory);
        if (!task) {
          cycleMetric.result = 'idle';
          cycleMetric.reason = 'no_valid_task_available';
          log('⏸️ no valid task available');
        } else {
          latestMemory.metrics.tasksExecuted += 1;
          latestMemory.backlog = (latestMemory.backlog || []).map((item) =>
            item.id === task.id ? { ...item, status: 'in_progress' } : item
          );
          pushHistory(latestMemory, { type: 'task_selected', task });
          saveMemory(latestMemory);

          cycleMetric.taskId = task.id;
          cycleMetric.taskTitle = task.title;

          log('🎯 task:', task.title);
          log('📌 goal:', task.goal);

          try {
            const result = await executeTask({ task, blueprint, memory: latestMemory, provider, requestHumanApproval: options.requestHumanApproval });
            const commitMessage = result.review.suggested_commit_message || task.commit_message;
            const beforeCommitPreview = buildPreview(task, result.implementation, 'before_commit');
            await enforceHumanApproval({
              memory: latestMemory,
              preview: beforeCommitPreview,
              requestHumanApproval: options.requestHumanApproval,
              assistedMode: CONFIG.ASSISTED_MODE
            });
            const committed = commitAll(commitMessage);

            if (committed) latestMemory.metrics.commits += 1;
            if (CONFIG.AUTO_PUSH && committed) {
              pushBranch();
              latestMemory.metrics.pushes += 1;
            }

            latestMemory.accepted.unshift({
              at: new Date().toISOString(),
              title: task.title,
              category: task.category,
              commit_message: commitMessage
            });
            latestMemory.accepted = latestMemory.accepted.slice(0, 300);
            latestMemory.metrics.lastSuccessAt = new Date().toISOString();
            rememberSuccess(latestMemory, task, commitMessage);

            updateMainEvolutionDoc({
              task,
              implementation: result.implementation,
              review: result.review,
              commitMessage,
              memory: latestMemory
            });

            latestMemory.backlog = (latestMemory.backlog || []).map((item) =>
              item.id === task.id ? { ...item, status: 'done' } : item
            );
            removeTaskFromBacklog(latestMemory, task.id);
            saveMemory(latestMemory);
            cycleMetric.result = 'success';
            log('✅ task concluída:', task.title);
          } catch (error) {
            rollbackHard();
            const reason = error instanceof Error ? error.message : String(error);
            const errorCode = error && typeof error === 'object' ? String((error as { code?: string }).code || '') : '';
            if (errorCode === 'HUMAN_REJECTED' || errorCode === 'HUMAN_EDIT') {
              latestMemory.backlog = (latestMemory.backlog || []).map((item) =>
                item.id === task.id ? { ...item, status: 'ready' } : item
              );
              saveMemory(latestMemory);
              cycleMetric.result = 'idle';
              cycleMetric.reason = errorCode.toLowerCase();
              log('⏸️ task pausada por decisão humana:', reason);
              continue;
            }
            const decisionByFailure = registerFailureAndDecide(latestMemory, task, reason, null);

            if (decisionByFailure.action === 'replan') {
              try {
                const nextTask = await replanTask({
                  blueprint,
                  task,
                  failureSummary: reason,
                  memory: latestMemory,
                  config: CONFIG,
                  provider
                });
                latestMemory.backlog = (latestMemory.backlog || []).map((item) =>
                  item.id === task.id ? { ...nextTask, status: 'ready' } : item
                );
                saveMemory(latestMemory);
                log('🧠 task replanned:', nextTask.title);
              } catch (replanError) {
                debug('replan error:', replanError instanceof Error ? replanError.message : String(replanError));
                removeTaskFromBacklog(latestMemory, task.id);
                saveMemory(latestMemory);
              }
            } else if (decisionByFailure.action === 'drop') {
              latestMemory.backlog = (latestMemory.backlog || []).map((item) =>
                item.id === task.id ? { ...item, status: 'failed' } : item
              );
              removeTaskFromBacklog(latestMemory, task.id);
              saveMemory(latestMemory);
            }

            cycleMetric.result = 'failure';
            cycleMetric.reason = reason;
            log('❌ task failed:', reason);
          }
        }
      } catch (cycleError) {
        rollbackHard();
        cycleMetric.result = 'failure';
        cycleMetric.reason = cycleError instanceof Error ? cycleError.message : String(cycleError);
        log('💥 cycle-level failure:', cycleMetric.reason);
      } finally {
        const cycleEndedAt = Date.now();
        cycleMetric.endedAt = new Date(cycleEndedAt).toISOString();
        cycleMetric.durationMs = Math.max(0, cycleEndedAt - cycleStartedAt);

        const postCycleMemory = loadMemory();
        registerProviderMetrics(postCycleMemory, provider.getMetrics());
        registerCycleMetric(postCycleMemory, cycleMetric);
        postCycleMemory.runtime.endedAt = cycleMetric.endedAt;
        saveMemory(postCycleMemory);

        runtime.consecutiveFailures = postCycleMemory.runtime.consecutiveCycleFailures;
      }

      await delayBetweenCycles(runtimeConfig.loopDelayMs);
    }
  } finally {
    try {
      rollbackHard();
    } catch {
      // noop
    }
    releaseLock();
  }
}
