import { CONFIG } from '../config';
import { log } from '../core/logger';
import { sanitizeOneLine, stableTaskSignature, stableTextSignature } from '../core/text';
import { extractRelevantFilesFromErrors } from '../repo/health';
import {
  clearTaskFailureBursts,
  countTaskFailures,
  getTaskReplanCount,
  incrementTaskReplan,
  registerIdenticalFailure,
  rememberFailure,
  rememberFileFailures,
  saveMemory
} from '../state/memory';
import type { AgentTask, FailureClassification, FailureDecision, ImplementationPlan, MemoryState } from '../types';

export function collectFailureFiles(task: AgentTask, reason: string, implementation: ImplementationPlan | null): string[] {
  return [
    ...new Set([
      ...(Array.isArray(task.files) ? task.files : []),
      ...extractRelevantFilesFromErrors(reason || ''),
      ...((implementation?.files || []).map((item) => item.path))
    ])
  ].filter(Boolean);
}

export function classifyFailure(reason: string): FailureClassification {
  const low = String(reason || '').toLowerCase();

  if (
    low.includes('invalid_json') ||
    low.includes('json_comment_not_allowed') ||
    low.includes('implementação sanitizada ficou vazia') ||
    low.includes('blocked_extension') ||
    low.includes('blocked_name:') ||
    low.includes('arquivo protegido') ||
    low.includes('non_fatal_invalid_file_selection') ||
    low.includes('empty_implementation') ||
    low.includes('policy_denied') ||
    low.includes('policy_denied_command') ||
    low.includes('policy_denied_pattern') ||
    low.includes('policy_denied_write_scope')
  ) {
    return 'replanable';
  }

  if (
    low.includes('lint') ||
    low.includes('eslint') ||
    low.includes('typecheck') ||
    low.includes('typescript') ||
    low.includes('build') ||
    low.includes('test')
  ) {
    return 'healable';
  }

  if (low.includes('repository health check failed') || low.includes('stabilize repository')) {
    return 'stabilization';
  }

  if (low.includes('fatal_protected_file')) return 'fatal';
  return 'unknown';
}

export function registerFailureAndDecide(
  memory: MemoryState,
  task: AgentTask,
  reason: string,
  implementation: ImplementationPlan | null
): FailureDecision {
  const classification = classifyFailure(reason);

  memory.failed.unshift({
    at: new Date().toISOString(),
    title: task.title,
    category: String(task.category),
    reason: sanitizeOneLine(reason, 400),
    signature: stableTaskSignature(task),
    error_signature: stableTextSignature(reason),
    classification
  });
  memory.failed = memory.failed.slice(0, 300);
  memory.metrics.lastErrorAt = new Date().toISOString();

  rememberFailure(memory, task, reason);
  rememberFileFailures(memory, collectFailureFiles(task, reason, implementation), reason);

  const identical = registerIdenticalFailure(memory, task, reason);
  const taskFailures = countTaskFailures(memory, task);
  const replans = getTaskReplanCount(memory, task);

  let action: FailureDecision['action'] = 'retry';

  if (classification === 'replanable') {
    if (replans < CONFIG.MAX_REPLAN_PER_TASK) {
      incrementTaskReplan(memory, task);
      memory.metrics.replans += 1;
      action = 'replan';
    } else if (identical.count >= CONFIG.MAX_IDENTICAL_ERROR_RETRIES) {
      action = 'drop';
    }
  } else if (classification === 'healable') {
    if (taskFailures >= CONFIG.MAX_REPEAT_FAILURES_PER_TASK && identical.count >= CONFIG.MAX_IDENTICAL_ERROR_RETRIES) {
      action = 'drop';
    }
  } else if (classification === 'fatal') {
    action = 'drop';
  } else {
    if (taskFailures >= CONFIG.MAX_REPEAT_FAILURES_PER_TASK) {
      action = 'drop';
    }
  }

  if (action === 'drop') {
    clearTaskFailureBursts(memory, task);
    log('⛔ dropping task after exhausted retries');
  } else if (action === 'replan') {
    log('🔁 task will be replanned instead of dropped');
  } else {
    log('🔁 keeping task for retry/self-heal');
  }

  saveMemory(memory);
  return { action, classification, identicalCount: identical.count, taskFailures };
}
