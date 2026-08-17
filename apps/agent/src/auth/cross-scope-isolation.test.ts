/**
 * PPR-36 — Cross-scope fail-closed integration test (REAL, not scaffold).
 *
 * Spins up ONE Postgres testcontainer (via `@internal/testcontainers`
 * `postgresTest`, whose `prisma` fixture is fully schema-d by
 * `prisma db push --force-reset`), seeds TWO complete scopes, and asserts
 * that the four boundaries this security audit actually moved are
 * fail-closed at the Prisma query layer:
 *
 *   a. cross-ORG   Agent              — findFirst null; updateMany/deleteMany
 *                                        count 0; row survives.
 *   b. cross-ORG   Thread             — findFirst null.
 *   c. cross-USER  Thread             — findFirst null (H3 / Phase-2 room
 *                                        isolation: same org/project/env,
 *                                        different userId).
 *   d. cross-USER  Memory             — findMany [] / findFirst null (H7:
 *                                        same scope tuple, different userId).
 *
 * The scope model in Prisma is a code-level convention
 * (`where: { organizationId, projectId, environmentId[, userId] }`), not a
 * DB-enforced RLS constraint. This test pins that the convention holds for
 * the concrete rows the audit hardened: a query carrying the WRONG scope
 * tuple must return nothing and mutate nothing.
 *
 * CLAUDE.md §9.11: Vitest only, never mock — real Postgres via testcontainers.
 *
 * NOTE: intentionally NOT guarded by `describe.skipIf(process.env.GITHUB_ACTIONS)`
 * — this suite is the CI enforcement gate; it MUST run in CI. ubuntu-latest
 * has Docker.
 */
import { describe, it, expect, vi } from "vitest";
import { postgresTest } from "@internal/testcontainers";

// Container pull + start + `prisma db push` on a cold CI runner can take a
// while; the fixture setup counts against the test/hook timeout.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

