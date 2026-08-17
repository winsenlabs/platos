-- Representative non-secret tenancy/auth fixture. Apply only after replaying
-- legacy-prisma migrations into an isolated test database.
INSERT INTO "User"
  (id, email, "authenticationMethod", "authIdentifier", "displayName", name, admin,
   "dashboardPreferences", "createdAt", "updatedAt")
VALUES
  ('cllegacyuser0001', ' Owner@Example.COM ', 'GITHUB', 'github:10001', 'Owner', 'Owner Example', true,
   '{"version":1}'::jsonb, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('cllegacyuser0002', 'member@example.com', 'MAGIC_LINK', NULL, 'Member', NULL, false,
   NULL, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "Organization" (id, slug, title, "createdAt", "updatedAt")
VALUES ('cllegacyorg0001', 'example-org', 'Example Organization', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "OrgMember" (id, "organizationId", "userId", role, "createdAt", "updatedAt")
VALUES
  ('cllegacymember0001', 'cllegacyorg0001', 'cllegacyuser0001', 'ADMIN', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('cllegacymember0002', 'cllegacyorg0001', 'cllegacyuser0002', 'MEMBER', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

INSERT INTO "Project"
  (id, slug, name, "externalRef", "organizationId", "createdAt", "updatedAt")
VALUES
  ('cllegacyproject0001', 'example-project', 'Example Project', 'proj_external_1', 'cllegacyorg0001',
   '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');

-- Duplicate legacy slugs are deliberately legal when orgMemberId differs and
-- must become deterministic, non-merged target slugs.
INSERT INTO "RuntimeEnvironment"
  (id, slug, "apiKey", "pkApiKey", type, shortcode, "organizationId", "projectId", "orgMemberId",
   "createdAt", "updatedAt")
VALUES
  ('cllegacyenv0001', 'dev', 'tr_dev_fixture_1', 'pk_dev_fixture_1', 'DEVELOPMENT', 'dev1',
   'cllegacyorg0001', 'cllegacyproject0001', 'cllegacymember0001', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'),
  ('cllegacyenv0002', 'dev', 'tr_dev_fixture_2', 'pk_dev_fixture_2', 'PREVIEW', 'dev2',
   'cllegacyorg0001', 'cllegacyproject0001', 'cllegacymember0002', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
