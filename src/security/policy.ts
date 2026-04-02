import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { abs, normalizeSlashes, safeWrite } from '../core/fs-utils';
import type { ImplementationPlan } from '../types';

export const EXECUTABLE_ALLOWLIST = ['git', 'npm', 'pnpm', 'yarn', 'node', 'npx', 'bash', 'sh'] as const;

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /(^|\s)rm\s+-rf(\s|$)/i,
  /(^|\s)(mkfs|dd)\s+/i,
  /(^|\s)chmod\s+777(\s|$)/i,
  /(^|\s)(sudo|su)\s+/i,
  /(^|\s)curl\s+[^|\n]+\|\s*(bash|sh)/i,
  /(^|\s)wget\s+[^|\n]+\|\s*(bash|sh)/i,
  /(^|\s):\s*>\s*\/dev\/(sda|disk)/i
];

export const WRITE_SCOPE_ALLOWLIST = [
  'src/',
  'test/',
  'tests/',
  'docs/',
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json'
] as const;

const AUDIT_LOG_FILE = '.agent-audit.log';

export class PolicyError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export function isDryRunMode(): boolean {
  return String(process.env.DRY_RUN || '').toLowerCase() === 'true';
}

function normalizeExecutable(token: string): string {
  return token.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

function getCommandExecutable(command: string): string {
  const cleaned = String(command || '').trim();
  if (!cleaned) return '';
  const withoutEnvPrefix = cleaned.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
  const token = withoutEnvPrefix.split(/\s+/)[0] || '';
  return normalizeExecutable(token);
}

function isWritePathAllowed(filePath: string): boolean {
  const normalized = normalizeSlashes(path.relative(CONFIG.REPO_PATH, abs(filePath)));
  if (!normalized || normalized.startsWith('..')) return false;
  return WRITE_SCOPE_ALLOWLIST.some((allowed) => normalized === allowed || normalized.startsWith(allowed));
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function makePromptHash(prompt: string): string {
  return hash(prompt);
}

export function appendAuditLog(entry: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ timestamp, ...entry });
  const full = abs(AUDIT_LOG_FILE);
  const previous = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  safeWrite(full, `${previous}${line}\n`);
}

export function assertCommandAllowed(command: string, context: { cwd?: string; promptHash?: string } = {}): void {
  const executable = getCommandExecutable(command);

  if (!executable || !EXECUTABLE_ALLOWLIST.includes(executable as (typeof EXECUTABLE_ALLOWLIST)[number])) {
    appendAuditLog({
      type: 'policy.command',
      promptHash: context.promptHash || null,
      command,
      executable,
      verdict: 'deny',
      reason: 'command_not_allowlisted'
    });
    throw new PolicyError('POLICY_DENIED_COMMAND', `policy_denied:command_not_allowlisted:${executable || 'empty'}`);
  }

  const dangerousPattern = DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(command));
  if (dangerousPattern) {
    appendAuditLog({
      type: 'policy.command',
      promptHash: context.promptHash || null,
      command,
      executable,
      verdict: 'deny',
      reason: 'command_matches_denylist',
      pattern: String(dangerousPattern)
    });
    throw new PolicyError('POLICY_DENIED_PATTERN', 'policy_denied:command_matches_denylist');
  }

  appendAuditLog({
    type: 'policy.command',
    promptHash: context.promptHash || null,
    command,
    executable,
    cwd: context.cwd || CONFIG.REPO_PATH,
    verdict: 'allow'
  });
}

export function assertImplementationWriteScope(impl: ImplementationPlan, context: { promptHash?: string } = {}): void {
  const touchedFiles = [...(impl.files || []).map((item) => item.path), ...(impl.delete_files || [])].map(normalizeSlashes);

  const blocked = touchedFiles.filter((item) => !isWritePathAllowed(item));
  if (blocked.length > 0) {
    appendAuditLog({
      type: 'policy.write',
      promptHash: context.promptHash || null,
      filesTouched: touchedFiles,
      verdict: 'deny',
      reason: 'write_scope_violation',
      blocked
    });
    throw new PolicyError('POLICY_DENIED_WRITE_SCOPE', `policy_denied:write_scope:${blocked.join(',')}`);
  }

  appendAuditLog({
    type: 'policy.write',
    promptHash: context.promptHash || null,
    filesTouched: touchedFiles,
    verdict: 'allow',
    dryRun: isDryRunMode()
  });
}
