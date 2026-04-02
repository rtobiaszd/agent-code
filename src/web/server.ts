import http from 'http';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { runAgent } from '../agent/orchestrator';
import { loadMemory, pushHistory, saveMemory } from '../state/memory';
import type { AgentTask, MemoryState } from '../types';

type WebSettings = {
  configOverrides: Record<string, string | number | boolean>;
  defaultOwnerAgent: string;
  defaultSkills: string[];
};

const WEB_SETTINGS_FILE = path.join(CONFIG.REPO_PATH, '.agent-web-settings.json');

function loadWebSettings(): WebSettings {
  try {
    if (!fs.existsSync(WEB_SETTINGS_FILE)) {
      return {
        configOverrides: {},
        defaultOwnerAgent: 'builder',
        defaultSkills: ['coding']
      };
    }
    const parsed = JSON.parse(fs.readFileSync(WEB_SETTINGS_FILE, 'utf8')) as WebSettings;
    return {
      configOverrides: parsed.configOverrides || {},
      defaultOwnerAgent: parsed.defaultOwnerAgent || 'builder',
      defaultSkills: Array.isArray(parsed.defaultSkills) ? parsed.defaultSkills.slice(0, 6) : ['coding']
    };
  } catch {
    return {
      configOverrides: {},
      defaultOwnerAgent: 'builder',
      defaultSkills: ['coding']
    };
  }
}

function saveWebSettings(settings: WebSettings): void {
  fs.writeFileSync(WEB_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function sanitizeConfigOverrides(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object') return {};
  const output: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in CONFIG)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
    }
  }

  return output;
}

function getEffectiveConfig(settings: WebSettings): Record<string, unknown> {
  return { ...CONFIG, ...settings.configOverrides };
}

function createGoalTask(goal: string, ownerAgent: string, skillTags: string[]): AgentTask {
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

function injectGoal(memory: MemoryState, goal: string, ownerAgent: string, skillTags: string[]): void {
  const task = createGoalTask(goal, ownerAgent, skillTags);
  memory.backlog = [task, ...(memory.backlog || [])];
  pushHistory(memory, { type: 'web_goal_injected', taskId: task.id, goal, ownerAgent, skillTags });
}

function getBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function renderHtml(): string {
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

export function startWebServer(): http.Server {
  let running = false;

  const server = http.createServer(async (req, res) => {
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
        config: CONFIG,
        effectiveConfig: getEffectiveConfig(settings),
        configOverrides: settings.configOverrides,
        settings,
        roles: CONFIG.AGENT_ROLES,
        skills: CONFIG.AGENT_SKILLS
      });
      return;
    }

    if (method === 'PUT' && url === '/api/config') {
      try {
        const raw = await getBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const current = loadWebSettings();
        const overrides =
          parsed && typeof parsed.configOverrides === 'object'
            ? sanitizeConfigOverrides(parsed.configOverrides)
            : current.configOverrides;
        const defaultOwnerAgent = CONFIG.AGENT_ROLES.includes(String(parsed?.settings?.defaultOwnerAgent || ''))
          ? String(parsed.settings.defaultOwnerAgent)
          : current.defaultOwnerAgent;
        const defaultSkills = Array.isArray(parsed?.settings?.defaultSkills)
          ? parsed.settings.defaultSkills.map((item: unknown) => String(item || '').toLowerCase()).filter((item: string) => CONFIG.AGENT_SKILLS.includes(item))
          : current.defaultSkills;

        const next: WebSettings = {
          configOverrides: overrides || {},
          defaultOwnerAgent,
          defaultSkills: defaultSkills.slice(0, 6)
        };
        saveWebSettings(next);
        sendJson(res, 200, { ok: true, settings: next });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === 'GET' && url === '/api/status') {
      const memory = loadMemory();
      const byAgent = (memory.backlog || []).reduce<Record<string, number>>((acc, task) => {
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
        const ownerAgent = CONFIG.AGENT_ROLES.includes(ownerAgentRaw) ? ownerAgentRaw : 'builder';
        const skillTagsRaw = Array.isArray(parsed.skillTags) ? parsed.skillTags : settings.defaultSkills;
        const skillTags = skillTagsRaw
          .map((item: unknown) => String(item || '').toLowerCase().trim())
          .filter((item: string) => CONFIG.AGENT_SKILLS.includes(item))
          .slice(0, 6);
        if (!goal || goal.length < 5) {
          sendJson(res, 400, { ok: false, error: 'Objetivo inválido. Use no mínimo 5 caracteres.' });
          return;
        }
        const memory = loadMemory();
        injectGoal(memory, goal, ownerAgent, skillTags);
        saveMemory(memory);
        sendJson(res, 200, { ok: true });
      } catch (error) {
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
        await runAgent({
          maxCycles: 1,
          runtimeOverrides: {
            MAX_ITERATIONS: Number(settings.configOverrides.MAX_ITERATIONS || CONFIG.MAX_ITERATIONS),
            MAX_RUNTIME_MS: Number(settings.configOverrides.MAX_RUNTIME_MS || CONFIG.MAX_RUNTIME_MS),
            LOOP_DELAY_MS: Number(settings.configOverrides.LOOP_DELAY_MS || CONFIG.LOOP_DELAY_MS),
            REPLAN_INTERVAL_CYCLES: Number(settings.configOverrides.REPLAN_INTERVAL_CYCLES || CONFIG.REPLAN_INTERVAL_CYCLES),
            CRITICAL_FAILURE_REPLAN_THRESHOLD: Number(
              settings.configOverrides.CRITICAL_FAILURE_REPLAN_THRESHOLD || CONFIG.CRITICAL_FAILURE_REPLAN_THRESHOLD
            )
          }
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Rota não encontrada.' });
  });

  server.listen(CONFIG.WEB_PORT, () => {
    console.log(`🌐 Agent web UI em http://localhost:${CONFIG.WEB_PORT}`);
  });
  return server;
}
