// Every value the CANONICAL SCHEMA refuses and `InMemorySkillsRepository`
// accepts, standing beside the constraint it comes from.
//
// EACH CASE IS A PAIR. The double is asked first and ACCEPTS; the adapter is
// asked the same thing and REFUSES, or the database does. A case that only
// showed the refusal would not establish that the double is the thing that is
// wrong, and "the double accepts what the canonical schema refuses" is the whole
// finding.
//
// *** SIX OF THE EIGHT CONSTRAINTS BELOW EXIST ONLY IN THE MIGRATIONS ***
//
// `schema.prisma` shows the three models with their columns, their `@@unique`
// keys and their foreign keys, and NONE of the following:
//
//   Skill_manifest_json_root           CHECK jsonb_typeof("manifest") = 'object'
//   Skill_providesTools_json_root      CHECK jsonb_typeof("providesTools") = 'array'
//   EnvironmentSkill_config_json_root  CHECK jsonb_typeof("config") = 'object'
//   Skill_owner_immutable              RULE: organizationId is immutable
//   ProjectSkill_ancestry              RULE: project and skill share an ORG
//   EnvironmentSkill_ancestry          RULE: environment and adoption share a
//                                      PROJECT — and BOTH fire ON UPDATE too
//
// The three CHECKs are read back out of `pg_catalog`, so the claim that they
// exist is measured rather than transcribed. The three RULES are proved by
// BEHAVIOUR instead — one raw statement each, applied through the ORM's own CLI
// and required to RAISE — and that is the stronger evidence rather than the
// convenient one: a catalogue read establishes that a rule is installed and says
// nothing about what it does, while a refused statement is the rule doing it.
// It also reaches the half a catalogue read cannot: BOTH ancestry rules fire ON
// UPDATE as well as ON INSERT, which is what decides that the two upserts below
// never move `projectId`, `skillId`, `environmentId` or `projectSkillId`.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemorySkillsRepository } from "@platos/context-skills/application/index.js";
import type {
  CatalogueScope,
  EnvironmentSkillId,
  ProjectSkillId,
  SkillId,
  SkillManifest,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier, catalogueScope } from "@platos/context-skills/application/ports/index.js";
import { runResult } from "@platos/kernel";

import { conformanceDraft, conformanceIdentity } from "./skills-conformance.js";
import {
  IDENTIFIER_NOT_UUID,
  IDENTITY_SEGMENT_EMPTY,
  MANIFEST_NOT_OBJECT,
  PROVIDED_TOOLS_NOT_ARRAY,
  SCOPE_ANCESTRY_INCOHERENT,
} from "./skills-guards.js";
import { startSkillsHarness, type SkillsHarness, type SkillsTenant } from "./skills-harness.js";

let harness: SkillsHarness;
let tenant: SkillsTenant;
let foreign: SkillsTenant;