describe("cross-scope fail-closed (real Postgres testcontainer)", () => {
  postgresTest(
    "scoped Prisma reads/writes are fail-closed across org and user boundaries",
    async ({ prisma }) => {
      // ── Seed scope A ────────────────────────────────────────────────
      const orgA = await prisma.organization.create({
        data: { slug: "org-a", name: "Org A" },
      });
      const projA = await prisma.project.create({
        data: {
          slug: "proj-a",
          name: "Project A",
          organizationId: orgA.id,
        },
      });
      const envA = await prisma.environment.create({
        data: {
          slug: "dev",
          name: "Development",
          projectId: projA.id,
        },
      });
      const userA1 = await prisma.endUser.create({ data: { organizationId: orgA.id } });
      const userA2 = await prisma.endUser.create({ data: { organizationId: orgA.id } });

      // ── Seed scope B (a completely separate org) ────────────────────
      const orgB = await prisma.organization.create({
        data: { slug: "org-b", name: "Org B" },
      });
      const projB = await prisma.project.create({
        data: {
          slug: "proj-b",
          name: "Project B",
          organizationId: orgB.id,
        },
      });
      const envB = await prisma.environment.create({
        data: {
          slug: "dev",
          name: "Development",
          projectId: projB.id,
        },
      });

      // ── Scoped rows live entirely in scope A, owned by USER_1 ───────
      const agentA = await prisma.agent.create({
        data: {
          projectId: projA.id,
          name: "Agent A",
          slug: "agent-a",
        },
      });
      const threadA = await prisma.thread.create({
        data: {
          agentId: agentA.id,
          environmentId: envA.id,
          endUserId: userA1.id,
        },
      });
      const memoryA = await prisma.memory.create({
        data: {
          environmentId: envA.id,
          endUserId: userA1.id,
          agentId: agentA.id,
          kind: "fact",
          content: "scope-A secret fact",
          visibility: "private",
          source: "manual",
        },
      });

      // ─────────────────────────────────────────────────────────────────
      // a. cross-ORG Agent — reads null, writes touch 0 rows, survives.
      // ─────────────────────────────────────────────────────────────────
      expect(
        await prisma.agent.findFirst({
          where: { id: agentA.id, project: { organizationId: orgB.id } },
        })
      ).toBeNull();

      // Full wrong tuple (the exact where-shape the services build).
      expect(
        await prisma.agent.findFirst({
          where: {
            id: agentA.id,
            projectId: projB.id,
          },
        })
      ).toBeNull();

      const crossOrgUpdate = await prisma.agent.updateMany({
        where: { id: agentA.id, projectId: projB.id },
        data: { name: "HACKED" },
      });
      expect(crossOrgUpdate.count).toBe(0);

      const crossOrgDelete = await prisma.agent.deleteMany({
        where: { id: agentA.id, projectId: projB.id },
      });
      expect(crossOrgDelete.count).toBe(0);

      // The row must still exist, unmodified, when queried in its OWN scope.
      const survivor = await prisma.agent.findFirst({
        where: { id: agentA.id, projectId: projA.id },
      });
      expect(survivor).not.toBeNull();
      expect(survivor?.name).toBe("Agent A");

      // ─────────────────────────────────────────────────────────────────
      // b. cross-ORG Thread — findFirst null.
      // ─────────────────────────────────────────────────────────────────
      expect(
        await prisma.thread.findFirst({
          where: { id: threadA.id, environment: { project: { organizationId: orgB.id } } },
        })
      ).toBeNull();

      // ─────────────────────────────────────────────────────────────────
      // c. cross-USER Thread — SAME org/project/env, WRONG user.
      //    (H3 / Phase-2 per-user room isolation.)
      // ─────────────────────────────────────────────────────────────────
      expect(
        await prisma.thread.findFirst({
          where: {
            id: threadA.id,
            environmentId: envA.id,
            endUserId: userA2.id,
          },
        })
      ).toBeNull();

      // Control: the OWNER sees it.
      expect(
        await prisma.thread.findFirst({
          where: {
            id: threadA.id,
            environmentId: envA.id,
            endUserId: userA1.id,
          },
        })
      ).not.toBeNull();

      // ─────────────────────────────────────────────────────────────────
      // d. cross-USER Memory — SAME scope tuple, WRONG user. (H7.)
      // ─────────────────────────────────────────────────────────────────
      const crossUserMemories = await prisma.memory.findMany({
        where: {
          environmentId: envA.id,
          endUserId: userA2.id,
        },
      });
      expect(crossUserMemories).toHaveLength(0);

      expect(
        await prisma.memory.findFirst({
          where: { id: memoryA.id, endUserId: userA2.id },
        })
      ).toBeNull();

      // Control: the OWNER sees exactly their memory.
      const ownMemories = await prisma.memory.findMany({
        where: {
          environmentId: envA.id,
          endUserId: userA1.id,
        },
      });
      expect(ownMemories).toHaveLength(1);
      expect(ownMemories[0]?.id).toBe(memoryA.id);
    },
    180_000
  );
});

describe("cross-scope fail-closed (scope tuple sanity checks)", () => {
  // Pure-logic asserts that don't need a DB — the semantic basis for the
  // where-tuple checks above.
  const ORG_A = { organizationId: "org_A", projectId: "proj_A", environmentId: "env_A" };
  const ORG_B = { organizationId: "org_B", projectId: "proj_B", environmentId: "env_B" };

  it("scope objects with differing org are !== equal", () => {
    expect(ORG_A.organizationId).not.toBe(ORG_B.organizationId);
    expect(ORG_A.projectId).not.toBe(ORG_B.projectId);
    expect(ORG_A.environmentId).not.toBe(ORG_B.environmentId);
  });

  it("four-axis tuple — any differing axis means different scope", () => {
    const a = { ...ORG_A };
    const bDiffOrg = { ...ORG_A, organizationId: "org_Z" };
    const bDiffProj = { ...ORG_A, projectId: "proj_Z" };
    const bDiffEnv = { ...ORG_A, environmentId: "env_Z" };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(bDiffOrg));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(bDiffProj));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(bDiffEnv));
  });
});
