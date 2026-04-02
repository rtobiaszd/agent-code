import { CONFIG } from '../config';
import { isBlockedFileName, isProtectedFile, normalizeSlashes } from '../core/fs-utils';
import { unique } from '../core/text';
import { askAndParseJson } from '../models/ollama';
import { getHotFiles } from '../state/memory';
import { buildBacklogPlannerPrompt, buildReplanPrompt } from './prompts';
import type { AgentConfig, AgentTask, BacklogResponse, Blueprint, MemoryState, RepoIndex, RepoSnapshot } from '../types';

export function isValidBacklog(value: unknown): value is BacklogResponse {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as BacklogResponse).tasks));
}

export function validateTaskShape(value: unknown): value is AgentTask {
  const task = value as AgentTask;
  return Boolean(task && typeof task === 'object' && task.id && task.title && task.category && task.goal);
}

export function detectForbiddenKeywordsInTask(task: AgentTask, config: AgentConfig = CONFIG): string[] {
  const serialized = JSON.stringify(task).toLowerCase();
  return config.FORBIDDEN_TECH_KEYWORDS.filter((keyword) => serialized.includes(keyword));
}

export function validateBacklog(
  backlog: BacklogResponse,
  repoIndex: RepoIndex,
  memory: MemoryState,
  config: AgentConfig = CONFIG
): BacklogResponse {
  const realFiles = new Set(repoIndex.rels);
  const cleaned: AgentTask[] = [];

  for (const task of backlog.tasks.slice(0, config.MAX_BACKLOG_ITEMS)) {
    if (!validateTaskShape(task)) continue;

    const forbidden = detectForbiddenKeywordsInTask(task, config);
    if (forbidden.length) {
      memory.learned.forbiddenKeywordsObserved.push(...forbidden);
      memory.learned.forbiddenKeywordsObserved = unique(memory.learned.forbiddenKeywordsObserved).slice(0, 100);
      continue;
    }

    const validFiles = (Array.isArray(task.files) ? task.files : [])
      .filter(Boolean)
      .map(normalizeSlashes)
      .filter((file) => !isProtectedFile(file))
      .filter((file) => !isBlockedFileName(file))
      .filter((file) => realFiles.has(file));

    const normalizedTask: AgentTask = {
      id: String(task.id),
      title: String(task.title),
      category: String(task.category),
      priority: String(task.priority || 'medium'),
      goal: String(task.goal),
      why: String(task.why || ''),
      files: validFiles.slice(0, config.MAX_FILES_PER_TASK),
      new_files_allowed: Boolean(task.new_files_allowed),
      commit_message: String(task.commit_message || `chore: ${task.title}`),
      kind: task.kind
    };

    if (!normalizedTask.files.length && !normalizedTask.new_files_allowed) continue;
    cleaned.push(normalizedTask);
  }

  backlog.tasks = cleaned;
  return backlog;
}

export async function createBacklog(input: {
  blueprint: Blueprint;
  snapshot: RepoSnapshot;
  memory: MemoryState;
  branch: string;
  repoIndex: RepoIndex;
  config?: AgentConfig;
}): Promise<BacklogResponse> {
  const { blueprint, snapshot, memory, branch, repoIndex, config = CONFIG } = input;

  const prompt = buildBacklogPlannerPrompt({
    blueprint,
    snapshot,
    memory,
    branch,
    config,
    hotFiles: getHotFiles(memory)
  });

  const backlog = await askAndParseJson<BacklogResponse>(config.MODEL_PLANNER, prompt, 'backlog', isValidBacklog);
  return validateBacklog(backlog, repoIndex, memory, config);
}

export async function replanTask(input: {
  blueprint: Blueprint;
  task: AgentTask;
  failureSummary: string;
  memory: MemoryState;
  config?: AgentConfig;
}): Promise<AgentTask> {
  const { blueprint, task, failureSummary, memory, config = CONFIG } = input;

  const prompt = buildReplanPrompt({
    blueprint,
    task,
    failureSummary,
    replanCount: Number(memory.learned.taskReplanStats?.[task.id] || 0)
  });

  const nextTask = await askAndParseJson<AgentTask>(config.MODEL_PLANNER, prompt, 'task-replan', validateTaskShape);

  return {
    ...task,
    ...nextTask,
    files: Array.isArray(nextTask.files)
      ? nextTask.files.map(normalizeSlashes).slice(0, config.MAX_FILES_PER_TASK)
      : task.files,
    new_files_allowed: Boolean(nextTask.new_files_allowed),
    commit_message: String(nextTask.commit_message || task.commit_message || `chore: ${nextTask.title || task.title}`)
  };
}
