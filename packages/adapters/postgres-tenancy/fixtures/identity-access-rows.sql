-- Rows this adapter is NOT the writer of, seeded as SQL rather than as code.
--
-- `EnvironmentSession.operatorSessionId` and `OrganizationMembership.userId` are
-- real foreign keys into `OperatorSession` and `User`, both of which ADR M0.3 §1
-- makes `identity-access` the sole writer of. An integration suite for the
-- tenancy repository still needs those rows to exist, and the sole-writer lint
-- correctly refuses `db.user.create()` from this package — the whole point of
-- the gate is that a package cannot write another owner's row, and a fixture is
-- not an exemption.
--
-- So the fixture is SQL applied by `prisma db execute`, outside the source the
-- lint judges, and the file states plainly which owner's rows it is standing in
-- for. When identity-access grows its own PostgreSQL adapter this file is
-- replaced by a call to it.
--
-- The identifiers are fixed so the suite can name them. They match
-- CONFORMANCE_IDS in src/repository.integration.test.ts.

INSERT INTO "User" ("id", "email", "displayName", "platformOperator", "createdAt", "updatedAt")
VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'Owner', false, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('22222222-2222-4222-8222-222222222222', 'second-owner@example.test', 'Second owner', false, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('33333333-3333-4333-8333-333333333333', 'member@example.test', 'Member', false, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "OperatorSession" ("id", "tokenHash", "tier", "userId", "expiresAt", "createdAt")
VALUES
  ('44444444-4444-4444-8444-444444444444', 'conformance-session-hash', 'OPERATOR', '11111111-1111-4111-8111-111111111111', '2026-06-01T09:00:00Z', '2026-05-01T09:00:00Z');
