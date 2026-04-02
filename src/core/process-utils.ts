import { spawnSync } from 'child_process';
import { CONFIG } from '../config';
import { assertCommandAllowed } from '../security/policy';
export interface ProcessRunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(command: string, options: { cwd?: string; promptHash?: string } = {}): ProcessRunResult {
  assertCommandAllowed(command, { cwd: options.cwd || CONFIG.REPO_PATH, promptHash: options.promptHash });

  const result = spawnSync(command, {
    cwd: options.cwd || CONFIG.REPO_PATH,
    shell: true,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 1024 * 1024 * 100
  });

  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}
