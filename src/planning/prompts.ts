import type { AgentConfig, AgentTask, Blueprint, ImplementationPlan, MemoryState, RepoSnapshot } from '../types';

export function buildBacklogPlannerPrompt(input: {
  blueprint: Blueprint;
  snapshot: RepoSnapshot;
  memory: MemoryState;
  branch: string;
  config: AgentConfig;
  hotFiles: string[];
}): string {
  const { blueprint, snapshot, memory, branch, config, hotFiles } = input;

  return `You are an autonomous principal software engineer evolving a real production system.

SOURCE OF TRUTH:
The blueprint below defines the product, architecture, goals, and constraints.
You must obey it strictly.

BLUEPRINT:
${blueprint.content}

CURRENT BRANCH:
${branch}

PACKAGE SUMMARY:
${snapshot.packageSummary}

KNOWN FILES:
${snapshot.fileList}

IMPORTANT FILE EXCERPTS:
${snapshot.fileContexts}

MAIN EVOLUTION DOCUMENT EXCERPT:
${snapshot.evolutionDocSummary || '(empty)'}

KNOWN DEPENDENCIES:
${JSON.stringify(snapshot.dependencySummary.slice(0, 120), null, 2)}

LEARNED SUCCESSES:
${JSON.stringify(memory.accepted.slice(0, 10), null, 2)}

LEARNED FAILURES:
${JSON.stringify(memory.failed.slice(0, 10), null, 2)}

HOT FILES WITH RECENT FAILURES:
${JSON.stringify(hotFiles, null, 2)}

LEARNED NEXT OPPORTUNITIES:
${JSON.stringify(memory.learned.nextOpportunityPatterns.slice(0, 20), null, 2)}

LEARNED DEPENDENCY INSTALLS:
${JSON.stringify(memory.learned.dependencyInstallPatterns.slice(0, 20), null, 2)}

GOAL PROGRESS BY OBJECTIVE:
${JSON.stringify(memory.learned.goalProgressByObjective, null, 2)}

CATEGORY COMPLETION STATS:
${JSON.stringify(memory.learned.categoryCompletionByCategory, null, 2)}

AVAILABLE MULTI-AGENT ROLES:
${JSON.stringify(config.AGENT_ROLES, null, 2)}

AVAILABLE SKILLS TAXONOMY:
${JSON.stringify(config.AGENT_SKILLS, null, 2)}

CRITICAL RULES:
- Read the blueprint and continuously create useful tasks forever
- Generate tasks in these categories whenever relevant: product, performance, security, optimization, bugfix, tests, refactor, dx
- Prefer features that move the product forward, then hardening/performance/security
- Propose ONLY improvements aligned with the existing system
- DO NOT introduce new frameworks or platforms unless already present in dependencies or files
- DO NOT introduce: ${config.FORBIDDEN_TECH_KEYWORDS.join(', ')}
- NEVER suggest protected/internal files
- NEVER suggest blocked env/config secret files such as .env or .env.example
- Prefer improving existing modules, bugfixes, tests, validation, security hardening, performance, DX
- If the repository is unhealthy, prefer repo stabilization and tooling fixes over new features
- Only propose small or medium shippable tasks
- Max ${config.MAX_FILES_PER_TASK} files per task
- Always include real file paths when possible
- Consider previously completed tasks and the auto evolution log so the project keeps evolving instead of repeating itself
- Build the backlog as a dependency graph: include tasks, depends_on edges, and measurable acceptance criteria
- Use status 'ready' when there are no dependencies; otherwise use 'blocked'
- Every task must include:
  - owner_agent: pick one role from AVAILABLE MULTI-AGENT ROLES
  - skill_tags: choose 1 to 4 items from AVAILABLE SKILLS TAXONOMY

Return ONLY valid JSON in this exact shape:
{
  "summary": "short summary of repo direction",
  "tasks": [
    {
      "id": "task-short-id",
      "title": "short title",
      "category": "security|performance|product|optimization|bugfix|refactor|dx|tests",
      "priority": "high|medium|low",
      "goal": "what should be improved",
      "why": "why this matters",
      "files": ["real/path1", "real/path2"],
      "depends_on": ["task-id-dependency"],
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "estimated_size": "s|m",
      "risk_level": "low|medium|high|critical",
      "status": "ready|blocked|pending",
      "new_files_allowed": true,
      "commit_message": "feat/fix/chore/test/refactor/perf: concise message",
      "owner_agent": "role-from-available-list",
      "skill_tags": ["skill-a", "skill-b"]
    }
  ]
}`;
}

