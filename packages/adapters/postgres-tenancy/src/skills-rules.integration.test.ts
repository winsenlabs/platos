// Rows an OLDER BINARY could have written, planted as SQL and read back — and
// the two places where this store and the in-memory double are both right and
// answer differently.
//
// WHY THE ROWS ARE PLANTED RATHER THAN WRITTEN. Every one of them is a shape
// `skills-guards.ts` refuses on the way in, which is the whole point: the READ
// path has to survive what the WRITE path will no longer produce. A container
// only ever holds rows this binary wrote, so the legacy branches in
// `skills-rows.ts` are unreachable from any suite that goes through the port.
// `prisma db execute` is the only tool that can put them there, and it is
// runtime, so the sole-writer scanner does not see it — which is correct: those
// statements are a FIXTURE, not this package's writes.
//
// *** TWO DIVERGENCES ARE PINNED HERE AND REPORTED RATHER THAN HIDDEN ***
//
//   THE ORDER IS A COLLATION. `compareCatalogueEntries` compares strings with
//   `<`, which is UTF-16 code-unit order; PostgreSQL compares them under the
//   database's collation, `en_US.utf8` on this image. The two agree for the
//   alphanumerics a namespaced slug is made of and disagree for punctuation,
//   which glibc weighs only after letters and digits. `version` is an opaque
//   author-supplied string with no character restriction at all, so the exposure
//   is real. It is not closable in memory: `pageVisibleSkills` windows with
//   `skip`/`take`, and a store that fetched every visible row to sort a page of
//   ten would answer a paged read with an unbounded one.
//
//   `%` AND `_` ARE LIKE METACHARACTERS. `matchesSearch` is a plain substring
//   test; `contains` compiles to `ILIKE '%term%'` and the client escapes
//   neither. `_` is in the ordinary vocabulary of a namespaced skill id, so
//   searching `web_search` matches `webXsearch` in the database and does not in
//   the double. `contains` has no ESCAPE option and pre-escaping the term would
//   make a literal backslash unsearchable.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { InMemorySkillsRepository } from "@platos/context-skills/application/index.js";
import type {
  CatalogueEntry,
  EnvironmentSkillId,
  ProjectSkillId,
  SkillId,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier } from "@platos/context-skills/application/ports/index.js";

import { conformanceDraft, conformanceIdentity } from "./skills-conformance.js";
import {
  UNKNOWN_SKILL_ORIGIN,
  UNREADABLE_MANIFEST,
  UNREADABLE_PROVIDED_TOOLS,
} from "./skills-rows.js";
import { startSkillsHarness, type SkillsHarness, type SkillsTenant } from "./skills-harness.js";

let harness: SkillsHarness;
let tenant: SkillsTenant;

const STAMP = "'2026-05-01T09:00:00Z'";

beforeAll(async () => {
  harness = await startSkillsHarness();
  tenant = await harness.freshTenant();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

function uuidStamps() {
  let counter = 0;
  let tick = Date.parse("2026-05-01T09:00:00.000Z");
  const mint = (kind: string): string => {
    counter += 1;
    return `ffffffff-${kind}-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  return {
    now: (): Date => new Date((tick += 1)),
    skillId: (): SkillId => asIdentifier<SkillId>(mint("0001")),
    projectSkillId: (): ProjectSkillId => asIdentifier<ProjectSkillId>(mint("0002")),
    environmentSkillId: (): EnvironmentSkillId => asIdentifier<EnvironmentSkillId>(mint("0003")),
  };
}

const FAKE_TXN: TransactionScope = { transactionId: asIdentifier("fake-txn") };

let planted = 0;

/**
 * Plant one `Skill` row exactly as written, bypassing every guard.
 *
 * `tags` and the two key lists default to the literal SQL below rather than to
 * `ARRAY[]::TEXT[]`, so a case that wants NULL says NULL and a case that does
 * not gets a real list.
 */
function plantSkill(options: {
  readonly slug: string;
  readonly origin?: string;
  readonly manifest?: string;
  readonly providesTools?: string;
  readonly tags?: string;
  readonly author?: string;
}): string {
  planted += 1;
  const id = `aaaaaaaa-0f0f-4000-8000-${String(planted).padStart(12, "0")}`;
  harness.applyRows(
    `INSERT INTO "Skill"
       ("id", "organizationId", "slug", "name", "description", "version", "author",
        "origin", "isOfficial", "tags", "source", "manifest", "promptBlock",
        "providesTools", "requiredEnvironmentKeys", "optionalEnvironmentKeys",
        "createdAt", "updatedAt")
     VALUES ('${id}', '${tenant.organizationId}', '${options.slug}', 'planted', 'planted by SQL',
             '1.0.0', ${options.author === undefined ? "NULL" : `'${options.author}'`},
             '${options.origin ?? "official"}', true,
             ${options.tags ?? "ARRAY['planted']::TEXT[]"}, 'planted source',
             '${options.manifest ?? '{"id":"' + options.slug + '","name":"planted","description":"planted by SQL","version":"1.0.0"}'}'::jsonb,
             'planted body',
             '${options.providesTools ?? "[]"}'::jsonb,
             ARRAY[]::TEXT[], ARRAY[]::TEXT[], ${STAMP}, ${STAMP});`,
  );
  return id;
}

async function readPlanted(id: string) {
  return harness.repository.findVisibleSkill(tenant.scope, asIdentifier<SkillId>(id));
}

function reasonOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "<not a result>";
  const shape = result as { readonly ok?: unknown; readonly error?: { readonly details?: Record<string, unknown> } };
  if (shape.ok === true) return "<no refusal>";
  const reason = shape.error?.details?.["reason"];
  return typeof reason === "string" ? reason : "<no reason>";
}

describe("the three TEXT[] columns are NULLABLE in the DDL and non-optional in schema.prisma", () => {
  test("information_schema says so, which is why every read goes through readTextList", async () => {
    const columns = (await harness.base.client.$queryRawUnsafe(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'Skill'
          AND column_name IN ('tags', 'requiredEnvironmentKeys', 'optionalEnvironmentKeys', 'manifest')
        ORDER BY column_name`,
    )) as ReadonlyArray<{ readonly column_name: string; readonly is_nullable: string }>;
    expect(columns).toEqual([
      { column_name: "manifest", is_nullable: "NO" },
      { column_name: "optionalEnvironmentKeys", is_nullable: "YES" },
      { column_name: "requiredEnvironmentKeys", is_nullable: "YES" },
      { column_name: "tags", is_nullable: "YES" },
    ]);
  });

  test("a row holding SQL NULL in all three reads as the empty list the DEFAULT names", async () => {
    const id = plantSkill({ slug: "legacy.nulltags", tags: "NULL" });
    harness.applyRows(
      `UPDATE "Skill" SET "requiredEnvironmentKeys" = NULL, "optionalEnvironmentKeys" = NULL
        WHERE "id" = '${id}';`,
    );
    const read = await readPlanted(id);
    expect(read.ok).toBe(true);
    const entry = read.ok ? (read.value as CatalogueEntry) : null;
    expect(entry?.tags).toEqual([]);
    expect(entry?.requiredEnvironmentKeys).toEqual([]);
    expect(entry?.optionalEnvironmentKeys).toEqual([]);
  });
});

