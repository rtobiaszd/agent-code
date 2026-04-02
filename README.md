# Agent Refactor em TypeScript

Versão em TypeScript do agente autônomo modular.

## O que já está resolvido

- leitura contínua do `BLUEPRINT.md`
- backlog planner + replan
- executor + reviewer
- verificação em duas fases (`fast` e `full`)
- distinção entre erro pré-existente do repo e erro introduzido pela task
- self-heal com noção de progresso
- stabilization task para tooling/build/typecheck/test
- log de evolução no documento principal

## Uso

```bash
npm install
npm run build
npm start
```

### Interface Browser (novo)

```bash
agent web
# abre em http://localhost:3030 (ou WEB_PORT)
```

No modo web você consegue:
- enviar objetivo para o backlog,
- rodar 1 ciclo do agente,
- visualizar status/métricas em tempo real.

## Variáveis principais

- `REPO_PATH`
- `BLUEPRINT_FILE`
- `MAIN_EVOLUTION_DOC`
- `OLLAMA_URL`
- `MODEL_PLANNER`
- `MODEL_EXECUTOR`
- `MODEL_REVIEWER`
- `MODEL_FIXER`

## Estrutura

- `src/config.ts`
- `src/types.ts`
- `src/core/*`
- `src/repo/*`
- `src/planning/*`
- `src/execution/*`
- `src/state/*`
- `src/agent/orchestrator.ts`
