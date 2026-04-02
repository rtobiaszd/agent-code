export type TaskCategory = 'security' | 'performance' | 'product' | 'optimization' | 'bugfix' | 'refactor' | 'dx' | 'tests';
export type TaskPriority = 'high' | 'medium' | 'low';
export type FailureClassification = 'replanable' | 'healable' | 'stabilization' | 'fatal' | 'unknown';
export type VerificationMode = 'fast' | 'full';
export type FileAction = 'update' | 'create';

export interface AgentConfig {
  REPO_PATH: string;
  BLUEPRINT_FILE: string;
  MAIN_EVOLUTION_DOC: string;
  EVOLUTION_SECTION_TITLE: string;
  MAX_EVOLUTION_ENTRIES: number;
  OLLAMA_URL: string;
  MODEL_PROVIDER: string;
  MODEL_PLANNER: string;
  MODEL_PLANNER_FALLBACK: string;
  MODEL_EXECUTOR: string;
  MODEL_EXECUTOR_FALLBACK: string;
  MODEL_REVIEWER: string;
  MODEL_REVIEWER_FALLBACK: string;
  MODEL_FIXER: string;
  MODEL_FIXER_FALLBACK: string;
  MODEL_JSON_REPAIR: string;
  MODEL_TIMEOUT_MS: number;
  MODEL_RETRY_ATTEMPTS: number;
  MODEL_RETRY_BACKOFF_MS: number;
  MODEL_RETRY_MAX_BACKOFF_MS: number;
  REMOTE_NAME: string;
  AUTO_PUSH: boolean;
  AUTO_BRANCH: boolean;
  BRANCH_PREFIX: string;
  MAX_ITERATIONS: number;
  MAX_RUNTIME_MS: number;
  LOOP_DELAY_MS: number;
  MAX_FILES_PER_TASK: number;
  MAX_CONTEXT_FILES: number;
  MAX_FILE_CHARS: number;
  MAX_BLUEPRINT_CHARS: number;
  MAX_BACKLOG_ITEMS: number;
  MAX_HISTORY_ITEMS: number;
  MAX_REPEAT_FAILURES_PER_TASK: number;
  MAX_REPLAN_PER_TASK: number;
  MAX_HOT_FILES: number;
  HOT_FILE_FAILURE_THRESHOLD: number;
  EVOLUTION_DOC_CONTEXT_CHARS: number;
  MAX_SELF_HEAL_ATTEMPTS: number;
  MAX_PARSE_RETRIES: number;
  MAX_JSON_REPAIR_ATTEMPTS: number;
  MAX_IDENTICAL_ERROR_RETRIES: number;
  AUTO_INSTALL_MISSING_PACKAGES: boolean;
  ALLOW_DEV_DEP_INSTALLS: boolean;
  MAX_AUTO_INSTALLS_PER_ITERATION: number;
  NPM_CLIENT: string;
  REPO_STABILIZATION_MODE: boolean;
  ALLOW_NEW_FILES: boolean;
  ALLOW_DELETE_FILES: boolean;
  STRICT_CLEAN_START: boolean;
  IGNORE_UNTRACKED_PROTECTED_FILES_ONLY: boolean;
  DEBUG: boolean;
  IGNORE_DIRS: string[];
  IGNORE_FILES: string[];
  PROTECTED_FILES: string[];
  BLOCKED_FILE_NAMES: string[];
  SPECIAL_ALLOWED_FILES: string[];
  ALLOWED_EXTENSIONS: string[];
  STABILIZATION_ALLOWED_NEW_FILES: string[];
  FORBIDDEN_TECH_KEYWORDS: string[];
}

export interface RuntimeCycleMetric {
  cycle: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  result: 'success' | 'failure' | 'idle' | 'stopped';
  reason?: string;
  taskId?: string;
  taskTitle?: string;
}

export interface RuntimeState {
  startedAt: string | null;
  endedAt: string | null;
  lastLoopResult: string | null;
  consecutiveCycleFailures: number;
  cycleMetrics: RuntimeCycleMetric[];
}