describe("Skill.origin is a plain TEXT column with the closed set only in the domain", () => {
  test("a value outside SkillOrigin is REFUSED on read, not cast", async () => {
    const id = plantSkill({ slug: "legacy.badorigin", origin: "invented" });
    const read = await readPlanted(id);
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toContain(UNKNOWN_SKILL_ORIGIN);
  });

  test("and the three real values all read", async () => {
    // The negative control: without it the case above would pass against a
    // reader that refused everything.
    for (const origin of ["official", "community", "custom"]) {
      const id = plantSkill({ slug: `legacy.origin-${origin}`, origin });
      const read = await readPlanted(id);
      expect({ origin, ok: read.ok }).toEqual({ origin, ok: true });
    }
  });
});

describe("Skill.manifest is JSONB behind one CHECK on its ROOT and nothing else", () => {
  test("a manifest missing every NULLABLE key still reads — expand/contract", async () => {
    // A row written before `importedFrom`, `category` or `spec_version` existed.
    // Refusing it would make this binary unable to read what an older one wrote.
    const id = plantSkill({
      slug: "legacy.thin",
      manifest: '{"id":"legacy.thin","name":"thin","description":"no optional keys","version":"1.0.0"}',
    });
    const read = await readPlanted(id);
    expect(read.ok).toBe(true);
    const manifest = read.ok ? (read.value as CatalogueEntry).manifest : null;
    expect(manifest?.author).toBeNull();
    expect(manifest?.origin).toBeNull();
    expect(manifest?.spec_version).toBeNull();
    expect(manifest?.importedFrom).toBeNull();
    expect(manifest?.category).toBeNull();
    expect(manifest?.required_env).toEqual([]);
    expect(manifest?.optional_env).toEqual([]);
    expect(manifest?.provides_tools).toEqual([]);
    expect(manifest?.tags).toEqual([]);
  });

  test("a manifest missing a REQUIRED key is refused — that is corruption, not skew", async () => {
    const id = plantSkill({ slug: "legacy.noid", manifest: '{"name":"nameless"}' });
    const read = await readPlanted(id);
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toContain(UNREADABLE_MANIFEST);
  });

  test("a nullable key PRESENT with the wrong type is refused too", async () => {
    const id = plantSkill({
      slug: "legacy.badauthor",
      manifest: '{"id":"legacy.badauthor","name":"n","description":"d","version":"1.0.0","author":7}',
    });
    const read = await readPlanted(id);
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toContain(UNREADABLE_MANIFEST);
  });

  test("an UNKNOWN key survives a read and a re-registration", async () => {
    // The contract direction of expand/contract: a field a NEWER release wrote
    // must not be deleted by this one's next write.
    const id = plantSkill({
      slug: "legacy.newerfield",
      manifest:
        '{"id":"legacy.newerfield","name":"n","description":"d","version":"1.0.0","future_field":"kept"}',
    });
    const read = await readPlanted(id);
    expect(read.ok).toBe(true);
    const manifest = read.ok ? (read.value as CatalogueEntry).manifest : null;
    expect((manifest as unknown as Record<string, unknown>)["future_field"]).toBe("kept");

    const rewritten = await harness.run((transaction) =>
      harness.repository.upsertSkill(
        {
          ...conformanceDraft(tenant.scope, "legacy.newerfield", "1.0.0"),
          manifest: manifest ?? conformanceDraft(tenant.scope, "legacy.newerfield", "1.0.0").manifest,
        },
        transaction,
      ),
    );
    expect(rewritten.ok).toBe(true);
    const again = await harness.repository.findSkillByIdentity(
      conformanceIdentity(tenant.scope, "legacy.newerfield", "1.0.0"),
    );
    const kept = again.ok && again.value !== null ? again.value.manifest : null;
    expect((kept as unknown as Record<string, unknown>)["future_field"]).toBe("kept");
  });
});

