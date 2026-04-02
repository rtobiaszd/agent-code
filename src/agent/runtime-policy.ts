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

export interface RuntimePolicyOptions {
  maxIterations?: number;
  maxRuntimeMs?: number;
  loopDelayMs?: number;
}

export function createRuntimeLoopContext(): RuntimeLoopContext {
  return {
    startedAtMs: Date.now(),
    iteration: 0,
    consecutiveFailures: 0
  };
}

export function evaluateRuntimePolicy(context: RuntimeLoopContext, options: RuntimePolicyOptions = {}): RuntimeDecision {
  const maxIterations = Number(options.maxIterations ?? CONFIG.MAX_ITERATIONS);
  const maxRuntimeMs = Number(options.maxRuntimeMs ?? CONFIG.MAX_RUNTIME_MS);

  if (context.iteration >= maxIterations) {
    return {
      shouldContinue: false,
      reason: `max_iterations_reached:${maxIterations}`
    };
  }

  const elapsedMs = Date.now() - context.startedAtMs;
  if (elapsedMs >= maxRuntimeMs) {
    return {
      shouldContinue: false,
      reason: `max_runtime_reached:${maxRuntimeMs}ms`
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

export async function delayBetweenCycles(loopDelayMs: number = CONFIG.LOOP_DELAY_MS): Promise<void> {
  if (loopDelayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, loopDelayMs);
  });
}
