import readline from 'readline';
import { CONFIG } from './config';
import { runAgent } from './agent/orchestrator';
import { loadMemory, pushHistory, saveMemory } from './state/memory';
import type { AgentTask, MemoryState } from './types';

type CliCommand = 'run' | 'auto' | 'chat' | 'help';

const CHAT_HISTORY_LIMIT = 8;

function printUsage(): void {
  console.log(`
Uso:
  agent run --goal "seu objetivo"
  agent auto
  agent chat

Comandos no chat:
  /plan   mostra backlog atual (resumido)
  /apply  executa uma iteração do agente
  /status mostra métricas rápidas
  /stop   encerra o chat
`);
}

function failWith(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
  throw new Error(message);
}

function getSubcommand(argv: string[]): CliCommand {
  const raw = argv[2];
  if (!raw || raw === '--help' || raw === '-h') return 'help';
  if (raw === 'run' || raw === 'auto' || raw === 'chat') return raw;
  failWith(`Subcomando inválido: "${raw}". Use "run", "auto" ou "chat".`);
  return 'help';
}

function extractGoal(argv: string[]): string {
  const goalIndex = argv.findIndex((arg) => arg === '--goal');
  if (goalIndex === -1) failWith('No modo "run", informe --goal "seu objetivo".');

  const goal = argv[goalIndex + 1];
  if (!goal || goal.startsWith('--')) failWith('Valor ausente para --goal. Exemplo: agent run --goal "corrigir testes".');
  if (goal.trim().length < 5) failWith('O objetivo está muito curto. Forneça mais contexto para o modo "run".');
  return goal.trim();
}

function buildInitialTaskFromGoal(goal: string): AgentTask {
  const compact = goal.replace(/\s+/g, ' ').trim();
  const title = compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
  const id = `goal-${Date.now().toString(36)}`;

  return {
    id,
    title: `Goal: ${title}`,
    category: 'product',
    priority: 'high',
    goal: compact,
    why: 'Objetivo inicial informado pelo usuário via CLI.',
    files: [],
    depends_on: [],
    acceptance_criteria: ['Implementar o objetivo inicial sem quebrar verificações existentes.'],
    estimated_size: 'm',
    risk_level: 'medium',
    status: 'ready',
    new_files_allowed: true,
    commit_message: `feat: ${title.slice(0, 60)}`
  };
}

function prependTaskToBacklog(memory: MemoryState, task: AgentTask): void {
  memory.backlog = [task, ...(memory.backlog || [])];
  pushHistory(memory, { type: 'cli_goal_injected', taskId: task.id, goal: task.goal });
}

async function runGoalMode(goal: string): Promise<void> {
  const memory = loadMemory();
  const task = buildInitialTaskFromGoal(goal);
  prependTaskToBacklog(memory, task);
  saveMemory(memory);
  console.log('🧭 Objetivo convertido em tarefa inicial e injetado no backlog.');
  await runAgent();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAutoMode(): Promise<void> {
  let shouldStop = false;
  process.on('SIGINT', () => {
    shouldStop = true;
    console.log('\n🛑 Sinal recebido. Encerrando modo auto...');
  });

  console.log(`♻️ Modo auto iniciado (delay: ${CONFIG.LOOP_DELAY_MS}ms). Pressione Ctrl+C para parar.`);
  while (!shouldStop) {
    await runAgent();
    if (shouldStop) break;
    await sleep(CONFIG.LOOP_DELAY_MS);
  }
}

function renderStatus(memory: MemoryState): void {
  const pending = memory.backlog.length;
  const metrics = memory.metrics;
  console.log(`📊 backlog: ${pending} | iterações: ${metrics.iterations} | tarefas: ${metrics.tasksExecuted} | commits: ${metrics.commits}`);
}

function renderPlan(memory: MemoryState): void {
  if (!memory.backlog.length) {
    console.log('📭 backlog vazio.');
    return;
  }
  console.log('🗂️ Próximas tarefas:');
  for (const [index, task] of memory.backlog.slice(0, 5).entries()) {
    console.log(`  ${index + 1}. ${task.title} (${task.priority})`);
  }
}

async function runChatMode(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  const history: Array<{ role: 'user' | 'system'; text: string }> = [];
  console.log('💬 Chat iniciado. Digite /help para comandos.');

  const ask = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question('agent> ', (answer) => resolve(answer.trim()));
    });

  let active = true;
  while (active) {
    const input = await ask();
    if (!input) continue;

    history.push({ role: 'user', text: input });
    if (history.length > CHAT_HISTORY_LIMIT) history.splice(0, history.length - CHAT_HISTORY_LIMIT);

    if (input === '/help') {
      printUsage();
      continue;
    }
    if (input === '/stop') {
      active = false;
      continue;
    }
    if (input === '/status') {
      renderStatus(loadMemory());
      continue;
    }
    if (input === '/plan') {
      renderPlan(loadMemory());
      continue;
    }
    if (input === '/apply') {
      await runAgent();
      continue;
    }
    if (input.startsWith('/')) {
      console.log('❓ Comando desconhecido. Use /help para ver comandos disponíveis.');
      continue;
    }

    const condensed = history.map((item) => `${item.role}: ${item.text}`).join(' | ');
    const memory = loadMemory();
    const task = buildInitialTaskFromGoal(`Contexto recente: ${condensed}`);
    prependTaskToBacklog(memory, task);
    saveMemory(memory);
    console.log('📝 Mensagem convertida em tarefa. Use /apply para executar agora.');
  }

  rl.close();
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const command = getSubcommand(argv);

  if (command === 'help') {
    printUsage();
    return;
  }

  if (command === 'run') {
    const goal = extractGoal(argv);
    await runGoalMode(goal);
    return;
  }

  if (command === 'auto') {
    await runAutoMode();
    return;
  }

  await runChatMode();
}

if (require.main === module) {
  runCli(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
