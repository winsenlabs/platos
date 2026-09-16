# WIN-268 (M4.2) — the MCP disposition register

GENERATED — `node scripts/arch/mcp-disposition-register.mjs --write`.

Decision applied: **D18 — retire none by default; a tool is retired only with evidence it is dead**.

205 rows: 202 platform/entity MCP tools from `apps/agent/src/control-plane/operation-manifest.generated.json`, 1 docs tool(s) and 2 docs resource surface(s) read by AST from `apps/agent/src/mcp-docs/docs-mcp.controller.ts`.

## Dispositions

| disposition | rows | what it claims |
| --- | --- | --- |
| `MAPPED` | 30 | a published contract method is the V1 form of the declaring file; the row names `<context>.<method>` and the method is AST-verified |
| `REPLACED` | 76 | a named V1 REST operation carries the capability; the row names the operation id(s), each verified present in the REST inventory and mapping back to this tool |
| `RETAINED` | 99 | MCP is the only transport. D18 keeps it. **This is the open remainder**, not a third way of saying done |
| `RETIRED` | 0 | evidence that it is dead. Empty by D18 |

Manifest classification of the platform rows, for the join:

| classification | rows |
| --- | --- |
| `MAPPED` | 82 |
| `MCP_ONLY` | 120 |

## What the gate refuses

- `RET-1-UNDISPOSITIONED_TOOL`
- `RET-2-ORPHAN_ROW`
- `RET-3-METHOD_NOT_PUBLISHED`
- `RET-4-REPLACEMENT_NOT_FOUND`
- `RET-5-RETIRED_WITHOUT_EVIDENCE`
- `RET-6-UNDISPOSITIONED_SURFACE`

RET-1/RET-6 are the manifest -> register direction: a tool or surface a server declares and the committed register has no row for. RET-2 is the register -> manifest direction. RET-3 joins a mapped row to the AST-read contract; RET-4 joins a replaced row to the REST inventory IN BOTH DIRECTIONS, because a one-way join would pass on a register that pointed every tool at one real route.

## The open remainder

99 rows are RETAINED. They are the part of the census row that is NOT closed: MCP is still their only transport. Grouped by what the store-ownership register says their declaring file is waiting on:

| waiting on | rows |
| --- | --- |
| `no-orm-site-in-declaring-file` | 47 |
| `contract-method` | 30 |
| `context-composition` | 19 |
| `docs-mcp-bridge-deployable` | 3 |

Contexts the composition root actually composes: identityAccess, providers, secrets, tenancy, tools.

## Rows

A MAPPED row names the contract method published for the tool's DECLARING FILE — the unit `scripts/arch/mcp-store-ownership.mjs` records — not a per-tool binding. Per-tool bindings arrive when the MCP transport moves to `apps/core-api/src/transports/mcp`.

