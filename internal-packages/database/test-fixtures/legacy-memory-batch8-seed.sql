-- Retained-domain memory/knowledge-graph Batch 8 fixture.
-- Apply after legacy core, agent/tool Batch 1, and conversation Batch 2 fixtures.
-- Exact inherited envelopes use test-only message key version 1 with key hex
-- "11" repeated 32 times. Batch 8 validates and retains these envelopes; it
-- does not claim target re-encryption or a final runtime read probe.

INSERT INTO "PlatosMemory"
  (id, "organizationId", "projectId", "environmentId", "agentId", "userId",
   "platosEndUserId", kind, content, metadata, embedding, "agentVisible", visibility,
   source, "sourceThreadId", "sourceMessageIds", "extractorVersion", "contentHash",
   confidence, "createdAt", "updatedAt", "lastAccessedAt", "archivedAt")
VALUES
  ('cllegacymemory0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'external-user-001', 'cllegacyenduser0001', 'fact',
   '{"__platos_enc":1,"v":1,"ct":"UVFRUVFRUVFRUVFRUVFRUeHCYyukdrpJJ9hAEZSCrJaSZNnmATpszJN1nw6dgK5AuxxsTIPJ"}',
   '{"category":"employment","nested":{"retained":true}}'::jsonb,
   ('[' || array_to_string(array_fill(0.125::double precision, ARRAY[1536]), ',') || ']')::vector,
   true, 'agent_visible', 'extracted', 'cllegacythread0001',
   ARRAY['cllegacymessage0001','cllegacymessage0002'], 'fixture-extractor-v1',
   '030549a81f2b45ad55d6ba63c629501d52f6b4a646810e4ea8b32c6d23376f79', 0.91,
   '2025-01-03T01:00:00Z', '2025-01-03T02:00:00Z', '2025-01-04T00:00:00Z', NULL),
  ('cllegacymemory0002', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyagent0001', 'external-user-001', NULL, 'preference',
   'Manual preference',
   '{"__platos_enc":1,"v":1,"ct":"VVVVVVVVVVVVVVVVVVVVVbLfIZy+jgA+cY860XJcVcMF1pR0yDkmyrHE/Q8ntNXeC2GX0wsN98XBltqXo0gH963KIgISmtgWNjFl1EZd4UvNxMJu"}'::jsonb,
   ('[' || array_to_string(array_fill(0.25::double precision, ARRAY[1536]), ',') || ']')::vector,
   false, 'private', 'manual', NULL, ARRAY[]::text[], NULL, NULL, NULL,
   '2025-01-02T01:00:00Z', '2025-01-05T02:00:00Z', NULL, '2025-01-06T00:00:00Z');

INSERT INTO "PlatosMemoryEntity"
  (id, "organizationId", "projectId", "environmentId", "userId", "agentId",
   "entityKey", "entityType", label, aliases, metadata, embedding, "createdAt", "updatedAt")
VALUES
  ('cllegacymemoryentity0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'external-user-001', 'cllegacyagent0001', 'person_alice', 'person',
   '{"__platos_enc":1,"v":1,"ct":"UlJSUlJSUlJSUlJSUlJSUufZikhUK59UR9CCjq2FyKaBJByuR6VM"}',
   ARRAY['Alice A.','alice'], '{"role":"engineer"}'::jsonb,
   ('[' || array_to_string(array_fill(0.375::double precision, ARRAY[1536]), ',') || ']')::vector,
   '2025-01-03T01:00:01Z', '2025-01-03T02:00:01Z'),
  ('cllegacymemoryentity0002', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'external-user-001', 'cllegacyagent0001', 'company_acme', 'organization',
   'Acme', ARRAY['Acme Corp'],
   '{"__platos_enc":1,"v":1,"ct":"U1NTU1NTU1NTU1NTU1NTU0iqUtevNvobMXLuwn8gUQVejC88c6GaSSLfGdUfycnO1jJyP0eix+D/dN+Cncqij1LON0+Ewyzr9Q=="}'::jsonb,
   ('[' || array_to_string(array_fill(0.5::double precision, ARRAY[1536]), ',') || ']')::vector,
   '2025-01-03T01:00:02Z', '2025-01-03T02:00:02Z');

INSERT INTO "PlatosMemoryRelationship"
  (id, "organizationId", "projectId", "environmentId", "userId", "agentId",
   "fromEntityId", "toEntityId", "relationshipType", weight, metadata,
   "sourceMemoryId", "createdAt")
VALUES
  -- The edge uses the linked alias while both endpoints use externalUserId;
  -- canonical EndUser scope, not raw identifier equality, owns the graph.
  ('cllegacymemoryrelationship0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'adopted-user-001', 'cllegacyagent0001',
   'cllegacymemoryentity0001', 'cllegacymemoryentity0002', 'works_at', 0.91,
   '{"__platos_enc":1,"v":1,"ct":"VFRUVFRUVFRUVFRUVFRUVMG0fP8ACx7b/VYD0a9ZS9ERxJS7uYmDZZXMFqhY3mWyKpowf76t2dqgtVPSWaOxX2ZqRybP/A=="}'::jsonb,
   'cllegacymemory0001', '2025-01-03T01:00:03Z');
