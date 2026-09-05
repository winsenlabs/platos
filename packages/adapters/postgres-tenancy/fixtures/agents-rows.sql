-- The tenant tree and the SKILL CHAIN the `agents` suites hang off.
--
-- WHY THE SKILL CHAIN IS HERE AND NOT IN THE HARNESS. `AgentSkill` names an
-- `EnvironmentSkill` by foreign key, and ADR M0.3 §1 row 6 makes `skills` the
-- sole writer of `Skill`, `ProjectSkill` and `EnvironmentSkill`. `skills` has no
-- entry in `CANONICAL_STORE_ADAPTERS`, so this directory may not write those
-- three rows at all — a `$executeRawUnsafe("INSERT INTO \"EnvironmentSkill\" …")`
-- in the harness would be a sole-writer violation, and correctly so. A fixture
-- applied by `prisma db execute` is not a package file and is not judged by that
-- lint, which is the honest way to say "this row belongs to a context whose
-- store does not exist yet" rather than reaching for a permission the ownership
-- map deliberately withholds.
--
-- WHY THE TENANT TREE IS HERE TOO, when this directory IS permitted to write it.
-- The skill chain has to hang off a project and an environment, and this file is
-- applied before any code runs, so the ids have to be fixed. Seeding the two
-- halves in two places would mean the fixture's environment and the harness's
-- were different rows, and `enforce_domain_ancestry` compares exactly those.
--
-- THE THREE ENVIRONMENTS ARE THE SCOPE CASES, and each is load bearing:
--
--   the HOME environment, where almost everything is written;
--   the PEER environment, in the SAME project — an agent is visible to both, so
--     this is where "bound here, not bound there" is a real distinction rather
--     than a different tenant;
--   the FOREIGN environment, in a DIFFERENT project — this is what
--     `AgentBinding_ancestry` and `PostmanTemplate_ancestry` refuse, and neither
--     refusal exists in the in-memory double.
--
-- The identifiers are fixed so the suites can name them; they match the
-- constants in src/agents-harness.ts.

INSERT INTO "Organization" ("id", "slug", "name", "createdAt", "updatedAt")
VALUES ('aa000000-0000-4000-8000-000000000001', 'agents-suite', 'Agents suite', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "Project" ("id", "organizationId", "slug", "name", "createdAt", "updatedAt")
VALUES
  ('aa000000-0000-4000-8000-000000000002', 'aa000000-0000-4000-8000-000000000001', 'home', 'Home', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 'foreign', 'Foreign', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "Environment" ("id", "projectId", "slug", "name", "createdAt", "updatedAt")
VALUES
  ('aa000000-0000-4000-8000-000000000004', 'aa000000-0000-4000-8000-000000000002', 'home', 'Home', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-000000000005', 'aa000000-0000-4000-8000-000000000002', 'peer', 'Peer', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-000000000006', 'aa000000-0000-4000-8000-000000000003', 'foreign', 'Foreign', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "Skill" ("id", "organizationId", "slug", "name", "description", "version", "origin", "source", "manifest", "promptBlock", "createdAt", "updatedAt")
VALUES
  ('aa000000-0000-4000-8000-000000000007', 'aa000000-0000-4000-8000-000000000001', 'first', 'First', 'The first skill', '1.0.0', 'builtin', 'inline', '{}'::jsonb, 'first', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-000000000008', 'aa000000-0000-4000-8000-000000000001', 'second', 'Second', 'The second skill', '1.0.0', 'builtin', 'inline', '{}'::jsonb, 'second', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "ProjectSkill" ("id", "projectId", "skillId", "createdAt", "updatedAt")
VALUES
  ('aa000000-0000-4000-8000-000000000009', 'aa000000-0000-4000-8000-000000000002', 'aa000000-0000-4000-8000-000000000007', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-00000000000a', 'aa000000-0000-4000-8000-000000000002', 'aa000000-0000-4000-8000-000000000008', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-00000000000b', 'aa000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000007', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');

INSERT INTO "EnvironmentSkill" ("id", "environmentId", "projectSkillId", "createdAt", "updatedAt")
VALUES
  ('aa000000-0000-4000-8000-00000000000c', 'aa000000-0000-4000-8000-000000000004', 'aa000000-0000-4000-8000-000000000009', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-00000000000d', 'aa000000-0000-4000-8000-000000000004', 'aa000000-0000-4000-8000-00000000000a', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-00000000000e', 'aa000000-0000-4000-8000-000000000005', 'aa000000-0000-4000-8000-000000000009', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z'),
  ('aa000000-0000-4000-8000-00000000000f', 'aa000000-0000-4000-8000-000000000006', 'aa000000-0000-4000-8000-00000000000b', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');
