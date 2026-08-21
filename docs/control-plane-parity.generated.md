# Platos control-plane parity report (generated)

> Deterministic WIN-129 artifact. Do not edit by hand; run `pnpm --filter platos-agent generate:control-plane`.

The **explicit operation manifest** is canonical. Platform MCP metadata is seeded from the 206 runtime-shaped handler declarations; REST metadata is derived from Nest controller decorators. Compact policy rules classify every operation. MCP schemas are authoritative for MCP calls; generated OpenAPI intentionally does not invent REST request/response schemas.

## Summary

- MCP tools: **206** across **35** namespaces (24 admin-tier).
- REST operations: **290** unique method/path pairs from **291** route bindings.
- Ambiguous duplicate REST method/path pairs: **1**.
- MCP classifications: MAPPED=83, MCP_ONLY=123.
- REST classifications: DEPRECATED=13, INTERNAL=13, MAPPED=82, PUBLIC_TRANSPORT=45, REST_ONLY=137.

## REST inventory

| REST operation | Classification | MCP mapping | Semantic rationale / policy | Implementation(s) |
| --- | --- | --- | --- | --- |
| `GET /.well-known/oauth-authorization-server` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#metadata` |
| `GET /.well-known/oauth-authorization-server/entity/:entityId` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityMetadata` |
| `GET /api/health` | PUBLIC_TRANSPORT | — | `service-observability` | `apps/agent/src/health/health.controller.ts#health` |
| `DELETE /api/v1/agent/access-key` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#deleteAccessKey` |
| `GET /api/v1/agent/access-key` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getAccessKey` |
| `POST /api/v1/agent/access-key` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#createOrRotateAccessKey` |
| `POST /api/v1/agent/access-key/origins` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#setAllowedOrigins` |
| `GET /api/v1/agent/activity/recent` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#recentActivity` |
| `POST /api/v1/agent/admin/privacy/erasures` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/privacy/erasure.controller.ts#create` |
| `GET /api/v1/agent/admin/privacy/erasures/:operationId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/privacy/erasure.controller.ts#get` |
| `POST /api/v1/agent/admin/privacy/erasures/:operationId/retry` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/privacy/erasure.controller.ts#retry` |
| `POST /api/v1/agent/admin/privacy/erasures/resume-due` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/privacy/erasure.controller.ts#resumeDue` |
| `GET /api/v1/agent/admin/privacy/subjects/:externalUserId/inventory` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/privacy/erasure.controller.ts#inventory` |
| `GET /api/v1/agent/agents` | MAPPED | `agents.list` | Reviewed behavioral equivalence: the REST adapter and agents.list invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listAgents` |
| `POST /api/v1/agent/agents` | MAPPED | `agents.create` | Reviewed behavioral equivalence: the REST adapter and agents.create invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#createAgent` |
| `DELETE /api/v1/agent/agents/:agentId` | MAPPED | `agents.delete` | Reviewed behavioral equivalence: the REST adapter and agents.delete invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#deleteAgent` |
| `GET /api/v1/agent/agents/:agentId` | MAPPED | `agents.get` | Reviewed behavioral equivalence: the REST adapter and agents.get invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getAgent` |
| `PATCH /api/v1/agent/agents/:agentId` | MAPPED | `agents.update` | Reviewed behavioral equivalence: the REST adapter and agents.update invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#updateAgent` |
| `PATCH /api/v1/agent/agents/:agentId/canary` | MAPPED | `agents.canary.set` | Reviewed behavioral equivalence: the REST adapter and agents.canary.set invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#setAgentCanary` |
| `GET /api/v1/agent/agents/:agentId/canary/metrics` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getAgentCanaryMetrics` |
| `POST /api/v1/agent/agents/:agentId/canary/promote` | MAPPED | `agents.canary.promote` | Reviewed behavioral equivalence: the REST adapter and agents.canary.promote invoke the same scope-pinned AgentCrudService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#promoteAgentCanary` |
| `GET /api/v1/agent/agents/:agentId/categories` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getAgentCategories` |
| `GET /api/v1/agent/agents/:agentId/chat/stream` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#agentChatStream` |
| `GET /api/v1/agent/agents/:agentId/evals/aggregate` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#aggregateEvals` |
| `PATCH /api/v1/agent/agents/:agentId/feature-flags` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#setAgentFeatureFlags` |
| `POST /api/v1/agent/agents/:agentId/messages` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#agentMessages` |
| `GET /api/v1/agent/agents/:agentId/satisfaction` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getAgentSatisfaction` |
| `GET /api/v1/agent/agents/:agentId/tool-mappings` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getAgentToolMappings` |
| `GET /api/v1/agent/agents/:agentId/versions` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#listAgentVersions` |
| `GET /api/v1/agent/agents/:agentId/versions/:versionId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getAgentVersion` |
| `POST /api/v1/agent/agents/:agentId/versions/:versionId/rollback` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#rollbackAgentVersion` |
| `POST /api/v1/agent/approvals/:approvalId/resolve` | MAPPED | `approvals.resolve` | Reviewed behavioral equivalence: the REST adapter and approvals.resolve invoke the same scope-pinned MonitoringApprovalsService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#resolveApproval` |
| `GET /api/v1/agent/budgets` | MAPPED | `budgets.list` | Reviewed behavioral equivalence: the REST adapter and budgets.list invoke the same scope-pinned BudgetService cap operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listBudgets` |
| `POST /api/v1/agent/budgets` | MAPPED | `budgets.upsert` | Reviewed behavioral equivalence: the REST adapter and budgets.upsert invoke the same scope-pinned BudgetService cap operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#upsertBudget` |
| `DELETE /api/v1/agent/budgets/:capId` | MAPPED | `budgets.delete` | Reviewed behavioral equivalence: the REST adapter and budgets.delete invoke the same scope-pinned BudgetService cap operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#deleteBudget` |
| `POST /api/v1/agent/budgets/:capId/override` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#overrideBudget` |
| `GET /api/v1/agent/budgets/status` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#budgetStatus` |
| `GET /api/v1/agent/channel-apps` | MAPPED | `channel_apps.list` | Reviewed behavioral equivalence: the REST adapter and channel_apps.list invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#list` |
| `POST /api/v1/agent/channel-apps` | MAPPED | `channel_apps.create` | Reviewed behavioral equivalence: the REST adapter and channel_apps.create invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#create` |
| `DELETE /api/v1/agent/channel-apps/:id` | MAPPED | `channel_apps.delete` | Reviewed behavioral equivalence: the REST adapter and channel_apps.delete invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#remove` |
| `GET /api/v1/agent/channel-apps/:id` | MAPPED | `channel_apps.get` | Reviewed behavioral equivalence: the REST adapter and channel_apps.get invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#getOne` |
| `PATCH /api/v1/agent/channel-apps/:id` | MAPPED | `channel_apps.update` | Reviewed behavioral equivalence: the REST adapter and channel_apps.update invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#update` |
| `GET /api/v1/agent/channel-apps/:id/installations` | MAPPED | `channel_apps.list_installations` | Reviewed behavioral equivalence: the REST adapter and channel_apps.list_installations invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#listInstallations` |
| `DELETE /api/v1/agent/channel-apps/:id/installations/:installationId` | MAPPED | `channel_apps.revoke_installation` | Reviewed behavioral equivalence: the REST adapter and channel_apps.revoke_installation invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#revokeInstallation` |
| `POST /api/v1/agent/channel-apps/:id/installations/:installationId/bind` | MAPPED | `channel_apps.bind_installation` | Reviewed behavioral equivalence: the REST adapter and channel_apps.bind_installation invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#bindInstallation` |
| `POST /api/v1/agent/channel-apps/:id/installations/import` | MAPPED | `channel_apps.import_installation` | Reviewed behavioral equivalence: the REST adapter and channel_apps.import_installation invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#importInstallation` |
| `GET /api/v1/agent/channel-apps/:id/installations/status` | MAPPED | `channel_apps.installations_status` | Reviewed behavioral equivalence: the REST adapter and channel_apps.installations_status invoke the same scope-pinned channel-app persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channel-apps.controller.ts#installationsStatus` |
| `GET /api/v1/agent/channels` | MAPPED | `channels.list` | Reviewed behavioral equivalence: the REST adapter and channels.list invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#list` |
| `POST /api/v1/agent/channels` | MAPPED | `channels.create` | Reviewed behavioral equivalence: the REST adapter and channels.create invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#create` |
| `DELETE /api/v1/agent/channels/:id` | MAPPED | `channels.delete` | Reviewed behavioral equivalence: the REST adapter and channels.delete invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#remove` |
| `GET /api/v1/agent/channels/:id` | MAPPED | `channels.get` | Reviewed behavioral equivalence: the REST adapter and channels.get invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#getOne` |
| `PATCH /api/v1/agent/channels/:id` | MAPPED | `channels.update` | Reviewed behavioral equivalence: the REST adapter and channels.update invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#update` |
| `POST /api/v1/agent/channels/:id/rotate-secret` | MAPPED | `channels.rotate_webhook_secret` | Reviewed behavioral equivalence: the REST adapter and channels.rotate_webhook_secret invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#rotateSecret` |
| `POST /api/v1/agent/channels/mint` | MAPPED | `channels.mint_from_manifest` | Reviewed behavioral equivalence: the REST adapter and channels.mint_from_manifest invoke the same scope-pinned channel persistence operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/channels.controller.ts#mintFromManifest` |
| `GET /api/v1/agent/clusters` | MAPPED | `clusters.list` | Reviewed behavioral equivalence: the REST adapter and clusters.list invoke the same scope-pinned AgentClusterService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listClusters` |
| `POST /api/v1/agent/clusters` | MAPPED | `clusters.create` | Reviewed behavioral equivalence: the REST adapter and clusters.create invoke the same scope-pinned AgentClusterService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#createCluster` |
| `DELETE /api/v1/agent/clusters/:clusterId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#deleteCluster` |
| `GET /api/v1/agent/clusters/:clusterId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getCluster` |
| `PATCH /api/v1/agent/clusters/:clusterId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#updateCluster` |
| `POST /api/v1/agent/clusters/:clusterId/agents` | MAPPED | `clusters.add_agent` | Reviewed behavioral equivalence: the REST adapter and clusters.add_agent invoke the same scope-pinned AgentClusterService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#addAgentToCluster` |
| `DELETE /api/v1/agent/clusters/:clusterId/agents/:agentId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#removeAgentFromCluster` |
| `GET /api/v1/agent/connect` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#connectionDetails` |
| `POST /api/v1/agent/durable-approvals/:token/resolve` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#resolveDurableApproval` |
| `GET /api/v1/agent/entities` | MAPPED | `entities.list` | Reviewed behavioral equivalence: the REST adapter and entities.list invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listEntities` |
| `POST /api/v1/agent/entities` | MAPPED | `entities.register` | Reviewed behavioral equivalence: the REST adapter and entities.register invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#registerEntity` |
| `DELETE /api/v1/agent/entities/:entityId` | MAPPED | `entities.delete` | Reviewed behavioral equivalence: the REST adapter and entities.delete invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#deleteEntity` |
| `GET /api/v1/agent/entities/:entityId` | MAPPED | `entities.get` | Reviewed behavioral equivalence: the REST adapter and entities.get invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getEntity` |
| `PATCH /api/v1/agent/entities/:entityId` | MAPPED | `entities.update` | Reviewed behavioral equivalence: the REST adapter and entities.update invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#patchEntity` |
| `GET /api/v1/agent/entities/:entityId/mcp/config` | MAPPED | `entities.get_mcp_config` | Reviewed behavioral equivalence: the REST adapter and entities.get_mcp_config invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getEntityMcpConfig` |
| `PATCH /api/v1/agent/entities/:entityId/mcp/config` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#patchEntityMcpConfig` |
| `POST /api/v1/agent/entities/:entityId/refresh-discovery` | MAPPED | `entities.refresh_discovery` | Reviewed behavioral equivalence: the REST adapter and entities.refresh_discovery invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#refreshEntityDiscovery` |
| `POST /api/v1/agent/entities/:entityId/regenerate-secret` | MAPPED | `entities.regenerate_secret` | Reviewed behavioral equivalence: the REST adapter and entities.regenerate_secret invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#regenerateEntitySecret` |
| `GET /api/v1/agent/entities/:entityId/test-credentials` | MAPPED | `entities.get_test_credentials` | Reviewed behavioral equivalence: the REST adapter and entities.get_test_credentials invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getEntityTestCredentials` |
| `POST /api/v1/agent/entities/:entityId/wire-test` | MAPPED | `entities.wire_test` | Reviewed behavioral equivalence: the REST adapter and entities.wire_test invoke the same canonical Entity control-plane operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#wireTestEntity` |
| `GET /api/v1/agent/entities/check-availability` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#checkEntityAvailability` |
| `GET /api/v1/agent/eval-criteria` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#listCriteria` |
| `POST /api/v1/agent/eval-criteria` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#createCriterion` |
| `DELETE /api/v1/agent/eval-criteria/:criterionId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#deleteCriterion` |
| `GET /api/v1/agent/eval-criteria/:criterionId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getCriterion` |
| `PATCH /api/v1/agent/eval-criteria/:criterionId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#updateCriterion` |
| `GET /api/v1/agent/evals` | MAPPED | `evals.list` | Reviewed behavioral equivalence: the REST adapter and evals.list invoke the same scope-pinned EvalService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listEvals` |
| `GET /api/v1/agent/evals/:evalId` | MAPPED | `evals.get` | Reviewed behavioral equivalence: the REST adapter and evals.get invoke the same scope-pinned EvalService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getEval` |
| `POST /api/v1/agent/evals/run` | MAPPED | `evals.run` | Reviewed behavioral equivalence: the REST adapter and evals.run invoke the same scope-pinned EvalService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#runEval` |
| `GET /api/v1/agent/feature-flags` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#listFeatureFlags` |
| `GET /api/v1/agent/files/agents` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/files/files.controller.ts#listAgents` |
| `GET /api/v1/agent/files/agents/:agentId/users` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/files/files.controller.ts#listUsers` |
| `GET /api/v1/agent/files/agents/:agentId/users/:userId/conversations` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/files/files.controller.ts#listConversations` |
| `GET /api/v1/agent/files/threads/:threadId/attachments` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/files/files.controller.ts#listAttachments` |
| `GET /api/v1/agent/golden-sets` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#listGoldenSets` |
| `POST /api/v1/agent/golden-sets` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#createGoldenSet` |
| `DELETE /api/v1/agent/golden-sets/:goldenSetId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#deleteGoldenSet` |
| `GET /api/v1/agent/golden-sets/:goldenSetId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getGoldenSet` |
| `PATCH /api/v1/agent/golden-sets/:goldenSetId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#updateGoldenSet` |
| `POST /api/v1/agent/golden-sets/:goldenSetId/run` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#runGoldenSet` |
| `POST /api/v1/agent/internal/budget-alert` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalBudgetAlert` |
| `POST /api/v1/agent/internal/chat/reap-sessions` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalChatReapSessions` |
| `POST /api/v1/agent/internal/chat/stream-turn` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalChatStreamTurn` |
| `POST /api/v1/agent/internal/compaction` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalCompaction` |
| `POST /api/v1/agent/internal/durable-turn` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalDurableTurn` |
| `POST /api/v1/agent/internal/employee-run` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalEmployeeRun` |
| `POST /api/v1/agent/internal/platos-tasks/execute` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/platos-task-execution.controller.ts#execute` |
| `POST /api/v1/agent/internal/skill-run` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalSkillRun` |
| `POST /api/v1/agent/internal/subagent-report` | INTERNAL | — | `agent-internal-prefix` | `apps/agent/src/agent-runtime/agent.controller.ts#internalSubagentReport` |
| `DELETE /api/v1/agent/messages/:messageId/rating` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#unrateMessage` |
| `GET /api/v1/agent/messages/:messageId/rating` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getMessageRating` |
| `POST /api/v1/agent/messages/:messageId/rating` | MAPPED | `messages.rate` | Reviewed behavioral equivalence: the REST adapter and messages.rate invoke the same scope-pinned conversation/rating operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#rateMessage` |
| `GET /api/v1/agent/monitoring/agent-scorecard` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#agentScorecard` |
| `GET /api/v1/agent/monitoring/agent/:agentId/cache-range` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#agentCacheRange` |
| `GET /api/v1/agent/monitoring/agents` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringAgents` |
| `GET /api/v1/agent/monitoring/approvals` | MAPPED | `approvals.list` | Reviewed behavioral equivalence: the REST adapter and approvals.list invoke the same scope-pinned MonitoringApprovalsService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listApprovals` |
| `GET /api/v1/agent/monitoring/approvals/:approvalId` | MAPPED | `approvals.get` | Reviewed behavioral equivalence: the REST adapter and approvals.get invoke the same scope-pinned MonitoringApprovalsService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getApproval` |
| `POST /api/v1/agent/monitoring/approvals/expiry-sweep` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#expireApprovals` |
| `GET /api/v1/agent/monitoring/breaches` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringBreaches` |
| `POST /api/v1/agent/monitoring/budget/email` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#sendBudgetEmail` |
| `GET /api/v1/agent/monitoring/cost` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getScopeCost` |
| `GET /api/v1/agent/monitoring/cost-by-agent` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#costByAgent` |
| `GET /api/v1/agent/monitoring/cost-by-model` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#costByModel` |
| `GET /api/v1/agent/monitoring/cost-by-user` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#costByUser` |
| `POST /api/v1/agent/monitoring/cost/catalog` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#ingestCostCatalog` |
| `POST /api/v1/agent/monitoring/cost/reconcile` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#reconcileCost` |
| `GET /api/v1/agent/monitoring/cost/skills/daily` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#skillCostDaily` |
| `GET /api/v1/agent/monitoring/cost/skills/range` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#skillCostRange` |
| `GET /api/v1/agent/monitoring/cost/thread/:threadId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getThreadCost` |
| `GET /api/v1/agent/monitoring/cost/user/:userId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getUserCost` |
| `POST /api/v1/agent/monitoring/dlq/drain` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#drainDlq` |
| `GET /api/v1/agent/monitoring/governance` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#governanceDashboard` |
| `GET /api/v1/agent/monitoring/memory-extraction/health` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#memoryExtractionHealth` |
| `GET /api/v1/agent/monitoring/observability/status` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#observabilityStatus` |
| `GET /api/v1/agent/monitoring/safety-events` | MAPPED | `audit.safety_events.query` | Reviewed behavioral equivalence: the REST adapter and audit.safety_events.query invoke the same scope-pinned monitoring audit query; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listSafetyEvents` |
| `GET /api/v1/agent/monitoring/summary` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringSummary` |
| `GET /api/v1/agent/monitoring/tool-audit` | MAPPED | `audit.tool_calls.query` | Reviewed behavioral equivalence: the REST adapter and audit.tool_calls.query invoke the same scope-pinned monitoring audit query; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listToolAudit` |
| `GET /api/v1/agent/monitoring/tool-audit/:callId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getToolAudit` |
| `POST /api/v1/agent/monitoring/tool-audit/:callId/replay` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#replayToolAudit` |
| `GET /api/v1/agent/monitoring/top-users` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#topUsers` |
| `GET /api/v1/agent/monitoring/trace/:threadId` | MAPPED | `traces.get`, `runs.get_trace` | Reviewed behavioral equivalence: the REST adapter and traces.get, runs.get_trace invoke the same scope-pinned TraceService thread trace operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getThreadTrace` |
| `GET /api/v1/agent/monitoring/users` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringUsers` |
| `GET /api/v1/agent/monitoring/users/:userId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringUserDetail` |
| `GET /api/v1/agent/monitoring/users/:userId/consumption` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringUserConsumption` |
| `POST /api/v1/agent/monitoring/users/:userId/summary` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#monitoringUserSummary` |
| `GET /api/v1/agent/monitoring/utilization` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#utilization` |
| `GET /api/v1/agent/openapi.json` | PUBLIC_TRANSPORT | — | `generated-api-description` | `apps/agent/src/openapi/openapi.controller.ts#getSpec` |
| `GET /api/v1/agent/platos-tasks` | MAPPED | `platos_tasks.list` | Reviewed behavioral equivalence: the REST adapter and platos_tasks.list invoke the same Environment-owned Job operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/platos-tasks.controller.ts#list` |
| `POST /api/v1/agent/platos-tasks` | MAPPED | `platos_tasks.create` | Reviewed behavioral equivalence: the REST adapter and platos_tasks.create invoke the same Environment-owned Job operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/platos-tasks.controller.ts#create` |
| `DELETE /api/v1/agent/platos-tasks/:id` | MAPPED | `platos_tasks.delete` | Reviewed behavioral equivalence: the REST adapter and platos_tasks.delete invoke the same Environment-owned Job operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/platos-tasks.controller.ts#remove` |
| `GET /api/v1/agent/platos-tasks/:id` | MAPPED | `platos_tasks.get` | Reviewed behavioral equivalence: the REST adapter and platos_tasks.get invoke the same Environment-owned Job operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/platos-tasks.controller.ts#getOne` |
| `PATCH /api/v1/agent/platos-tasks/:id` | MAPPED | `platos_tasks.update` | Reviewed behavioral equivalence: the REST adapter and platos_tasks.update invoke the same Environment-owned Job operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/platos-tasks.controller.ts#update` |
| `POST /api/v1/agent/platos-tasks/:id/run` | MAPPED | `platos_tasks.run` | Reviewed behavioral equivalence: the REST adapter and platos_tasks.run invoke the same Environment-owned Job operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/platos-tasks.controller.ts#run` |
| `GET /api/v1/agent/postman-templates` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#listPostmanTemplates` |
| `POST /api/v1/agent/postman-templates` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#createPostmanTemplate` |
| `DELETE /api/v1/agent/postman-templates/:id` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#deletePostmanTemplate` |
| `PUT /api/v1/agent/postman-templates/:id` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#updatePostmanTemplate` |
| `POST /api/v1/agent/prompt/assemble` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#assemblePrompt` |
| `GET /api/v1/agent/prompt/defaults` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getDefaultBlocks` |
| `POST /api/v1/agent/prompt/preview` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#previewPrompt` |
| `GET /api/v1/agent/providers` | MAPPED | `providers.list` | Reviewed behavioral equivalence: the REST adapter and providers.list invoke the same authorized provider registry/key operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listProviders`<br>`apps/agent/src/providers/providers.controller.ts#listProviders` |
| `PATCH /api/v1/agent/providers/:provider` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#toggleProvider` |
| `GET /api/v1/agent/providers/:provider/health` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#testProvider` |
| `DELETE /api/v1/agent/providers/:provider/link` | MAPPED | `providers.unlink` | Reviewed behavioral equivalence: the REST adapter and providers.unlink invoke the same authorized provider registry/key operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#unlinkProvider` |
| `POST /api/v1/agent/providers/:provider/link` | MAPPED | `providers.link` | Reviewed behavioral equivalence: the REST adapter and providers.link invoke the same authorized provider registry/key operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#linkProvider` |
| `GET /api/v1/agent/providers/health` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#checkProviderHealth` |
| `GET /api/v1/agent/providers/keys` | MAPPED | `providers.list_keys` | Reviewed behavioral equivalence: the REST adapter and providers.list_keys invoke the same authorized provider registry/key operation; only transport parameters/envelopes differ. | `apps/agent/src/providers/providers.controller.ts#listKeys` |
| `POST /api/v1/agent/providers/keys` | MAPPED | `providers.add_key` | Reviewed behavioral equivalence: the REST adapter and providers.add_key invoke the same authorized provider registry/key operation; only transport parameters/envelopes differ. | `apps/agent/src/providers/providers.controller.ts#createKey` |
| `DELETE /api/v1/agent/providers/keys/:id` | MAPPED | `providers.delete_key` | Reviewed behavioral equivalence: the REST adapter and providers.delete_key invoke the same authorized provider registry/key operation; only transport parameters/envelopes differ. | `apps/agent/src/providers/providers.controller.ts#deleteKey` |
| `PATCH /api/v1/agent/providers/keys/:id` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/providers/providers.controller.ts#updateKey` |
| `POST /api/v1/agent/providers/keys/:id/rotate-secret` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/providers/providers.controller.ts#rotateKeySecret` |
| `POST /api/v1/agent/providers/keys/byok` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/providers/providers.controller.ts#createKeyWithSecret` |
| `GET /api/v1/agent/providers/models` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#availableModels` |
| `GET /api/v1/agent/secrets/status` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#secretsStatus` |
| `GET /api/v1/agent/skills` | MAPPED | `skills.list` | Reviewed behavioral equivalence: the REST adapter and skills.list invoke the same scope-pinned skill registry/import operation; only transport parameters/envelopes differ. | `apps/agent/src/skills/skills.controller.ts#list` |
| `POST /api/v1/agent/skills` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/skills/skills.controller.ts#create` |
| `DELETE /api/v1/agent/skills/:id` | MAPPED | `skills.uninstall` | Reviewed behavioral equivalence: the REST adapter and skills.uninstall invoke the same scope-pinned skill registry/import operation; only transport parameters/envelopes differ. | `apps/agent/src/skills/skills.controller.ts#remove` |
| `GET /api/v1/agent/skills/:id` | MAPPED | `skills.get` | Reviewed behavioral equivalence: the REST adapter and skills.get invoke the same scope-pinned skill registry/import operation; only transport parameters/envelopes differ. | `apps/agent/src/skills/skills.controller.ts#getOne` |
| `GET /api/v1/agent/skills/agent/:agentId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/skills/skills.controller.ts#listForAgent` |
| `DELETE /api/v1/agent/skills/agent/:agentId/:id` | MAPPED | `skills.disable` | Reviewed behavioral equivalence: the REST adapter and skills.disable invoke the same scope-pinned skill registry/import operation; only transport parameters/envelopes differ. | `apps/agent/src/skills/skills.controller.ts#removeFromAgent` |
| `POST /api/v1/agent/skills/agent/:agentId/:id` | MAPPED | `skills.enable` | Reviewed behavioral equivalence: the REST adapter and skills.enable invoke the same scope-pinned skill registry/import operation; only transport parameters/envelopes differ. | `apps/agent/src/skills/skills.controller.ts#enableForAgent` |
| `GET /api/v1/agent/skills/health` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/skills/skills.controller.ts#health` |
| `POST /api/v1/agent/skills/import` | MAPPED | `skills.install` | Reviewed behavioral equivalence: the REST adapter and skills.install invoke the same scope-pinned skill registry/import operation; only transport parameters/envelopes differ. | `apps/agent/src/skills/skills.controller.ts#importFromUrl` |
| `GET /api/v1/agent/threads` | MAPPED | `threads.list` | Reviewed behavioral equivalence: the REST adapter and threads.list invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listThreads` |
| `POST /api/v1/agent/threads` | MAPPED | `threads.create` | Reviewed behavioral equivalence: the REST adapter and threads.create invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#createThread` |
| `DELETE /api/v1/agent/threads/:threadId` | MAPPED | `threads.delete` | Reviewed behavioral equivalence: the REST adapter and threads.delete invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#deleteThread` |
| `GET /api/v1/agent/threads/:threadId` | MAPPED | `threads.get` | Reviewed behavioral equivalence: the REST adapter and threads.get invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getThread` |
| `PATCH /api/v1/agent/threads/:threadId` | MAPPED | `threads.update` | Reviewed behavioral equivalence: the REST adapter and threads.update invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#updateThread` |
| `POST /api/v1/agent/threads/:threadId/archive` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#archiveThread` |
| `GET /api/v1/agent/threads/:threadId/artifacts` | MAPPED | `artifacts.list` | Reviewed behavioral equivalence: the REST adapter and artifacts.list invoke the same scope-pinned attachment listing operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#listThreadArtifacts` |
| `POST /api/v1/agent/threads/:threadId/fork` | MAPPED | `threads.fork` | Reviewed behavioral equivalence: the REST adapter and threads.fork invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#forkThread` |
| `GET /api/v1/agent/threads/:threadId/messages` | MAPPED | `messages.list` | Reviewed behavioral equivalence: the REST adapter and messages.list invoke the same scope-pinned conversation/rating operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#getMessages` |
| `POST /api/v1/agent/threads/:threadId/messages` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#sendMessage` |
| `POST /api/v1/agent/threads/:threadId/messages/:messageId/edit-and-rerun` | MAPPED | `threads.edit_and_rerun` | Reviewed behavioral equivalence: the REST adapter and threads.edit_and_rerun invoke the same scope-pinned ConversationService operation; only transport parameters/envelopes differ. | `apps/agent/src/agent-runtime/agent.controller.ts#editAndRerun` |
| `GET /api/v1/agent/threads/:threadId/messages/:messageId/replies` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getMessageReplies` |
| `POST /api/v1/agent/threads/:threadId/messages/:messageId/retry` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#retryAssistant` |
| `POST /api/v1/agent/threads/:threadId/pin` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#togglePin` |
| `PATCH /api/v1/agent/threads/:threadId/rename` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#renameThread` |
| `GET /api/v1/agent/threads/:threadId/reply-counts` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#getReplyCounts` |
| `POST /api/v1/agent/threads/:threadId/stream` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#streamMessage` |
| `POST /api/v1/agent/threads/:threadId/tags` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#setTags` |
| `POST /api/v1/agent/threads/:threadId/unarchive` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#unarchiveThread` |
| `GET /api/v1/agent/tools` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#listTools` |
| `PATCH /api/v1/agent/tools/:entityId/:toolName/enabled` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#setToolEnabled` |
| `POST /api/v1/agent/tools/:toolId/test` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#testTool` |
| `POST /api/v1/agent/tools/execute` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#executeTool` |
| `GET /api/v1/agent/tools/matrix` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#toolMatrix` |
| `GET /api/v1/agent/tools/search` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#searchTools` |
| `GET /api/v1/agent/tools/stats` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/agent-runtime/agent.controller.ts#toolStats` |
| `POST /api/v1/channels/apps/:appId/events` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channel-app-events.controller.ts#events` |
| `GET /api/v1/channels/inbound/:connectionId/:webhookSecret` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channels-inbound.controller.ts#inboundGet` |
| `POST /api/v1/channels/inbound/:connectionId/:webhookSecret` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channels-inbound.controller.ts#inboundPost` |
| `GET /api/v1/channels/link/:nonce` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channel-link.controller.ts#redirect` |
| `GET /api/v1/channels/link/callback` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channel-link.controller.ts#callback` |
| `GET /api/v1/channels/oauth/:appId/callback` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channel-app-oauth.controller.ts#callback` |
| `GET /api/v1/channels/oauth/:appId/install` | PUBLIC_TRANSPORT | — | `channel-webhooks-and-oauth` | `apps/agent/src/channels/channel-app-oauth.controller.ts#install` |
| `POST /api/v1/entities/:entityId/session-tokens` | PUBLIC_TRANSPORT | — | `public-token-mint` | `apps/agent/src/auth/session-token.controller.ts#mint` |
| `GET /api/v1/memory` | MAPPED | `memories.list` | Reviewed behavioral equivalence: the REST adapter and memories.list invoke the same scope-pinned MemoryService operation; only transport parameters/envelopes differ. | `apps/agent/src/memory/memory.controller.ts#listMemories` |
| `POST /api/v1/memory` | MAPPED | `memories.upsert` | Reviewed behavioral equivalence: the REST adapter and memories.upsert invoke the same scope-pinned MemoryService operation; only transport parameters/envelopes differ. | `apps/agent/src/memory/memory.controller.ts#createMemory` |
| `DELETE /api/v1/memory/:id` | MAPPED | `memories.delete` | Reviewed behavioral equivalence: the REST adapter and memories.delete invoke the same scope-pinned MemoryService operation; only transport parameters/envelopes differ. | `apps/agent/src/memory/memory.controller.ts#deleteMemory` |
| `POST /api/v1/memory/:id` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#updateMemory` |
| `POST /api/v1/memory/admin/extraction-sweep` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#adminExtractionSweep` |
| `GET /api/v1/memory/export` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#exportBundle` |
| `POST /api/v1/memory/extract` | MAPPED | `memories.extract_now` | Reviewed behavioral equivalence: the REST adapter and memories.extract_now invoke the same scope-pinned MemoryService operation; only transport parameters/envelopes differ. | `apps/agent/src/memory/memory.controller.ts#manualExtract` |
| `GET /api/v1/memory/graph/entities` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#listEntities` |
| `GET /api/v1/memory/graph/entities/:id/relationships` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#getRelationships` |
| `GET /api/v1/memory/graph/path` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#getShortestPath` |
| `POST /api/v1/memory/import` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#importBundle` |
| `POST /api/v1/memory/relate` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/memory/memory.controller.ts#relate` |
| `GET /api/v1/memory/search` | MAPPED | `memories.search` | Reviewed behavioral equivalence: the REST adapter and memories.search invoke the same scope-pinned MemoryService operation; only transport parameters/envelopes differ. | `apps/agent/src/memory/memory.controller.ts#searchMemories` |
| `GET /api/v1/platos/memory` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#listMemories` |
| `POST /api/v1/platos/memory` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#createMemory` |
| `DELETE /api/v1/platos/memory/:id` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#deleteMemory` |
| `POST /api/v1/platos/memory/:id` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#updateMemory` |
| `POST /api/v1/platos/memory/admin/extraction-sweep` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#adminExtractionSweep` |
| `GET /api/v1/platos/memory/export` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#exportBundle` |
| `POST /api/v1/platos/memory/extract` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#manualExtract` |
| `GET /api/v1/platos/memory/graph/entities` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#listEntities` |
| `GET /api/v1/platos/memory/graph/entities/:id/relationships` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#getRelationships` |
| `GET /api/v1/platos/memory/graph/path` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#getShortestPath` |
| `POST /api/v1/platos/memory/import` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#importBundle` |
| `POST /api/v1/platos/memory/relate` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#relate` |
| `GET /api/v1/platos/memory/search` | DEPRECATED | — | `legacy-platos-memory-prefix` | `apps/agent/src/memory/memory.controller.ts#searchMemories` |
| `POST /api/v1/public/guest-token` | PUBLIC_TRANSPORT | — | `public-token-mint` | `apps/agent/src/auth/public-guest-token.controller.ts#mint` |
| `POST /internal/batch-turn` | INTERNAL | — | `internal-prefix` | `apps/agent/src/trigger-bridge/internal-execute-tool.controller.ts#batchTurn` |
| `POST /internal/env/invalidate` | INTERNAL | — | `internal-prefix` | `apps/agent/src/trigger-bridge/internal-execute-tool.controller.ts#invalidateEnv` |
| `POST /internal/execute-tool` | INTERNAL | — | `internal-prefix` | `apps/agent/src/trigger-bridge/internal-execute-tool.controller.ts#executeTool` |
| `POST /internal/subagent-turn` | INTERNAL | — | `internal-prefix` | `apps/agent/src/trigger-bridge/internal-execute-tool.controller.ts#subagentTurn` |
| `GET /mcp` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#getInfo` |
| `POST /mcp` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#jsonRpc` |
| `GET /mcp/docs` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#getInfo` |
| `POST /mcp/docs` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#jsonRpc` |
| `POST /mcp/docs/messages` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#messages` |
| `GET /mcp/docs/sse` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#sse` |
| `GET /mcp/entity` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#listMcps` |
| `POST /mcp/entity/:entityId` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#jsonRpc` |
| `PATCH /mcp/entity/:entityId/branding` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#updateBranding` |
| `GET /mcp/entity/:entityId/config` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#getMcpConfig` |
| `PATCH /mcp/entity/:entityId/enabled` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#setEnabled` |
| `GET /mcp/entity/:entityId/events/subscribe` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#eventsSubscribe` |
| `PATCH /mcp/entity/:entityId/identity` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#updateIdentityMode` |
| `PATCH /mcp/entity/:entityId/inject-context` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#setInjectMcpContext` |
| `POST /mcp/entity/:entityId/messages` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#messages` |
| `GET /mcp/entity/:entityId/sse` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#sse` |
| `GET /mcp/entity/:entityId/tokens` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#listBearerTokens` |
| `POST /mcp/entity/:entityId/tokens` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#generateBearerToken` |
| `DELETE /mcp/entity/:entityId/tokens/:tokenId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#revokeBearerToken` |
| `GET /mcp/entity/:entityId/tool-acl` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#listToolAcl` |
| `PATCH /mcp/entity/:entityId/tool-acl/:toolId` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#patchToolAcl` |
| `POST /mcp/entity/:entityId/tool-acl/bulk` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-entity.controller.ts#bulkToolAcl` |
| `POST /mcp/messages` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#messages` |
| `POST /mcp/platform` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#jsonRpc` |
| `GET /mcp/platform/catalog` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#toolCatalog` |
| `GET /mcp/platform/events/subscribe` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#eventsSubscribe` |
| `POST /mcp/platform/messages` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#messages` |
| `GET /mcp/platform/sse` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#sse` |
| `GET /mcp/platform/tokens` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#listTokens` |
| `POST /mcp/platform/tokens` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#mintToken` |
| `POST /mcp/platform/tokens/:id/revoke` | REST_ONLY | — | `explicit-default-rest-only` | `apps/agent/src/mcp-platform/mcp-platform.controller.ts#revokeToken` |
| `GET /mcp/sse` | PUBLIC_TRANSPORT | — | `mcp-protocol` | `apps/agent/src/mcp-docs/docs-mcp.controller.ts#sse` |
| `GET /metrics` | PUBLIC_TRANSPORT | — | `service-observability` | `apps/agent/src/monitoring/metrics.controller.ts#scrape` |
| `GET /oauth/authorize` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#authorize` |
| `POST /oauth/authorize/callback` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#authorizeCallback` |
| `GET /oauth/consent` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#inspectConsent` |
| `GET /oauth/entity/:entityId/authorize` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityAuthorize` |
| `POST /oauth/entity/:entityId/authorize/anonymous` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityAnonAuthorize` |
| `GET /oauth/entity/:entityId/oidc-callback` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityOidcCallback` |
| `GET /oauth/entity/:entityId/oidc-redirect` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityOidcRedirect` |
| `POST /oauth/entity/:entityId/register` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityRegister` |
| `POST /oauth/entity/:entityId/revoke` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityRevoke` |
| `POST /oauth/entity/:entityId/token` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#entityToken` |
| `POST /oauth/introspect` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#introspect` |
| `POST /oauth/register` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#register` |
| `POST /oauth/revoke` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#revoke` |
| `POST /oauth/token` | PUBLIC_TRANSPORT | — | `oauth-protocol` | `apps/agent/src/oauth/oauth.controller.ts#token` |
| `GET /openapi` | PUBLIC_TRANSPORT | — | `generated-api-description` | `apps/agent/src/openapi/openapi.controller.ts#getSwaggerUi` |

