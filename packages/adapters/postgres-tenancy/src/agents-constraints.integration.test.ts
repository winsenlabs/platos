// What the MIGRATIONS refuse and `schema.prisma` does not say.
//
// Every case below was found by running this adapter against a real container,
// and every one of them is accepted in silence by `InMemoryAgentsRepository` or
// `InMemoryScaffolding` — which is the point: a double that accepts a write the
// database refuses lets a use case pass its whole suite and fail in production.
// Each test names the constraint or the rule, and says what the double does.
//
// THE RULES ARE NOT IN THE SCHEMA FILE AT ALL. `enforce_domain_ancestry` and
// `reject_canonical_owner_change` are plpgsql functions installed by
// `migrations/00000000000000_initial`, and both fire on UPDATE as well as
// INSERT. Reading `schema.prisma` and stopping there would have found none of
// them; three of this tranche's five findings are theirs.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemoryAgentsRepository } from "@platos/context-agents/application/index.js";
import type {
  AgentBinding,
  AgentCluster,
  ProjectId,
} from "@platos/context-agents/application/ports/index.js";
import { DEFAULT_AGENTS_POLICY } from "@platos/context-agents/application/ports/index.js";

import {
  CANARY_PERCENT_OUT_OF_RANGE,
  CROSSES_OWNER_ANCESTRY,
  MACRO_NAME_TAKEN,
  OWNER_KEY_IMMUTABLE,
  TEMPLATE_NAME_TAKEN,
} from "./agents-guards.js";
import {
  agentSlugOf,
  bindingIdOf,
  clusterIdOf,
  FIRST_SKILL,
  FOREIGN_ENVIRONMENT,
  FOREIGN_PROJECT,
  FOREIGN_SKILL,
  HOME_ENVIRONMENT,
  PEER_ENVIRONMENT,
  PEER_SKILL,
  scopeOf,
  skillIdOf,
  startAgentsHarness,
  type AgentsHarness,
  type SeededAgent,
} from "./agents-harness.js";

let harness: AgentsHarness;
let home: SeededAgent;
let neighbour: SeededAgent;

const HOME = scopeOf(HOME_ENVIRONMENT);
const FOREIGN = scopeOf(FOREIGN_ENVIRONMENT, FOREIGN_PROJECT);

/** The refusal reason a `Result` carries, or the code when it is not a refusal. */
function reasonOf(result: { readonly ok: boolean; readonly error?: { readonly code: string; readonly details: Readonly<Record<string, unknown>> } }): string {
  if (result.ok) return "ACCEPTED";
  return `${result.error!.code}:${String(result.error!.details["reason"] ?? "")}`;
}

async function raw(sql: string, ...args: unknown[]): Promise<unknown> {
  const client = harness.client as never as {
    $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number>;
  };
  return client.$executeRawUnsafe(sql, ...args);
}

