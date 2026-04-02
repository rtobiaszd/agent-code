import { CONFIG } from '../config';
import { log } from '../core/logger';
import { OllamaProvider } from './ollama';
import type { ModelProvider } from './provider';

let providerSingleton: ModelProvider | null = null;

export function createModelProvider(providerName: string = CONFIG.MODEL_PROVIDER): ModelProvider {
  switch (String(providerName || '').toUpperCase()) {
    case 'OLLAMA':
      return new OllamaProvider();
    case 'OPENAI':
      throw new Error('Provider OPENAI ainda não implementado.');
    default:
      throw new Error(`Provider não suportado: ${providerName}`);
  }
}

export function getModelProvider(): ModelProvider {
  if (!providerSingleton) {
    providerSingleton = createModelProvider(CONFIG.MODEL_PROVIDER);
    log(`🤖 model provider: ${providerSingleton.name}`);
  }
  return providerSingleton;
}
