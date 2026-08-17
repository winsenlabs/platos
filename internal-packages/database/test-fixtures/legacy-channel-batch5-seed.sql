-- Retained-domain channel Batch 5 fixture.
-- Apply after legacy-core-seed.sql, legacy-agent-tool-batch1-seed.sql, and
-- legacy-conversation-batch2-seed.sql. Message envelopes use the synthetic
-- test-only key version 1 with key hex "11" repeated 32 times.
INSERT INTO "PlatosChannelConnection"
  (id, "organizationId", "projectId", "environmentId", "entityPk", provider,
   "displayName", "agentId", "agentRouting", enabled, credentials, config,
   "webhookSecret", "createdAt", "updatedAt")
VALUES
  ('cllegacychannelconnection0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', NULL, 'slack', 'Fixture BYO Slack', 'cllegacyagent0001',
   '[{"match":{"type":"prefix","value":"support"},"agentId":"cllegacyagent0001"}]'::jsonb,
   true,
   '{"__platos_enc":1,"v":1,"ct":"UFBQUFBQUFBQUFBQUFBQUJd2qtoaKNcrqC/KKD5mWoLP6CkETh/hU1c5/k5uH5/7QVLSoKW86xaKrAONeszfq2qXu23hkDHTD4mhc0wQM/2863FOM/57lQoO0A9Uk2ntklJAxUB2N13xUYxxwauyJg=="}',
   '{"exportOnlyConfig":"fixture"}'::jsonb, 'fixture-webhook-secret-required',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "PlatosChannelThread"
  (id, "connectionId", "channelThreadKey", "platosThreadId", "platosEndUserId",
   "agentId", "createdAt", "updatedAt")
VALUES
  ('cllegacychannelthread0001', 'cllegacychannelconnection0001',
   'slack:C-FIXTURE:1700000000.000001', 'cllegacythread0001',
   'cllegacyenduser0001', 'cllegacyagent0001',
   '2025-01-01T01:00:00Z', '2025-01-02T01:00:00Z');

INSERT INTO "PlatosChannelApp"
  (id, "organizationId", "projectId", "environmentId", provider, "displayName",
   "clientId", "clientSecret", "signingSecret", scopes, distribution,
   "aiAppsSurface", "tokenRotation", linking, "defaultAgentId", "agentRouting",
   "createdAt", "updatedAt")
VALUES
  ('cllegacychannelapp0001', 'cllegacyorg0001', 'cllegacyproject0001',
   'cllegacyenv0001', 'slack', 'Fixture marketplace app', 'fixture-slack-client-id',
   '{"__platos_enc":1,"v":1,"ct":"UVFRUVFRUVFRUVFRUVFRUaBxG3GkLJGQ3vtjSaGJ7B+SQ9z3Fio+3tFknBzTj78M1xxtQMiFJFr9bD/uwQLZ"}',
   '{"__platos_enc":1,"v":1,"ct":"UlJSUlJSUlJSUlJSUlJSUl9Mlu+rIC69q8wyocDIAo6BAxm/ULUcikLr761NGoPFjDEzn2Jv9qpCKDqyzQCBuw=="}',
   ARRAY['app_mentions:read','chat:write'], 'private', true, true, 'optional',
   'cllegacyagent0001',
   '[{"match":{"type":"channel","id":"C-FIXTURE"},"agentId":"cllegacyagent0001"}]'::jsonb,
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

-- The two rows exercise canonical team and Enterprise Grid identities. The
-- second intentionally omits the optional refresh token.
INSERT INTO "PlatosChannelInstallation"
  (id, "appId", "teamId", "enterpriseId", "isEnterpriseInstall", "teamName",
   "botToken", "refreshToken", "tokenExpiresAt", "botUserId", "grantedScopes",
   "agentId", "agentRouting", "installedByUserId", status, "revokedAt",
   "lastEventAt", "createdAt", "updatedAt")
VALUES
  ('cllegacychannelinstallation0001', 'cllegacychannelapp0001', 'T-FIXTURE', NULL,
   false, 'Fixture workspace',
   '{"__platos_enc":1,"v":1,"ct":"U1NTU1NTU1NTU1NTU1NTU/qj34Ax3xP3IJfJe6DJrhoHyC8qY6GbWH3FU45T08nBkz5yJwWx0am2OISTisKpxA=="}',
   '{"__platos_enc":1,"v":1,"ct":"VFRUVFRUVFRUVFRUVFRUVOn8uW//5oYiY6xvwowZRyZIgI6suI6SZZqVXK9fyHSrdY13Ne6rxdzrqFjcUq75CTk7BD0="}',
   '2025-01-01T12:00:00Z', 'U-BOT-FIXTURE', ARRAY['app_mentions:read','chat:write'],
   'cllegacyagent0001', NULL, 'cllegacyuser0001', 'active', NULL,
   '2025-01-02T02:00:00Z', '2025-01-01T00:30:00Z', '2025-01-02T00:30:00Z'),
  ('cllegacychannelinstallation0002', 'cllegacychannelapp0001', NULL, 'E-FIXTURE',
   true, 'Fixture enterprise',
   '{"__platos_enc":1,"v":1,"ct":"VVVVVVVVVVVVVVVVVVVVVSaA2KI1SBd4H1j534OMa9Rckp5tyCkzwO7et1Rrv93CSmyBykMX7IyI2pmXvkgH4f+CMFMF3Q=="}',
   NULL, NULL, NULL, ARRAY['app_mentions:read'], NULL, '[]'::jsonb,
   'cllegacyuser0001', 'revoked', '2025-01-03T00:00:00Z', NULL,
   '2025-01-01T00:45:00Z', '2025-01-03T00:00:00Z');

INSERT INTO "PlatosChannelAppThread"
  (id, "installationId", "channelThreadKey", "platosThreadId", "platosEndUserId",
   "agentId", "createdAt", "updatedAt")
VALUES
  ('cllegacychannelappthread0001', 'cllegacychannelinstallation0001',
   'slack:C-FIXTURE:1700000000.000002', 'cllegacythread0001',
   'cllegacyenduser0001', 'cllegacyagent0001',
   '2025-01-01T02:00:00Z', '2025-01-02T02:00:00Z'),
  ('cllegacychannelappthread0002', 'cllegacychannelinstallation0002',
   'slack:C-GRID:1700000000.000003', 'cllegacythread0000child',
   'cllegacyenduser0001', 'cllegacyagent0001',
   '2025-01-01T03:00:00Z', '2025-01-02T03:00:00Z');
