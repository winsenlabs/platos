# Platos documentation inventory

Generated: 2026-05-04 by Phase 1 agent.

Categories:

- **platform** — Platos surface concepts (agents, skills, memory, conversations, threads, evals, etc.).
- **engine** — trigger.dev engine primitives surfaced through Platos (runs, schedules, queues, deployments, batches, waitpoints).
- **governance** — safety, approvals, budgets, PII, rate limits.
- **observability** — traces, costs, metrics, monitoring.
- **dx** — SDKs, MCP, OpenAPI, webhooks, BYOK, scope.
- **getting-started** — guides only.
- **integrations** — guides only.
- **recipes** — guides only.
- **troubleshooting** — guides only.

## Docs (47 topics)

| Slug | Title | Category | Order | trigger.dev primitive? | Source files | Status |
|---|---|---|---|---|---|---|
| agents | Agents | platform | 10 | no | apps/agent/src/agent-runtime/agent.controller.ts, apps/agent/src/agent-runtime/agent.service.ts, apps/agent/src/agent-runtime/agent-crud.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId._index/route.tsx | skeleton |
| agent-versions | Agent versions, canary, rollback | platform | 20 | no | apps/agent/src/agent-runtime/agent.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.versions/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.canary/route.tsx | skeleton |
| agent-clusters | Agent clusters | platform | 30 | no | apps/agent/src/agent-runtime/agent-cluster.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-clusters._index/route.tsx | skeleton |
| skills | Skills | platform | 40 | no | apps/agent/src/skills/skill-registry.service.ts, apps/agent/src/skills/skill-runtime.service.ts, apps/agent/src/skills/skill-importer.service.ts, apps/agent/src/skills/skill-manifest.parser.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.skills._index/route.tsx | skeleton |
| official-skills | Official skills catalog | platform | 50 | no | apps/agent/src/skills/official, apps/agent/src/skills/official-skills-seeder.service.ts | skeleton |
| tools | Tools and tool routing | platform | 60 | no | apps/agent/src/tool-gateway/tool-registry.service.ts, apps/agent/src/tool-gateway/tool-router.service.ts, apps/agent/src/tool-gateway/tool-executor.service.ts, apps/agent/src/tool-gateway/schema-injector.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-tools._index/route.tsx | skeleton |
| connected-entities | Connected entities | platform | 70 | no | apps/agent/src/tool-gateway/tool-sync-ws.service.ts, apps/agent/src/connections/connections.gateway.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-entities._index/route.tsx | skeleton |
| memory | Memory | platform | 80 | no | apps/agent/src/memory/memory.service.ts, apps/agent/src/memory/memory.controller.ts, apps/agent/src/memory/memory-extraction.service.ts, apps/agent/src/memory/working-memory.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories._index/route.tsx | skeleton |
| memory-graph | Memory graph | platform | 90 | no | apps/agent/src/memory/knowledge-graph.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.graph/route.tsx | skeleton |
| conversations-and-threads | Conversations and threads | platform | 100 | no | apps/agent/src/memory/conversation.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations._index/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.conversations.$threadId/route.tsx | skeleton |
| chat-and-postman | Chat and Postman mode | platform | 110 | no | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.postman-templates/route.tsx | skeleton |
| context | Agent context | platform | 120 | no | apps/agent/src/agent-runtime/context-resolver.ts, apps/agent/src/agent-runtime/context-automap.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.context/route.tsx | skeleton |
| prompts | Prompts | platform | 130 | no | apps/agent/src/agent-runtime/prompt-builder.service.ts, apps/agent/src/agent-runtime/prompt-cache.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.prompts._index/route.tsx | skeleton |
| models | Models | platform | 140 | no | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.models._index/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.models.compare/route.tsx | skeleton |
| providers | Providers and BYOK | platform | 150 | no | apps/agent/src/providers/provider-registry.service.ts, apps/agent/src/providers/providers.controller.ts, apps/agent/src/providers/scoped-env.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx | skeleton |
| evals | Evals | platform | 160 | no | apps/agent/src/evals/eval.service.ts, apps/agent/src/evals/criterion.service.ts, apps/agent/src/evals/golden-set.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-evals._index/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.eval-criteria._index/route.tsx | skeleton |
| evals-ab | A/B evals | platform | 170 | no | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.evals-ab/route.tsx | skeleton |
| artifacts | Artifacts | platform | 180 | no | apps/agent/src/agent-runtime/artifact-meta.ts, apps/webapp/app/routes/api.v1.artifacts.ts | skeleton |
| attachments-and-files | Attachments and files | platform | 190 | no | apps/agent/src/agent-runtime/attachments.service.ts, apps/agent/src/files/files.controller.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.files._index/route.tsx | skeleton |
| platos-tasks | Platos tasks (BGOs) | platform | 200 | no | apps/agent/src/agent-runtime/platos-tasks.controller.ts, apps/agent/src/agent-runtime/agent-task.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx | skeleton |
| runs | Runs | engine | 10 | yes | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/route.tsx | skeleton |
| schedules | Schedules | engine | 20 | yes | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules/route.tsx | skeleton |
| queues | Queues | engine | 30 | yes | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues/route.tsx | skeleton |
| deployments | Deployments | engine | 40 | yes | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.deployments/route.tsx | skeleton |
| batches | Batches | engine | 50 | yes | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.batches/route.tsx | skeleton |
| waitpoints | Waitpoints | engine | 60 | yes | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.tokens/route.tsx | skeleton |
| approvals-and-hitl | Approvals and HITL | governance | 10 | no | apps/agent/src/monitoring/approvals.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.approvals._index/route.tsx | skeleton |
| budgets | Budget caps | governance | 20 | no | apps/agent/src/monitoring/budget.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-budgets._index/route.tsx | skeleton |
| safety-and-pii | Safety, PII, governance | governance | 30 | no | apps/agent/src/monitoring/safety.service.ts, apps/agent/src/monitoring/safety-event.service.ts, apps/agent/src/monitoring/governance.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-governance._index/route.tsx | skeleton |
| rate-limits | Rate limits | governance | 40 | no | apps/agent/src/monitoring/rate-limit.service.ts, apps/agent/src/auth/rate-limit.guard.ts | skeleton |
| encryption-and-secrets | Encryption and secrets | governance | 50 | no | apps/agent/src/monitoring/message-crypto.service.ts, apps/agent/src/auth/secrets.service.ts | skeleton |
| monitoring | Monitoring | observability | 10 | no | apps/agent/src/monitoring/monitoring.module.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring._index/route.tsx, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-monitoring.users._index/route.tsx | skeleton |
| traces | Traces | observability | 20 | no | apps/agent/src/monitoring/trace.service.ts, apps/agent/src/monitoring/spans.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.trace.$threadId/route.tsx | skeleton |
| costs | Costs and spend | observability | 30 | no | apps/agent/src/monitoring/cost.service.ts | skeleton |
| metrics | Metrics | observability | 40 | no | apps/agent/src/monitoring/metrics.service.ts, apps/agent/src/monitoring/metrics.controller.ts, apps/agent/src/monitoring/utilization.service.ts | skeleton |
| audit-log | Audit log | observability | 50 | no | apps/agent/src/monitoring/admin-audit.service.ts, apps/agent/src/monitoring/tool-audit.service.ts | skeleton |
| scope-and-multi-tenancy | Scope tuple and multi-tenancy | dx | 10 | no | apps/agent/src/auth/scope.guard.ts, apps/agent/src/auth/cross-scope-isolation.test.ts, docs/PLATOS_SPEC.md | skeleton |
| auth-modes | Auth modes and session tokens | dx | 20 | no | apps/agent/src/auth/auth.service.ts, apps/agent/src/auth/session-token.controller.ts, apps/agent/src/auth/public-guest-token.controller.ts | skeleton |
| sdks | SDKs (TypeScript and Python) | dx | 30 | no | packages/platos-client, packages/platools-py, packages/platools-ts | skeleton |
| mcp-gateway | MCP gateway | dx | 40 | no | apps/agent/src/mcp-platform/mcp-platform.controller.ts, apps/agent/src/mcp-platform/mcp-router.ts, apps/agent/src/mcp-platform/mcp-entity.controller.ts, apps/agent/src/mcp-platform/permission-gateway.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.mcps._index/route.tsx | skeleton |
| mcp-tokens-and-pat | MCP tokens and PATs | dx | 50 | no | apps/agent/src/mcp-platform/token.service.ts, apps/agent/src/mcp-platform/mcp-bearer-token.service.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.mcp-tokens/route.tsx | skeleton |
| openapi-and-rest | OpenAPI and REST | dx | 60 | no | apps/agent/src/openapi | skeleton |
| webhooks | Webhooks | dx | 70 | no | apps/webapp/app/routes/api.v3.webhooks.ts | skeleton |
| public-agents-and-embed | Public agents and embed | dx | 80 | no | apps/agent/src/auth/public-guest-token.controller.ts, apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.share/route.tsx | skeleton |
| self-hosting | Self-hosting | dx | 90 | no | docker-compose.platos.yml, docs/SELF_HOSTING.md | skeleton |
| environments | Environments | dx | 100 | no | apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx | skeleton |
| streaming | Streaming and WebSocket events | dx | 110 | no | apps/agent/src/streaming, apps/agent/src/connections/connections.gateway.ts | skeleton |

