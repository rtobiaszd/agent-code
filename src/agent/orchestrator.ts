import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { exists, safeWrite } from '../core/fs-utils';
import { commitAll, ensureBranch, git, hasGitRepo, pushBranch, rollbackHard, workingTreeDirty } from '../core/git';
import { debug, log } from '../core/logger';
import { stableTaskSignature, truncate } from '../core/text';
import { applyImplementation, containsDangerousContent, isValidImplementation, sanitizeImplementation } from '../execution/implementation';
import { registerFailureAndDecide } from '../execution/failure-policy';
import { selfHeal } from '../execution/self-heal';
import { createRepoStabilizationTask } from '../execution/stabilization';
import { runVerification } from '../execution/verification';
import { askAndParseJson } from '../models/ollama';
import { createBacklog, replanTask } from '../planning/planner';
import { buildExecutorPrompt, buildReviewerPrompt } from '../planning/prompts';
import { compareRepoHealth, getRepoHealth } from '../repo/health';
import { buildRepoIndex, buildRepoSnapshot, collectFileContents, loadBlueprint } from '../repo/indexer';
import { updateMainEvolutionDoc } from '../state/evolution';
import { getHotFiles, loadMemory, pushHistory, rememberSuccess, saveMemory } from '../state/memory';
import type { AgentTask, ImplementationPlan, MemoryState, ReviewResult } from '../types';

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
}): Promise<{ implementation: ImplementationPlan; review: ReviewResult; repoDelta: ReturnType<typeof compareRepoHealth> }> {
  const { task, blueprint, memory } = input;

  const fileContexts = collectFileContents(task.files || []);
  const baselineHealth = getRepoHealth(CONFIG, log);

  const executorPrompt = buildExecutorPrompt({
    blueprint,
    task,
    fileContexts,
    commands: baselineHealth.commands || {},
    memory
  });

  const rawImplementation = await askAndParseJson<ImplementationPlan>(
    CONFIG.MODEL_EXECUTOR,
    executorPrompt,
    'executor',
    isValidImplementation
  );

  const implementation = sanitizeImplementation(rawImplementation, task).impl;

  if (containsDangerousContent(implementation)) {
    throw new Error('Implementação recusada por conteúdo perigoso.');
  }

  applyImplementation(implementation);

  const quickChecks = runVerification(memory, { mode: 'fast', logger: log });
  if (!quickChecks.ok) {
    const healed = await selfHeal({ blueprint, task, implementation, memory, baselineHealth });
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

  const review = await askAndParseJson<ReviewResult>(CONFIG.MODEL_REVIEWER, reviewPrompt, 'review', isValidReview);
  if (String(review.verdict).toUpperCase() !== 'APPROVED') {
    throw new Error(review.reason || 'Reviewer rejeitou a implementação.');
  }

  return { implementation, review, repoDelta };
}

export async function runAgent(): Promise<void> {
  acquireLock();

  try {
    ensureSafeStart();

    const memory = loadMemory();
    const blueprint = loadBlueprint();
    const repoIndex = buildRepoIndex();

    memory.repoHash = repoIndex.repoHash;
    memory.blueprintHash = blueprint.hash;
    saveMemory(memory);

    const branch = ensureBranch(nowDate());
    log('🚀 AGENT STARTED');
    log('📁 repo:', CONFIG.REPO_PATH);
    log('📘 blueprint:', CONFIG.BLUEPRINT_FILE);
    log('🌿 branch:', branch);

    const repoHealth = getRepoHealth(CONFIG, log);
    if (!repoHealth.ok && CONFIG.REPO_STABILIZATION_MODE) {
      const stabilizationTask = createRepoStabilizationTask(repoHealth);
      memory.backlog = [stabilizationTask, ...(memory.backlog || [])];
      saveMemory(memory);
      log('🛠️ repo unhealthy, entering stabilization mode');
    }

    if (!memory.backlog.length) {
      const snapshot = buildRepoSnapshot(repoIndex);
      const backlog = await createBacklog({ blueprint, snapshot, memory, branch, repoIndex, config: CONFIG });
      memory.backlog = backlog.tasks || [];
      memory.metrics.plannerRuns += 1;
      saveMemory(memory);
    }

    const task = pickNextTask(memory);
    if (!task) {
      log('⏸️ no valid task available');
      return;
    }

    memory.metrics.iterations += 1;
    memory.metrics.tasksExecuted += 1;
    pushHistory(memory, { type: 'task_selected', task });
    saveMemory(memory);

    log('🎯 task:', task.title);
    log('📌 goal:', task.goal);

    try {
      const result = await executeTask({ task, blueprint, memory });
      const commitMessage = result.review.suggested_commit_message || task.commit_message;
      const committed = commitAll(commitMessage);

      if (committed) memory.metrics.commits += 1;
      if (CONFIG.AUTO_PUSH && committed) {
        pushBranch();
        memory.metrics.pushes += 1;
      }

      memory.accepted.unshift({
        at: new Date().toISOString(),
        title: task.title,
        category: task.category,
        commit_message: commitMessage
      });
      memory.accepted = memory.accepted.slice(0, 300);
      memory.metrics.lastSuccessAt = new Date().toISOString();
      rememberSuccess(memory, task, commitMessage);

      updateMainEvolutionDoc({
        task,
        implementation: result.implementation,
        review: result.review,
        commitMessage,
        memory
      });

      removeTaskFromBacklog(memory, task.id);
      saveMemory(memory);
      log('✅ task concluída:', task.title);
    } catch (error) {
      rollbackHard();
      const reason = error instanceof Error ? error.message : String(error);
      const decision = registerFailureAndDecide(memory, task, reason, null);

      if (decision.action === 'replan') {
        try {
          const nextTask = await replanTask({ blueprint, task, failureSummary: reason, memory, config: CONFIG });
          memory.backlog = (memory.backlog || []).map((item) => (item.id === task.id ? nextTask : item));
          saveMemory(memory);
          log('🧠 task replanned:', nextTask.title);
        } catch (replanError) {
          debug('replan error:', replanError instanceof Error ? replanError.message : String(replanError));
          removeTaskFromBacklog(memory, task.id);
          saveMemory(memory);
        }
      } else if (decision.action === 'drop') {
        removeTaskFromBacklog(memory, task.id);
        saveMemory(memory);
      }

      log('❌ task failed:', reason);
    }
  } finally {
    releaseLock();
  }
}
