import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import type { AgentTask, FileEligibility } from '../types';

export function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function ensureDir(dir: string): void {
  if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function safeRead(filePath: string, fallback = ''): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

export function safeWrite(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

export function normalizeSlashes(filePath: unknown): string {
  return String(filePath ?? '').replace(/\\/g, '/');
}

export function abs(relPath: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(CONFIG.REPO_PATH, relPath);
}

export function rel(absPath: string): string {
  return normalizeSlashes(path.relative(CONFIG.REPO_PATH, absPath));
}

export function fileLooksText(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    const len = Math.min(buf.length, 512);
    for (let i = 0; i < len; i += 1) {
      if (buf[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function basenameNormalized(filePath: string): string {
  return path.basename(normalizeSlashes(filePath)).toLowerCase();
}

export function isProtectedFile(filePath: string): boolean {
  const normalized = normalizeSlashes(filePath).toLowerCase();
  return CONFIG.PROTECTED_FILES.some((item) => normalized.endsWith(item.toLowerCase()));
}

export function isBlockedFileName(filePath: string): boolean {
  return CONFIG.BLOCKED_FILE_NAMES.includes(basenameNormalized(filePath));
}

export function isSpecialAllowedFile(filePath: string): boolean {
  return CONFIG.SPECIAL_ALLOWED_FILES.includes(basenameNormalized(filePath));
}

export function hasAllowedExtension(filePath: string): boolean {
  const lower = normalizeSlashes(filePath).toLowerCase();
  if (isSpecialAllowedFile(lower)) return true;
  return CONFIG.ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function classifyFileEligibility(filePath: string, task: Partial<AgentTask> | null = null): FileEligibility {
  const normalized = normalizeSlashes(filePath);
  const base = basenameNormalized(normalized);

  if (!normalized) return { allowed: false, reason: 'empty_path', fatal: false };
  if (isProtectedFile(normalized)) return { allowed: false, reason: `protected:${base}`, fatal: true };
  if (isBlockedFileName(normalized)) return { allowed: false, reason: `blocked_name:${base}`, fatal: false };
  if (!hasAllowedExtension(normalized)) return { allowed: false, reason: `blocked_extension:${base}`, fatal: false };

  if (
    task?.kind === 'stabilization' &&
    !exists(abs(normalized)) &&
    !CONFIG.STABILIZATION_ALLOWED_NEW_FILES.includes(normalized)
  ) {
    return { allowed: false, reason: `stabilization_create_not_allowed:${base}`, fatal: false };
  }

  return { allowed: true, reason: 'allowed', fatal: false };
}

export function walkFiles(dir: string, list: string[] = []): string[] {
  let entries: Array<any> = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (CONFIG.IGNORE_DIRS.includes(entry.name)) continue;
      walkFiles(full, list);
      continue;
    }

    if (CONFIG.IGNORE_FILES.includes(entry.name)) continue;
    if (isBlockedFileName(entry.name)) continue;
    if (!hasAllowedExtension(entry.name) && !isSpecialAllowedFile(entry.name)) continue;
    if (!fileLooksText(full)) continue;
    list.push(full);
  }

  return list;
}

export function backupFiles(paths: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const filePath of paths || []) {
    const full = abs(filePath);
    map.set(normalizeSlashes(filePath), exists(full) ? safeRead(full, '') : null);
  }
  return map;
}

export function restoreBackup(backupMap: Map<string, string | null>): void {
  for (const [filePath, content] of backupMap.entries()) {
    const full = abs(filePath);
    if (content === null) {
      if (exists(full)) fs.unlinkSync(full);
      continue;
    }
    safeWrite(full, content);
  }
}
