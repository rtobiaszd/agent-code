import path from 'path';
import { CONFIG } from '../config';
import { exists, isProtectedFile, normalizeSlashes, safeRead, safeWrite } from '../core/fs-utils';
import { sanitizeOneLine, stableTaskSignature, stableTextSignature, unique } from '../core/text';
import type { AgentTask, FailureEntry, HistoryItem, MemoryState } from '../types';

export function memoryFile(): string {
  return path.join(CONFIG.REPO_PATH, '.agent-memory.json');
}

export function createMemory(): MemoryState {
  return {
    repoHash: '',
    blueprintHash: '',
    backlog: [],
    accepted: [],
    failed: [],
    skipped: [],
    history: [],
    identicalFailureBursts: {},
    runtime: {
      startedAt: null,
      endedAt: null,
      lastLoopResult: null,
      consecutiveCycleFailures: 0,
      cycleMetrics: []
    },
    learned: {
      successfulTaskSignatures: [],
      failedTaskSignatures: [],
      successfulCommitMessages: [],
      forbiddenKeywordsObserved: [],
      lintPatterns: [],
      buildPatterns: [],
      testPatterns: [],
      fileFailureStats: {},
      taskReplanStats: {},
      nextOpportunityPatterns: [],
      dependencyInstallPatterns: []
    },
    metrics: {
      iterations: 0,
      plannerRuns: 0,
      tasksExecuted: 0,
      approvals: 0,
      rejections: 0,
      applied: 0,
      commits: 0,
      pushes: 0,
      verifyPass: 0,
      verifyFail: 0,
      testPass: 0,
      testFail: 0,
      selfHealSuccess: 0,
      selfHealFail: 0,
      replans: 0,
      blueprintUpdates: 0,
      installs: 0,
      installSuccess: 0,
      installFail: 0,
      lastSuccessAt: null,
      lastErrorAt: null
    }
  };
}

export function sanitizeMemory(raw: unknown): MemoryState {
  const base = createMemory();
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<MemoryState>;

  return {
    ...base,
    ...m,
    backlog: Array.isArray(m.backlog) ? m.backlog : [],
    accepted: Array.isArray(m.accepted) ? m.accepted : [],
    failed: Array.isArray(m.failed) ? m.failed : [],
    skipped: Array.isArray(m.skipped) ? m.skipped : [],
    history: Array.isArray(m.history) ? m.history : [],
    identicalFailureBursts: m.identicalFailureBursts && typeof m.identicalFailureBursts === 'object' ? m.identicalFailureBursts : {},
    runtime: {
      ...base.runtime,
      ...(m.runtime || {}),
      cycleMetrics: Array.isArray(m.runtime?.cycleMetrics) ? m.runtime.cycleMetrics : []
    },
    learned: {
      ...base.learned,
      ...(m.learned || {}),
      successfulTaskSignatures: Array.isArray(m.learned?.successfulTaskSignatures) ? m.learned!.successfulTaskSignatures : [],
      failedTaskSignatures: Array.isArray(m.learned?.failedTaskSignatures) ? m.learned!.failedTaskSignatures : [],
      successfulCommitMessages: Array.isArray(m.learned?.successfulCommitMessages) ? m.learned!.successfulCommitMessages : [],
      forbiddenKeywordsObserved: Array.isArray(m.learned?.forbiddenKeywordsObserved) ? m.learned!.forbiddenKeywordsObserved : [],
      lintPatterns: Array.isArray(m.learned?.lintPatterns) ? m.learned!.lintPatterns : [],
      buildPatterns: Array.isArray(m.learned?.buildPatterns) ? m.learned!.buildPatterns : [],
      testPatterns: Array.isArray(m.learned?.testPatterns) ? m.learned!.testPatterns : [],
      fileFailureStats: m.learned?.fileFailureStats && typeof m.learned.fileFailureStats === 'object' ? m.learned.fileFailureStats : {},
      taskReplanStats: m.learned?.taskReplanStats && typeof m.learned.taskReplanStats === 'object' ? m.learned.taskReplanStats : {},
      nextOpportunityPatterns: Array.isArray(m.learned?.nextOpportunityPatterns) ? m.learned!.nextOpportunityPatterns : [],
      dependencyInstallPatterns: Array.isArray(m.learned?.dependencyInstallPatterns) ? m.learned!.dependencyInstallPatterns : []
    },
    metrics: {
      ...base.metrics,
      ...(m.metrics || {})
    }
  };
}

export function loadMemory(): MemoryState {
  if (!exists(memoryFile())) return createMemory();
  try {
    return sanitizeMemory(JSON.parse(safeRead(memoryFile(), '{}')));
  } catch {
    return createMemory();
  }
}

export function saveMemory(memory: MemoryState): void {
  safeWrite(memoryFile(), JSON.stringify(sanitizeMemory(memory), null, 2));
}

export function pushHistory(memory: MemoryState, item: HistoryItem): void {
  memory.history.unshift({ at: new Date().toISOString(), ...item });
  if (memory.history.length > CONFIG.MAX_HISTORY_ITEMS) {
    memory.history = memory.history.slice(0, CONFIG.MAX_HISTORY_ITEMS);
  }
}

