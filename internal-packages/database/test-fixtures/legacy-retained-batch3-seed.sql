-- Retained-domain Batch 3 fixture, checkpoint 1.
-- Apply after legacy-core-seed.sql and legacy-agent-tool-batch1-seed.sql.
-- The service secret is test-only source material for checkpoint 2. Checkpoint
-- 1 verifies that it is present but never selects, inserts, or reports it.
INSERT INTO "PlatosConnectedEntity"
  (id, "organizationId", "projectId", "entityId", "displayName", "mcpUrls",
   "serviceSecret", "connectionStatus", "lastConnectedAt",
   "disconnectAlertSent", "linkedAgentIds", "allowedOrigins", capabilities,
   "connectionKind", "testCredentials", "createdAt", "updatedAt")
VALUES
  ('cllegacyentity0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'fixture-mcp-entity', 'Fixture MCP Entity', ARRAY['https://mcp.example.invalid'],
   'fixture-only-service-material', 'connected', '2025-01-02T00:00:00Z', false,
   ARRAY['export-only-agent-sentinel'], ARRAY['https://app.example.invalid'],
   ARRAY['tools'], 'mcp', NULL,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosEntityMcpConfig"
  ("entityPk", enabled, "identityMode", "identityProviders",
   "bearerTokenCount", branding, "toolAllowlist", "consentCopy",
   "redirectUriAllowlist", "rateLimitPerMinute", "injectMcpContext",
   "createdAt", "updatedAt")
VALUES
  ('cllegacyentity0001', true, 'anonymous+bearer',
   '[{"id":"fixture-oidc","kind":"oidc"}]'::jsonb, 17,
   '{"name":"Fixture MCP","theme":{"accent":"blue"}}'::jsonb,
   ARRAY['search_docs'], 'export-only-consent-copy',
   ARRAY['https://app.example.invalid/oauth/callback'], 45, true,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosEntityMcpClient"
  ("entityPk", transport, url, "credsSecretKey", "headersTemplate",
   "lastDiscoveryAt", "discoveryError", "createdAt", "updatedAt")
VALUES
  ('cllegacyentity0001', 'remote-http', 'https://mcp.example.invalid', NULL,
   '{"X-Fixture-User":"{{endUserId}}"}'::jsonb,
   '2025-01-02T00:00:00Z', NULL,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosEntityToolMapping"
  (id, "toolId", "entityId", "environmentId", enabled, "callbackUrl",
   "createdAt", "updatedAt")
VALUES
  ('cllegacyentitytool0001', 'cllegacytool0001', 'cllegacyentity0001',
   'cllegacyenv0001', true, NULL,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosEntityMcpToolAcl"
  (id, "entityPk", "toolId", "toolName", exposed, "minIdentityMode",
   "allowedPatIds", "scopeLabels", "addedBy", "addedAt", "lastReviewedAt")
VALUES
  ('cllegacyentityacl0001', 'cllegacyentity0001', 'cllegacytool0001',
   'search_docs', true, 'bearer', ARRAY['export-only-pat-sentinel'],
   ARRAY['mcp:tools'], 'cllegacyuser0001',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