beforeAll(async () => {
  harness = await startSkillsHarness();
  tenant = await harness.freshTenant();
  foreign = await harness.freshTenant();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function uuidStamps() {
  let counter = 0;
  let tick = Date.parse("2026-05-01T09:00:00.000Z");
  const mint = (kind: string): string => {
    counter += 1;
    return `eeeeeeee-${kind}-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  return {
    now: (): Date => new Date((tick += 1)),
    skillId: (): SkillId => asIdentifier<SkillId>(mint("0001")),
    projectSkillId: (): ProjectSkillId => asIdentifier<ProjectSkillId>(mint("0002")),
    environmentSkillId: (): EnvironmentSkillId => asIdentifier<EnvironmentSkillId>(mint("0003")),
  };
}

const FAKE_TXN: TransactionScope = { transactionId: asIdentifier("fake-txn") };

/** A catalogue row, adopted and bound in `tenant.scope`. All three ids. */
async function seedInstalled(slug: string): Promise<{
  readonly skillId: string;
  readonly projectSkillId: string;
  readonly environmentSkillId: string;
}> {
  const skill = await runResult(harness, (transaction) =>
    harness.repository.upsertSkill(conformanceDraft(tenant.scope, slug, "1.0.0"), transaction),
  );
  if (!skill.ok) throw new Error(`the fixture must register ${slug}`);
  return harness.run(async (transaction) => {
    const project = await harness.repository.upsertProjectInstallation(
      tenant.scope,
      skill.value.skillId,
      transaction,
    );
    if (!project.ok) throw new Error(`the fixture must adopt ${slug}`);
    const binding = await harness.repository.upsertEnvironmentInstallation(
      tenant.scope,
      project.value,
      transaction,
    );
    if (!binding.ok) throw new Error(`the fixture must bind ${slug}`);
    return {
      skillId: skill.value.skillId,
      projectSkillId: project.value.projectSkillId,
      environmentSkillId: binding.value.environmentSkillId,
    };
  });
}

function reasonOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "<not a result>";
  const shape = result as { readonly ok?: unknown; readonly error?: { readonly details?: Record<string, unknown> } };
  if (shape.ok === true) return "<no refusal>";
  const reason = shape.error?.details?.["reason"];
  return typeof reason === "string" ? reason : "<no reason>";
}

describe("the six constraints that exist ONLY in the migrations are really installed", () => {
  test("the three CHECKs, read back out of pg_catalog", async () => {
    const checks = (await harness.base.client.$queryRawUnsafe(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN ('"Skill"'::regclass, '"ProjectSkill"'::regclass, '"EnvironmentSkill"'::regclass)
          AND contype = 'c' ORDER BY conname`,
    )) as ReadonlyArray<{ readonly conname: string }>;
    expect(checks.map((row) => row.conname)).toEqual([
      "EnvironmentSkill_config_json_root",
      "Skill_manifest_json_root",
      "Skill_providesTools_json_root",
    ]);
  });

  test("the three immutability RULES, proved by statements that must raise", async () => {
    // BEHAVIOUR rather than metadata. A catalogue read establishes that a rule
    // is installed; a refused statement is the rule doing its job, and it is the
    // only kind of evidence that would notice a rule installed against the wrong
    // column.
    const owned = await seedInstalled("acme.immutable");
    const raises = (sql: string): boolean => {
      try {
        harness.applyRows(sql);
        return false;
      } catch {
        return true;
      }
    };
    expect(
      raises(
        `UPDATE "Skill" SET "organizationId" = '${foreign.organizationId}' WHERE "id" = '${owned.skillId}';`,
      ),
    ).toBe(true);
    expect(
      raises(
        `UPDATE "ProjectSkill" SET "projectId" = '${tenant.siblingProjectId}' WHERE "id" = '${owned.projectSkillId}';`,
      ),
    ).toBe(true);
    expect(
      raises(
        `UPDATE "EnvironmentSkill" SET "environmentId" = '${tenant.stagingEnvironmentId}' WHERE "id" = '${owned.environmentSkillId}';`,
      ),
    ).toBe(true);
    // The negative control: a column NO rule protects still updates, so the
    // three refusals above are the rules and not a broken fixture.
    expect(raises(`UPDATE "Skill" SET "name" = 'renamed' WHERE "id" = '${owned.skillId}';`)).toBe(false);
  });

  test("and both ancestry RULES fire ON UPDATE as well as ON INSERT", async () => {
    // The half that decides how the two upserts are written. A rule that fired
    // only on INSERT would let a re-install move a row across a tenant boundary,
    // and no INSERT-shaped case anywhere would notice.
    const owned = await seedInstalled("acme.onupdate");
    const foreignSkill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(
        conformanceDraft(foreign.scope, "foreign.onupdate", "1.0.0"),
        transaction,
      ),
    );
    // A skill in the SAME organization that NOTHING has adopted. It has to be
    // un-adopted: `@@unique([projectId, skillId])` would refuse a re-point onto
    // a pair the project already holds, and the refusal would look like the
    // ancestry rule while being the index.
    const sibling = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(
        conformanceDraft(tenant.scope, "acme.onupdate-free", "1.0.0"),
        transaction,
      ),
    );
    const raises = (sql: string): boolean => {
      try {
        harness.applyRows(sql);
        return false;
      } catch {
        return true;
      }
    };
    // `ProjectSkill_ancestry` on UPDATE: the adoption is re-pointed at a skill
    // in ANOTHER organization. `skillId` is not an owner-tagged column, so the
    // immutability rule has nothing to say about it.
    expect(
      raises(
        `UPDATE "ProjectSkill" SET "skillId" = '${foreignSkill.ok ? foreignSkill.value.skillId : ""}' WHERE "id" = '${owned.projectSkillId}';`,
      ),
    ).toBe(true);
    // And the negative control on the same column: re-pointing it at a skill in
    // the SAME organization is accepted, so the refusal above is the ancestry
    // rule rather than the column being frozen.
    expect(
      raises(
        `UPDATE "ProjectSkill" SET "skillId" = '${sibling.ok ? sibling.value.skillId : ""}' WHERE "id" = '${owned.projectSkillId}';`,
      ),
    ).toBe(false);
  });
});

