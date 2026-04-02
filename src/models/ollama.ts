import axios from 'axios';
import { CONFIG } from '../config';
import { parseJsonSafe, truncate } from '../core/text';
import { log } from '../core/logger';

export async function askModel(model: string, prompt: string): Promise<string> {
  const response = await axios.post(
    CONFIG.OLLAMA_URL,
    { model, prompt, stream: false },
    { timeout: 1000 * 60 * 10 }
  );

  return response.data?.response || '';
}

export async function repairJsonWithModel<T = unknown>(model: string, raw: string, label: string): Promise<T | null> {
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

  const repairedRaw = await askModel(model, prompt);
  const parsed = parseJsonSafe<T>(repairedRaw);

  if (parsed) {
    log(`🧩 JSON repaired for ${label}`);
    return parsed;
  }

  return null;
}

export async function askAndParseJson<T>(
  model: string,
  prompt: string,
  label: string,
  validator?: ((value: unknown) => value is T) | ((value: unknown) => boolean)
): Promise<T> {
  const raw = await askModel(model, prompt);
  let parsed = parseJsonSafe<T>(raw);

  if (!parsed && CONFIG.MAX_JSON_REPAIR_ATTEMPTS > 0) {
    parsed = await repairJsonWithModel<T>(CONFIG.MODEL_JSON_REPAIR, raw, label);
  }

  if (!parsed) {
    throw new Error(`Falha ao parsear JSON para ${label}`);
  }

  if (validator && !validator(parsed)) {
    throw new Error(`JSON inválido para ${label}`);
  }

  return parsed;
}
