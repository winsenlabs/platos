// Statement counts for the `skills` store, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected, and every read is measured TWICE: once over a small catalogue and
// once over one an order of magnitude larger. What matters is not the figure but
// that the figure DOES NOT MOVE with the number of rows. An N+1 does not announce
// itself in a suite — every value is correct and every test passes — it announces
// itself as a library page that took four seconds because the organization had
// forty skills.
//
// *** THE ONE PLACE THIS CONTEXT COULD NOT AVOID AN N+1 WITHOUT RAW SQL ***
// `anonymizeAuthoredSkills` overwrites the author in TWO places — the column and
// the `author` field of the stored `manifest` JSON — and the client cannot
// express a partial JSONB update. Through the delegate API it is one read plus
// one UPDATE PER ROW, on the erasure path, whose row count is exactly the number
// the same selector just reported and is bounded by nothing. `jsonb_set` in one
// `$executeRaw` is what makes it one statement, and the pair of measurements
// below — one matching row and twenty — is what proves it.
//
// THE PROBE FILTER IS ANCHORED, AND THE ANCHOR IS THE POINT. The driver's
// connection probe is exactly `SELECT 1`, and a filter written as a SUBSTRING
// match would discard any statement containing it — which is how tranche 3
// measured an advisory lock at ZERO statements. The pattern below matches the
// whole statement, and the case at the end asserts that not one measured
// statement of this store would have been swallowed by it.

import { afterAll, beforeAll, expect, test } from "vitest";

import type {
  EnvironmentSkillId,
  Installation,
  OrganizationScope,
  ProjectInstallation,
  SkillId,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier } from "@platos/context-skills/application/ports/index.js";
import { runResult } from "@platos/kernel";

import { conformanceDraft, conformanceIdentity } from "./skills-conformance.js";
import { startSkillsHarness, type SkillsHarness, type SkillsTenant } from "./skills-harness.js";

let harness: SkillsHarness;
/** Two visible skills, one installed. */
let small: SkillsTenant;
/** Twenty-two visible skills, twenty installed. */
let large: SkillsTenant;

let smallSkillId: SkillId;
let smallBindingId: EnvironmentSkillId;
let smallInstallations: readonly Installation[] = [];

let largeSkillId: SkillId;
let largeBindingIds: EnvironmentSkillId[] = [];
let largeInstallations: readonly Installation[] = [];

const HEAVY = 20;
const AUTHOR = "subject-a";

function queries(): readonly string[] {
  return harness
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\s*$/iu.test(statement) &&
        !/^\s*SELECT 1\s*$/iu.test(statement),
    );
}

/**
 * Let the client's `query` events arrive.
 *
 * The event is emitted ASYNCHRONOUSLY, after the call has resolved, and a count
 * taken in the same tick can miss the last statement — which is not merely a
 * measurement that reads low: the missed event lands in the NEXT measurement's
 * array, so one pin reads one short and the pin after it reads one long.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

async function measure(work: () => Promise<unknown>): Promise<number> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  return queries().length;
}

async function seed(
  tenant: SkillsTenant,
  slug: string,
  install: boolean,
): Promise<{ skillId: SkillId; bindingId: EnvironmentSkillId | null }> {
  const written = await runResult(harness, (transaction) =>
    harness.repository.upsertSkill(
      conformanceDraft(tenant.scope, slug, "1.0.0", { isOfficial: true }),
      transaction,
    ),
  );
  if (!written.ok) throw new Error(`the fixture must register: ${slug}`);
  const skillId = written.value.skillId;
  if (!install) return { skillId, bindingId: null };
  const bindingId = await harness.run(async (transaction) => {
    const project = await harness.repository.upsertProjectInstallation(
      tenant.scope,
      skillId,
      transaction,
    );
    if (!project.ok) throw new Error("the fixture must adopt");
    const binding = await harness.repository.upsertEnvironmentInstallation(
      tenant.scope,
      project.value as ProjectInstallation,
      transaction,
    );
    if (!binding.ok) throw new Error("the fixture must bind");
    return binding.value.environmentSkillId;
  });
  return { skillId, bindingId };
}

async function resolveAll(
  tenant: SkillsTenant,
  ids: readonly EnvironmentSkillId[],
): Promise<readonly Installation[]> {
  const found = await harness.repository.findInstallationsByIds(tenant.scope, ids);
  return found.ok ? found.value : [];
}

beforeAll(async () => {
  harness = await startSkillsHarness();
  small = await harness.freshTenant();
  large = await harness.freshTenant();

  const seeded = await seed(small, "acme.small", true);
  smallSkillId = seeded.skillId;
  smallBindingId = seeded.bindingId as EnvironmentSkillId;
  await seed(small, "acme.smallspare", false);
  smallInstallations = await resolveAll(small, [smallBindingId]);

  for (let index = 0; index < HEAVY; index += 1) {
    const one = await seed(large, `acme.big${String(index).padStart(2, "0")}`, true);
    if (index === 0) largeSkillId = one.skillId;
    largeBindingIds.push(one.bindingId as EnvironmentSkillId);
  }
  await seed(large, "acme.bigspare", false);
  await seed(large, "acme.bigspare2", false);
  largeInstallations = await resolveAll(large, largeBindingIds);

  // Twenty rows authored by the erasure subject in the large tenant, and one in
  // the small, so the anonymisation's cost can be measured against both.
  for (let index = 0; index < HEAVY; index += 1) {
    await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(
        conformanceDraft(large.scope, `acme.authored${String(index).padStart(2, "0")}`, "1.0.0", {
          isOfficial: true,
          manifest: { author: AUTHOR },
        }),
        transaction,
      ),
    );
  }
  await runResult(harness, (transaction) =>
    harness.repository.upsertSkill(
      conformanceDraft(small.scope, "acme.authored", "1.0.0", {
        isOfficial: true,
        manifest: { author: AUTHOR },
      }),
      transaction,
    ),
  );
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

/**
 * Every measurement, taken over both fixtures.
 *
 * One map rather than one case per method, deliberately: a divergence then shows
 * EVERY pin that moved in one failure instead of the first one, and the small
 * and large columns sit beside each other so an N+1 is visible as a difference
 * between two numbers on the same line rather than as a number somebody has to
 * remember.
 */