describe("Skill.providesTools is the column the RUNTIME reads", () => {
  test("an element that is not an object is refused", async () => {
    const id = plantSkill({ slug: "legacy.badtool", providesTools: "[3]" });
    const read = await readPlanted(id);
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toContain(UNREADABLE_PROVIDED_TOOLS);
  });

  test("an element missing its OPTIONAL fields reads with the documented defaults", async () => {
    const id = plantSkill({ slug: "legacy.thintool", providesTools: '[{"name":"run"}]' });
    const read = await readPlanted(id);
    expect(read.ok).toBe(true);
    const tools = read.ok ? (read.value as CatalogueEntry).providesTools : [];
    expect(tools).toEqual([
      { name: "run", description: "", inputSchema: null, outputSchema: null, handler: null },
    ]);
  });
});

describe("the two divergences between this store and the double, PINNED and reported", () => {
  test("FINDING 1: the catalogue ORDER is the database's collation, not JavaScript's", async () => {
    // Two versions of one slug differing only in where the punctuation sits.
    // JavaScript compares code units, so `1-0` sorts before `10`; glibc's
    // `en_US.utf8` weighs alphanumerics first, so `10` sorts before `1-0`. The
    // port orders `version` DESCENDING, so the two stores name a different row
    // as "the highest version" for the same slug.
    const slug = "acme.collate";
    for (const version of ["1-0", "10"]) {
      const written = await harness.run((transaction) =>
        harness.repository.upsertSkill(
          conformanceDraft(tenant.scope, slug, version, { isOfficial: true }),
          transaction,
        ),
      );
      expect(written.ok).toBe(true);
    }
    const real = await harness.repository.findVisibleSkillByReference(tenant.scope, slug);

    const fake = new InMemorySkillsRepository(uuidStamps());
    for (const version of ["1-0", "10"]) {
      await fake.upsertSkill(
        conformanceDraft(tenant.scope, slug, version, { isOfficial: true }),
        FAKE_TXN,
      );
    }
    const doubled = await fake.findVisibleSkillByReference(tenant.scope, slug);

    const realVersion = real.ok && real.value !== null ? real.value.identity.version : null;
    const fakeVersion = doubled.ok && doubled.value !== null ? doubled.value.identity.version : null;
    // BOTH ARE INTERNALLY CONSISTENT AND THEY DISAGREE. The pin is the
    // disagreement itself: the day either side changes, this case moves and
    // somebody has to decide which order the port means.
    expect({ realVersion, fakeVersion }).toEqual({ realVersion: "1-0", fakeVersion: "10" });
  });

  test("FINDING 2: `_` in a search term is a LIKE metacharacter in SQL and a letter in the double", async () => {
    // `webXsearch` is matched by `ILIKE '%web_search%'` and is not matched by
    // `"webXsearch".includes("web_search")`.
    const decoy = "acme.webxsearch";
    await harness.run((transaction) =>
      harness.repository.upsertSkill(
        conformanceDraft(tenant.scope, decoy, "1.0.0", {
          isOfficial: true,
          manifest: { name: "webXsearch", description: "a decoy" },
        }),
        transaction,
      ),
    );
    const real = await harness.repository.pageVisibleSkills(tenant.scope, {
      limit: 50,
      offset: 0,
      search: "web_search",
    });
    const realHits = real.ok ? real.value.items.map((entry) => entry.name) : [];

    const fake = new InMemorySkillsRepository(uuidStamps());
    await fake.upsertSkill(
      conformanceDraft(tenant.scope, decoy, "1.0.0", {
        isOfficial: true,
        manifest: { name: "webXsearch", description: "a decoy" },
      }),
      FAKE_TXN,
    );
    const doubled = await fake.pageVisibleSkills(tenant.scope, {
      limit: 50,
      offset: 0,
      search: "web_search",
    });
    const fakeHits = doubled.ok ? doubled.value.items.map((entry) => entry.name) : [];

    expect(realHits).toContain("webXsearch");
    expect(fakeHits).toEqual([]);
  });
});