export function buildExecutorPrompt(input: {
  blueprint: Blueprint;
  task: AgentTask;
  fileContexts: string;
  commands: unknown;
  memory: MemoryState;
}): string {
  const { blueprint, task, fileContexts, commands, memory } = input;
  const ownerAgent = String(task.owner_agent || 'builder');
  const skills = Array.isArray(task.skill_tags) && task.skill_tags.length ? task.skill_tags : ['coding'];

  return `You are implementing one task in a production codebase.

SOURCE OF TRUTH:
${blueprint.content}

TASK:
${JSON.stringify(task, null, 2)}

ACTIVE OWNER AGENT:
${ownerAgent}

ACTIVE SKILLS:
${JSON.stringify(skills, null, 2)}

PROJECT COMMANDS:
${JSON.stringify(commands, null, 2)}

CURRENT FILES:
${fileContexts}

LEARNED FAILURES:
${JSON.stringify(memory.failed.slice(0, 8), null, 2)}

CRITICAL IMPLEMENTATION RULES:
- Implement ONLY this task
- Respect the blueprint and current stack
- Keep scope safe but COMPLETE
- Do not modify unrelated files
- Do not modify .env, .env.example or protected files
- Use exact relative repo paths
- Existing files must be fully rewritten in output
- New files only if task justifies it
- Focus on delivering working code that passes lint, typecheck, build and tests
- NEVER modify or access protected files
- Never introduce forbidden technologies
- NEVER add comments to JSON files
- NEVER output invalid JSON for package.json, tsconfig.json, or other .json files

Return ONLY valid JSON in this exact shape:
{
  "summary": "what changed",
  "files": [
    {
      "path": "relative/path.ext",
      "action": "update|create",
      "content": "full file content"
    }
  ],
  "delete_files": [],
  "notes": ["important note 1", "important note 2"]
}`;
}

export function buildReplanPrompt(input: {
  blueprint: Blueprint;
  task: AgentTask;
  failureSummary: string;
  replanCount: number;
}): string {
  const { blueprint, task, failureSummary, replanCount } = input;

  return `You are replanning a failed implementation task in a production repository.

BLUEPRINT:
${blueprint.content}

FAILED TASK:
${JSON.stringify(task, null, 2)}

FAILURE:
${failureSummary}

CURRENT REPLAN COUNT:
${replanCount}

RULES:
- Keep the same end goal
- Reduce scope if necessary
- Prefer fewer files
- Prefer existing files
- Avoid blocked/protected files
- If tooling is broken, suggest stabilization-oriented changes
- Return ONLY valid JSON using the same task schema

Return ONLY valid JSON:
{
  "id": "task-short-id",
  "title": "short title",
  "category": "security|performance|product|optimization|bugfix|refactor|dx|tests",
  "priority": "high|medium|low",
  "goal": "what should be improved",
  "why": "why this matters",
  "files": ["real/path1", "real/path2"],
  "depends_on": ["task-id-dependency"],
  "acceptance_criteria": ["criterion 1", "criterion 2"],
  "estimated_size": "xs|s|m|l",
  "risk_level": "low|medium|high|critical",
  "status": "ready|blocked|pending",
  "new_files_allowed": true,
  "commit_message": "feat/fix/chore/test/refactor/perf: concise message",
  "owner_agent": "role-from-available-list",
  "skill_tags": ["skill-a", "skill-b"]
}`;
}

export function buildReviewerPrompt(input: {
  blueprint: Blueprint;
  task: AgentTask;
  implementation: ImplementationPlan;
  diff: string;
}): string {
  const { blueprint, task, implementation, diff } = input;

  return `You are a strict senior reviewer.

SOURCE OF TRUTH:
${blueprint.content}

TASK:
${JSON.stringify(task, null, 2)}

IMPLEMENTATION:
${JSON.stringify(implementation, null, 2)}

DIFF:
${diff}

Approve only if:
- it matches the blueprint
- it matches the task
- files are relevant
- risk is acceptable
- code is coherent
- no obvious breakage
- no secrets or destructive operations
- no unrelated changes
- no protected files are touched
- no blocked config files like .env.example are touched
- no new frameworks outside current stack
- JSON files remain valid JSON

Return ONLY valid JSON:
{
  "verdict": "APPROVED|REJECTED",
  "reason": "short reason",
  "warnings": ["warning 1"],
  "suggested_commit_message": "optional improved commit message"
}`;
}

export function buildSelfHealPrompt(input: {
  blueprint: Blueprint;
  task: AgentTask;
  implementation: ImplementationPlan;
  failedSummary: string;
  currentFiles: string;
  commands: unknown;
}): string {
  const { blueprint, task, implementation, failedSummary, currentFiles, commands } = input;

  return `You are a senior engineer fixing a broken codebase.

SOURCE OF TRUTH:
${blueprint.content}

TASK:
${JSON.stringify(task, null, 2)}

PREVIOUS IMPLEMENTATION:
${JSON.stringify(implementation, null, 2)}

PROJECT COMMANDS:
${JSON.stringify(commands, null, 2)}

FAILURE OUTPUT (VERY IMPORTANT):
${failedSummary}

CURRENT FILES AND ERROR CONTEXT:
${currentFiles}

CRITICAL RULES:
- You MUST fix ALL errors until the project passes
- Fix lint, type errors, build errors, import errors, path alias issues, runtime issues and tests
- If the failure indicates missing ESLint/TypeScript packages, prefer fixing config and dependency setup first
- If the failure mentions parsing errors in TypeScript decorators, do NOT remove NestJS decorators as a fix
- You can modify any file directly related to the failure
- Keep changes minimal but COMPLETE
- Do not introduce new frameworks
- Do not touch protected files
- Do not touch .env, .env.example or secret files
- NEVER add comments to JSON files
- Prioritize actual delivery over partial changes

RETURN ONLY VALID JSON:
{
  "summary": "what was fixed",
  "files": [
    {
      "path": "relative/path.ext",
      "action": "update|create",
      "content": "full file content"
    }
  ],
  "delete_files": [],
  "notes": ["..."]
}`;
}
