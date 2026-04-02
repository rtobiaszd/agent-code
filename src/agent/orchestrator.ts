import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { exists, safeWrite } from '../core/fs-utils';
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
import type { AgentTask, ImplementationPlan, MemoryState, ReviewResult, RuntimeCycleMetric } from '../types';

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

function pickNextTask(memory: MemoryState): AgentTask | null {
  const backlog = Array.isArray(memory.backlog) ? memory.backlog : [];
  if (!backlog.length) return null;

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

  const candidates = backlog
    .filter((task) => !successful.has(stableTaskSignature(task)))
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
}): Promise<{ implementation: ImplementationPlan; review: ReviewResult; repoDelta: ReturnType<typeof compareRepoHealth> }> {
  const { task, blueprint, memory, provider } = input;

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

export async function runAgent(): Promise<void> {
  acquireLock();
  const provider = getModelProvider();

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
      const decision = evaluateRuntimePolicy(runtime);
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

        if (!memory.backlog.length) {
          const snapshot = buildRepoSnapshot(repoIndex);
          const backlog = await createBacklog({ blueprint, snapshot, memory, branch, repoIndex, config: CONFIG, provider });
          memory.backlog = backlog.tasks || [];
          memory.metrics.plannerRuns += 1;
          saveMemory(memory);
        }

        const latestMemory = loadMemory();
        const task = pickNextTask(latestMemory);
        if (!task) {
          cycleMetric.result = 'idle';
          cycleMetric.reason = 'no_valid_task_available';
          log('⏸️ no valid task available');
        } else {
          latestMemory.metrics.tasksExecuted += 1;
          pushHistory(latestMemory, { type: 'task_selected', task });
          saveMemory(latestMemory);

          cycleMetric.taskId = task.id;
          cycleMetric.taskTitle = task.title;

          log('🎯 task:', task.title);
          log('📌 goal:', task.goal);

          try {
            const result = await executeTask({ task, blueprint, memory: latestMemory, provider });
            const commitMessage = result.review.suggested_commit_message || task.commit_message;
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

            removeTaskFromBacklog(latestMemory, task.id);
            saveMemory(latestMemory);
            cycleMetric.result = 'success';
            log('✅ task concluída:', task.title);
          } catch (error) {
            rollbackHard();
            const reason = error instanceof Error ? error.message : String(error);
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
                latestMemory.backlog = (latestMemory.backlog || []).map((item) => (item.id === task.id ? nextTask : item));
                saveMemory(latestMemory);
                log('🧠 task replanned:', nextTask.title);
              } catch (replanError) {
                debug('replan error:', replanError instanceof Error ? replanError.message : String(replanError));
                removeTaskFromBacklog(latestMemory, task.id);
                saveMemory(latestMemory);
              }
            } else if (decisionByFailure.action === 'drop') {
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

      await delayBetweenCycles();
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
