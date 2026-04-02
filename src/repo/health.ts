import { abs, exists, normalizeSlashes } from '../core/fs-utils';
import { run } from '../core/process-utils';
import { truncate } from '../core/text';
import { readPackageJsonSafe } from './indexer';
import type { AgentConfig, CommandResult, ProjectCommands, RepoDelta, RepoHealth } from '../types';

export function detectPackageManager(config: AgentConfig): string {
  if (config.NPM_CLIENT) return config.NPM_CLIENT;
  if (exists(abs('pnpm-lock.yaml'))) return 'pnpm';
  if (exists(abs('yarn.lock'))) return 'yarn';
  if (exists(abs('package-lock.json'))) return 'npm';
  return 'npm';
}

export function runScript(config: AgentConfig, scriptName: string): string {
  const manager = detectPackageManager(config);
  if (manager === 'pnpm') return `pnpm ${scriptName}`;
  if (manager === 'yarn') return `yarn ${scriptName}`;
  return `npm run ${scriptName}`;
}

export function detectProjectCommands(config: AgentConfig): ProjectCommands {
  const pkg = readPackageJsonSafe();
  const result: ProjectCommands = { verify: [], test: [] };
  if (!pkg) return result;

  const scripts = ((pkg.scripts as Record<string, string>) || {});
  if (scripts.lint) result.verify.push(runScript(config, 'lint'));
  if (scripts.typecheck) result.verify.push(runScript(config, 'typecheck'));
  if (scripts.build) result.verify.push(runScript(config, 'build'));

  if (scripts.test) {
    const manager = detectPackageManager(config);
    result.test.push(manager === 'yarn' ? 'yarn test' : manager === 'pnpm' ? 'pnpm test' : 'npm test');
  }
  if (scripts['test:unit']) result.test.push(runScript(config, 'test:unit'));
  if (scripts['test:integration']) result.test.push(runScript(config, 'test:integration'));

  return result;
}

export function runCommands(
  config: AgentConfig,
  commands: string[],
  label: string,
  logger: (...args: unknown[]) => void
): CommandResult[] {
  const outputs: CommandResult[] = [];
  for (const cmd of commands) {
    logger(`🧪 ${label}: ${cmd}`);
    const res = run(cmd, { cwd: config.REPO_PATH });
    outputs.push({
      command: cmd,
      ok: res.ok,
      code: res.code,
      stdout: truncate(res.stdout, 30000),
      stderr: truncate(res.stderr, 30000)
    });
    if (!res.ok) break;
  }
  return outputs;
}

export function summarizeCommandFailures(results: CommandResult[]): string {
  const failed = results.find((result) => !result.ok);
  if (!failed) return '';
  return [
    `COMMAND: ${failed.command}`,
    'STDOUT:',
    failed.stdout || '(empty)',
    'STDERR:',
    failed.stderr || '(empty)'
  ].join('\n');
}

export function summarizeVerificationResults(verifyResults: CommandResult[], testResults: CommandResult[]): string {
  return [summarizeCommandFailures(verifyResults), summarizeCommandFailures(testResults)]
    .filter(Boolean)
    .join('\n\n');
}

export function extractRelevantFilesFromErrors(text: string): string[] {
  const matches = text.match(/[A-Za-z0-9_./\\-]+\.(tsx|ts|jsx|js|json|css|scss|md|yml|yaml|mjs|cjs)/g) || [];
  return [...new Set(matches.map(normalizeSlashes))];
}

export function getMandatoryDiagnosticFiles(summary: string): string[] {
  const text = String(summary || '').toLowerCase();
  const files: string[] = [];

  if (text.includes('eslint')) {
    files.push('package.json', 'eslint.config.js', 'eslint.config.cjs', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs');
  }
  if (text.includes('typescript') || text.includes('typecheck')) {
    files.push('package.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.test.json');
  }
  if (text.includes('jest') || text.includes('vitest') || text.includes('test')) {
    files.push('package.json', 'jest.config.js', 'jest.config.cjs', 'jest.config.ts', 'vitest.config.ts');
  }
  if (text.includes('build')) {
    files.push('package.json');
  }

  return [...new Set(files)];
}

export function normalizeFailureSummary(summary: string): string {
  return String(summary || '')
    .replace(/\r/g, '')
    .replace(/[A-Z]:[\\/][^\n]+/g, '<abs_path>')
    .replace(/\/[^ \n]+/g, (match) => (match.includes('.') ? '<path>' : match))
    .replace(/\d+/g, '<n>')
    .trim();
}

export function getRepoHealth(config: AgentConfig, logger: (...args: unknown[]) => void): RepoHealth {
  const commands = detectProjectCommands(config);
  const verifyResults = runCommands(config, commands.verify, 'verify', logger);
  const verifyOk = verifyResults.every((item) => item.ok);
  const testResults = verifyOk ? runCommands(config, commands.test, 'test', logger) : [];
  const testOk = testResults.every((item) => item.ok);
  const summary = summarizeVerificationResults(verifyResults, testResults);

  return {
    ok: verifyOk && testOk,
    commands,
    verifyResults,
    testResults,
    summary,
    signature: normalizeFailureSummary(summary)
  };
}

export function compareRepoHealth(beforeHealth: RepoHealth | null | undefined, afterHealth: Pick<RepoHealth, 'ok' | 'summary' | 'signature'>): RepoDelta {
  const beforeSignature = beforeHealth?.signature || '';
  const afterSignature = afterHealth?.signature || '';

  if (afterHealth.ok) {
    return {
      introducedNewErrors: false,
      improved: true,
      worsened: false,
      unchanged: Boolean(beforeSignature && beforeSignature === afterSignature)
    };
  }

  if (!beforeHealth || beforeHealth.ok) {
    return { introducedNewErrors: true, improved: false, worsened: true, unchanged: false };
  }

  if (beforeSignature === afterSignature) {
    return { introducedNewErrors: false, improved: false, worsened: false, unchanged: true };
  }

  const beforeSize = String(beforeHealth.summary || '').length;
  const afterSize = String(afterHealth.summary || '').length;

  if (afterSize < beforeSize) {
    return { introducedNewErrors: false, improved: true, worsened: false, unchanged: false };
  }

  return { introducedNewErrors: true, improved: false, worsened: true, unchanged: false };
}