| surface | server | kind | disposition | contract method (file-level) / REST replacement | waiting on |
| --- | --- | --- | --- | --- | --- |
| `resources/list` | docs | resource | RETAINED | — | `docs-mcp-bridge-deployable` |
| `resources/read` | docs | resource | RETAINED | — | `docs-mcp-bridge-deployable` |
| `search_docs` | docs | tool | RETAINED | — | `docs-mcp-bridge-deployable` |
| `agents.canary.promote` | platform | tool | REPLACED | `POST /api/v1/agent/agents/:agentId/canary/promote` | `no-orm-site-in-declaring-file` |
| `agents.canary.set` | platform | tool | REPLACED | `PATCH /api/v1/agent/agents/:agentId/canary` | `no-orm-site-in-declaring-file` |
| `agents.census` | platform | tool | RETAINED | — | `contract-method` |
| `agents.clone_from` | platform | tool | MAPPED | `tools.discoverEntityTools`, `tools.registerTools` | `transport-move` |
| `agents.create` | platform | tool | REPLACED | `POST /api/v1/agent/agents` | `no-orm-site-in-declaring-file` |
| `agents.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/agents/:agentId` | `no-orm-site-in-declaring-file` |
| `agents.deploy_with_skills` | platform | tool | MAPPED | `tools.discoverEntityTools`, `tools.registerTools` | `transport-move` |
| `agents.get` | platform | tool | REPLACED | `GET /api/v1/agent/agents/:agentId` | `no-orm-site-in-declaring-file` |
| `agents.list` | platform | tool | REPLACED | `GET /api/v1/agent/agents` | `no-orm-site-in-declaring-file` |
| `agents.update` | platform | tool | REPLACED | `PATCH /api/v1/agent/agents/:agentId` | `no-orm-site-in-declaring-file` |
| `alert_channels.create` | platform | tool | RETAINED | — | `context-composition` |
| `alert_channels.delete` | platform | tool | RETAINED | — | `context-composition` |
| `alert_channels.get_integration` | platform | tool | RETAINED | — | `context-composition` |
| `alert_channels.list` | platform | tool | RETAINED | — | `context-composition` |
| `alert_channels.test` | platform | tool | RETAINED | — | `context-composition` |
| `alert_channels.update` | platform | tool | RETAINED | — | `context-composition` |
| `approvals.get` | platform | tool | REPLACED | `GET /api/v1/agent/monitoring/approvals/:approvalId` | `contract-method` |
| `approvals.list` | platform | tool | REPLACED | `GET /api/v1/agent/monitoring/approvals` | `contract-method` |
| `approvals.resolve` | platform | tool | REPLACED | `POST /api/v1/agent/approvals/:approvalId/resolve` | `contract-method` |
| `artifacts.list` | platform | tool | REPLACED | `GET /api/v1/agent/threads/:threadId/artifacts` | `contract-method` |
| `audit.safety_events.query` | platform | tool | REPLACED | `GET /api/v1/agent/monitoring/safety-events` | `contract-method` |
| `budgets.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/budgets/:capId` | `contract-method` |
| `budgets.get` | platform | tool | RETAINED | — | `contract-method` |
| `budgets.list` | platform | tool | REPLACED | `GET /api/v1/agent/budgets` | `contract-method` |
| `budgets.rollup_org_wide` | platform | tool | RETAINED | — | `contract-method` |
| `budgets.upsert` | platform | tool | REPLACED | `POST /api/v1/agent/budgets` | `contract-method` |
| `channel_apps.bind_installation` | platform | tool | REPLACED | `POST /api/v1/agent/channel-apps/:id/installations/:installationId/bind` | `context-composition` |
| `channel_apps.create` | platform | tool | REPLACED | `POST /api/v1/agent/channel-apps` | `context-composition` |
| `channel_apps.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/channel-apps/:id` | `context-composition` |
| `channel_apps.get` | platform | tool | REPLACED | `GET /api/v1/agent/channel-apps/:id` | `context-composition` |
| `channel_apps.import_installation` | platform | tool | REPLACED | `POST /api/v1/agent/channel-apps/:id/installations/import` | `context-composition` |
| `channel_apps.installations_status` | platform | tool | REPLACED | `GET /api/v1/agent/channel-apps/:id/installations/status` | `context-composition` |
| `channel_apps.list` | platform | tool | REPLACED | `GET /api/v1/agent/channel-apps` | `context-composition` |
| `channel_apps.list_installations` | platform | tool | REPLACED | `GET /api/v1/agent/channel-apps/:id/installations` | `context-composition` |
| `channel_apps.revoke_installation` | platform | tool | REPLACED | `DELETE /api/v1/agent/channel-apps/:id/installations/:installationId` | `context-composition` |
| `channel_apps.update` | platform | tool | REPLACED | `PATCH /api/v1/agent/channel-apps/:id` | `context-composition` |
| `channels.create` | platform | tool | REPLACED | `POST /api/v1/agent/channels` | `context-composition` |
| `channels.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/channels/:id` | `context-composition` |
| `channels.get` | platform | tool | REPLACED | `GET /api/v1/agent/channels/:id` | `context-composition` |
| `channels.list` | platform | tool | REPLACED | `GET /api/v1/agent/channels` | `context-composition` |
| `channels.mint_from_manifest` | platform | tool | REPLACED | `POST /api/v1/agent/channels/mint` | `context-composition` |
| `channels.rotate_webhook_secret` | platform | tool | REPLACED | `POST /api/v1/agent/channels/:id/rotate-secret` | `context-composition` |
| `channels.update` | platform | tool | REPLACED | `PATCH /api/v1/agent/channels/:id` | `context-composition` |
| `clusters.add_agent` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `clusters.create` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `clusters.list` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `end_users.bind_external_id` | platform | tool | RETAINED | — | `contract-method` |
| `end_users.get` | platform | tool | RETAINED | — | `contract-method` |
| `end_users.link_identity` | platform | tool | RETAINED | — | `contract-method` |
| `end_users.unlink_identity` | platform | tool | RETAINED | — | `contract-method` |
| `entities.census` | platform | tool | RETAINED | — | `contract-method` |
| `entities.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/entities/:entityId` | `contract-method` |
| `entities.generate_mcp_token` | platform | tool | RETAINED | — | `contract-method` |
| `entities.get` | platform | tool | REPLACED | `GET /api/v1/agent/entities/:entityId` | `contract-method` |
| `entities.get_linked_agents` | platform | tool | RETAINED | — | `contract-method` |
| `entities.get_mcp_config` | platform | tool | REPLACED | `GET /api/v1/agent/entities/:entityId/mcp/config` | `contract-method` |
| `entities.get_test_credentials` | platform | tool | REPLACED | `GET /api/v1/agent/entities/:entityId/test-credentials` | `contract-method` |
| `entities.get_tools` | platform | tool | RETAINED | — | `contract-method` |
| `entities.list` | platform | tool | REPLACED | `GET /api/v1/agent/entities` | `contract-method` |
| `entities.provision` | platform | tool | MAPPED | `tools.discoverEntityTools`, `tools.registerTools` | `transport-move` |
| `entities.refresh_discovery` | platform | tool | REPLACED | `POST /api/v1/agent/entities/:entityId/refresh-discovery` | `contract-method` |
| `entities.regenerate_secret` | platform | tool | REPLACED | `POST /api/v1/agent/entities/:entityId/regenerate-secret` | `contract-method` |
| `entities.register` | platform | tool | REPLACED | `POST /api/v1/agent/entities` | `contract-method` |
| `entities.set_linked_agents` | platform | tool | RETAINED | — | `contract-method` |
| `entities.set_mcp_enabled` | platform | tool | RETAINED | — | `contract-method` |
| `entities.set_mcp_inject_context` | platform | tool | RETAINED | — | `contract-method` |
| `entities.set_test_credentials` | platform | tool | RETAINED | — | `contract-method` |
| `entities.set_tool_acl` | platform | tool | RETAINED | — | `contract-method` |
| `entities.update` | platform | tool | REPLACED | `PATCH /api/v1/agent/entities/:entityId` | `contract-method` |
| `entities.wire_test` | platform | tool | REPLACED | `POST /api/v1/agent/entities/:entityId/wire-test` | `contract-method` |
| `environments.create` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `environments.delete` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `environments.delete_secret` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `environments.list` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `environments.list_secrets` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `environments.set_secret` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `evals.dispatch` | platform | tool | REPLACED | `POST /api/v1/agent/evals/dispatch` | `contract-method` |
| `evals.get` | platform | tool | REPLACED | `GET /api/v1/agent/evals/:evalId` | `contract-method` |
| `evals.list` | platform | tool | REPLACED | `GET /api/v1/agent/evals` | `contract-method` |
| `evals.regression_sweep` | platform | tool | MAPPED | `tools.discoverEntityTools`, `tools.registerTools` | `transport-move` |
| `events.recent` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `events.subscribe` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `gdpr.export` | platform | tool | RETAINED | — | `contract-method` |
| `gdpr.export_user_everywhere` | platform | tool | RETAINED | — | `contract-method` |
| `gdpr.import` | platform | tool | RETAINED | — | `contract-method` |
| `gdpr.purge` | platform | tool | RETAINED | — | `contract-method` |
| `health.check` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `jobs.create` | platform | tool | REPLACED | `POST /api/v1/agent/jobs` | `context-composition` |
| `jobs.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/jobs/:id` | `context-composition` |
| `jobs.dispatch` | platform | tool | REPLACED | `POST /api/v1/agent/jobs/:id/dispatch` | `context-composition` |
| `jobs.get` | platform | tool | REPLACED | `GET /api/v1/agent/jobs/:id` | `context-composition` |
| `jobs.list` | platform | tool | REPLACED | `GET /api/v1/agent/jobs` | `context-composition` |
| `jobs.set_enabled` | platform | tool | RETAINED | — | `context-composition` |
| `jobs.update` | platform | tool | REPLACED | `PATCH /api/v1/agent/jobs/:id` | `context-composition` |
| `jobs.validate_handler` | platform | tool | RETAINED | — | `context-composition` |
| `kg.create_node` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.delete_node` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.discover_links` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.get_entity` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.link_nodes` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.list_entities` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.search_entities` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `kg.update_node` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `macros.delete` | platform | tool | RETAINED | — | `context-composition` |
| `macros.get` | platform | tool | RETAINED | — | `context-composition` |
| `macros.list` | platform | tool | RETAINED | — | `context-composition` |
| `macros.record_start` | platform | tool | RETAINED | — | `context-composition` |
| `macros.record_stop` | platform | tool | RETAINED | — | `context-composition` |
| `macros.replay` | platform | tool | RETAINED | — | `context-composition` |
| `macros.share` | platform | tool | RETAINED | — | `context-composition` |
| `macros.update` | platform | tool | RETAINED | — | `context-composition` |
| `mcp.list_clients` | platform | tool | RETAINED | — | `contract-method` |
| `mcp.list_tokens` | platform | tool | RETAINED | — | `contract-method` |
| `memories.archive` | platform | tool | RETAINED | — | `contract-method` |
| `memories.bulk_delete` | platform | tool | RETAINED | — | `contract-method` |
| `memories.delete` | platform | tool | REPLACED | `DELETE /api/v1/memory/:id` | `contract-method` |
| `memories.extract_now` | platform | tool | REPLACED | `POST /api/v1/memory/extract` | `contract-method` |
| `memories.get` | platform | tool | RETAINED | — | `contract-method` |
| `memories.list` | platform | tool | REPLACED | `GET /api/v1/memory` | `contract-method` |
| `memories.restore` | platform | tool | RETAINED | — | `contract-method` |
| `memories.search` | platform | tool | REPLACED | `GET /api/v1/memory/search` | `contract-method` |
| `memories.upsert` | platform | tool | REPLACED | `POST /api/v1/memory` | `contract-method` |
| `messages.list` | platform | tool | REPLACED | `GET /api/v1/agent/threads/:threadId/messages` | `no-orm-site-in-declaring-file` |
| `messages.rate` | platform | tool | REPLACED | `POST /api/v1/agent/messages/:messageId/rating` | `no-orm-site-in-declaring-file` |
| `monitoring.cost.daily` | platform | tool | RETAINED | — | `contract-method` |
| `monitoring.cost.range` | platform | tool | RETAINED | — | `contract-method` |
| `notifications.delete` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `notifications.get` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `notifications.list` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `notifications.register` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `notifications.test` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `notifications.update` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `oauth.create_client` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `oauth.delete_client` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `oauth.list_clients` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `oauth.list_tokens` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `oauth.revoke_token` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `oauth.rotate_secret` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `org.add_member` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `org.get` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `org.list` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `org.list_members` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `org.remove_member` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `org.set_member_role` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `org.update` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `platos.diff_agents` | platform | tool | RETAINED | — | `context-composition` |
| `platos.explain_turn` | platform | tool | RETAINED | — | `context-composition` |
| `platos.list_accessible_scopes` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `platos.simulate_turn` | platform | tool | RETAINED | — | `context-composition` |
| `platos.whoami` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `projects.list_all` | platform | tool | MAPPED | `tenancy.listVisibleProjects` | `transport-move` |
| `providers.add_key` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.delete_key` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.get` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.get_routes` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.link` | platform | tool | REPLACED | `POST /api/v1/agent/providers/:provider/link` | `contract-method` |
| `providers.list` | platform | tool | REPLACED | `GET /api/v1/agent/providers` | `contract-method` |
| `providers.list_keys` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.rotate_key` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.set_routes` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.test_credentials` | platform | tool | MAPPED | `providers.listProviderKeys` | `transport-move` |
| `providers.unlink` | platform | tool | REPLACED | `DELETE /api/v1/agent/providers/:provider/link` | `contract-method` |
| `scopes.bootstrap_demo_data` | platform | tool | MAPPED | `tools.discoverEntityTools`, `tools.registerTools` | `transport-move` |
| `scopes.list_all` | platform | tool | RETAINED | — | `contract-method` |
| `skills.disable` | platform | tool | REPLACED | `DELETE /api/v1/agent/skills/agent/:agentId/:id` | `no-orm-site-in-declaring-file` |
| `skills.disable_globally` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `skills.enable` | platform | tool | REPLACED | `POST /api/v1/agent/skills/agent/:agentId/:id` | `no-orm-site-in-declaring-file` |
| `skills.get` | platform | tool | REPLACED | `GET /api/v1/agent/skills/:id` | `no-orm-site-in-declaring-file` |
| `skills.get_installed_config` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `skills.install` | platform | tool | REPLACED | `POST /api/v1/agent/skills/import` | `no-orm-site-in-declaring-file` |
| `skills.list` | platform | tool | REPLACED | `GET /api/v1/agent/skills` | `no-orm-site-in-declaring-file` |
| `skills.uninstall` | platform | tool | REPLACED | `DELETE /api/v1/agent/skills/:id` | `no-orm-site-in-declaring-file` |
| `skills.update` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `threads.create` | platform | tool | REPLACED | `POST /api/v1/agent/threads` | `no-orm-site-in-declaring-file` |
| `threads.delete` | platform | tool | REPLACED | `DELETE /api/v1/agent/threads/:threadId` | `no-orm-site-in-declaring-file` |
| `threads.edit_and_rerun` | platform | tool | REPLACED | `POST /api/v1/agent/threads/:threadId/messages/:messageId/edit-and-rerun` | `no-orm-site-in-declaring-file` |
| `threads.fork` | platform | tool | REPLACED | `POST /api/v1/agent/threads/:threadId/fork` | `no-orm-site-in-declaring-file` |
| `threads.get` | platform | tool | REPLACED | `GET /api/v1/agent/threads/:threadId` | `no-orm-site-in-declaring-file` |
| `threads.list` | platform | tool | REPLACED | `GET /api/v1/agent/threads` | `no-orm-site-in-declaring-file` |
| `threads.update` | platform | tool | REPLACED | `PATCH /api/v1/agent/threads/:threadId` | `no-orm-site-in-declaring-file` |
| `tool_calls.cross_scope_audit` | platform | tool | RETAINED | — | `contract-method` |
| `tool_calls.list` | platform | tool | REPLACED | `GET /api/v1/agent/tool-calls` | `contract-method` |
| `traces.get` | platform | tool | REPLACED | `GET /api/v1/agent/monitoring/trace/:threadId` | `no-orm-site-in-declaring-file` |
| `traces.list` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.batches.get` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.deployments.get` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.deployments.promote` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.queues.list` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.queues.pause` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.queues.resume` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.runs.cancel` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.runs.get` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.runs.list` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.runs.replay` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.schedules.activate` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.schedules.create` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.schedules.deactivate` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.schedules.delete` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.schedules.get` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.schedules.list` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.tasks.trigger` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
| `trigger.workers.list` | platform | tool | RETAINED | — | `no-orm-site-in-declaring-file` |
