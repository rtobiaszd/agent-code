"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startWebServer = startWebServer;
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const orchestrator_1 = require("../agent/orchestrator");
const memory_1 = require("../state/memory");
const WEB_SETTINGS_FILE = path_1.default.join(config_1.CONFIG.REPO_PATH, '.agent-web-settings.json');
function loadWebSettings() {
    try {
        if (!fs_1.default.existsSync(WEB_SETTINGS_FILE)) {
            return {
                configOverrides: {},
                defaultOwnerAgent: 'builder',
                defaultSkills: ['coding']
            };
        }
        const parsed = JSON.parse(fs_1.default.readFileSync(WEB_SETTINGS_FILE, 'utf8'));
        return {
            configOverrides: parsed.configOverrides || {},
            defaultOwnerAgent: parsed.defaultOwnerAgent || 'builder',
            defaultSkills: Array.isArray(parsed.defaultSkills) ? parsed.defaultSkills.slice(0, 6) : ['coding']
        };
    }
    catch {
        return {
            configOverrides: {},
            defaultOwnerAgent: 'builder',
            defaultSkills: ['coding']
        };
    }
}
function saveWebSettings(settings) {
    fs_1.default.writeFileSync(WEB_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}
function sanitizeConfigOverrides(input) {
    if (!input || typeof input !== 'object')
        return {};
    const output = {};
    for (const [key, value] of Object.entries(input)) {
        if (!(key in config_1.CONFIG))
            continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            output[key] = value;
        }
    }
    return output;
}
function getEffectiveConfig(settings) {
    return { ...config_1.CONFIG, ...settings.configOverrides };
}
function createGoalTask(goal, ownerAgent, skillTags) {
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
        owner_agent: ownerAgent,
        skill_tags: skillTags
    };
}
function injectGoal(memory, goal, ownerAgent, skillTags) {
    const task = createGoalTask(goal, ownerAgent, skillTags);
    memory.backlog = [task, ...(memory.backlog || [])];
    (0, memory_1.pushHistory)(memory, { type: 'web_goal_injected', taskId: task.id, goal, ownerAgent, skillTags });
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
      <label>Owner agent:</label>
      <select id="ownerAgent"></select>
      <label>Skills (separadas por vírgula):</label>
      <input id="skills" type="text" placeholder="coding,testing,security" />
    </p>
    <p>
      <button onclick="injectGoal()">Adicionar no backlog</button>
      <button onclick="runOneCycle()">Rodar 1 ciclo</button>
      <button onclick="loadStatus()">Atualizar status</button>
    </p>
  </div>

  <div class="card">
    <h3>Configurações (todas)</h3>
    <p>Edite em JSON (campos inválidos são ignorados no update).</p>
    <textarea id="configEditor" style="min-height:220px"></textarea>
    <p>
      <button onclick="loadConfig()">Recarregar config</button>
      <button onclick="saveConfig()">Salvar overrides</button>
    </p>
  </div>

  <div class="card">
    <h3>Status</h3>
    <pre id="status">carregando...</pre>
  </div>

  <script>
    async function loadConfig() {
      const res = await fetch('/api/config');
      const data = await res.json();
      document.getElementById('configEditor').value = JSON.stringify(data, null, 2);
      const select = document.getElementById('ownerAgent');
      const roles = data.roles || [];
      select.innerHTML = roles.map((role) => '<option value="' + role + '">' + role + '</option>').join('');
      if (data.settings && data.settings.defaultOwnerAgent) {
        select.value = data.settings.defaultOwnerAgent;
      }
      if (data.settings && Array.isArray(data.settings.defaultSkills)) {
        document.getElementById('skills').value = data.settings.defaultSkills.join(',');
      }
    }
    async function saveConfig() {
      let payload;
      try {
        payload = JSON.parse(document.getElementById('configEditor').value);
      } catch (e) {
        return alert('JSON inválido no editor de config.');
      }
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Falha ao salvar config');
      await loadConfig();
      alert('Config salva com sucesso.');
    }
    async function loadStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('status').textContent = JSON.stringify(data, null, 2);
    }
    async function injectGoal() {
      const goal = document.getElementById('goal').value.trim();
      if (!goal) return alert('Informe um objetivo.');
      const ownerAgent = document.getElementById('ownerAgent').value;
      const skillTags = document.getElementById('skills').value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const res = await fetch('/api/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, ownerAgent, skillTags })
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
    loadConfig();
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
        if (method === 'GET' && url === '/api/config') {
            const settings = loadWebSettings();
            sendJson(res, 200, {
                config: config_1.CONFIG,
                effectiveConfig: getEffectiveConfig(settings),
                configOverrides: settings.configOverrides,
                settings,
                roles: config_1.CONFIG.AGENT_ROLES,
                skills: config_1.CONFIG.AGENT_SKILLS
            });
            return;
        }
        if (method === 'PUT' && url === '/api/config') {
            try {
                const raw = await getBody(req);
                const parsed = raw ? JSON.parse(raw) : {};
                const current = loadWebSettings();
                const overrides = parsed && typeof parsed.configOverrides === 'object'
                    ? sanitizeConfigOverrides(parsed.configOverrides)
                    : current.configOverrides;
                const defaultOwnerAgent = config_1.CONFIG.AGENT_ROLES.includes(String(parsed?.settings?.defaultOwnerAgent || ''))
                    ? String(parsed.settings.defaultOwnerAgent)
                    : current.defaultOwnerAgent;
                const defaultSkills = Array.isArray(parsed?.settings?.defaultSkills)
                    ? parsed.settings.defaultSkills.map((item) => String(item || '').toLowerCase()).filter((item) => config_1.CONFIG.AGENT_SKILLS.includes(item))
                    : current.defaultSkills;
                const next = {
                    configOverrides: overrides || {},
                    defaultOwnerAgent,
                    defaultSkills: defaultSkills.slice(0, 6)
                };
                saveWebSettings(next);
                sendJson(res, 200, { ok: true, settings: next });
            }
            catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            return;
        }
        if (method === 'GET' && url === '/api/status') {
            const memory = (0, memory_1.loadMemory)();
            const byAgent = (memory.backlog || []).reduce((acc, task) => {
                const agent = String(task.owner_agent || 'builder');
                acc[agent] = (acc[agent] || 0) + 1;
                return acc;
            }, {});
            sendJson(res, 200, {
                backlogCount: memory.backlog.length,
                backlogByAgent: byAgent,
                backlogPreview: memory.backlog.slice(0, 5).map((task) => ({
                    id: task.id,
                    title: task.title,
                    priority: task.priority,
                    owner_agent: task.owner_agent || 'builder',
                    skill_tags: task.skill_tags || []
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
                const settings = loadWebSettings();
                const ownerAgentRaw = String(parsed.ownerAgent || settings.defaultOwnerAgent || 'builder').toLowerCase();
                const ownerAgent = config_1.CONFIG.AGENT_ROLES.includes(ownerAgentRaw) ? ownerAgentRaw : 'builder';
                const skillTagsRaw = Array.isArray(parsed.skillTags) ? parsed.skillTags : settings.defaultSkills;
                const skillTags = skillTagsRaw
                    .map((item) => String(item || '').toLowerCase().trim())
                    .filter((item) => config_1.CONFIG.AGENT_SKILLS.includes(item))
                    .slice(0, 6);
                if (!goal || goal.length < 5) {
                    sendJson(res, 400, { ok: false, error: 'Objetivo inválido. Use no mínimo 5 caracteres.' });
                    return;
                }
                const memory = (0, memory_1.loadMemory)();
                injectGoal(memory, goal, ownerAgent, skillTags);
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
                const settings = loadWebSettings();
                await (0, orchestrator_1.runAgent)({
                    maxCycles: 1,
                    runtimeOverrides: {
                        MAX_ITERATIONS: Number(settings.configOverrides.MAX_ITERATIONS || config_1.CONFIG.MAX_ITERATIONS),
                        MAX_RUNTIME_MS: Number(settings.configOverrides.MAX_RUNTIME_MS || config_1.CONFIG.MAX_RUNTIME_MS),
                        LOOP_DELAY_MS: Number(settings.configOverrides.LOOP_DELAY_MS || config_1.CONFIG.LOOP_DELAY_MS),
                        REPLAN_INTERVAL_CYCLES: Number(settings.configOverrides.REPLAN_INTERVAL_CYCLES || config_1.CONFIG.REPLAN_INTERVAL_CYCLES),
                        CRITICAL_FAILURE_REPLAN_THRESHOLD: Number(settings.configOverrides.CRITICAL_FAILURE_REPLAN_THRESHOLD || config_1.CONFIG.CRITICAL_FAILURE_REPLAN_THRESHOLD)
                    }
                });
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
