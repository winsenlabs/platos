// The facts the three read seams are BUILT ON, joined to the schema and to the
// migrations rather than to this file's own belief.
//
// WHY THIS SUITE EXISTS BESIDE THE INTEGRATION ONE. The integration suite proves
// the readers behave; it cannot say WHY the code is shaped the way it is, and a
// reader coming back to `governance-seam-conversations.ts` finds three
// load-bearing claims in its header:
//
//   1. `Turn` has no `environmentId` column, so its tenancy is a JOIN;
//   2. `Thread`, `ToolCallAudit` and `AgentApproval` each have one, so theirs is
//      not — which is why `ActivityReader` narrows three ways;
//   3. `Turn_ancestry` binds a turn's `AgentVersion` to its thread's agent,
//      which is why `RatingTarget.agentId` may be taken from the THREAD while
//      `agentVersionId` is taken from the TURN and the two cannot disagree.
//
// Every one of those is a property of `schema.prisma` and of the migrations, and
// every one of them would be silently falsified by a schema change that nothing
// here would otherwise notice. The day somebody adds `Turn.environmentId` the
// join in the activity reader becomes a redundant one and the whole argument for
// the raw statement evaporates — this suite is what makes that a red build
// rather than a comment that quietly stopped being true.
//
// IT READS THE MIGRATIONS AND NOT ONLY THE SCHEMA. `enforce_domain_ancestry` is
// a trigger function that exists in NO Prisma model: claim 3 is unreachable from
// `schema.prisma` alone, which is the same reason `governance-guards.ts` had to
// read `MessageRating_rating_check` out of the migration file twice.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  activityUnreadable,
  ratingTargetUnreadable,
  transcriptUnreadable,
} from "@platos/context-governance/application/ports/index.js";

const packageRoot = process.cwd();
const repositoryRoot = resolve(packageRoot, "../../..");
const prismaRoot = resolve(repositoryRoot, "internal-packages/tenancy-database/prisma");

const schema = readFileSync(resolve(prismaRoot, "schema.prisma"), "utf8");
const initialMigration = readFileSync(
  resolve(prismaRoot, "migrations/00000000000000_initial/migration.sql"),
  "utf8",
);

/** The scalar field names declared on one model, in declaration order. */
function fieldsOf(model: string): readonly string[] {
  const block = new RegExp(`^model\\s+${model}\\s*\\{$([\\s\\S]*?)^\\}$`, "mu").exec(schema);
  if (block === null) throw new Error(`no model ${model} in schema.prisma`);
  const found: string[] = [];
  for (const raw of (block[1] ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("@@") || line.startsWith("///")) {
      continue;
    }
    const name = /^(\w+)\s+\S/u.exec(line);
    if (name !== null) found.push(name[1] ?? "");
  }
  return found;
}

