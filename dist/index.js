"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cli_1 = require("./cli");
(0, cli_1.runCli)(process.argv).catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
});
