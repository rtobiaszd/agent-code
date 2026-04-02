import { CONFIG } from '../config';
import { detectProjectCommands, runCommands, summarizeVerificationResults } from '../repo/health';
import type { MemoryState, VerificationMode, VerificationRun } from '../types';

export function runVerification(
  memory: MemoryState,
  input: { mode?: VerificationMode; logger: (...args: unknown[]) => void }
): VerificationRun {
  const mode = input.mode || 'fast';
  const commands = detectProjectCommands(CONFIG);
  const verifyResults = runCommands(CONFIG, commands.verify, 'verify', input.logger);
  const verifyOk = verifyResults.every((item) => item.ok);

  let testResults = [] as VerificationRun['testResults'];
  let testOk = true;

  if (verifyOk && mode === 'full') {
    testResults = runCommands(CONFIG, commands.test, 'test', input.logger);
    testOk = testResults.every((item) => item.ok);
  }

  if (verifyOk) memory.metrics.verifyPass += 1;
  else memory.metrics.verifyFail += 1;

  if (mode === 'full') {
    if (testOk) memory.metrics.testPass += 1;
    else memory.metrics.testFail += 1;
  }

  return {
    ok: verifyOk && testOk,
    mode,
    commands,
    verifyResults,
    testResults,
    summary: summarizeVerificationResults(verifyResults, testResults)
  };
}