beforeAll(async () => {
  harness = await startAgentsHarness();
  home = await harness.seedAgent({ slug: "constraints-home" });
  neighbour = await harness.seedAgent({
    slug: "constraints-neighbour",
    environmentId: FOREIGN_ENVIRONMENT,
    projectId: FOREIGN_PROJECT,
  });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe("constraints only the migrations carry", () => {
  test("AgentBinding_canaryPercent_check refuses a percentage above one hundred", async () => {
    const overshoot: AgentBinding = {
      ...home.binding,
      agentBindingId: bindingIdOf(harness.freshId("0301")),
      canaryPercent: 101,
    };
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertBinding(overshoot, transaction),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CANARY_PERCENT_OUT_OF_RANGE}`);

    // The double has no such check. It is not asserted as a bug in the double —
    // it is the divergence this suite exists to record.
    const fake = new InMemoryAgentsRepository(DEFAULT_AGENTS_POLICY);
    const accepted = await fake.insertBinding(overshoot, { transactionId: "t" as never });
    expect(accepted.ok).toBe(true);
  });

  test("enforce_domain_ancestry refuses a binding whose agent belongs to another project", async () => {
    const crossed: AgentBinding = {
      ...home.binding,
      agentBindingId: bindingIdOf(harness.freshId("0302")),
      agentId: neighbour.agent.agentId,
      activeVersionId: neighbour.version.agentVersionId,
    };
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.insertBinding(crossed, transaction),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CROSSES_OWNER_ANCESTRY}`);
  });

  test("enforce_domain_ancestry refuses a canary version that belongs to another agent", async () => {
    const foreignCanary: AgentBinding = {
      ...home.binding,
      canaryVersionId: neighbour.version.agentVersionId,
      canaryPercent: 10,
    };
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.updateBinding(foreignCanary, transaction),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CROSSES_OWNER_ANCESTRY}`);

    // The double stores whatever version id it is handed, so a canary pointing
    // at ANOTHER AGENT's configuration is accepted and then served.
    const fake = new InMemoryAgentsRepository(DEFAULT_AGENTS_POLICY);
    fake.seedBinding(home.binding);
    const accepted = await fake.updateBinding(foreignCanary, { transactionId: "t" as never });
    expect(accepted.ok).toBe(true);
  });

  test("enforce_domain_ancestry refuses a cluster from another environment", async () => {
    const elsewhere = await harness.seedCluster({
      slug: "elsewhere",
      environmentId: PEER_ENVIRONMENT,
    });
    const crossed: AgentBinding = { ...home.binding, clusterId: elsewhere.clusterId };
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.updateBinding(crossed, transaction),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CROSSES_OWNER_ANCESTRY}`);
  });

  test("Agent_owner_immutable refuses a save that moves an agent between projects", async () => {
    const moved = { ...home.agent, projectId: FOREIGN_PROJECT as never as ProjectId };
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.updateAgent(moved, transaction),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${OWNER_KEY_IMMUTABLE}`);

    // The double replaces the record wholesale, so the agent silently changes
    // project — and every read scoped to the OLD project stops finding it.
    const fake = new InMemoryAgentsRepository(DEFAULT_AGENTS_POLICY);
    fake.seedAgent(home.agent);
    const accepted = await fake.updateAgent(moved, { transactionId: "t" as never });
    expect(accepted.ok).toBe(true);
    expect(fake.agents.get(home.agent.agentId)?.projectId).toBe(FOREIGN_PROJECT);
  });

  test("AgentCluster_owner_immutable refuses a save that moves a cluster between environments", async () => {
    const cluster = await harness.seedCluster({ slug: "immutable-owner" });
    const moved: AgentCluster = { ...cluster, environmentId: PEER_ENVIRONMENT as never };
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.updateCluster(moved, transaction),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${OWNER_KEY_IMMUTABLE}`);
  });

  test("enforce_domain_ancestry refuses a template for an agent in another project", async () => {
    const real = await harness.adapter.unitOfWork.run((transaction) =>
      harness.scaffolding.insertTemplate(
        {
          templateId: clusterIdOf(harness.freshId("0303")) as never,
          environmentId: HOME.environmentId,
          agentId: neighbour.agent.agentId,
          name: "crossed",
          simulateUserId: "simulated-1",
          sessionContext: null,
          isDefault: false,
          createdBy: agentSlugOf("operator-1") as never,
          createdAt: new Date("2026-05-01T09:00:00.000Z"),
          updatedAt: new Date("2026-05-01T09:00:00.000Z"),
        },
        transaction,
      ),
    );
    expect(reasonOf(real)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CROSSES_OWNER_ANCESTRY}`);
  });

  test("Macro is unique per environment and name, which the double does not know", async () => {
    await harness.seedMacro({ name: "unique-macro" });
    const again = harness.adapter.unitOfWork.run((transaction) =>
      harness.scaffolding.insertMacro(
        {
          macroId: clusterIdOf(harness.freshId("0304")) as never,
          environmentId: HOME.environmentId,
          name: "unique-macro",
          description: null,
          steps: [],
          paramSchema: null,
          sharedWithOrganization: false,
          createdBy: agentSlugOf("operator-1") as never,
          createdAt: new Date("2026-05-01T09:00:00.000Z"),
          updatedAt: new Date("2026-05-01T09:00:00.000Z"),
        },
        transaction,
      ),
    );
    expect(reasonOf(await again)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${MACRO_NAME_TAKEN}`);
  });

  test("PostmanTemplate is unique per environment, agent and name", async () => {
    await harness.seedTemplate({ name: "unique-template", agent: home });
    const again = await harness.adapter.unitOfWork.run((transaction) =>
      harness.scaffolding.insertTemplate(
        {
          templateId: clusterIdOf(harness.freshId("0305")) as never,
          environmentId: HOME.environmentId,
          agentId: home.agent.agentId,
          name: "unique-template",
          simulateUserId: "simulated-2",
          sessionContext: null,
          isDefault: false,
          createdBy: agentSlugOf("operator-1") as never,
          createdAt: new Date("2026-05-01T09:00:00.000Z"),
          updatedAt: new Date("2026-05-01T09:00:00.000Z"),
        },
        transaction,
      ),
    );
    expect(reasonOf(again)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${TEMPLATE_NAME_TAKEN}`);
  });

  test("AgentSkill ancestry is judged by PROJECT, not by environment", async () => {
    // A skill offered in a PEER environment of the SAME project is ACCEPTED.
    // That is the rule as written, it is not what the port's name suggests, and
    // it is recorded here as an observation rather than asserted as intent.
    const accepted = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.replaceLoadout(
        home.version.agentVersionId,
        [{ environmentSkillId: skillIdOf(PEER_SKILL), enabled: true, config: {} }],
        transaction,
      ),
    );
    expect(accepted.ok).toBe(true);

    // A skill in another PROJECT's environment is refused.
    const refusedLoadout = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.replaceLoadout(
        home.version.agentVersionId,
        [{ environmentSkillId: skillIdOf(FOREIGN_SKILL), enabled: true, config: {} }],
        transaction,
      ),
    );
    expect(reasonOf(refusedLoadout)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CROSSES_OWNER_ANCESTRY}`);

    // An `EnvironmentSkill` that does not exist at all reaches the ancestry rule
    // BEFORE the foreign key, so it is the same refusal rather than a FK one.
    const unknown = await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.replaceLoadout(
        home.version.agentVersionId,
        [
          {
            environmentSkillId: skillIdOf("aa000000-0000-4000-8000-0000000000ff"),
            enabled: true,
            config: {},
          },
        ],
        transaction,
      ),
    );
    expect(reasonOf(unknown)).toBe(`AGENTS_REPOSITORY_UNAVAILABLE:${CROSSES_OWNER_ANCESTRY}`);

    // Put the loadout back so no later case inherits this one's state.
    await harness.adapter.unitOfWork.run((transaction) =>
      harness.repository.replaceLoadout(
        home.version.agentVersionId,
        [{ environmentSkillId: skillIdOf(FIRST_SKILL), enabled: true, config: {} }],
        transaction,
      ),
    );
  });

  test("AgentVersion_toolsBlockConfig_enabledTools_check is why packVersionRow moves the tool list", async () => {
    // The column may not carry `enabledTools`. Proved directly, because no path
    // through the port can produce it — which is the claim being made.
    await expect(
      raw(
        `INSERT INTO "AgentVersion" ("id","agentId","versionNumber","model","toolsBlockConfig","createdBy","createdAt") VALUES ($1::uuid,$2::uuid,9001,'m','{"enabledTools":[]}'::jsonb,'op',now())`,
        harness.freshId("0306"),
        home.agent.agentId,
      ),
    ).rejects.toThrow(/AgentVersion_toolsBlockConfig_enabledTools_check/u);

    // And through the port, with `enabledTools` in the snapshot's tools config,
    // the write is accepted and the list comes back on the READ — because the
    // envelope carries it and the projection puts it back.
    const carried = await harness.seedAgent({
      slug: "carries-tools",
      snapshot: { toolsBlockConfig: { enabledTools: ["alpha"] } as never },
    });
    const readBack = await harness.repository.findVersion(
      carried.agent.agentId,
      carried.version.agentVersionId,
    );
    expect(readBack.ok).toBe(true);
    expect(
      readBack.ok ? (readBack.value?.snapshot.toolsBlockConfig as { enabledTools?: unknown }) : null,
    ).toMatchObject({ enabledTools: ["alpha"] });
  });

  test("a version a binding still serves cannot be deleted", async () => {
    await expect(
      raw(`DELETE FROM "AgentVersion" WHERE id = $1::uuid`, home.version.agentVersionId),
    ).rejects.toThrow(/AgentBinding_activeAgentVersionId_fkey/u);
  });

  test("a search term that is not an identifier is a page, not a failed read", async () => {
    // Unguarded, the id filter hands a malformed uuid to the driver and the
    // WHOLE read fails. Both halves are proved: the port answers a page, and the
    // driver refuses the same term when it reaches a uuid column.
    const page = await harness.repository.pageBoundAgents(HOME, {
      limit: 10,
      offset: 0,
      search: "not-an-identifier",
      active: null,
    });
    expect(page.ok).toBe(true);
    await expect(
      (harness.client as never as { agent: { findMany(args: unknown): Promise<unknown> } }).agent.findMany({
        where: { id: "not-an-identifier" },
      }),
    ).rejects.toThrow(/UUID/u);
  });

  test("a macro whose steps are not an array is refused by the column, not by the reader", async () => {
    await expect(
      raw(
        `INSERT INTO "Macro" ("id","environmentId","name","steps","sharedWithOrganization","createdBy","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'bad-steps','{}'::jsonb,false,'op',now(),now())`,
        harness.freshId("0307"),
        HOME_ENVIRONMENT,
      ),
    ).rejects.toThrow(/Macro_steps_json_root/u);
  });

  test("an agent in another project is invisible, not refused", async () => {
    // The scope is a filter on the read, so a foreign agent answers null rather
    // than raising — which is what stops a probe telling one tenant that another
    // tenant's id exists.
    const found = await harness.repository.findBoundAgent(HOME, neighbour.agent.agentId);
    expect(found.ok && found.value).toBeNull();
    const inItsOwnScope = await harness.repository.findBoundAgent(FOREIGN, neighbour.agent.agentId);
    expect(inItsOwnScope.ok && inItsOwnScope.value !== null).toBe(true);
  });
});
