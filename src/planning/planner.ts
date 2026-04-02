import { CONFIG } from '../config';
import { isBlockedFileName, isProtectedFile, normalizeSlashes } from '../core/fs-utils';
import { unique } from '../core/text';
import { getModelProvider } from '../models';
import type { ModelProvider } from '../models/provider';
import { getHotFiles } from '../state/memory';
import { buildBacklogPlannerPrompt, buildReplanPrompt } from './prompts';
import type { AgentConfig, AgentTask, BacklogResponse, Blueprint, MemoryState, RepoIndex, RepoSnapshot } from '../types';

const DEFAULT_OWNER_AGENT = 'builder';

function sanitizeOwnerAgent(owner: unknown, config: AgentConfig): string {
  const normalized = String(owner || '').toLowerCase().trim();
  return config.AGENT_ROLES.includes(normalized) ? normalized : DEFAULT_OWNER_AGENT;
}

function sanitizeSkillTags(skills: unknown, config: AgentConfig): string[] {
  const list = Array.isArray(skills) ? skills : [];
  const allowed = new Set(config.AGENT_SKILLS.map((item) => item.toLowerCase()));
  return unique(
    list
      .map((item) => String(item || '').toLowerCase().trim())
      .filter(Boolean)
      .filter((item) => allowed.has(item))
  ).slice(0, 6);
}

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

function sanitizeDependencies(dependsOn: unknown, taskId: string): string[] {
  const list = Array.isArray(dependsOn) ? dependsOn : [];
  return unique(
    list
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((depId) => depId !== taskId)
  );
}

function classifyTaskStatus(task: AgentTask, knownTaskIds: Set<string>): string {
  const dependencies = sanitizeDependencies(task.depends_on, task.id).filter((depId) => knownTaskIds.has(depId));
  if (!dependencies.length) return 'ready';
  return 'blocked';
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

    const acceptanceCriteria = unique((Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : []).map((item) => String(item || '').trim()).filter(Boolean));

    const normalizedTask: AgentTask = {
      id: String(task.id),
      title: String(task.title),
      category: String(task.category),
      priority: String(task.priority || 'medium'),
      goal: String(task.goal),
      why: String(task.why || ''),
      files: validFiles.slice(0, config.MAX_FILES_PER_TASK),
      depends_on: sanitizeDependencies(task.depends_on, String(task.id)),
      acceptance_criteria: acceptanceCriteria,
      estimated_size: String(task.estimated_size || 'm'),
      risk_level: String(task.risk_level || 'medium'),
      status: String(task.status || 'pending'),
      new_files_allowed: Boolean(task.new_files_allowed),
      commit_message: String(task.commit_message || `chore: ${task.title}`),
      kind: task.kind,
      owner_agent: sanitizeOwnerAgent(task.owner_agent, config),
      skill_tags: sanitizeSkillTags(task.skill_tags, config)
    };

    if (!normalizedTask.files.length && !normalizedTask.new_files_allowed) continue;
    cleaned.push(normalizedTask);
  }

  const taskIds = new Set(cleaned.map((task) => task.id));
  backlog.tasks = cleaned.map((task) => {
    const validDependsOn = task.depends_on.filter((depId) => taskIds.has(depId));
    return {
      ...task,
      depends_on: validDependsOn,
      status: classifyTaskStatus({ ...task, depends_on: validDependsOn }, taskIds)
    };
  });

  return backlog;
}

async function generateJsonWithFallback<T>(
  provider: ModelProvider,
  input: {
    primaryModel: string;
    fallbackModel: string;
    prompt: string;
    label: string;
    validator?: ((value: unknown) => value is T) | ((value: unknown) => boolean);
  }
): Promise<T> {
  try {
    return await provider.generateJson<T>({
      model: input.primaryModel,
      prompt: input.prompt,
      label: input.label,
      validator: input.validator
    });
  } catch {
    return await provider.generateJson<T>({
      model: input.fallbackModel || input.primaryModel,
      prompt: input.prompt,
      label: `${input.label}:fallback`,
      validator: input.validator
    });
  }
}

export async function createBacklog(input: {
  blueprint: Blueprint;
  snapshot: RepoSnapshot;
  memory: MemoryState;
  branch: string;
  repoIndex: RepoIndex;
  config?: AgentConfig;
  provider?: ModelProvider;
}): Promise<BacklogResponse> {
  const { blueprint, snapshot, memory, branch, repoIndex, config = CONFIG, provider = getModelProvider() } = input;

  const prompt = buildBacklogPlannerPrompt({
    blueprint,
    snapshot,
    memory,
    branch,
    config,
    hotFiles: getHotFiles(memory)
  });

  const backlog = await generateJsonWithFallback<BacklogResponse>(provider, {
    primaryModel: config.MODEL_PLANNER,
    fallbackModel: config.MODEL_PLANNER_FALLBACK,
    prompt,
    label: 'backlog',
    validator: isValidBacklog
  });
  return validateBacklog(backlog, repoIndex, memory, config);
}

export async function replanTask(input: {
  blueprint: Blueprint;
  task: AgentTask;
  failureSummary: string;
  memory: MemoryState;
  config?: AgentConfig;
  provider?: ModelProvider;
}): Promise<AgentTask> {
  const { blueprint, task, failureSummary, memory, config = CONFIG, provider = getModelProvider() } = input;

  const prompt = buildReplanPrompt({
    blueprint,
    task,
    failureSummary,
    replanCount: Number(memory.learned.taskReplanStats?.[task.id] || 0)
  });

  const nextTask = await generateJsonWithFallback<AgentTask>(provider, {
    primaryModel: config.MODEL_PLANNER,
    fallbackModel: config.MODEL_PLANNER_FALLBACK,
    prompt,
    label: 'task-replan',
    validator: validateTaskShape
  });

  return {
    ...task,
    ...nextTask,
    depends_on: sanitizeDependencies(nextTask.depends_on, String(nextTask.id || task.id)),
    acceptance_criteria: Array.isArray(nextTask.acceptance_criteria)
      ? unique(nextTask.acceptance_criteria.map((item) => String(item || '').trim()).filter(Boolean))
      : task.acceptance_criteria,
    estimated_size: String(nextTask.estimated_size || task.estimated_size || 'm'),
    risk_level: String(nextTask.risk_level || task.risk_level || 'medium'),
    status: String(nextTask.status || task.status || 'pending'),
    files: Array.isArray(nextTask.files)
      ? nextTask.files.map(normalizeSlashes).slice(0, config.MAX_FILES_PER_TASK)
      : task.files,
    new_files_allowed: Boolean(nextTask.new_files_allowed),
    commit_message: String(nextTask.commit_message || task.commit_message || `chore: ${nextTask.title || task.title}`),
    owner_agent: sanitizeOwnerAgent(nextTask.owner_agent || task.owner_agent, config),
    skill_tags: sanitizeSkillTags(nextTask.skill_tags || task.skill_tags, config)
  };
}