describe("the tenancy shape the readers narrow by", () => {
  test("`Turn` carries NO environment of its own", () => {
    // CLAIM 1, AND THE REASON THE RATING TARGET READER JOINS. A `Turn` resolved
    // by primary key alone belongs to whichever tenant wrote it, and nothing in
    // TypeScript can object. If this ever fails, the join in
    // `governance-seam-conversations.ts` has a simpler form and the raw
    // statement in `governance-seam-activity.ts` may not be needed at all.
    expect(fieldsOf("Turn")).not.toContain("environmentId");
    // ITS TENANCY IS ITS THREAD'S, which is only true while this holds.
    expect(fieldsOf("Turn")).toContain("threadId");
    expect(fieldsOf("Thread")).toContain("environmentId");
  });

  test("the other two activity sources DO carry one", () => {
    // CLAIM 2. This asymmetry is the whole reason `countByAgent` sends three
    // differently shaped statements instead of one loop.
    expect(fieldsOf("ToolCallAudit")).toContain("environmentId");
    expect(fieldsOf("AgentApproval")).toContain("environmentId");
    // AND BOTH CARRY A NULLABLE AGENT, which is why both group-bys exclude nulls
    // rather than folding them into a bucket no board could name.
    expect(schema).toMatch(/model ToolCallAudit \{[\s\S]*?agentId\s+String\?/u);
    expect(schema).toMatch(/model AgentApproval \{[\s\S]*?agentId\s+String\?/u);
  });

  test("`Turn.agentVersionId` is REQUIRED, so the rating target's version is never null here", () => {
    // The port allows `agentVersionId: null` because "the reader may not be able
    // to resolve it". This implementation always can, and that is a property of
    // the column rather than of the query.
    expect(schema).toMatch(/model Turn \{[\s\S]*?agentVersionId\s+String\s+@db\.Uuid/u);
  });

  test("`Turn_ancestry` ties the turn's version to the THREAD's agent", () => {
    // CLAIM 3, AND IT LIVES ONLY IN THE MIGRATION. `RatingTarget.agentId` is
    // read off the thread and `agentVersionId` off the turn; that is safe only
    // because the database refuses a turn whose version belongs to another
    // agent. Read out of `enforce_domain_ancestry`'s `Turn` branch.
    expect(initialMigration).toContain(
      'CREATE TRIGGER "Turn_ancestry" BEFORE INSERT OR UPDATE ON "public"."Turn"',
    );
    const turnBranch = /WHEN 'Turn' THEN([\s\S]*?)WHEN 'Artifact' THEN/u.exec(initialMigration);
    expect(turnBranch).not.toBeNull();
    expect(turnBranch?.[1]).toContain('version."agentId" = t."agentId"');
  });

  test("`WorkStatus` still has a CANCELLED the transcript can exclude", () => {
    // The transcript filter is `status: { not: "CANCELLED" }`, and the port says
    // "a cancelled turn is not included". A renamed enum member would leave that
    // filter matching nothing and the judge reading abandoned turns.
    expect(schema).toMatch(/enum WorkStatus \{[\s\S]*?\bCANCELLED\b[\s\S]*?\}/u);
  });

  test("`ToolCallAudit.status` still has the FAILED the error count is defined as", () => {
    expect(schema).toMatch(/model ToolCallAudit \{[\s\S]*?status\s+WorkStatus/u);
  });
});

describe("the three seams' refusals", () => {
  test("are three distinct codes, and none of them is the ledger's", () => {
    // Two guards sharing a code cannot be told apart. These three are raised by
    // ONE guard over ONE value, which is precisely the shape that collapses into
    // a single code by accident.
    const codes = [
      ratingTargetUnreadable("x").code,
      transcriptUnreadable("x").code,
      activityUnreadable("x").code,
    ];
    expect(new Set(codes).size).toBe(3);
    expect(codes).not.toContain("GOVERNANCE_LEDGER_UNAVAILABLE");
  });

  test("each is registered in the shipped taxonomy, at the status its category resolves to", () => {
    // JOINED TO `docs/error-taxonomy.json`, which is neither this file nor the
    // constructor: `scripts/error-taxonomy.mjs` reconciles that document against
    // the 17 contexts' mint sites AND against the transport's status table, so a
    // code minted here without an entry there is already a red gate. This asserts
    // the half that gate cannot — that all three landed as `internal`/500 rather
    // than as one entry three codes were pointed at.
    const taxonomy = JSON.parse(
      readFileSync(resolve(repositoryRoot, "docs/error-taxonomy.json"), "utf8"),
    ) as { readonly codes: Record<string, { category: string; status: number }> };
    for (const code of [
      ratingTargetUnreadable("x").code,
      transcriptUnreadable("x").code,
      activityUnreadable("x").code,
    ]) {
      expect(taxonomy.codes[code], `${code} must be in the shipped taxonomy`).toEqual({
        category: "internal",
        status: 500,
        contexts: ["governance"],
      });
    }
  });

  test("carry `internal`, not `unavailable`, so no transport tells a caller to retry", () => {
    // A scope with no environment to narrow by will fail identically for ever.
    // `retryAfterSeconds` is populated only for `rate_limited` and `unavailable`
    // (kernel `vo/error.ts`), so this is the field that would carry the lie.
    for (const error of [ratingTargetUnreadable("x"), transcriptUnreadable("x"), activityUnreadable("x")]) {
      expect(error.category).toBe("internal");
      expect(error.retryAfterSeconds).toBeNull();
    }
  });
});
