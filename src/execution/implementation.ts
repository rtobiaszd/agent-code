import fs from 'fs';
import { CONFIG } from '../config';
import { abs, classifyFileEligibility, exists, normalizeSlashes, safeWrite } from '../core/fs-utils';
import { sanitizeOneLine, unique } from '../core/text';
import { appendAuditLog, assertImplementationWriteScope, isDryRunMode } from '../security/policy';
import type { AgentConfig, AgentTask, FileEligibility, ImplementationPlan } from '../types';

function isJsonFilePath(filePath: string): boolean {
  return normalizeSlashes(filePath).toLowerCase().endsWith('.json');
}

function detectJsonCommentViolation(content: string): boolean {
  const text = String(content || '').trimStart();
  return text.startsWith('//') || text.startsWith('/*');
}

export function validateJsonContent(filePath: string, content: string): { ok: true } | { ok: false; reason: string } {
  if (!isJsonFilePath(filePath)) return { ok: true };
  if (detectJsonCommentViolation(content)) return { ok: false, reason: `json_comment_not_allowed:${filePath}` };

  try {
    JSON.parse(String(content));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `invalid_json:${filePath}:${sanitizeOneLine(error instanceof Error ? error.message : String(error), 220)}`
    };
  }
}

export function isValidImplementation(value: unknown): value is ImplementationPlan {
  const impl = value as ImplementationPlan;
  return Boolean(
    impl &&
      typeof impl === 'object' &&
      Array.isArray(impl.files) &&
      impl.files.every((item) => item && typeof item.path === 'string' && typeof item.content === 'string')
  );
}