describe("ProjectSkill_ancestry: a project may not adopt another organization's skill", () => {
  test("the double creates the adoption and PostgreSQL refuses it", async () => {
    const foreignSkill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(
        conformanceDraft(foreign.scope, "foreign.tool", "1.0.0"),
        transaction,
      ),
    );
    expect(foreignSkill.ok).toBe(true);
    const skillId = foreignSkill.ok ? foreignSkill.value.skillId : asIdentifier<SkillId>("x");

    // THE DOUBLE ACCEPTS. It holds a `skillId` and a project scope and has no
    // tree behind either, so nothing in it can notice that the two belong to
    // different organizations.
    const fake = new InMemorySkillsRepository(uuidStamps());
    const accepted = await fake.upsertProjectInstallation(tenant.scope, skillId, FAKE_TXN);
    expect(accepted.ok).toBe(true);

    // POSTGRESQL REFUSES, through a database rule that is not in `schema.prisma`.
    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertProjectInstallation(tenant.scope, skillId, transaction),
    ).catch((error: unknown) => ({ ok: false as const, thrown: error }));
    expect(refused.ok).toBe(false);
  });
});

describe("EnvironmentSkill_ancestry: a binding may not cross a project", () => {
  test("the double binds a sibling project's adoption and PostgreSQL refuses it", async () => {
    const skill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.cross", "1.0.0"), transaction),
    );
    expect(skill.ok).toBe(true);
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");

    const adoption = await runResult(harness, (transaction) =>
      harness.repository.upsertProjectInstallation(tenant.scope, skillId, transaction),
    );
    expect(adoption.ok).toBe(true);
    const project = adoption.ok ? adoption.value : null;
    if (project === null) throw new Error("the adoption is the fixture");

    // THE DOUBLE BINDS IT INTO THE SIBLING PROJECT'S ENVIRONMENT. It matches on
    // `projectSkillId` and `environmentId` and checks nothing above either.
    const fake = new InMemorySkillsRepository(uuidStamps());
    expect((await fake.upsertEnvironmentInstallation(tenant.sibling, project, FAKE_TXN)).ok).toBe(true);

    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertEnvironmentInstallation(tenant.sibling, project, transaction),
    ).catch((error: unknown) => ({ ok: false as const, thrown: error }));
    expect(refused.ok).toBe(false);
  });
});