export function rememberSuccess(memory: MemoryState, task: AgentTask, commitMessage: string): void {
  const signature = stableTaskSignature(task);
  if (!memory.learned.successfulTaskSignatures.includes(signature)) {
    memory.learned.successfulTaskSignatures.unshift(signature);
  }
  memory.learned.successfulTaskSignatures = memory.learned.successfulTaskSignatures.slice(0, 200);

  if (commitMessage && !memory.learned.successfulCommitMessages.includes(commitMessage)) {
    memory.learned.successfulCommitMessages.unshift(commitMessage);
  }
  memory.learned.successfulCommitMessages = memory.learned.successfulCommitMessages.slice(0, 100);

  clearTaskFailureBursts(memory, task);
}

export function rememberFailure(memory: MemoryState, task: AgentTask, reason: string): void {
  const signature = stableTaskSignature(task);
  if (!memory.learned.failedTaskSignatures.includes(signature)) {
    memory.learned.failedTaskSignatures.unshift(signature);
  }
  memory.learned.failedTaskSignatures = memory.learned.failedTaskSignatures.slice(0, 200);

  const low = String(reason || '').toLowerCase();
  if (low.includes('lint')) {
    memory.learned.lintPatterns.unshift(reason);
    memory.learned.lintPatterns = memory.learned.lintPatterns.slice(0, 50);
  } else if (low.includes('build') || low.includes('typecheck') || low.includes('typescript')) {
    memory.learned.buildPatterns.unshift(reason);
    memory.learned.buildPatterns = memory.learned.buildPatterns.slice(0, 50);
  } else if (low.includes('test')) {
    memory.learned.testPatterns.unshift(reason);
    memory.learned.testPatterns = memory.learned.testPatterns.slice(0, 50);
  }
}

export function rememberInstalledPackages(memory: MemoryState, packages: string[], reason: string): void {
  const items = unique(packages.map((pkg) => `${pkg} :: ${sanitizeOneLine(reason || '', 180)}`));
  memory.learned.dependencyInstallPatterns = unique([...items, ...memory.learned.dependencyInstallPatterns]).slice(0, 100);
}

export function rememberNextOpportunities(memory: MemoryState, opportunities: string[]): void {
  const next = unique(opportunities.map((item) => sanitizeOneLine(item, 220)).filter(Boolean));
  memory.learned.nextOpportunityPatterns = unique([...next, ...memory.learned.nextOpportunityPatterns]).slice(0, 100);
}

export function incrementTaskReplan(memory: MemoryState, task: AgentTask): number {
  const signature = stableTaskSignature(task);
  const current = Number(memory.learned.taskReplanStats?.[signature] || 0);
  memory.learned.taskReplanStats[signature] = current + 1;
  return memory.learned.taskReplanStats[signature];
}

export function getTaskReplanCount(memory: MemoryState, task: AgentTask): number {
  const signature = stableTaskSignature(task);
  return Number(memory.learned.taskReplanStats?.[signature] || 0);
}

export function rememberFileFailures(memory: MemoryState, files: string[], reason: string): void {
  const stats = memory.learned.fileFailureStats || {};
  const cleanFiles = unique(files.map(normalizeSlashes).filter(Boolean).filter((file) => !isProtectedFile(file)));

  for (const file of cleanFiles) {
    const current = stats[file] || { count: 0, lastReason: '', lastAt: null };
    stats[file] = {
      count: Number(current.count || 0) + 1,
      lastReason: sanitizeOneLine(reason || '', 220),
      lastAt: new Date().toISOString()
    };
  }

  const sortedEntries = Object.entries(stats)
    .sort((a, b) => Number(b[1]?.count || 0) - Number(a[1]?.count || 0))
    .slice(0, CONFIG.MAX_HOT_FILES);

  memory.learned.fileFailureStats = Object.fromEntries(sortedEntries);
}

export function getHotFiles(memory: MemoryState): string[] {
  return Object.entries(memory.learned.fileFailureStats || {})
    .filter(([, meta]) => Number(meta?.count || 0) >= CONFIG.HOT_FILE_FAILURE_THRESHOLD)
    .sort((a, b) => Number(b[1]?.count || 0) - Number(a[1]?.count || 0))
    .map(([file]) => file)
    .slice(0, CONFIG.MAX_HOT_FILES);
}

export function countTaskFailures(memory: MemoryState, task: AgentTask): number {
  const signature = stableTaskSignature(task);
  return memory.failed.filter((entry) => entry.signature === signature).length;
}

export function registerIdenticalFailure(memory: MemoryState, task: AgentTask, reason: string): { key: string; count: number; errorSignature: string } {
  const signature = stableTaskSignature(task);
  const errorSignature = stableTextSignature(reason);
  const key = `${signature}:${errorSignature}`;
  const current = Number(memory.identicalFailureBursts[key] || 0) + 1;
  memory.identicalFailureBursts[key] = current;
  return { key, count: current, errorSignature };
}

export function clearTaskFailureBursts(memory: MemoryState, task: AgentTask): void {
  const signature = stableTaskSignature(task);
  for (const key of Object.keys(memory.identicalFailureBursts || {})) {
    if (key.startsWith(`${signature}:`)) {
      delete memory.identicalFailureBursts[key];
    }
  }
}
