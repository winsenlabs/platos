-- Retained-domain Batch 1 fixture. Apply after legacy-core-seed.sql.
-- Export-only sentinels deliberately exercise that no legacy runtime aliases or
-- unsupported agent config fields enter the clean targets.
INSERT INTO "PlatosToolDefinition"
  (id, "organizationId", "projectId", name, description, "paramSchema", category,
   "schemaHash", "bm25Tokens", "createdAt", "updatedAt")
VALUES
  ('cllegacytool0001', 'cllegacyorg0001', 'cllegacyproject0001', 'search_docs',
   'Search the documentation', '{"type":"object","properties":{"query":{"type":"string"}}}'::jsonb,
   'knowledge', 'fixture-schema-hash', ARRAY['export-only-bm25-sentinel'],
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosAgentCluster"
  (id, "organizationId", "projectId", "environmentId", name, slug, description,
   metadata, "createdAt", "updatedAt")
VALUES
  ('cllegacycluster0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'Support Cluster', 'support-cluster', 'Shared support context',
   '{"department":"support"}'::jsonb,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosAgent"
  (id, "organizationId", "projectId", "environmentId", name, slug, model,
   "systemPrompt", "promptBlocks", "dynamicBlocks", "maxSteps", "contextLimit",
   "toolsBlockConfig", "memoryConfig", "isActive", "currentVersionId",
   "canaryVersionId", "canaryPercent", "featureFlags", "clusteringId",
   "createdAt", "updatedAt")
VALUES
  ('cllegacyagent0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'Support Agent', 'support-agent', 'legacy:export-only-model',
   'export-only-agent-system-prompt', '[]'::jsonb, '[]'::jsonb, 77, 88,
   '{"mode":"direct"}'::jsonb, '{"conversation":true}'::jsonb, true,
   'cllegacyversion0001', 'cllegacyversion0002', 25,
   '{"exportOnlyFlag":true}'::jsonb, 'cllegacycluster0001',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosAgentVersion"
  (id, "agentId", "versionNumber", "createdBy", note, snapshot, "createdAt")
VALUES
  ('cllegacyversion0001', 'cllegacyagent0001', 1, 'cllegacyuser0001', 'Published fixture',
   jsonb_build_object(
     'model', 'anthropic:claude-sonnet-4-6',
     'systemPrompt', 'export-only-version-system-prompt',
     'maxSteps', 321,
     'contextLimit', 654,
     'promptBlocks', jsonb_build_array(jsonb_build_object(
       'id', 'system', 'type', 'STATIC', 'name', 'System', 'content', 'Be concise',
       'enabled', true, 'editable', true, 'order', 0))::text,
     'dynamicBlocks', jsonb_build_array(jsonb_build_object(
       'key', 'customer', 'name', 'Customer', 'defaultContent', 'Unknown'))::text,
     'toolsBlockConfig', jsonb_build_object('mode', 'direct', 'pinnedTools', jsonb_build_array('search_docs'))::text,
     'modelRoutes', jsonb_build_array(jsonb_build_object(
       'label', 'primary', 'model', 'anthropic:claude-sonnet-4-6', 'isDefault', true))::text,
     'memoryConfig', jsonb_build_object('conversation', true),
     'outputSchema', jsonb_build_object('type', 'object')
   ),
   '2025-01-01T00:00:00Z'),
  ('cllegacyversion0002', 'cllegacyagent0001', 2, 'cllegacyuser0001', 'Canary fixture',
   jsonb_build_object(
     'model', 'anthropic:claude-haiku-4-5',
     'promptBlocks', jsonb_build_array(),
     'dynamicBlocks', jsonb_build_array(),
     'toolsBlockConfig', jsonb_build_object(),
     'modelRoutes', jsonb_build_array(),
     'memoryConfig', jsonb_build_object()
   ),
   '2025-01-02T00:00:00Z');