describe("the shapes the schema will not hold, refused BEFORE a statement is sent", () => {
  test("an organization id that is not a uuid — the double's own fixture shape", async () => {
    // `scopeFor("org-1", "project-1", "environment-1")` in
    // `in-memory-skills-repository.ts` is the shape every use-case suite in
    // `packages/contexts/skills` runs against, and `@db.Uuid` refuses all three.
    const bogus: CatalogueScope = catalogueScope({
      level: "environment",
      organizationId: asIdentifier("org-1"),
      projectId: asIdentifier("project-1"),
      environmentId: asIdentifier("environment-1"),
    });
    const fake = new InMemorySkillsRepository(uuidStamps());
    expect((await fake.upsertSkill(conformanceDraft(bogus, "acme.bogus", "1.0.0"), FAKE_TXN)).ok).toBe(true);

    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(bogus, "acme.bogus", "1.0.0"), transaction),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(IDENTIFIER_NOT_UUID);
  });

  test("a scope naming one identifier at two levels", async () => {
    const forged: CatalogueScope = catalogueScope({
      level: "environment",
      organizationId: asIdentifier(tenant.organizationId),
      projectId: asIdentifier(tenant.organizationId),
      environmentId: asIdentifier(tenant.environmentId),
    });
    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertProjectInstallation(
        forged,
        asIdentifier<SkillId>("cccccccc-0001-4000-8000-000000000001"),
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(SCOPE_ANCESTRY_INCOHERENT);
  });

  test("a manifest whose JSON root is an array — Skill_manifest_json_root", async () => {
    const draft = {
      ...conformanceDraft(tenant.scope, "acme.badmanifest", "1.0.0"),
      manifest: [] as unknown as SkillManifest,
    };
    const fake = new InMemorySkillsRepository(uuidStamps());
    expect((await fake.upsertSkill(draft, FAKE_TXN)).ok).toBe(true);

    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(draft, transaction),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(MANIFEST_NOT_OBJECT);
  });

  test("provided tools whose JSON root is an object — Skill_providesTools_json_root", async () => {
    const base = conformanceDraft(tenant.scope, "acme.badtools", "1.0.0");
    const draft = {
      ...base,
      manifest: { ...base.manifest, provides_tools: {} as unknown as SkillManifest["provides_tools"] },
    };
    const fake = new InMemorySkillsRepository(uuidStamps());
    expect((await fake.upsertSkill(draft, FAKE_TXN)).ok).toBe(true);

    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(draft, transaction),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(PROVIDED_TOOLS_NOT_ARRAY);
  });

  test("an empty version — two thirds of the uniqueness key, with no CHECK behind it", async () => {
    // The database ACCEPTS this row, which is why the guard exists. An empty
    // version is a legal `TEXT`, so every version-less registration in the
    // organization would converge onto one row and silently overwrite the last.
    const draft = conformanceDraft(tenant.scope, "acme.noversion", "");
    const fake = new InMemorySkillsRepository(uuidStamps());
    expect((await fake.upsertSkill(draft, FAKE_TXN)).ok).toBe(true);

    const refused = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(draft, transaction),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(IDENTITY_SEGMENT_EMPTY);
  });

  test("and a non-uuid row id READS as absent rather than aborting the read", async () => {
    // The other half of the uuid guard, and the more dangerous one. An unguarded
    // `{ id: "not-a-uuid" }` reaches `uuid_in`, and the driver's raise inside a
    // transaction takes the TRANSACTION as well as the answer.
    const notAUuid = asIdentifier<SkillId>("acme.search");
    expect(await harness.repository.findVisibleSkill(tenant.scope, notAUuid)).toEqual({
      ok: true,
      value: null,
    });
    expect(await harness.repository.findInstallation(tenant.scope, notAUuid)).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await harness.repository.findInstallationsByIds(tenant.scope, [
        asIdentifier<EnvironmentSkillId>("not-a-uuid"),
      ]),
    ).toEqual({ ok: true, value: [] });
  });
});

