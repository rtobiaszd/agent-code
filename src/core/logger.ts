import { CONFIG } from '../config';

function stamp(): string {
  return new Date().toISOString();
}

export function log(...args: unknown[]): void {
  console.log(stamp(), '-', ...args);
}

export function debug(...args: unknown[]): void {
  if (CONFIG.DEBUG) {
    console.log(stamp(), '-', '[DEBUG]', ...args);
  }
}