async function measureAll(): Promise<Record<string, { small: number; large: number }>> {
  const organizationOf = (tenant: SkillsTenant): OrganizationScope => ({
    level: "organization",
    organizationId: asIdentifier(tenant.organizationId),
  });

  return {
    findVisibleSkill: {
      small: await measure(() => harness.repository.findVisibleSkill(small.scope, smallSkillId)),
      large: await measure(() => harness.repository.findVisibleSkill(large.scope, largeSkillId)),
    },
    findVisibleSkillByReference: {
      small: await measure(() =>
        harness.repository.findVisibleSkillByReference(small.scope, "acme.small"),
      ),
      large: await measure(() =>
        harness.repository.findVisibleSkillByReference(large.scope, "acme.big00"),
      ),
    },
    findSkillByIdentity: {
      small: await measure(() =>
        harness.repository.findSkillByIdentity(conformanceIdentity(small.scope, "acme.small", "1.0.0")),
      ),
      large: await measure(() =>
        harness.repository.findSkillByIdentity(conformanceIdentity(large.scope, "acme.big00", "1.0.0")),
      ),
    },
    listVisibleSkills: {
      small: await measure(() => harness.repository.listVisibleSkills(small.scope)),
      large: await measure(() => harness.repository.listVisibleSkills(large.scope)),
    },
    pageVisibleSkills: {
      small: await measure(() =>
        harness.repository.pageVisibleSkills(small.scope, { limit: 10, offset: 0, search: null }),
      ),
      large: await measure(() =>
        harness.repository.pageVisibleSkills(large.scope, { limit: 10, offset: 0, search: null }),
      ),
    },
    pageVisibleSkillsSearching: {
      small: await measure(() =>
        harness.repository.pageVisibleSkills(small.scope, { limit: 10, offset: 0, search: "acme" }),
      ),
      large: await measure(() =>
        harness.repository.pageVisibleSkills(large.scope, { limit: 10, offset: 0, search: "acme" }),
      ),
    },
    hasOfficialSkills: {
      small: await measure(() => harness.repository.hasOfficialSkills(organizationOf(small))),
      large: await measure(() => harness.repository.hasOfficialSkills(organizationOf(large))),
    },
    findInstallation: {
      small: await measure(() => harness.repository.findInstallation(small.scope, smallSkillId)),
      large: await measure(() => harness.repository.findInstallation(large.scope, largeSkillId)),
    },
    findInstallationById: {
      small: await measure(() =>
        harness.repository.findInstallationById(small.scope, smallBindingId),
      ),
      large: await measure(() =>
        harness.repository.findInstallationById(large.scope, largeBindingIds[0] as EnvironmentSkillId),
      ),
    },
    // THE BULK RUNTIME LOAD. One id against twenty: the pin that would move if
    // the store resolved a project adoption per binding.
    findInstallationsByIds: {
      small: await measure(() =>
        harness.repository.findInstallationsByIds(small.scope, [smallBindingId]),
      ),
      large: await measure(() =>
        harness.repository.findInstallationsByIds(large.scope, largeBindingIds),
      ),
    },
    findSkillsForInstallations: {
      small: await measure(() =>
        harness.repository.findSkillsForInstallations(small.scope, smallInstallations),
      ),
      large: await measure(() =>
        harness.repository.findSkillsForInstallations(large.scope, largeInstallations),
      ),
    },
    countAuthoredSkills: {
      small: await measure(() =>
        harness.repository.countAuthoredSkills({
          scope: organizationOf(small),
          principalId: AUTHOR,
        }),
      ),
      large: await measure(() =>
        harness.repository.countAuthoredSkills({
          scope: organizationOf(large),
          principalId: AUTHOR,
        }),
      ),
    },
    upsertSkillInserting: {
      small: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.upsertSkill(
            conformanceDraft(small.scope, "acme.measured", "1.0.0"),
            transaction,
          ),
        ),
      ),
      large: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.upsertSkill(
            conformanceDraft(large.scope, "acme.measured", "1.0.0"),
            transaction,
          ),
        ),
      ),
    },
    upsertSkillUpdating: {
      small: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.upsertSkill(
            conformanceDraft(small.scope, "acme.measured", "1.0.0"),
            transaction,
          ),
        ),
      ),
      large: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.upsertSkill(
            conformanceDraft(large.scope, "acme.measured", "1.0.0"),
            transaction,
          ),
        ),
      ),
    },
    patchSkill: {
      small: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.patchSkill(smallSkillId, { name: "measured" }, transaction),
        ),
      ),
      large: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.patchSkill(largeSkillId, { name: "measured" }, transaction),
        ),
      ),
    },
    upsertProjectInstallation: {
      small: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.upsertProjectInstallation(small.scope, smallSkillId, transaction),
        ),
      ),
      large: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.upsertProjectInstallation(large.scope, largeSkillId, transaction),
        ),
      ),
    },
    deleteEnvironmentInstallation: {
      small: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.deleteEnvironmentInstallation(
            small.scope,
            asIdentifier<SkillId>("cccccccc-0001-4000-8000-000000000001"),
            transaction,
          ),
        ),
      ),
      large: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.deleteEnvironmentInstallation(
            large.scope,
            asIdentifier<SkillId>("cccccccc-0001-4000-8000-000000000001"),
            transaction,
          ),
        ),
      ),
    },
    // ONE MATCHING ROW AGAINST TWENTY. The number that would be 2 and 21 if the
    // manifest half were an update per row.
    anonymizeAuthoredSkills: {
      small: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.anonymizeAuthoredSkills(
            { scope: organizationOf(small), principalId: AUTHOR },
            transaction,
          ),
        ),
      ),
      large: await measure(() =>
        runResult(harness, (transaction) =>
          harness.repository.anonymizeAuthoredSkills(
            { scope: organizationOf(large), principalId: AUTHOR },
            transaction,
          ),
        ),
      ),
    },
  };
}

