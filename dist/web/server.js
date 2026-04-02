"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWebServer = startWebServer;
const http_1 = __importDefault(require("http"));
const config_1 = require("../config");
const orchestrator_1 = require("../agent/orchestrator");
const memory_1 = require("../state/memory");
function createGoalTask(goal) {
    const compact = goal.replace(/\s+/g, ' ').trim();
    const title = compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
    return {
        id: `web-goal-${Date.now().toString(36)}`,
        title: `Web Goal: ${title}`,
        category: 'product',
        priority: 'high',
        goal: compact,
        why: 'Objetivo criado pela interface web.',
        files: [],
        depends_on: [],
        acceptance_criteria: ['Executar objetivo via ciclo web sem quebrar verificações existentes.'],
        estimated_size: 'm',
        risk_level: 'medium',
        status: 'ready',
        new_files_allowed: true,
        commit_message: `feat: ${title.slice(0, 60)}`,
        owner_agent: 'builder'
    };
}
function injectGoal(memory, goal) {
    const task = createGoalTask(goal);
    memory.backlog = [task, ...(memory.backlog || [])];
    (0, memory_1.pushHistory)(memory, { type: 'web_goal_injected', taskId: task.id, goal });
}
function getBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}
function renderHtml() {
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Web Console</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin: 16px 0; }
    button { cursor: pointer; padding: 8px 12px; }
    textarea { width: 100%; min-height: 90px; }
    pre { background: #111; color: #f1f1f1; border-radius: 8px; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
  <h1>Agent Console (Browser)</h1>
  <p>Controle o agente sem CLI.</p>

  <div class="card">
    <h3>Novo objetivo</h3>
    <textarea id="goal" placeholder="Descreva o objetivo..."></textarea>
    <p>
      <button onclick="injectGoal()">Adicionar no backlog</button>
      <button onclick="runOneCycle()">Rodar 1 ciclo</button>
      <button onclick="loadStatus()">Atualizar status</button>
    </p>
  </div>

  <div class="card">
    <h3>Status</h3>
    <pre id="status">carregando...</pre>
  </div>

  <script>
    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('status').textContent = JSON.stringify(data, null, 2);
    }
    async function injectGoal() {
      const goal = document.getElementById('goal').value.trim();
      if (!goal) return alert('Informe um objetivo.');
      const res = await fetch('/api/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal })
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Falha');
      await loadStatus();
    }
    async function runOneCycle() {
      const res = await fetch('/api/apply', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Falha');
      await loadStatus();
    }
    loadStatus();
  </script>
</body>
</html>`;
}
function startWebServer() {
    let running = false;
    const server = http_1.default.createServer(async (req, res) => {
        const method = req.method || 'GET';
        const url = req.url || '/';
        if (method === 'GET' && url === '/') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(renderHtml());
            return;
        }
        if (method === 'GET' && url === '/api/status') {
            const memory = (0, memory_1.loadMemory)();
            sendJson(res, 200, {
                backlogCount: memory.backlog.length,
                backlogPreview: memory.backlog.slice(0, 5).map((task) => ({
                    id: task.id,
                    title: task.title,
                    priority: task.priority,
                    owner_agent: task.owner_agent || 'builder'
                })),
                metrics: memory.metrics,
                runtime: memory.runtime
            });
            return;
        }
        if (method === 'POST' && url === '/api/goal') {
            try {
                const raw = await getBody(req);
                const parsed = raw ? JSON.parse(raw) : {};
                const goal = String(parsed.goal || '').trim();
                if (!goal || goal.length < 5) {
                    sendJson(res, 400, { ok: false, error: 'Objetivo inválido. Use no mínimo 5 caracteres.' });
                    return;
                }
                const memory = (0, memory_1.loadMemory)();
                injectGoal(memory, goal);
                (0, memory_1.saveMemory)(memory);
                sendJson(res, 200, { ok: true });
            }
            catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (method === 'POST' && url === '/api/apply') {
            if (running) {
                sendJson(res, 409, { ok: false, error: 'Agente já está executando um ciclo.' });
                return;
            }
            running = true;
            try {
                await (0, orchestrator_1.runAgent)({ maxCycles: 1 });
                sendJson(res, 200, { ok: true });
            }
            catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            finally {
                running = false;
            }
            return;
        }
        sendJson(res, 404, { ok: false, error: 'Rota não encontrada.' });
    });
    server.listen(config_1.CONFIG.WEB_PORT, () => {
        console.log(`🌐 Agent web UI em http://localhost:${config_1.CONFIG.WEB_PORT}`);
    });
    return server;
}
