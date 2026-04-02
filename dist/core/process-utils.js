"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const child_process_1 = require("child_process");
const config_1 = require("../config");
function run(command, options = {}) {
    const result = (0, child_process_1.spawnSync)(command, {
        cwd: options.cwd || config_1.CONFIG.REPO_PATH,
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