test("every statement count is pinned and NONE of them moves with the number of rows", async () => {
  const measured = await measureAll();
  expect(measured).toEqual(PINS);
  for (const [method, counts] of Object.entries(measured)) {
    expect({ method, sameAcrossFixtures: counts.small === counts.large }).toEqual({
      method,
      sameAcrossFixtures: true,
    });
  }
}, 600_000);

test("the probe filter did not swallow a statement this store sent", async () => {
  // Trap 4, stated as a case. A statement-count suite whose filter discards the
  // thing it measures reports ZERO and passes.
  await settle();
  harness.resetStatements();
  const probeScope: OrganizationScope = {
    level: "organization",
    organizationId: asIdentifier(small.organizationId),
  };
  await harness.repository.hasOfficialSkills(probeScope);
  await settle();
  const all = harness.statements();
  const swallowed = all.filter((statement) => /^\s*SELECT 1\s*$/iu.test(statement));
  const measuredStatements = queries();
  expect(measuredStatements.length).toBeGreaterThan(0);
  // Every statement this store sends names a table, so none of them is the bare
  // probe — and the filter is anchored, so one that merely CONTAINED `SELECT 1`
  // would still be counted.
  expect(swallowed.every((statement) => statement.trim().toUpperCase() === "SELECT 1")).toBe(true);
  expect(measuredStatements.some((statement) => /"Skill"/u.test(statement))).toBe(true);
}, 300_000);

/**
 * The measured counts. EVERY ONE OF THEM WAS OBSERVED FIRST.
 *
 * Filled in from a container run; the suite fails if any of them moves, in
 * either column, so a read that grew a statement is a red build rather than a
 * slow page.
 */
const PINS: Record<string, { small: number; large: number }> = {
  findVisibleSkill: { small: 1, large: 1 },
  findVisibleSkillByReference: { small: 1, large: 1 },
  findSkillByIdentity: { small: 1, large: 1 },
  listVisibleSkills: { small: 1, large: 1 },
  pageVisibleSkills: { small: 2, large: 2 },
  pageVisibleSkillsSearching: { small: 2, large: 2 },
  hasOfficialSkills: { small: 1, large: 1 },
  findInstallation: { small: 2, large: 2 },
  findInstallationById: { small: 2, large: 2 },
  findInstallationsByIds: { small: 2, large: 2 },
  findSkillsForInstallations: { small: 1, large: 1 },
  countAuthoredSkills: { small: 1, large: 1 },
  upsertSkillInserting: { small: 1, large: 1 },
  upsertSkillUpdating: { small: 1, large: 1 },
  patchSkill: { small: 1, large: 1 },
  upsertProjectInstallation: { small: 1, large: 1 },
  deleteEnvironmentInstallation: { small: 1, large: 1 },
  anonymizeAuthoredSkills: { small: 1, large: 1 },
};
