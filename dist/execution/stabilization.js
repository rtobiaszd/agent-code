"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRepoStabilizationTask = createRepoStabilizationTask;
const config_1 = require("../config");
const text_1 = require("../core/text");
const health_1 = require("../repo/health");
function createRepoStabilizationTask(repoHealth) {
    const files = (0, text_1.unique)([
        ...(0, health_1.extractRelevantFilesFromErrors)(repoHealth.summary || ''),
        ...(0, health_1.getMandatoryDiagnosticFiles)(repoHealth.summary || '')
    ]);
    return {
        id: `stabilize-${Date.now()}`,
        title: 'Stabilize repository tooling and compilation',
        category: 'bugfix',
        priority: 'high',
        kind: 'stabilization',
        goal: 'Fix current lint, typecheck, build, dependency, or test failures before any product evolution',
        why: (0, text_1.sanitizeOneLine)(repoHealth.summary || 'repository health check failed', 240),
        files: files.slice(0, config_1.CONFIG.MAX_FILES_PER_TASK),
        new_files_allowed: true,
        commit_message: 'fix: stabilize repository tooling and compilation'
    };
}
