import axios from 'axios';
import { CONFIG } from '../config';
import { parseJsonSafe, truncate } from '../core/text';
import { log } from '../core/logger';
import {
  type GenerateJsonInput,
  type GenerateTextInput,
  type ModelProvider,
  type ProviderMetricsSnapshot,
  withExponentialBackoff,
  withTimeout
} from './provider';

type LocalModelMetric = {
  requests: number;
  errors: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  totalResponseSize: number;
  lastResponseSize: number;
};

export class OllamaProvider implements ModelProvider {
  readonly name = 'OLLAMA';
  private readonly metrics: Record<string, LocalModelMetric> = {};

  private registerMetric(model: string, input: { ok: boolean; latencyMs: number; responseSize: number }): void {
    const current = this.metrics[model] || {
      requests: 0,
      errors: 0,
      totalLatencyMs: 0,
      lastLatencyMs: 0,
      totalResponseSize: 0,
      lastResponseSize: 0
    };
    current.requests += 1;
    if (!input.ok) current.errors += 1;
    current.totalLatencyMs += input.latencyMs;
    current.lastLatencyMs = input.latencyMs;
    current.totalResponseSize += input.responseSize;
    current.lastResponseSize = input.responseSize;
    this.metrics[model] = current;
  }

  async generateText(input: GenerateTextInput): Promise<string> {
    const timeoutMs = Number(input.timeoutMs ?? CONFIG.MODEL_TIMEOUT_MS);
    const startedAt = Date.now();
    let responseText = '';

    try {
      responseText = await withTimeout(
        async () => {
          const response = await axios.post(
            CONFIG.OLLAMA_URL,
            { model: input.model, prompt: input.prompt, stream: false },
            { timeout: timeoutMs }
          );
          return String(response.data?.response || '');
        },
        timeoutMs,
        `${this.name}:${input.model}`
      );

      this.registerMetric(input.model, { ok: true, latencyMs: Date.now() - startedAt, responseSize: responseText.length });
      return responseText;
    } catch (error) {
      this.registerMetric(input.model, { ok: false, latencyMs: Date.now() - startedAt, responseSize: responseText.length });
      throw error;
    }
  }

  async repairJsonWithModel<T = unknown>(model: string, raw: string, label: string): Promise<T | null> {
    const prompt = [
      'You are a JSON repair engine.',
      '',
      'TASK:',
      'Repair the following broken JSON so it becomes directly parsable by JSON.parse.',
      '',
      'RULES:',
      '- Return ONLY valid JSON',
      '- No markdown',
      '- No explanation',
      '- Keep the original structure and intent',
      '- Escape all strings correctly',
      '- Preserve file contents exactly as much as possible',
      '',
      'BROKEN INPUT:',
      truncate(raw, 40000)
    ].join('\n');

    const repairedRaw = await this.generateText({ model, prompt });
    const parsed = parseJsonSafe<T>(repairedRaw);

    if (parsed) {
      log(`🧩 JSON repaired for ${label}`);
      return parsed;
    }

    return null;
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return await withExponentialBackoff<T>(
      async () => {
        const raw = await this.generateText({ model: input.model, prompt: input.prompt, timeoutMs: input.timeoutMs });
        let parsed = parseJsonSafe<T>(raw);

        if (!parsed && CONFIG.MAX_JSON_REPAIR_ATTEMPTS > 0) {
          parsed = await this.repairJsonWithModel<T>(CONFIG.MODEL_JSON_REPAIR, raw, input.label);
        }

        if (!parsed) {
          throw new Error(`Falha ao parsear JSON para ${input.label}`);
        }

        if (input.validator && !input.validator(parsed)) {
          throw new Error(`JSON inválido para ${input.label}`);
        }

        return parsed;
      },
      { retries: CONFIG.MODEL_RETRY_ATTEMPTS, initialDelayMs: CONFIG.MODEL_RETRY_BACKOFF_MS, maxDelayMs: CONFIG.MODEL_RETRY_MAX_BACKOFF_MS }
    );
  }

  async healthCheck(): Promise<boolean> {
    try {
      await axios.get(CONFIG.OLLAMA_URL.replace('/api/generate', '/api/tags'), { timeout: Math.min(CONFIG.MODEL_TIMEOUT_MS, 5000) });
      return true;
    } catch {
      return false;
    }
  }

  getMetrics(): ProviderMetricsSnapshot {
    const byModel = Object.fromEntries(
      Object.entries(this.metrics).map(([model, metric]) => [
        model,
        {
          requests: metric.requests,
          errors: metric.errors,
          averageLatencyMs: metric.requests > 0 ? Math.round(metric.totalLatencyMs / metric.requests) : 0,
          lastLatencyMs: metric.lastLatencyMs,
          averageResponseSize: metric.requests > 0 ? Math.round(metric.totalResponseSize / metric.requests) : 0,
          lastResponseSize: metric.lastResponseSize
        }
      ])
    );
    const totals = Object.values(this.metrics).reduce(
      (acc, metric) => {
        acc.requests += metric.requests;
        acc.errors += metric.errors;
        return acc;
      },
      { requests: 0, errors: 0 }
    );

    return {
      provider: this.name,
      byModel,
      totalRequests: totals.requests,
      totalErrors: totals.errors,
      errorRate: totals.requests > 0 ? totals.errors / totals.requests : 0
    };
  }
}

const legacyOllamaProvider = new OllamaProvider();

export async function askModel(model: string, prompt: string): Promise<string> {
  return legacyOllamaProvider.generateText({ model, prompt });
}

export async function askAndParseJson<T>(
  model: string,
  prompt: string,
  label: string,
  validator?: ((value: unknown) => value is T) | ((value: unknown) => boolean)
): Promise<T> {
  return legacyOllamaProvider.generateJson<T>({ model, prompt, label, validator });
}

export async function repairJsonWithModel<T = unknown>(model: string, raw: string, label: string): Promise<T | null> {
  return legacyOllamaProvider.repairJsonWithModel<T>(model, raw, label);
}
