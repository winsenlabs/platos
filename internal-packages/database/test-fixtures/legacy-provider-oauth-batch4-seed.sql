-- Retained-domain provider/OAuth Batch 4 fixture. Apply after legacy-core-seed.sql.
-- SecretStore v2 uses the test-only all-zero 64-hex ENCRYPTION_KEY shared by
-- the combined forced-rollback replay.
-- Values and bearer digests below are synthetic fixture material only.
INSERT INTO "PlatosProviderEnabled"
  (id, "organizationId", "projectId", "environmentId", "providerId", enabled,
   "linkedAt", "updatedAt")
VALUES
  ('cllegacyproviderenabled0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'anthropic', true, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('cllegacyproviderenabled0002', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'openai', true, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "SecretStore" (key, value, version, "createdAt", "updatedAt")
VALUES
  ('environmentvariable:cllegacyproject0001:cllegacyenv0001:ANTHROPIC_API_KEY',
   '{"secret":"fixture-provider-secret-v1"}'::jsonb, '1',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('environmentvariable:cllegacyproject0001:cllegacyenv0001:OPENAI_API_KEY',
   '{"ciphertext":"7eccd4e527fe5477b4b904d79469ff708b19f688b6d07b588b5adb78599fa2bc587c806ab0b210",
     "nonce":"333333333333333333333333","tag":"c3371435501da16615c208fd72911311"}'::jsonb,
   '2', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosProviderKey"
  (id, "organizationId", "projectId", "environmentId", provider, label,
   "envVarName", "isDefault", "createdBy", "createdAt", "updatedAt", "lastUsedAt")
VALUES
  ('cllegacyproviderkey0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'anthropic', 'Anthropic fixture', 'ANTHROPIC_API_KEY', true, 'cllegacyuser0001',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('cllegacyproviderkey0002', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'openai', 'OpenAI fixture', 'OPENAI_API_KEY', true, 'cllegacyuser0001',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', NULL);

INSERT INTO "PlatosAccessKey"
  (id, "organizationId", "projectId", "environmentId", "keyPrefix", "keyHash",
   "allowedOrigins", "lastUsedAt", "createdAt", "updatedAt")
VALUES
  ('cllegacyaccesskey0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'platos_live_fixture', 'e6c56e6a694bbc70f677e89324802f2ca275ccd02f30eeb4a97221fc61e5e779',
   ARRAY['https://fixture.example.invalid'], NULL,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosMCPToken"
  (id, "organizationId", "projectId", "environmentId", "mintedByUserId", name,
   "tokenHash", permissions, tier, "expiresAt", "lastUsedAt", "revokedAt",
   "revokedBy", "createdAt")
VALUES
  ('cllegacymcptoken0001', 'cllegacyorg0001', 'cllegacyproject0001', 'cllegacyenv0001',
   'cllegacyuser0001', 'Fixture MCP token',
   '437d70a13da01f8f38fb8a3967b92e25086a2df30e46c2582ea770c157cceb4f',
   ARRAY['agents.*'], 'scope', '2026-01-01T00:00:00Z', NULL, NULL, NULL,
   '2025-01-01T00:00:00Z');

INSERT INTO "PlatosPAT"
  (id, "tokenHash", name, "userId", "organizationId", "projectId", "environmentId",
   role, "lastUsedAt", "expiresAt", "revokedAt", "createdAt")
VALUES
  ('cllegacypat0001', 'ff243515b9ffccafd37117b8d0dc110376db8c4ec52d7774e711a18304282619',
   'Fixture PAT', 'cllegacyuser0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'write', NULL, '2026-01-01T00:00:00Z', NULL,
   '2025-01-01T00:00:00Z');

INSERT INTO "PlatosOAuthClient"
  (id, "clientId", "clientSecretHash", "clientName", "redirectUris",
   "tokenEndpointAuthMethod", "grantTypes", scope, "registeredByUserId",
   "organizationId", "entityPk", "createdAt", "deletedAt")
VALUES
  ('cllegacyoauthclient0001', 'plt_oac_fixture',
   'c187c41872a8ed6fbbc89f5249b1cda3a06b92b10353eec5de3233bd452f4991',
   'Fixture OAuth client', ARRAY['https://fixture.example.invalid/callback'],
   'client_secret_basic', ARRAY['authorization_code','refresh_token'],
   'mcp:tools', 'cllegacyuser0001', 'cllegacyorg0001', NULL,
   '2025-01-01T00:00:00Z', NULL);

INSERT INTO "PlatosOAuthAuthCode"
  (code, "clientId", "userId", "scopeTuple", "codeChallenge", "codeChallengeMethod",
   "redirectUri", scopes, "expiresAt", "usedAt", "entityPk", "createdAt")
VALUES
  ('plt_oacode_fixture_plaintext', 'plt_oac_fixture', 'cllegacyuser0001',
   '{"organizationId":"cllegacyorg0001","projectId":"cllegacyproject0001",
     "environmentId":"cllegacyenv0001"}'::jsonb,
   'fixture-s256-challenge', 'S256', 'https://fixture.example.invalid/callback',
   ARRAY['mcp:tools'], '2025-01-01T00:01:00Z', NULL, NULL, '2025-01-01T00:00:00Z');

INSERT INTO "PlatosOAuthAccessToken"
  ("tokenHash", "clientId", "userId", "scopeTuple", scopes, "issuedAt", "expiresAt",
   "revokedAt", "entityPk")
VALUES
  ('4683832021795301a87fa9f45c17bf4324ff07dde2e98a7a31ad036a6a499e98',
   'plt_oac_fixture', 'cllegacyuser0001',
   '{"organizationId":"cllegacyorg0001","projectId":"cllegacyproject0001",
     "environmentId":"cllegacyenv0001"}'::jsonb,
   ARRAY['mcp:tools'], '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z', NULL, NULL);

INSERT INTO "PlatosOAuthRefreshToken"
  ("tokenHash", "accessTokenHash", "clientId", "userId", "scopeTuple", scopes,
   "issuedAt", "expiresAt", "revokedAt", "entityPk")
VALUES
  ('421b424561bf6930dcc84e9b443e13a0146176bf547792aa70428e0af56a0c0d',
   '4683832021795301a87fa9f45c17bf4324ff07dde2e98a7a31ad036a6a499e98',
   'plt_oac_fixture', 'cllegacyuser0001',
   '{"organizationId":"cllegacyorg0001","projectId":"cllegacyproject0001",
     "environmentId":"cllegacyenv0001"}'::jsonb,
   ARRAY['mcp:tools'], '2025-01-01T00:00:00Z', '2025-04-01T00:00:00Z', NULL, NULL);

INSERT INTO "PlatosOrgMcpPolicy"
  (id, "organizationId", "projectId", "environmentId", pattern, policy,
   "createdAt", "updatedAt")
VALUES
  ('cllegacyorgmcppolicy0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'agents.*', 'require_approval',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
