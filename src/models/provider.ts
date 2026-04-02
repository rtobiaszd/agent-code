import { CONFIG } from '../config';

export interface ProviderRequestMetric {
  requests: number;
  errors: number;
  averageLatencyMs: number;
  lastLatencyMs: number;
  averageResponseSize: number;
  lastResponseSize: number;
}

export interface ProviderMetricsSnapshot {
  provider: string;
  byModel: Record<string, ProviderRequestMetric>;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
}

export interface GenerateTextInput {
  model: string;
  prompt: string;
  timeoutMs?: number;
}

export interface GenerateJsonInput<T> extends GenerateTextInput {
  label: string;
  validator?: ((value: unknown) => value is T) | ((value: unknown) => boolean);
}

export interface ModelProvider {
  readonly name: string;
  generateText(input: GenerateTextInput): Promise<string>;
  generateJson<T>(input: GenerateJsonInput<T>): Promise<T>;
  healthCheck(): Promise<boolean>;
  getMetrics(): ProviderMetricsSnapshot;
}

export async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  input?: {
    retries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  }
): Promise<T> {
  const retries = Number(input?.retries ?? CONFIG.MODEL_RETRY_ATTEMPTS);
  const initialDelayMs = Number(input?.initialDelayMs ?? CONFIG.MODEL_RETRY_BACKOFF_MS);
  const maxDelayMs = Number(input?.maxDelayMs ?? CONFIG.MODEL_RETRY_MAX_BACKOFF_MS);

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;

      const waitMs = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'unknown model provider error'));
}

export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return operation();

  return await Promise.race<T>([
    operation(),
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout em ${label} após ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}
