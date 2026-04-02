import { CONFIG } from '../config';
import { backupFiles, normalizeSlashes, restoreBackup } from '../core/fs-utils';
import { rollbackHard } from '../core/git';
import { debug, log } from '../core/logger';
import { errorProgressScore, stableTextSignature, unique } from '../core/text';
import { getModelProvider } from '../models';
import type { ModelProvider } from '../models/provider';
import { buildSelfHealPrompt } from '../planning/prompts';
import { compareRepoHealth } from '../repo/health';
import { collectFileContents } from '../repo/indexer';
import { applyImplementation, containsDangerousContent, isValidImplementation, mergeImplementations, sanitizeImplementation } from './implementation';
import { runVerification } from './verification';
import type { AgentTask, Blueprint, ImplementationPlan, MemoryState, RepoHealth } from '../types';

export async function selfHeal(input: {
  blueprint: Blueprint;
  task: AgentTask;
  implementation: ImplementationPlan;
  memory: MemoryState;
  baselineHealth: RepoHealth;
  provider?: ModelProvider;
}): Promise<{ ok: boolean; implementation: ImplementationPlan; progress?: boolean; lastFailedSummary: string }> {
  const { blueprint, task, memory, baselineHealth, provider = getModelProvider() } = input;
  let currentImpl = input.implementation;
  let previousSummary = baselineHealth.summary || '';
  let previousSignature = stableTextSignature(previousSummary);

  for (let attempt = 1; attempt <= CONFIG.MAX_SELF_HEAL_ATTEMPTS; attempt += 1) {
    const currentFiles = collectFileContents(
      unique([...(task.files || []), ...(currentImpl.files || []).map((item) => item.path)]).slice(0, CONFIG.MAX_CONTEXT_FILES)
    );

    const prompt = buildSelfHealPrompt({
      blueprint,
      task,
      implementation: currentImpl,
      failedSummary: previousSummary,
      currentFiles,
      commands: baselineHealth.commands || {}
    });

    let fixedImpl: ImplementationPlan;
    try {
      try {
        fixedImpl = await provider.generateJson<ImplementationPlan>({
          model: CONFIG.MODEL_FIXER,
          prompt,
          label: 'self-heal',
          validator: isValidImplementation
        });
      } catch {
        fixedImpl = await provider.generateJson<ImplementationPlan>({
          model: CONFIG.MODEL_FIXER_FALLBACK || CONFIG.MODEL_FIXER,
          prompt,
          label: 'self-heal:fallback',
          validator: isValidImplementation
        });
      }
    } catch (error) {
      debug('self-heal parse error:', error instanceof Error ? error.message : String(error));
      continue;
    }

    try {
      fixedImpl = sanitizeImplementation(fixedImpl, task).impl;
    } catch (error) {
      debug('self-heal sanitize error:', error instanceof Error ? error.message : String(error));
      continue;
    }

    if (containsDangerousContent(fixedImpl)) continue;

    const touchedPaths = unique([
      ...fixedImpl.files.map((item) => normalizeSlashes(item.path)),
      ...(fixedImpl.delete_files || []).map((item) => normalizeSlashes(item))
    ]);

    const backups = backupFiles(touchedPaths);

    try {
      applyImplementation(fixedImpl);
      const checks = runVerification(memory, { mode: 'fast', logger: log });
      const nextSummary = checks.summary || previousSummary;
      const nextSignature = stableTextSignature(nextSummary);
      const progress = errorProgressScore(nextSummary) < errorProgressScore(previousSummary) || nextSignature !== previousSignature;

      if (checks.ok) {
        memory.metrics.selfHealSuccess += 1;
        return {
          ok: true,
          implementation: mergeImplementations(currentImpl, fixedImpl),
          progress: true,
          lastFailedSummary: previousSummary
        };
      }

      const afterHealth = { ok: checks.ok, summary: checks.summary, signature: nextSignature };
      const comparison = compareRepoHealth(baselineHealth, afterHealth);

      currentImpl = mergeImplementations(currentImpl, fixedImpl);
      previousSummary = nextSummary;
      previousSignature = nextSignature;

      if (progress || comparison.improved) {
        log(`⚠️ self-heal attempt ${attempt} improved the failure surface; continuing`);
        continue;
      }

      restoreBackup(backups);
      rollbackHard();
    } catch (error) {
      debug('self-heal apply error:', error instanceof Error ? error.message : String(error));
      restoreBackup(backups);
      rollbackHard();
    }
  }

  memory.metrics.selfHealFail += 1;
  return { ok: false, implementation: currentImpl, lastFailedSummary: previousSummary };
}