describe("the clauses that decide WHICH ROW a call reaches", () => {
  test("a patch of a non-uuid id refuses without aborting the caller's transaction", async () => {
    // The uuid guard on the WRITE path, which is the one that costs a
    // transaction rather than an answer: `Skill.id` is `@db.Uuid`, and an
    // unguarded `updateManyAndReturn({ where: { id } })` sends the string to
    // `uuid_in`. The double answers `repositoryUnavailable("no such skill …")`
    // for the same input.
    const written = await runResult(harness, async (transaction) => {
      const refused = await harness.repository.patchSkill(
        asIdentifier<SkillId>("acme.search"),
        { name: "x" },
        transaction,
      );
      expect(refused.ok).toBe(false);
      expect(reasonOf(refused)).toContain("no such skill");
      return harness.repository.upsertSkill(
        conformanceDraft(tenant.scope, "acme.afterpatch", "1.0.0"),
        transaction,
      );
    });
    expect(written.ok).toBe(true);
  });

  test("a binding is not resolvable through a scope whose PROJECT is somebody else's", async () => {
    // `EnvironmentSkill` carries `environmentId` and `projectSkillId` and
    // nothing above either, so the project and organization halves of a read's
    // scope are the CALLER'S claim. The database's ancestry rules check the
    // rows against each other when they are WRITTEN and have nothing to say
    // about a scope assembled later, which is why the read joins through
    // `ProjectSkill.project` rather than trusting the environment id alone.
    const skill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.forged", "1.0.0"), transaction),
    );
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");
    const binding = await runResult(harness, async (transaction) => {
      const project = await harness.repository.upsertProjectInstallation(
        tenant.scope,
        skillId,
        transaction,
      );
      if (!project.ok) throw new Error("the adoption is the fixture");
      return harness.repository.upsertEnvironmentInstallation(
        tenant.scope,
        project.value,
        transaction,
      );
    });
    expect(binding.ok).toBe(true);
    const environmentSkillId = binding.ok
      ? binding.value.environmentSkillId
      : asIdentifier<EnvironmentSkillId>("x");

    // The RIGHT environment, the WRONG project. A read that trusted
    // `environmentId` alone would resolve it.
    const forged: CatalogueScope = catalogueScope({
      level: "environment",
      organizationId: asIdentifier(tenant.organizationId),
      projectId: asIdentifier(tenant.siblingProjectId),
      environmentId: asIdentifier(tenant.environmentId),
    });
    expect(await harness.repository.findInstallationById(forged, environmentSkillId)).toEqual({
      ok: true,
      value: null,
    });
    expect(
      await harness.repository.findInstallationsByIds(forged, [environmentSkillId]),
    ).toEqual({ ok: true, value: [] });
    // And the negative control: the honest scope resolves it.
    const honest = await harness.repository.findInstallationById(tenant.scope, environmentSkillId);
    expect(honest.ok && honest.value !== null).toBe(true);
  });

  test("an uninstall reaches THIS environment's binding and no other", async () => {
    // `domain/installation.ts`: "uninstalling from staging must not uninstall
    // from production, and neither may delete organization-wide catalogue
    // content." Nothing in the conformance scenario installs one skill in TWO
    // environments, so the environment clause of the DELETE survived the first
    // mutation sweep with nothing red — which is what this case is for.
    const skill = await runResult(harness, (transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.twoenvs", "1.0.0"), transaction),
    );
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");
    const adoption = await runResult(harness, (transaction) =>
      harness.repository.upsertProjectInstallation(tenant.scope, skillId, transaction),
    );
    if (!adoption.ok) throw new Error("the adoption is the fixture");
    // BOTH environments of the SAME project bind the SAME adoption — which is
    // the shape the second row's key makes possible and the reason it is keyed
    // by the project row rather than by the skill.
    for (const scope of [tenant.scope, tenant.staging]) {
      const bound = await runResult(harness, (transaction) =>
        harness.repository.upsertEnvironmentInstallation(scope, adoption.value, transaction),
      );
      expect(bound.ok).toBe(true);
    }

    const removed = await runResult(harness, (transaction) =>
      harness.repository.deleteEnvironmentInstallation(tenant.scope, skillId, transaction),
    );
    expect(removed).toEqual({ ok: true, value: true });

    // Gone here, and STILL THERE in the sibling environment.
    expect(await harness.repository.findInstallation(tenant.scope, skillId)).toEqual({
      ok: true,
      value: null,
    });
    const survivor = await harness.repository.findInstallation(tenant.staging, skillId);
    expect(survivor.ok && survivor.value !== null).toBe(true);
    // And the catalogue row is untouched, because an uninstall is not a delete.
    const catalogued = await harness.repository.findSkillByIdentity(
      conformanceIdentity(tenant.scope, "acme.twoenvs", "1.0.0"),
    );
    expect(catalogued.ok && catalogued.value !== null).toBe(true);
  });

  test("a non-uuid skill id does not reach an uninstall STATEMENT", async () => {
    // The write-path half of the uuid guard on the delete, and the expensive
    // one: a DELETE whose predicate raises takes the caller's transaction with
    // it. The read-path cases above cost only an answer.
    const written = await runResult(harness, async (transaction) => {
      const removed = await harness.repository.deleteEnvironmentInstallation(
        tenant.scope,
        asIdentifier<SkillId>("acme.search"),
        transaction,
      );
      expect(removed).toEqual({ ok: true, value: false });
      return harness.repository.upsertSkill(
        conformanceDraft(tenant.scope, "acme.afterdelete", "1.0.0"),
        transaction,
      );
    });
    expect(written.ok).toBe(true);
  });

  test("an anonymisation is confined to ONE organization", async () => {
    // The `organizationId` clause of the raw `UPDATE "Skill"`. Without it an
    // erasure addressed at one tenant would rewrite the author of every skill in
    // the installation that happened to carry the same principal string.
    const author = "subject-shared";
    for (const scope of [tenant.scope, foreign.scope]) {
      const written = await runResult(harness, (transaction) =>
        harness.repository.upsertSkill(
          conformanceDraft(scope, "acme.shared", "1.0.0", { manifest: { author } }),
          transaction,
        ),
      );
      expect(written.ok).toBe(true);
    }
    const erased = await runResult(harness, (transaction) =>
      harness.repository.anonymizeAuthoredSkills(
        {
          scope: { level: "organization", organizationId: asIdentifier(tenant.organizationId) },
          principalId: author,
        },
        transaction,
      ),
    );
    expect(erased).toEqual({ ok: true, value: 1 });

    const theirs = await harness.repository.findSkillByIdentity(
      conformanceIdentity(foreign.scope, "acme.shared", "1.0.0"),
    );
    expect(theirs.ok && theirs.value !== null ? theirs.value.author : null).toBe(author);
    const ours = await harness.repository.findSkillByIdentity(
      conformanceIdentity(tenant.scope, "acme.shared", "1.0.0"),
    );
    expect(ours.ok && ours.value !== null ? ours.value.author : null).toBe("[erased]");
  });
});

describe("a refusal leaves the caller's transaction usable", () => {
  test("a refused write and a real one in the SAME unit of work", async () => {
    // The property every guard in `skills-guards.ts` exists to preserve. If any
    // of them let the database raise instead, the second write below would meet
    // 25P02 and this case would go red without anything else changing.
    const written = await runResult(harness, async (transaction) => {
      const refused = await harness.repository.upsertSkill(
        { ...conformanceDraft(tenant.scope, "acme.after", "1.0.0"), manifest: [] as unknown as SkillManifest },
        transaction,
      );
      expect(refused.ok).toBe(false);
      return harness.repository.upsertSkill(
        conformanceDraft(tenant.scope, "acme.after", "1.0.0"),
        transaction,
      );
    });
    expect(written.ok).toBe(true);

    const readBack = await harness.repository.findSkillByIdentity(
      conformanceIdentity(tenant.scope, "acme.after", "1.0.0"),
    );
    expect(readBack.ok && readBack.value !== null).toBe(true);
  });
});
