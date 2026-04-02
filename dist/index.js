"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const orchestrator_1 = require("./agent/orchestrator");
(0, orchestrator_1.runAgent)().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
});
