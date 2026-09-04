-- Rows this adapter is NOT the writer of, seeded as SQL rather than as code.
--
-- `EnvironmentSession.operatorSessionId` and `OrganizationMembership.userId` are
-- real foreign keys into `OperatorSession` and `User`, both of which ADR M0.3 §1
-- makes `identity-access` the sole writer of. An integration suite for the
-- tenancy repository still needs those rows to exist.
--
-- WIN-258 T2 CHANGED WHY THIS FILE IS SQL, AND THE OLD REASON IS RECORDED HERE
-- RATHER THAN QUIETLY REPLACED. It used to be SQL because the sole-writer lint
-- refused a `User` write from this package: the only directory permitted to
-- write that row was `packages/contexts/identity-access`, which may not hold a
-- client. Tranche 2 delegates identity-access's canonical store to THIS
-- directory (`CANONICAL_STORE_ADAPTERS` in scripts/arch/table-ownership.mjs), so
-- that refusal no longer applies and `src/identity-harness.ts` seeds its users
-- THROUGH the port instead.
--
-- The file stays because tranche 1's two suites name these exact identifiers and
-- because a fixture applied by `prisma db execute` needs no code path at all.
-- It is a fixture for the TENANCY suites, and the identity-access suites do not
-- use it.
--
-- The identifiers are fixed so the suite can name them. They match the
-- constants in src/harness.ts.
--
-- `OperatorSession.tokenHash` is 64 lowercase hex characters because
-- `OperatorSession_tokenHash_check` requires it. That constraint is in the
-- migrations and NOT in the in-memory double, which is the first thing this
-- suite found: a readable placeholder was refused by PostgreSQL and would have
-- been accepted by every unit test in the tree.

INSERT INTO "User" ("id", "email", "displayName", "platformOperator", "createdAt", "updatedAt")
VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test', 'Owner', false, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('22222222-2222-4222-8222-222222222222', 'second-owner@example.test', 'Second owner', false, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('33333333-3333-4333-8333-333333333333', 'member@example.test', 'Member', false, '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "OperatorSession" ("id", "tokenHash", "tier", "userId", "expiresAt", "createdAt")
VALUES
  ('44444444-4444-4444-8444-444444444444', 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0', 'OPERATOR', '11111111-1111-4111-8111-111111111111', '2026-06-01T09:00:00Z', '2026-05-01T09:00:00Z');