export interface AgentTask {
  id: string;
  title: string;
  category: TaskCategory | string;
  priority: TaskPriority | string;
  goal: string;
  why: string;
  files: string[];
  new_files_allowed: boolean;
  commit_message: string;
  kind?: 'stabilization' | string;
}

export interface BacklogResponse {
  summary?: string;
  tasks: AgentTask[];
}

export interface Blueprint {
  path: string;
  content: string;
  hash: string;
}

export interface RepoIndex {
  files: string[];
  rels: string[];
  importantFiles: string[];
  repoHash: string;
}

export interface RepoSnapshot {
  packageSummary: string;
  dependencySummary: string[];
  fileList: string;
  fileContexts: string;
  evolutionDocSummary: string;
}

export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProjectCommands {
  verify: string[];
  test: string[];
}

export interface RepoHealth {
  ok: boolean;
  commands: ProjectCommands;
  verifyResults: CommandResult[];
  testResults: CommandResult[];
  summary: string;
  signature: string;
}

export interface RepoDelta {
  introducedNewErrors: boolean;
  improved: boolean;
  worsened: boolean;
  unchanged: boolean;
}

export interface ImplementationFile {
  path: string;
  action: FileAction;
  content: string;
}

export interface ImplementationPlan {
  summary?: string;
  files: ImplementationFile[];
  delete_files?: string[];
  notes?: string[];
}

export interface ReviewResult {
  verdict: 'APPROVED' | 'REJECTED' | string;
  reason: string;
  warnings?: string[];
  suggested_commit_message?: string;
}

export interface HistoryItem extends Record<string, unknown> {
  at?: string;
  type?: string;
}

export interface FailureEntry {
  at: string;
  title: string;
  category: string;
  reason: string;
  signature: string;
  error_signature: string;
  classification: FailureClassification;
}

export interface MemoryLearnedState {
  successfulTaskSignatures: string[];
  failedTaskSignatures: string[];
  successfulCommitMessages: string[];
  forbiddenKeywordsObserved: string[];
  lintPatterns: string[];
  buildPatterns: string[];
  testPatterns: string[];
  fileFailureStats: Record<string, { count: number; lastReason: string; lastAt: string | null }>;
  taskReplanStats: Record<string, number>;
  nextOpportunityPatterns: string[];
  dependencyInstallPatterns: string[];
}

export interface MemoryMetrics {
  iterations: number;
  plannerRuns: number;
  tasksExecuted: number;
  approvals: number;
  rejections: number;
  applied: number;
  commits: number;
  pushes: number;
  verifyPass: number;
  verifyFail: number;
  testPass: number;
  testFail: number;
  selfHealSuccess: number;
  selfHealFail: number;
  replans: number;
  blueprintUpdates: number;
  installs: number;
  installSuccess: number;
  installFail: number;
  providerMetrics: Record<
    string,
    {
      totalRequests: number;
      totalErrors: number;
      errorRate: number;
      models: Record<
        string,
        {
          requests: number;
          errors: number;
          averageLatencyMs: number;
          averageResponseSize: number;
        }
      >;
    }
  >;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
}

export interface MemoryState {
  repoHash: string;
  blueprintHash: string;
  backlog: AgentTask[];
  accepted: Array<Record<string, unknown>>;
  failed: FailureEntry[];
  skipped: Array<Record<string, unknown>>;
  history: HistoryItem[];
  identicalFailureBursts: Record<string, number>;
  runtime: RuntimeState;
  learned: MemoryLearnedState;
  metrics: MemoryMetrics;
}

export interface VerificationRun {
  ok: boolean;
  mode: VerificationMode;
  commands: ProjectCommands;
  verifyResults: CommandResult[];
  testResults: CommandResult[];
  summary: string;
}

export interface FailureDecision {
  action: 'retry' | 'replan' | 'drop';
  classification: FailureClassification;
  identicalCount: number;
  taskFailures: number;
}

export interface FileEligibility {
  allowed: boolean;
  reason: string;
  fatal: boolean;
}
