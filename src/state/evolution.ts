import { CONFIG } from '../config';
import { abs, rel, safeRead, safeWrite } from '../core/fs-utils';
import { listToBullets, sanitizeOneLine, unique } from '../core/text';
import { rememberNextOpportunities } from './memory';
import type { AgentTask, ImplementationPlan, MemoryState, ReviewResult } from '../types';

export function deriveNextOpportunities(input: {
  task: AgentTask;
  implementation: ImplementationPlan;
  review: ReviewResult;
}): string[] {
  const { task, implementation, review } = input;
  const touchedFiles = unique((implementation.files || []).map((item) => item.path)).slice(0, 6);
  const opportunities: string[] = [];

  if (task.category !== 'tests' && touchedFiles.length) {
    opportunities.push(`Add or expand automated tests for: ${touchedFiles.join(', ')}`);
  }
  if (task.category !== 'dx' && touchedFiles.length) {
    opportunities.push(`Improve developer experience around changed modules: ${touchedFiles.join(', ')}`);
  }
  if ((review.warnings || []).length) {
    opportunities.push(`Resolve remaining reviewer warnings related to ${sanitizeOneLine(task.title, 120)}`);
  }

  opportunities.push(`Monitor regressions after ${sanitizeOneLine(task.title, 120)} and harden validation where needed`);
  return unique(opportunities).slice(0, 4);
}

function buildEvolutionEntry(input: {
  task: AgentTask;
  implementation: ImplementationPlan;
  review: ReviewResult;
  commitMessage: string;
  nextOpportunities: string[];
}): string {
  const { task, implementation, review, commitMessage, nextOpportunities } = input;
  const touchedFiles = implementation.files?.map((file) => file.path) || [];
  const deletedFiles = implementation.delete_files || [];
  const notes = implementation.notes || [];
  const warnings = review.warnings || [];

  return [
    `### ${new Date().toISOString()} | ${sanitizeOneLine(task.title, 160)}`,
    `- category: ${sanitizeOneLine(task.category, 40)}`,
    `- priority: ${sanitizeOneLine(task.priority, 20)}`,
    `- goal: ${sanitizeOneLine(task.goal, 300)}`,
    `- commit: ${sanitizeOneLine(commitMessage || task.commit_message || '', 220)}`,
    `- files changed: ${touchedFiles.length ? touchedFiles.join(', ') : 'none'}`,
    deletedFiles.length ? `- files deleted: ${deletedFiles.join(', ')}` : '- files deleted: none',
    `- implementation summary: ${sanitizeOneLine(implementation.summary || 'completed successfully', 320)}`,
    `- review reason: ${sanitizeOneLine(review.reason || 'approved', 220)}`,
    `- notes:\n${listToBullets(notes)}`,
    `- warnings:\n${listToBullets(warnings)}`,
    `- next opportunities:\n${listToBullets(nextOpportunities)}`
  ].join('\n');
}

function trimEvolutionEntries(entries: string[]): string[] {
  return entries.slice(0, CONFIG.MAX_EVOLUTION_ENTRIES);
}

function upsertEvolutionSection(originalContent: string, entry: string): string {
  const marker = CONFIG.EVOLUTION_SECTION_TITLE;
  const text = String(originalContent || '').trimEnd();

  if (!text.includes(marker)) {
    return `${text}\n\n${marker}\n\n${entry}\n`;
  }

  const idx = text.indexOf(marker);
  const before = text.slice(0, idx + marker.length).trimEnd();
  const after = text.slice(idx + marker.length).trim();
  const blocks = after ? after.split(/\n(?=###\s)/g).map((chunk) => chunk.trim()).filter(Boolean) : [];
  const updated = trimEvolutionEntries([entry, ...blocks]).join('\n\n');
  return `${before}\n\n${updated}\n`;
}

export function updateMainEvolutionDoc(input: {
  task: AgentTask;
  implementation: ImplementationPlan;
  review: ReviewResult;
  commitMessage: string;
  memory: MemoryState;
}): { path: string; nextOpportunities: string[] } {
  const { task, implementation, review, commitMessage, memory } = input;
  const target = abs(CONFIG.MAIN_EVOLUTION_DOC);
  const previous = safeRead(target, '');
  const nextOpportunities = deriveNextOpportunities({ task, implementation, review });
  const entry = buildEvolutionEntry({ task, implementation, review, commitMessage, nextOpportunities });
  const next = upsertEvolutionSection(previous, entry);
  safeWrite(target, next);

  rememberNextOpportunities(memory, nextOpportunities);
  memory.metrics.blueprintUpdates += 1;

  return { path: rel(target), nextOpportunities };
}
