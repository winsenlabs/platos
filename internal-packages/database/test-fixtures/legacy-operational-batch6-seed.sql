-- Retained-domain operational/audit/governance Batch 6 fixture.
-- Apply after legacy-core-seed.sql, legacy-agent-tool-batch1-seed.sql, and
-- legacy-conversation-batch2-seed.sql. Message envelopes use the test-only key
-- version 1 with key hex "11" repeated 32 times. This fixture exercises strict
-- source classification only; it does not claim target re-encryption/read probes.

INSERT INTO "PlatosToolHealth"
  (id, "toolId", "entityId", "environmentId", "lastCalledAt", "lastStatus",
   "failCount", "totalCalls", "totalFailures", "p95LatencyMs", "avgLatencyMs", "updatedAt")
VALUES
  ('cllegacytoolhealth0001', 'cllegacytool0001', 'fixture-entity', 'cllegacyenv0001',
   '2025-01-03T00:00:00Z', 'success', 0, 4, 1, 120, 70, '2025-01-03T00:00:00Z');

INSERT INTO "PlatosToolCallAudit"
  (id, "organizationId", "projectId", "environmentId", "toolId", "toolName",
   "entityId", "entityPk", "agentId", "threadId", "userId", "platosEndUserId",
   "traceId", "spanId", "parentSpanId", args, result, error, status, "latencyMs",
   "costCents", source, "mcpUserId", "mcpClientId", "endUserId", "createdAt")
VALUES
  ('cllegacytoolaudit0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacytool0001', 'search_docs', 'fixture-entity', NULL, 'cllegacyagent0001',
   'cllegacythread0001', 'external-user-001', 'cllegacyenduser0001', 'trace-fixture',
   'span-export-only', 'parent-span-export-only',
   '{"__platos_enc":1,"v":1,"ct":"IiIiIiIiIiIiIiIiIiIiIsI8qPaofwr++n2e5IGNFmpnkWBa+5XmkAnTg1msXkRUc7gLiEs2SuHPW+sggw=="}'::jsonb,
   '[{"ok":true}]'::jsonb, NULL, 'success', 12, 0.25, 'agent_turn', NULL, NULL,
   'external-user-001', '2025-01-03T00:00:00Z');

-- Both inherited audit families intentionally merge into AdminAudit. Their
-- deterministic mappings and target provenance must conserve 1 + 1 = 2 rows.
INSERT INTO "PlatosAdminAudit"
  (id, "organizationId", "projectId", "environmentId", "actorUserId", action,
   "subjectType", "subjectId", "beforeJson", "afterJson", reason, source, "createdAt")
VALUES
  ('cllegacyadminaudit0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyuser0001', 'agent.update', 'PlatosAgent', 'cllegacyagent0001',
   '{"enabled":false}'::jsonb, '{"enabled":true}'::jsonb, 'fixture change', 'ui',
   '2025-01-03T00:00:01Z');

INSERT INTO "PlatosCredentialAudit"
  (id, family, "credentialId", action, "organizationId", "projectId", "environmentId",
   "actorUserId", "createdAt")
VALUES
  ('cllegacycredentialaudit0001', 'control_plane', 'credential-fixture', 'use',
   'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001', 'cllegacyuser0001',
   '2025-01-03T00:00:02Z');

INSERT INTO "PlatosAgentApproval"
  (id, "approvalId", "organizationId", "projectId", "environmentId", source,
   "agentId", "threadId", "requestedBy", action, details, status, "timeoutSeconds",
   "resolvedAt", "respondedBy", comment, "toolName", args, "requestHash", resolution,
   "consumedAt", "requestedByMcpTokenId", "editedArgs", "editedByUserId", "createdAt", "updatedAt")