export function containsDangerousContent(value: unknown): boolean {
  const text = JSON.stringify(value);
  const patterns = [
    /rm\s+-rf/gi,
    /DROP\s+TABLE/gi,
    /TRUNCATE\s+TABLE/gi,
    /-----BEGIN (?:RSA|OPENSSH|PRIVATE KEY)-----/g,
    /process\.env\.[A-Z0-9_]+\s*=\s*["'`]/g
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function sanitizeImplementation(
  impl: ImplementationPlan,
  task: Partial<AgentTask>,
  config: AgentConfig = CONFIG
): { impl: ImplementationPlan; skipped: Array<{ path: string; reason: string; fatal: boolean }> } {
  if (!impl || typeof impl !== 'object') throw new Error('Implementação inválida.');
  if (!Array.isArray(impl.files)) impl.files = [];
  if (!Array.isArray(impl.delete_files)) impl.delete_files = [];
  if (!Array.isArray(impl.notes)) impl.notes = [];

  const skipped: Array<{ path: string; reason: string; fatal: boolean }> = [];
  const cleanedFiles = [];

  for (const file of impl.files) {
    if (!file || typeof file.path !== 'string') {
      skipped.push({ path: '(unknown)', reason: 'invalid_path', fatal: false });
      continue;
    }

    const eligibility = classifyFileEligibility(file.path, task);
    if (!eligibility.allowed) {
      skipped.push({ path: normalizeSlashes(file.path), reason: eligibility.reason, fatal: eligibility.fatal });
      if (eligibility.fatal) {
        const fatal = new Error(`Tentativa de alterar arquivo protegido: ${file.path}`) as Error & { code?: string };
        fatal.code = 'FATAL_PROTECTED_FILE';
        throw fatal;
      }
      continue;
    }

    if (!['update', 'create'].includes(file.action)) {
      skipped.push({ path: normalizeSlashes(file.path), reason: `invalid_action:${file.action}`, fatal: false });
      continue;
    }

    if (typeof file.content !== 'string') {
      skipped.push({ path: normalizeSlashes(file.path), reason: 'invalid_content', fatal: false });
      continue;
    }

    if (file.action === 'create' && !config.ALLOW_NEW_FILES && !task.new_files_allowed) {
      skipped.push({ path: normalizeSlashes(file.path), reason: 'create_not_allowed', fatal: false });
      continue;
    }

    const jsonValidation = validateJsonContent(file.path, file.content);
    if (!jsonValidation.ok) {
      skipped.push({ path: normalizeSlashes(file.path), reason: jsonValidation.reason, fatal: false });
      continue;
    }

    cleanedFiles.push({
      path: normalizeSlashes(file.path),
      action: file.action,
      content: String(file.content)
    });
  }

  const cleanedDeletes: string[] = [];
  for (const delPath of impl.delete_files || []) {
    const eligibility = classifyFileEligibility(delPath, task);
    if (!eligibility.allowed || eligibility.fatal) {
      skipped.push({ path: normalizeSlashes(delPath), reason: `delete_${eligibility.reason}`, fatal: Boolean(eligibility.fatal) });
      continue;
    }
    cleanedDeletes.push(normalizeSlashes(delPath));
  }

  if (cleanedDeletes.length > 0 && !config.ALLOW_DELETE_FILES) {
    throw new Error('Delete de arquivos bloqueado pela configuração.');
  }

  impl.files = cleanedFiles;
  impl.delete_files = cleanedDeletes;
  impl.notes = impl.notes || [];

  if (skipped.length) {
    impl.notes.unshift(`Skipped files: ${skipped.map((item) => `${item.path} [${item.reason}]`).join(', ')}`);
  }

  if (impl.files.length === 0 && (impl.delete_files || []).length === 0) {
    const empty = new Error(
      `Implementação sanitizada ficou vazia. Ignorados: ${skipped.map((item) => `${item.path} [${item.reason}]`).join(', ')}`
    ) as Error & { code?: string };

    empty.code = skipped.some((item) => item.reason.startsWith('blocked_'))
      ? 'NON_FATAL_INVALID_FILE_SELECTION'
      : 'EMPTY_IMPLEMENTATION';
    throw empty;
  }

  if (impl.files.length > config.MAX_FILES_PER_TASK + 8) {
    throw new Error('Implementação alterou arquivos demais.');
  }

  return { impl, skipped };
}

export function applyImplementation(impl: ImplementationPlan, options: { promptHash?: string } = {}): string[] {
  assertImplementationWriteScope(impl, { promptHash: options.promptHash });

  const touched: string[] = [];
  const dryRun = isDryRunMode();

  for (const file of impl.files) {
    const jsonValidation = validateJsonContent(file.path, file.content);
    if (!jsonValidation.ok) {
      throw new Error(`Conteúdo inválido para ${file.path}: ${jsonValidation.reason}`);
    }
    touched.push(normalizeSlashes(file.path));
    if (!dryRun) safeWrite(abs(file.path), file.content);
  }

  for (const delPath of impl.delete_files || []) {
    const full = abs(delPath);
    if (exists(full)) {
      touched.push(normalizeSlashes(delPath));
      if (!dryRun) fs.unlinkSync(full);
    }
  }

  const uniqueTouched = unique(touched);

  appendAuditLog({
    type: 'implementation.apply',
    promptHash: options.promptHash || null,
    filesTouched: uniqueTouched,
    commandsExecuted: [],
    policyVerdict: 'allow',
    dryRun
  });

  return uniqueTouched;
}

export function mergeImplementations(baseImpl: ImplementationPlan, nextImpl: ImplementationPlan): ImplementationPlan {
  const fileMap = new Map<string, { path: string; action: 'update' | 'create'; content: string }>();

  for (const file of [...(baseImpl.files || []), ...(nextImpl.files || [])]) {
    if (!file || !file.path) continue;
    fileMap.set(normalizeSlashes(file.path), {
      path: normalizeSlashes(file.path),
      action: (file.action || (exists(abs(file.path)) ? 'update' : 'create')) as 'update' | 'create',
      content: String(file.content || '')
    });
  }

  return {
    summary: sanitizeOneLine(nextImpl.summary || baseImpl.summary || 'implementation updated', 320),
    files: [...fileMap.values()],
    delete_files: unique([...(baseImpl.delete_files || []), ...(nextImpl.delete_files || [])].map(normalizeSlashes)),
    notes: unique([...(baseImpl.notes || []), ...(nextImpl.notes || [])])
  };
}
