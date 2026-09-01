# Platos v1.0.0 — Release Notes

**Open-source agent runtime, built on top of trigger.dev.**

## What's in the box

Platos is a durable agent runtime platform. You get everything trigger.dev does (schedules, batches, retries, checkpoints, queues, build extensions, observability, LLM cost tracking), plus a dedicated agent layer:

- **Two-pane agent builder** — static config (cached) vs dynamic config (per-call). Prompt blocks + Tools Block + custom static + custom dynamic. Live on the dashboard.
- **Three tool execution modes** — Direct schema injection, dedicated sub-agent tool-caller (Haiku by default), generic execute-tool wrapper.
- **User profiling** — per-agent-per-user profile. LLM auto-manages `update_user_profile` / `recall_user_profile` tools. Auto-inject into every conversation.
- **Conversation compaction** — rolling or compact modes. When threads exceed threshold, oldest messages summarize via Haiku; summary auto-injected next turn.
- **HITL approvals** — `request_approval` meta-tool. Emits `approval_needed` event to UI via Socket.IO; user approves/denies; 5-minute waitpoint.
- **Dynamic block injection** — caller passes `dynamicBlocks: { current_screen, work_graph, ... }` at request time; runtime matches declared templates and injects into dynamic context.
- **Multi-provider support** — Anthropic (Claude 4.5/4.6), OpenAI (GPT-4.1, GPT-4o), Google (Gemini 2.5), Vertex AI. BYOK (bring your own key) per org, encrypted AES-256.
- **Tool matrix** — multi-tenant tool registry. WebSocket tool sync (`wss://platos.dev/tools/sync/{org_id}`). BM25 search. HMAC-signed execution. Per-tool permissions (approve/destructive).
- **Prompt caching** — Anthropic `cache_control: ephemeral` attached at message level. Up to 90% discount on cached prefix for ≥1024-token system prompts.
- **Durable task spawning** — `spawn_task` meta-tool (renamed to `spawn_bgo` under Theme BGO; old name kept as a deprecated alias — see `docs/BGO_RENAME.md`) → `tasks.trigger()` on trigger.dev run engine. Retries, checkpoints, cross-restart resumption.

## Architecture

```
┌─ apps/webapp (Remix, :3030) ─────────────────────────┐
│  Dashboard + Trigger.dev run engine + API + auth     │
│  New: Agent Platform section first in sidebar        │
└──────────────────────────────────────────────────────┘

┌─ apps/agent (NestJS, :3100) ─────────────────────────┐
│  Agent runtime + Socket.IO streaming                  │
│  Tool gateway (BM25, HMAC exec, WS sync)              │
│  Memory (conversation, working, profile)              │
│  Meta-tools: find_tools, execute_tools, remember,     │
│  recall, update_user_profile, recall_user_profile,    │
│  request_approval, delegate_to_sub_agent, spawn_task  │
└──────────────────────────────────────────────────────┘

Shared: Postgres 16 (Prisma) + Redis 7
```

## Quickstart

```bash
git clone https://github.com/winsenlabs/platos.git
cd platos
docker compose -f docker-compose.platos.yml up
```

Open http://localhost:3030 → log in → Agents → New Agent → configure → chat.

## Migrating from trigger.dev

Every trigger.dev project works on Platos. See `docs/upgrading-from-trigger.md`.

Package boundaries:
- Trigger durable-runtime APIs remain in `@trigger.dev/sdk`
- Platos REST/WebSocket APIs are provided by `@platosdev/client`
- `@trigger.dev/core` → `@platos/core`
- Trigger build extensions remain external Trigger packages

Environment variables for the SDK (`TRIGGER_SECRET_KEY`, `TRIGGER_API_URL`, `TRIGGER_PROJECT_REF`) stay the same for compatibility.

## Credits

Built on [trigger.dev](https://github.com/triggerdotdev/trigger.dev) by Trigger.dev Inc (Apache 2.0). Platos adds the agent runtime + tool gateway + user profiling + HITL approvals on top. See NOTICE for full attribution.

## License

Apache 2.0.

## What's next (roadmap)

Post-v1.0 backlog in PLV2-56 (tracked in the project management):
- v1.1: pgvector semantic memory (Layer 3), knowledge graph extraction (Layer 4), GPT-OSS dual-model adapter, tool health dashboard widgets
- Winsen internal fork: Winsen Walle agent + AI Employees migrated from FanDesk Central

---

**Get help:** [github.com/winsenlabs/platos/discussions](https://github.com/winsenlabs/platos/discussions)

**Security:** security@platos.dev (see SECURITY.md)

**Commercial support + managed:** hello@platos.dev