## MCP inventory

| MCP tool | Classification | REST mapping | Tier | Source |
| --- | --- | --- | --- | --- |
| `agents.canary.promote` | MAPPED | `POST /api/v1/agent/agents/:agentId/canary/promote` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `agents.canary.set` | MAPPED | `PATCH /api/v1/agent/agents/:agentId/canary` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `agents.census` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/admin.ts` |
| `agents.clone_from` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/orchestration.ts` |
| `agents.create` | MAPPED | `POST /api/v1/agent/agents` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `agents.delete` | MAPPED | `DELETE /api/v1/agent/agents/:agentId` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `agents.deploy_with_skills` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/orchestration.ts` |
| `agents.get` | MAPPED | `GET /api/v1/agent/agents/:agentId` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `agents.list` | MAPPED | `GET /api/v1/agent/agents` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `agents.update` | MAPPED | `PATCH /api/v1/agent/agents/:agentId` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `alert_channels.create` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/alert_channels.ts` |
| `alert_channels.delete` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/alert_channels.ts` |
| `alert_channels.get_integration` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/alert_channels.ts` |
| `alert_channels.list` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/alert_channels.ts` |
| `alert_channels.test` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/alert_channels.ts` |
| `alert_channels.update` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/alert_channels.ts` |
| `approvals.get` | MAPPED | `GET /api/v1/agent/monitoring/approvals/:approvalId` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `approvals.list` | MAPPED | `GET /api/v1/agent/monitoring/approvals` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `approvals.resolve` | MAPPED | `POST /api/v1/agent/approvals/:approvalId/resolve` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `artifacts.list` | MAPPED | `GET /api/v1/agent/threads/:threadId/artifacts` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `audit.cross_scope_tool_calls` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/admin.ts` |
| `audit.safety_events.query` | MAPPED | `GET /api/v1/agent/monitoring/safety-events` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `audit.tool_calls.query` | MAPPED | `GET /api/v1/agent/monitoring/tool-audit` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `budgets.delete` | MAPPED | `DELETE /api/v1/agent/budgets/:capId` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `budgets.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `budgets.list` | MAPPED | `GET /api/v1/agent/budgets` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `budgets.rollup_org_wide` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/admin.ts` |
| `budgets.upsert` | MAPPED | `POST /api/v1/agent/budgets` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `channel_apps.bind_installation` | MAPPED | `POST /api/v1/agent/channel-apps/:id/installations/:installationId/bind` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.create` | MAPPED | `POST /api/v1/agent/channel-apps` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.delete` | MAPPED | `DELETE /api/v1/agent/channel-apps/:id` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.get` | MAPPED | `GET /api/v1/agent/channel-apps/:id` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.import_installation` | MAPPED | `POST /api/v1/agent/channel-apps/:id/installations/import` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.installations_status` | MAPPED | `GET /api/v1/agent/channel-apps/:id/installations/status` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.list` | MAPPED | `GET /api/v1/agent/channel-apps` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.list_installations` | MAPPED | `GET /api/v1/agent/channel-apps/:id/installations` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.revoke_installation` | MAPPED | `DELETE /api/v1/agent/channel-apps/:id/installations/:installationId` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channel_apps.update` | MAPPED | `PATCH /api/v1/agent/channel-apps/:id` | scope | `apps/agent/src/mcp-platform/tools/channel-apps.ts` |
| `channels.create` | MAPPED | `POST /api/v1/agent/channels` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `channels.delete` | MAPPED | `DELETE /api/v1/agent/channels/:id` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `channels.get` | MAPPED | `GET /api/v1/agent/channels/:id` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `channels.list` | MAPPED | `GET /api/v1/agent/channels` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `channels.mint_from_manifest` | MAPPED | `POST /api/v1/agent/channels/mint` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `channels.rotate_webhook_secret` | MAPPED | `POST /api/v1/agent/channels/:id/rotate-secret` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `channels.update` | MAPPED | `PATCH /api/v1/agent/channels/:id` | scope | `apps/agent/src/mcp-platform/tools/channels.ts` |
| `clusters.add_agent` | MAPPED | `POST /api/v1/agent/clusters/:clusterId/agents` | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `clusters.create` | MAPPED | `POST /api/v1/agent/clusters` | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `clusters.list` | MAPPED | `GET /api/v1/agent/clusters` | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `end_users.bind_external_id` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/end-users.ts` |
| `end_users.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/end-users.ts` |
| `end_users.link_identity` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/end-users.ts` |
| `end_users.unlink_identity` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/end-users.ts` |
| `entities.census` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/admin.ts` |
| `entities.delete` | MAPPED | `DELETE /api/v1/agent/entities/:entityId` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.generate_mcp_token` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.get` | MAPPED | `GET /api/v1/agent/entities/:entityId` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.get_linked_agents` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.get_mcp_config` | MAPPED | `GET /api/v1/agent/entities/:entityId/mcp/config` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.get_test_credentials` | MAPPED | `GET /api/v1/agent/entities/:entityId/test-credentials` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.get_tools` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.list` | MAPPED | `GET /api/v1/agent/entities` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.provision` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/orchestration.ts` |
| `entities.refresh_discovery` | MAPPED | `POST /api/v1/agent/entities/:entityId/refresh-discovery` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.regenerate_secret` | MAPPED | `POST /api/v1/agent/entities/:entityId/regenerate-secret` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.register` | MAPPED | `POST /api/v1/agent/entities` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.set_linked_agents` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.set_mcp_enabled` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.set_mcp_inject_context` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.set_test_credentials` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.set_tool_acl` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.update` | MAPPED | `PATCH /api/v1/agent/entities/:entityId` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `entities.wire_test` | MAPPED | `POST /api/v1/agent/entities/:entityId/wire-test` | scope | `apps/agent/src/mcp-platform/tools/entities.ts` |
| `environments.create` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `environments.delete` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `environments.delete_secret` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `environments.list` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `environments.list_secrets` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `environments.set_secret` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `evals.get` | MAPPED | `GET /api/v1/agent/evals/:evalId` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `evals.list` | MAPPED | `GET /api/v1/agent/evals` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `evals.regression_sweep` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/orchestration.ts` |
| `evals.run` | MAPPED | `POST /api/v1/agent/evals/run` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `events.recent` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `events.subscribe` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `gdpr.export` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `gdpr.export_user_everywhere` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/admin.ts` |
| `gdpr.import` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `gdpr.purge` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `health.check` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/monitoring.ts` |
| `kg.create_node` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.delete_node` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.discover_links` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.get_entity` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.link_nodes` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.list_entities` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.search_entities` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `kg.update_node` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/kg.ts` |
| `macros.delete` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.list` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.record_start` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.record_stop` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.replay` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.share` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `macros.update` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/macros.ts` |
| `mcp.list_clients` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/mcp.ts` |
| `mcp.list_tokens` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/mcp.ts` |
| `memories.archive` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.bulk_delete` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.delete` | MAPPED | `DELETE /api/v1/memory/:id` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.extract_now` | MAPPED | `POST /api/v1/memory/extract` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.list` | MAPPED | `GET /api/v1/memory` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.restore` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.search` | MAPPED | `GET /api/v1/memory/search` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `memories.upsert` | MAPPED | `POST /api/v1/memory` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `messages.list` | MAPPED | `GET /api/v1/agent/threads/:threadId/messages` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `messages.rate` | MAPPED | `POST /api/v1/agent/messages/:messageId/rating` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `monitoring.cost.daily` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `monitoring.cost.range` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `notifications.delete` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `notifications.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `notifications.list` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `notifications.register` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `notifications.test` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `notifications.update` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/events.ts` |
| `oauth.create_client` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/oauth.ts` |
| `oauth.delete_client` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/oauth.ts` |
| `oauth.list_clients` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/oauth.ts` |
| `oauth.list_tokens` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/oauth.ts` |
| `oauth.revoke_token` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/oauth.ts` |
| `oauth.rotate_secret` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/oauth.ts` |
| `org.add_member` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `org.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `org.list` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `org.list_members` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `org.remove_member` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `org.set_member_role` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `org.update` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `platos_tasks.create` | MAPPED | `POST /api/v1/agent/platos-tasks` | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.delete` | MAPPED | `DELETE /api/v1/agent/platos-tasks/:id` | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.get` | MAPPED | `GET /api/v1/agent/platos-tasks/:id` | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.get_run` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.get_runs` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.list` | MAPPED | `GET /api/v1/agent/platos-tasks` | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.run` | MAPPED | `POST /api/v1/agent/platos-tasks/:id/run` | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.set_enabled` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.update` | MAPPED | `PATCH /api/v1/agent/platos-tasks/:id` | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos_tasks.validate_handler` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/platos_tasks.ts` |
| `platos.diff_agents` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/reflection.ts` |
| `platos.explain_turn` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/reflection.ts` |
| `platos.list_accessible_scopes` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `platos.simulate_turn` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/reflection.ts` |
| `platos.whoami` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `projects.list_all` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/settings.ts` |
| `providers.add_key` | MAPPED | `POST /api/v1/agent/providers/keys` | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.delete_key` | MAPPED | `DELETE /api/v1/agent/providers/keys/:id` | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.get` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.get_routes` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.link` | MAPPED | `POST /api/v1/agent/providers/:provider/link` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `providers.list` | MAPPED | `GET /api/v1/agent/providers` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `providers.list_keys` | MAPPED | `GET /api/v1/agent/providers/keys` | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.rotate_key` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.set_routes` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.test_credentials` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/providers.ts` |
| `providers.unlink` | MAPPED | `DELETE /api/v1/agent/providers/:provider/link` | scope | `apps/agent/src/mcp-platform/tools/platos-control.ts` |
| `runs.get_trace` | MAPPED | `GET /api/v1/agent/monitoring/trace/:threadId` | scope | `apps/agent/src/mcp-platform/tools/monitoring.ts` |
| `runs.list_all` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/monitoring.ts` |
| `scopes.bootstrap_demo_data` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/orchestration.ts` |
| `scopes.list_all` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/admin.ts` |
| `skills.disable` | MAPPED | `DELETE /api/v1/agent/skills/agent/:agentId/:id` | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.disable_globally` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.enable` | MAPPED | `POST /api/v1/agent/skills/agent/:agentId/:id` | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.get` | MAPPED | `GET /api/v1/agent/skills/:id` | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.get_installed_config` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.install` | MAPPED | `POST /api/v1/agent/skills/import` | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.list` | MAPPED | `GET /api/v1/agent/skills` | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.uninstall` | MAPPED | `DELETE /api/v1/agent/skills/:id` | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `skills.update` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/skills.ts` |
| `threads.create` | MAPPED | `POST /api/v1/agent/threads` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `threads.delete` | MAPPED | `DELETE /api/v1/agent/threads/:threadId` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `threads.edit_and_rerun` | MAPPED | `POST /api/v1/agent/threads/:threadId/messages/:messageId/edit-and-rerun` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `threads.fork` | MAPPED | `POST /api/v1/agent/threads/:threadId/fork` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `threads.get` | MAPPED | `GET /api/v1/agent/threads/:threadId` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `threads.list` | MAPPED | `GET /api/v1/agent/threads` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `threads.update` | MAPPED | `PATCH /api/v1/agent/threads/:threadId` | scope | `apps/agent/src/mcp-platform/tools/index.ts` |
| `traces.get` | MAPPED | `GET /api/v1/agent/monitoring/trace/:threadId` | scope | `apps/agent/src/mcp-platform/tools/monitoring.ts` |
| `traces.list` | MCP_ONLY | — | scope | `apps/agent/src/mcp-platform/tools/monitoring.ts` |
| `trigger.batches.get` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.deployments.get` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.deployments.promote` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.queues.list` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.queues.pause` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.queues.resume` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.runs.cancel` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.runs.get` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.runs.list` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.runs.replay` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.schedules.activate` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.schedules.create` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.schedules.deactivate` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.schedules.delete` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.schedules.get` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.schedules.list` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.tasks.trigger` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
| `trigger.workers.list` | MCP_ONLY | — | admin | `apps/agent/src/mcp-platform/tools/trigger.ts` |
