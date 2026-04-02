import fs from 'fs';
import { CONFIG } from '../config';
import { run } from './process-utils';
import { abs, exists, isProtectedFile, safeRead, safeWrite } from './fs-utils';
import { log } from './logger';

export function git(cmd: string, allowFail = false): string {
  const res = run(`git ${cmd}`, { cwd: CONFIG.REPO_PATH });
  if (!allowFail && !res.ok) {
    throw new Error(`git ${cmd} falhou:\n${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

export function hasGitRepo(): boolean {
  const res = run('git rev-parse --is-inside-work-tree', { cwd: CONFIG.REPO_PATH });
  return res.ok && String(res.stdout).trim() === 'true';
}

export function currentBranch(): string {
  return git('rev-parse --abbrev-ref HEAD', true) || 'unknown';
}

export function stageAll(): void {
  git('add .');
}

export function commitAll(message: string): boolean {
  stageAll();
  const res = run(`git commit -m ${JSON.stringify(message)}`, { cwd: CONFIG.REPO_PATH });
  const output = `${res.stdout}\n${res.stderr}`.trim();
  if (!res.ok) {
    if (/nothing to commit/i.test(output)) return false;
    throw new Error(`Commit falhou:\n${output}`);
  }
  return true;
}

export function pushBranch(): void {
  const branch = currentBranch();
  const res = run(`git push -u ${CONFIG.REMOTE_NAME} ${branch}`, { cwd: CONFIG.REPO_PATH });
  if (!res.ok) {
    throw new Error(`Push falhou:\n${res.stderr || res.stdout}`);
  }
}

export function getStatusPorcelain(): string[] {
  const out = git('status --porcelain', true);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

export function workingTreeDirty(): boolean {
  const lines = getStatusPorcelain();
  if (!lines.length) return false;
  if (!CONFIG.IGNORE_UNTRACKED_PROTECTED_FILES_ONLY) return true;

  for (const line of lines) {
    const candidate = line.slice(3).trim();
    const isUntracked = line.startsWith('??');
    if (isUntracked && isProtectedFile(candidate)) continue;
    return true;
  }

  return false;
}

export function ensureBranch(nowDate: string): string {
  if (!CONFIG.AUTO_BRANCH) return currentBranch();
  const target = `${CONFIG.BRANCH_PREFIX}/${nowDate}`;
  const current = currentBranch();
  if (current === target) return current;

  const existsBranch = run(`git rev-parse --verify ${target}`, { cwd: CONFIG.REPO_PATH }).ok;
  if (existsBranch) {
    git(`checkout ${target}`);
    return target;
  }

  git(`checkout -b ${target}`);
  return target;
}

export function rollbackHard(): void {
  const backup = new Map<string, string>();
  for (const filePath of CONFIG.PROTECTED_FILES) {
    const full = abs(filePath);
    if (exists(full)) backup.set(full, safeRead(full, ''));
  }

  const mainDoc = abs(CONFIG.MAIN_EVOLUTION_DOC);
  if (exists(mainDoc)) backup.set(mainDoc, safeRead(mainDoc, ''));

  git('reset --hard', true);
  git('clean -fd', true);

  for (const [full, content] of backup.entries()) {
    try {
      safeWrite(full, content);
    } catch (error) {
      log('⚠️ falha ao restaurar backup:', full, error instanceof Error ? error.message : String(error));
    }
  }
}
