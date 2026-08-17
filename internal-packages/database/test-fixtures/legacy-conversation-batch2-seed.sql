-- Retained-domain conversation Batch 2 fixture.
-- Apply after legacy-core-seed.sql and legacy-agent-tool-batch1-seed.sql.
-- The assistant message uses test-only key version 1 with key hex "11" repeated
-- 32 times. The fixed envelopes exercise strict classification; they are not
-- production key material and this fixture does not claim target re-encryption.
INSERT INTO "PlatosEndUser"
  (id, "organizationId", "projectId", "environmentId", "externalUserId",
   "linkedExternalId", "displayName", email, metadata, "threadCount",
   "lastActiveAt", "createdAt", "updatedAt")
VALUES
  ('cllegacyenduser0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'external-user-001', 'adopted-user-001', 'Fixture End User', 'fixture@example.invalid',
   '{"locale":"en-GB","shared":"same"}'::jsonb, 2,
   '2025-01-03T00:00:00Z', '2025-01-01T00:00:00Z', '2025-01-03T00:00:00Z');

INSERT INTO "PlatosEndUserIdentity"
  (id, "organizationId", "projectId", "environmentId", "platosEndUserId",
   channel, handle, verified, "sourceEntityId", metadata, "createdAt", "updatedAt")
VALUES
  ('cllegacyidentity0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyenduser0001', 'web', 'fixture-handle', true, NULL,
   '{"timezone":"UTC","shared":"same"}'::jsonb,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

-- The child sorts before its parent by source id. Parent-first backfill must use
-- ancestry depth rather than a source-id-only cursor.
INSERT INTO "PlatosAgentThread"
  (id, "agentId", "organizationId", "projectId", "environmentId", "userId",
   "createdByUserId", "platosEndUserId", "singleEndUser", title, status,
   "compactedSummary", "compactedAt", "compactedUpToMessageId",
   "compactionInFlight", "turnCount", "lockedVersionId", "sessionContext",
   tags, "pinnedAt", "archivedAt", "parentThreadId", "forkedFromMessageId",
   "clusteringId", "createdAt", "updatedAt")
VALUES
  ('cllegacythread0000child', 'cllegacyagent0001', 'cllegacyorg0001',
   'cllegacyproject0001', 'cllegacyenv0001', 'external-user-001', 'cllegacyuser0001',
   'cllegacyenduser0001', true, 'Fixture fork', 'archived', NULL, NULL, NULL,
   false, 0, 'cllegacyversion0001', '{"surface":"fixture-child"}'::jsonb,
   ARRAY['fork'], NULL, '2025-01-04T00:00:00Z', 'cllegacythread0001',
   'cllegacymessage0002', NULL, '2025-01-04T00:00:00Z', '2025-01-04T00:00:00Z'),
  ('cllegacythread0001', 'cllegacyagent0001', 'cllegacyorg0001',
   'cllegacyproject0001', 'cllegacyenv0001', 'external-user-001', 'cllegacyuser0001',
   'cllegacyenduser0001', true, 'Fixture conversation', 'active',
   'export-only-compacted-summary', '2025-01-03T00:00:00Z', NULL, false, 2,
   'cllegacyversion0001', '{"surface":"fixture","nested":{"ok":true}}'::jsonb,
   ARRAY['fixture','retained'], '2025-01-02T00:00:00Z', NULL, NULL, NULL,
   'cllegacycluster0001', '2025-01-01T00:00:00Z', '2025-01-03T00:00:00Z');

INSERT INTO "PlatosAgentMessage"
  (id, "threadId", role, content, "toolCalls", "thinkingContent", "responseJson",
   "encKeyVersion", "systemPromptOverride", "outputSchema", status,
   "editParentMessageId", revision, "threadReplyToId", "replyCount",
   "authorAgentId", "createdAt")
VALUES
  ('cllegacymessage0001', 'cllegacythread0001', 'user', 'What is the fixture result?',
   NULL, NULL, NULL, NULL, NULL, NULL, 'active', NULL, 1, NULL, 0, NULL,
   '2025-01-01T01:00:00Z'),
  ('cllegacymessage0002', 'cllegacythread0001', 'assistant',
   'IiIiIiIiIiIiIiIiIiIiIsq4Itw0Y1vUb52g1XxdfTNZ3XJd55fr11fRgF63WEhWYv0Oy14oV+c=',
   '[{"type":"call","name":"lookup_fixture","params":{"id":"fixture-1"},"callId":"call-1"},
     {"type":"result","name":"lookup_fixture","result":{"found":true},"callId":"call-1"}]'::jsonb,
   'MzMzMzMzMzMzMzMzMzMzM4XRD3geWfAvmwhzEFXPRhiWmfwIw83KnPUejteYEsnmIrJiN/vkGbdX6IM=',
   '{"model":"anthropic:claude-sonnet-4-6","version_id":"cllegacyversion0001",
     "version_bucket":"current","usage":{"inputTokens":12,"outputTokens":7,
     "cacheReadInputTokens":3},"cost_cents":0.25,"cost_with_cache_cents":0.2,
     "latency_ms":321,"trace_id":"export-only-trace"}'::jsonb,
   1, NULL, NULL, 'active', NULL, 1, NULL, 0, 'cllegacyagent0001',
   '2025-01-01T01:00:01Z');

INSERT INTO "PlatosAgentArtifact"
  (id, "organizationId", "projectId", "environmentId", "threadId", "artifactKey",
   revision, kind, title, language, content, metadata, "producedByMessageId",
   "createdBy", "createdAt")
VALUES
  ('cllegacyartifact0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacythread0001', 'fixture-result', 1, 'json', 'Fixture result', NULL,
   '{"found":true}', '{"render":"inline"}'::jsonb, 'cllegacymessage0002',
   'agent:cllegacyagent0001', '2025-01-01T01:00:02Z');

INSERT INTO "PlatosMessageAttachment"
  (id, "organizationId", "projectId", "environmentId", "messageId", "uploadedBy",
   kind, "mimeType", bytes, width, height, "durationSec", "storageKey",
   "originalName", "contentHash", "createdAt", "expiresAt")
VALUES
  ('cllegacyattachment0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacymessage0001', 'cllegacyenduser0001', 'document', 'application/json', 17,
   NULL, NULL, NULL,
   'cllegacyorg0001//opaque/%2Fkey+must=remain?exact#fragment',
   'fixture.json', 'fixture-content-hash', '2025-01-01T00:59:59Z',
   '2025-02-01T00:00:00Z');

INSERT INTO "PlatosPostmanTemplate"
  (id, "organizationId", "projectId", "environmentId", "agentId", name,
   "simulateUserId", "sessionContext", "createdBy", "isDefault", "createdAt", "updatedAt")
VALUES
  ('cllegacypostman0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'Fixture request', 'external-user-001',
   '{"channel":"fixture","flags":["retained"]}'::jsonb,
   'cllegacyuser0001', true, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
