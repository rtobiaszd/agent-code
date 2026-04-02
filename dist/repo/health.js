"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectPackageManager = detectPackageManager;
exports.runScript = runScript;
exports.detectProjectCommands = detectProjectCommands;
exports.runCommands = runCommands;
exports.summarizeCommandFailures = summarizeCommandFailures;
exports.summarizeVerificationResults = summarizeVerificationResults;
exports.extractRelevantFilesFromErrors = extractRelevantFilesFromErrors;
exports.getMandatoryDiagnosticFiles = getMandatoryDiagnosticFiles;
exports.normalizeFailureSummary = normalizeFailureSummary;
exports.getRepoHealth = getRepoHealth;
exports.compareRepoHealth = compareRepoHealth;
const fs_utils_1 = require("../core/fs-utils");
const process_utils_1 = require("../core/process-utils");
const text_1 = require("../core/text");
const indexer_1 = require("./indexer");
function detectPackageManager(config) {
    if (config.NPM_CLIENT)
        return config.NPM_CLIENT;
    if ((0, fs_utils_1.exists)((0, fs_utils_1.abs)('pnpm-lock.yaml')))
        return 'pnpm';
    if ((0, fs_utils_1.exists)((0, fs_utils_1.abs)('yarn.lock')))
        return 'yarn';
    if ((0, fs_utils_1.exists)((0, fs_utils_1.abs)('package-lock.json')))
        return 'npm';
    return 'npm';
}
function runScript(config, scriptName) {
    const manager = detectPackageManager(config);
    if (manager === 'pnpm')
        return `pnpm ${scriptName}`;
    if (manager === 'yarn')
        return `yarn ${scriptName}`;
    return `npm run ${scriptName}`;
}
function detectProjectCommands(config) {
    const pkg = (0, indexer_1.readPackageJsonSafe)();
    const result = { verify: [], test: [] };
    if (!pkg)
        return result;
    const scripts = (pkg.scripts || {});
    if (scripts.lint)
        result.verify.push(runScript(config, 'lint'));
    if (scripts.typecheck)
        result.verify.push(runScript(config, 'typecheck'));
    if (scripts.build)
        result.verify.push(runScript(config, 'build'));
    if (scripts.test) {
        const manager = detectPackageManager(config);
        result.test.push(manager === 'yarn' ? 'yarn test' : manager === 'pnpm' ? 'pnpm test' : 'npm test');
    }
    if (scripts['test:unit'])
        result.test.push(runScript(config, 'test:unit'));
    if (scripts['test:integration'])
        result.test.push(runScript(config, 'test:integration'));
    return result;
}
function runCommands(config, commands, label, logger) {
    const outputs = [];
    for (const cmd of commands) {
        logger(`🧪 ${label}: ${cmd}`);
        const res = (0, process_utils_1.run)(cmd, { cwd: config.REPO_PATH });
        outputs.push({
            command: cmd,
            ok: res.ok,
            code: res.code,
            stdout: (0, text_1.truncate)(res.stdout, 30000),
            stderr: (0, text_1.truncate)(res.stderr, 30000)
        });
        if (!res.ok)
            break;
    }
    return outputs;
}
function summarizeCommandFailures(results) {
    const failed = results.find((result) => !result.ok);
    if (!failed)
        return '';
    return [
        `COMMAND: ${failed.command}`,
        'STDOUT:',
        failed.stdout || '(empty)',
        'STDERR:',
        failed.stderr || '(empty)'
    ].join('\n');
}
function summarizeVerificationResults(verifyResults, testResults) {
    return [summarizeCommandFailures(verifyResults), summarizeCommandFailures(testResults)]
        .filter(Boolean)
        .join('\n\n');
}
function extractRelevantFilesFromErrors(text) {
    const matches = text.match(/[A-Za-z0-9_./\\-]+\.(tsx|ts|jsx|js|json|css|scss|md|yml|yaml|mjs|cjs)/g) || [];
    return [...new Set(matches.map(fs_utils_1.normalizeSlashes))];
}
function getMandatoryDiagnosticFiles(summary) {
    const text = String(summary || '').toLowerCase();
    const files = [];
    if (text.includes('eslint')) {
        files.push('package.json', 'eslint.config.js', 'eslint.config.cjs', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs');
    }
    if (text.includes('typescript') || text.includes('typecheck')) {
        files.push('package.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.test.json');
    }
    if (text.includes('jest') || text.includes('vitest') || text.includes('test')) {
        files.push('package.json', 'jest.config.js', 'jest.config.cjs', 'jest.config.ts', 'vitest.config.ts');
    }
    if (text.includes('build')) {
        files.push('package.json');
    }
    return [...new Set(files)];
}
function normalizeFailureSummary(summary) {
    return String(summary || '')
        .replace(/\r/g, '')
        .replace(/[A-Z]:[\\/][^\n]+/g, '<abs_path>')
        .replace(/\/[^ \n]+/g, (match) => (match.includes('.') ? '<path>' : match))
        .replace(/\d+/g, '<n>')
        .trim();
}
function getRepoHealth(config, logger) {
    const commands = detectProjectCommands(config);
    const verifyResults = runCommands(config, commands.verify, 'verify', logger);
    const verifyOk = verifyResults.every((item) => item.ok);
    const testResults = verifyOk ? runCommands(config, commands.test, 'test', logger) : [];
    const testOk = testResults.every((item) => item.ok);
    const summary = summarizeVerificationResults(verifyResults, testResults);
    return {
        ok: verifyOk && testOk,
        commands,
        verifyResults,
        testResults,
        summary,
        signature: normalizeFailureSummary(summary)
    };
}
function compareRepoHealth(beforeHealth, afterHealth) {
    const beforeSignature = beforeHealth?.signature || '';
    const afterSignature = afterHealth?.signature || '';
    if (afterHealth.ok) {
        return {
            introducedNewErrors: false,
            improved: true,
            worsened: false,
            unchanged: Boolean(beforeSignature && beforeSignature === afterSignature)
        };
    }
    if (!beforeHealth || beforeHealth.ok) {
        return { introducedNewErrors: true, improved: false, worsened: true, unchanged: false };
    }
    if (beforeSignature === afterSignature) {
        return { introducedNewErrors: false, improved: false, worsened: false, unchanged: true };
    }
    const beforeSize = String(beforeHealth.summary || '').length;
    const afterSize = String(afterHealth.summary || '').length;
    if (afterSize < beforeSize) {
        return { introducedNewErrors: false, improved: true, worsened: false, unchanged: false };
    }
    return { introducedNewErrors: true, improved: false, worsened: true, unchanged: false };
}