VALUES
  ('cllegacyapproval0001', 'approval-fixture', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'request_approval', 'cllegacyagent0001', 'cllegacythread0001',
   'cllegacyuser0001', 'Run fixture tool', 'Fixture approval', 'approved', 300,
   '2025-01-03T00:01:00Z', 'cllegacyuser0001', 'approved for fixture', 'search_docs',
   '{"query":"fixture"}'::jsonb, 'export-only-request-hash',
   '{"decision":"approved"}'::jsonb, '2025-01-03T00:01:01Z', NULL, NULL, NULL,
   '2025-01-03T00:00:03Z', '2025-01-03T00:01:01Z');

INSERT INTO "PlatosBudgetCap"
  (id, "organizationId", "projectId", "environmentId", "scopeType", "targetId",
   tier, "skillSlug", "agentId", period, "limitCents", "runsLimit", "alertThresholds",
   "alertWebhookUrl", "alertEmails", "overrideUntil", "overrideBy", enabled,
   "createdAt", "updatedAt")
VALUES
  ('cllegacybudget0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'agent', 'cllegacyagent0001', 'llm', NULL, 'cllegacyagent0001', 'month', 1000, 20,
   '[50,80,100]'::jsonb, NULL, NULL, NULL, NULL, true,
   '2025-01-03T00:00:04Z', '2025-01-03T00:00:04Z');

INSERT INTO "PlatosSafetyEvent"
  (id, "organizationId", "projectId", "environmentId", "agentId", "threadId",
   "messageId", "userId", detector, action, severity, detail, meta, "toolName",
   "toolCallId", "createdAt")
VALUES
  ('cllegacysafetyevent0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'cllegacythread0001', 'cllegacymessage0002', 'external-user-001',
   'pii', 'redact', 'medium',
   '{"__platos_enc":1,"v":1,"ct":"MzMzMzMzMzMzMzMzMzMzM8vqfEVcJbJ19H/Ip+aC/Mbxhfoe297KnPUejteYEsnmIrJ0N+72H7Uc"}',
   '{"__platos_enc":1,"v":1,"ct":"RERERERERERERERERERERMh2QM9hh8CSOg9Z5v1Gh0Uu/IgNy9E4D7qyU7nVTnc11A4="}'::jsonb,
   'search_docs', 'cllegacytoolaudit0001', '2025-01-03T00:00:05Z');

INSERT INTO "PlatosEvent"
  (id, "organizationId", "projectId", "environmentId", "eventType", "subjectId",
   payload, "createdAt")
VALUES
  ('cllegacyevent0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'approval.opened', 'approval-fixture', '{"version":1,"approvalId":"approval-fixture"}'::jsonb,
   '2025-01-03T00:00:06Z');

INSERT INTO "PlatosNotificationRule"
  (id, "organizationId", "projectId", "environmentId", name, filters, delivery,
   enabled, "createdAt", "updatedAt", "createdBy")
VALUES
  ('cllegacynotification0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'Fixture events', '{"eventTypes":["approval.opened"]}'::jsonb,
   '{"type":"email","email":"fixture@example.invalid"}'::jsonb, true,
   '2025-01-03T00:00:07Z', '2025-01-03T00:00:07Z', 'cllegacyuser0001');

INSERT INTO "PlatosErasureOperation"
  (id, "idempotencyKey", "subjectKeyHash", "organizationId", status, scopes, stores,
   inventory, "policyVersion", "legalHoldPolicyId", attempts, "requestedAt",
   "startedAt", "completedAt", "updatedAt")
VALUES
  ('cllegacyerasure0001', 'erasure-fixture', 'subject-hash-fixture', 'cllegacyorg0001',
   'completed',
   '[{"organizationId":"cllegacyorg0001","projectId":"cllegacyproject0001","environmentId":"cllegacyenv0001"}]'::jsonb,
   '[{"store":"postgres","deleted":2,"verificationStatus":"verified"}]'::jsonb,
   '{"rows":2}'::jsonb, '2026-08', NULL, 1,
   '2025-01-03T00:00:08Z', '2025-01-03T00:00:09Z', '2025-01-03T00:00:10Z',
   '2025-01-03T00:00:10Z');
