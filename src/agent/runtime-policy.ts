import { CONFIG } from '../config';
import type { MemoryState, RuntimeCycleMetric } from '../types';

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CYCLE_METRICS = 300;

export interface RuntimeLoopContext {
  startedAtMs: number;
  iteration: number;
  consecutiveFailures: number;
}

export interface RuntimeDecision {
  shouldContinue: boolean;
  reason?: string;
}

export function createRuntimeLoopContext(): RuntimeLoopContext {
  return {
    startedAtMs: Date.now(),
    iteration: 0,
    consecutiveFailures: 0
  };
}

export function evaluateRuntimePolicy(context: RuntimeLoopContext): RuntimeDecision {
  if (context.iteration >= CONFIG.MAX_ITERATIONS) {
    return {
      shouldContinue: false,
      reason: `max_iterations_reached:${CONFIG.MAX_ITERATIONS}`
    };
  }

  const elapsedMs = Date.now() - context.startedAtMs;
  if (elapsedMs >= CONFIG.MAX_RUNTIME_MS) {
    return {
      shouldContinue: false,
      reason: `max_runtime_reached:${CONFIG.MAX_RUNTIME_MS}ms`
    };
  }

  if (context.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      shouldContinue: false,
      reason: `consecutive_cycle_failures:${context.consecutiveFailures}`
    };
  }

  return { shouldContinue: true };
}

export function registerCycleMetric(memory: MemoryState, metric: RuntimeCycleMetric): void {
  memory.runtime.cycleMetrics.unshift(metric);
  memory.runtime.cycleMetrics = memory.runtime.cycleMetrics.slice(0, MAX_CYCLE_METRICS);
  memory.runtime.lastLoopResult = metric.result;

  if (metric.result === 'failure') {
    memory.runtime.consecutiveCycleFailures += 1;
  } else {
    memory.runtime.consecutiveCycleFailures = 0;
  }
}

export async function delayBetweenCycles(): Promise<void> {
  if (CONFIG.LOOP_DELAY_MS <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, CONFIG.LOOP_DELAY_MS);
  });
}
