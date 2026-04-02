import crypto from 'crypto';
import type { AgentTask } from '../types';

export function sha1(value: unknown): string {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex');
}

export function unique<T>(arr: Array<T | null | undefined>): T[] {
  return [...new Set(arr.filter(Boolean) as T[])];
}

export function stripCodeFence(text: unknown): string {
  return String(text ?? '')
    .replace(/^```(?:json|javascript|js|txt)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function sanitizeOneLine(text: unknown, max = 220): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function truncate(text: unknown, max = 20000): string {
  const content = String(text ?? '');
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n/* ...TRUNCATED... */`;
}

export function stableTextSignature(text: unknown): string {
  return sha1(String(text ?? '').trim().toLowerCase());
}

export function stableTaskSignature(task?: Partial<AgentTask> | null): string {
  const payload = {
    title: String(task?.title ?? ''),
    category: String(task?.category ?? ''),
    goal: String(task?.goal ?? ''),
    files: Array.isArray(task?.files) ? [...task.files].sort() : []
  };
  return sha1(JSON.stringify(payload));
}

export function listToBullets(items: Array<string | null | undefined>, fallback = '- none'): string {
  const cleaned = unique(items.map((item) => sanitizeOneLine(item, 260)).filter(Boolean));
  if (!cleaned.length) return fallback;
  return cleaned.map((item) => `- ${item}`).join('\n');
}

export function sanitizeModelOutput(raw: unknown): string {
  let cleaned = stripCodeFence(raw).trim();
  cleaned = cleaned.replace(/^\uFEFF/, '');
  cleaned = cleaned.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  return cleaned;
}

export function parseJsonSafe<T = unknown>(raw: unknown): T | null {
  if (!raw) return null;

  try {
    let cleaned = sanitizeModelOutput(raw)
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // noop
    }

    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;

    let candidate = match[0];
    candidate = candidate.replace(/,\s*([}\]])/g, '$1');
    candidate = candidate.replace(/:\s*`([\s\S]*?)`(?=\s*[,}])/g, (_full, content: string) => {
      return ': ' + JSON.stringify(content);
    });

    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

export function errorProgressScore(summary: unknown): number {
  const text = String(summary ?? '').toLowerCase();
  let score = 0;
  if (text.includes('error')) score += 10;
  if (text.includes('typescript')) score += 8;
  if (text.includes('typecheck')) score += 8;
  if (text.includes('eslint')) score += 6;
  if (text.includes('lint')) score += 6;
  if (text.includes('build')) score += 5;
  if (text.includes('test')) score += 4;
  return score + text.length / 1000;
}