## Guides (28 topics)

| Slug | Title | Category | Order | Status |
|---|---|---|---|---|
| quickstart | Quickstart: your first agent in 10 minutes | getting-started | 10 | skeleton |
| install-self-host | Self-host with docker compose | getting-started | 20 | skeleton |
| add-provider-key | Add a provider key (BYOK) | getting-started | 30 | skeleton |
| create-first-agent | Create your first agent | getting-started | 40 | skeleton |
| invite-team | Invite a teammate to a project | getting-started | 50 | skeleton |
| connect-entity-platools-ts | Connect an entity (TypeScript) | integrations | 10 | skeleton |
| connect-entity-platools-py | Connect an entity (Python) | integrations | 20 | skeleton |
| consume-platos-mcp | Consume Platos via MCP | integrations | 30 | skeleton |
| import-claude-skill | Import a Claude skill from a URL | integrations | 40 | skeleton |
| embed-public-agent | Embed a public agent on a website | integrations | 50 | skeleton |
| webhook-on-conversation-events | Subscribe to conversation events | integrations | 60 | skeleton |
| version-and-rollback | Version, canary, and roll back an agent | recipes | 10 | skeleton |
| run-an-eval-suite | Run an A/B eval suite | recipes | 20 | skeleton |
| extract-memory | Extract long-term memory from a conversation | recipes | 30 | skeleton |
| send-attachment | Send an image or PDF attachment | recipes | 40 | skeleton |
| spawn-bgo | Spawn a long-running task (BGO) | recipes | 50 | skeleton |
| schedule-recurring-task | Schedule a recurring task | recipes | 60 | skeleton |
| approve-tool-call | Add a human approval gate to a tool | recipes | 70 | skeleton |
| set-budget-cap | Set a per-agent budget cap | recipes | 80 | skeleton |
| filter-pii | Configure a PII filter | recipes | 90 | skeleton |
| publish-postman-template | Publish a Postman conversation template | recipes | 100 | skeleton |
| build-agent-cluster | Build an agent cluster | recipes | 110 | skeleton |
| trace-a-turn | Trace a single turn end to end | troubleshooting | 10 | skeleton |
| debug-cost-spike | Debug a sudden cost spike | troubleshooting | 20 | skeleton |
| recover-stuck-run | Recover a stuck run | troubleshooting | 30 | skeleton |
| fix-encryption-key | Fix an ENCRYPTION_KEY length error | troubleshooting | 40 | skeleton |
| chat-stream-disconnects | Chat stream keeps disconnecting | troubleshooting | 50 | skeleton |
| backup-and-restore | Backup and restore Postgres, ClickHouse, MinIO | troubleshooting | 60 | skeleton |
