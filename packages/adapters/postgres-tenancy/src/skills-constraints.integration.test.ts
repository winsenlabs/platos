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
//   Skill_owner_immutable              TRIGGER: organizationId is immutable
//   ProjectSkill_ancestry              TRIGGER: project and skill share an ORG
//   EnvironmentSkill_ancestry          TRIGGER: environment and adoption share a
//                                      PROJECT — and BOTH fire ON UPDATE too
//
// The first case in this file reads all six back out of `pg_catalog`, so the
// claim that they exist is measured rather than transcribed. An adapter written
// from the model definitions alone would have had none of them.

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

function reasonOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "<not a result>";
  const shape = result as { readonly ok?: unknown; readonly error?: { readonly details?: Record<string, unknown> } };
  if (shape.ok === true) return "<no refusal>";
  const reason = shape.error?.details?.["reason"];
  return typeof reason === "string" ? reason : "<no reason>";
}

describe("the six constraints that exist ONLY in the migrations are really installed", () => {
  test("three CHECKs and three TRIGGERs, read back out of pg_catalog", async () => {
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

    const triggers = (await harness.base.client.$queryRawUnsafe(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid IN ('"Skill"'::regclass, '"ProjectSkill"'::regclass, '"EnvironmentSkill"'::regclass)
          AND NOT tgisinternal ORDER BY tgname`,
    )) as ReadonlyArray<{ readonly tgname: string }>;
    expect(triggers.map((row) => row.tgname)).toEqual([
      "EnvironmentSkill_ancestry",
      "EnvironmentSkill_owner_immutable",
      "ProjectSkill_ancestry",
      "ProjectSkill_owner_immutable",
      "Skill_owner_immutable",
    ]);
  });

  test("and the ancestry triggers fire ON UPDATE as well as ON INSERT", async () => {
    // The half that decides how the upserts are written. A trigger that fired
    // only on INSERT would let a re-install move a row across a tenant boundary.
    const rows = (await harness.base.client.$queryRawUnsafe(
      `SELECT tgname, (tgtype & 4) <> 0 AS on_insert, (tgtype & 16) <> 0 AS on_update
         FROM pg_trigger
        WHERE tgrelid IN ('"ProjectSkill"'::regclass, '"EnvironmentSkill"'::regclass)
          AND NOT tgisinternal AND tgname LIKE '%ancestry' ORDER BY tgname`,
    )) as ReadonlyArray<{ readonly tgname: string; readonly on_insert: boolean; readonly on_update: boolean }>;
    expect(rows).toEqual([
      { tgname: "EnvironmentSkill_ancestry", on_insert: true, on_update: true },
      { tgname: "ProjectSkill_ancestry", on_insert: true, on_update: true },
    ]);
  });
});

describe("ProjectSkill_ancestry: a project may not adopt another organization's skill", () => {
  test("the double creates the adoption and PostgreSQL refuses it", async () => {
    const foreignSkill = await harness.run((transaction) =>
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

    // POSTGRESQL REFUSES, through a trigger that is not in `schema.prisma`.
    const refused = await harness
      .run((transaction) =>
        harness.repository.upsertProjectInstallation(tenant.scope, skillId, transaction),
      )
      .catch((error: unknown) => ({ ok: false as const, thrown: error }));
    expect(refused.ok).toBe(false);
  });
});

describe("EnvironmentSkill_ancestry: a binding may not cross a project", () => {
  test("the double binds a sibling project's adoption and PostgreSQL refuses it", async () => {
    const skill = await harness.run((transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.cross", "1.0.0"), transaction),
    );
    expect(skill.ok).toBe(true);
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");

    const adoption = await harness.run((transaction) =>
      harness.repository.upsertProjectInstallation(tenant.scope, skillId, transaction),
    );
    expect(adoption.ok).toBe(true);
    const project = adoption.ok ? adoption.value : null;
    if (project === null) throw new Error("the adoption is the fixture");

    // THE DOUBLE BINDS IT INTO THE SIBLING PROJECT'S ENVIRONMENT. It matches on
    // `projectSkillId` and `environmentId` and checks nothing above either.
    const fake = new InMemorySkillsRepository(uuidStamps());
    expect((await fake.upsertEnvironmentInstallation(tenant.sibling, project, FAKE_TXN)).ok).toBe(true);

    const refused = await harness
      .run((transaction) =>
        harness.repository.upsertEnvironmentInstallation(tenant.sibling, project, transaction),
      )
      .catch((error: unknown) => ({ ok: false as const, thrown: error }));
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

    const refused = await harness.run((transaction) =>
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
    const refused = await harness.run((transaction) =>
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

    const refused = await harness.run((transaction) =>
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

    const refused = await harness.run((transaction) =>
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

    const refused = await harness.run((transaction) =>
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
    const written = await harness.run(async (transaction) => {
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
    // scope are the CALLER'S claim. The database's ancestry triggers check the
    // rows against each other when they are WRITTEN and have nothing to say
    // about a scope assembled later, which is why the read joins through
    // `ProjectSkill.project` rather than trusting the environment id alone.
    const skill = await harness.run((transaction) =>
      harness.repository.upsertSkill(conformanceDraft(tenant.scope, "acme.forged", "1.0.0"), transaction),
    );
    const skillId = skill.ok ? skill.value.skillId : asIdentifier<SkillId>("x");
    const binding = await harness.run(async (transaction) => {
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

  test("an anonymisation is confined to ONE organization", async () => {
    // The `organizationId` clause of the raw `UPDATE "Skill"`. Without it an
    // erasure addressed at one tenant would rewrite the author of every skill in
    // the installation that happened to carry the same principal string.
    const author = "subject-shared";
    for (const scope of [tenant.scope, foreign.scope]) {
      const written = await harness.run((transaction) =>
        harness.repository.upsertSkill(
          conformanceDraft(scope, "acme.shared", "1.0.0", { manifest: { author } }),
          transaction,
        ),
      );
      expect(written.ok).toBe(true);
    }
    const erased = await harness.run((transaction) =>
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
    const written = await harness.run(async (transaction) => {
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
