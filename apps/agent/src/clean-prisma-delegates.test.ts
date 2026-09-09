import { createHash } from "node:crypto";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeAgentSource,
  createAnalyzer,
  disconnectGeneratedClient,
  generatedDelegates,
  generatedOperationsByDelegate,
} from "./prisma-delegate-census";

// WIN-268 P2. THE ANALYZER MOVED; NOTHING IT MEASURES DID.
//
// The three hundred lines of type-checker walk that used to sit here are now
// `prisma-delegate-census.ts`, because a SECOND gate needs the same walk with
// its per-call-site results kept rather than reduced to three numbers — see
// that module's header, and `mcp-platform/orm-ownership-census.test.ts`, which
// splits the same calls by the context that owns the row.
//
// THE PINS BELOW ARE UNMOVED, and that is the whole evidence for the move being
// a refactor: 815 / 329 / 0c4fd159... were measured by the analyzer in its old
// home and are re-measured by the analyzer in its new one. A move that changed
// what is walked would have moved them.

afterAll(async () => {
  await disconnectGeneratedClient();
});

describe("clean tenancy Prisma boundary", () => {
  it("uses the type checker to inventory every production delegate operation", () => {
    const { analysis, fileCount } = analyzeAgentSource();
    const violations = analysis.calls.filter(({ delegate, operation }) =>
      !generatedDelegates.has(delegate)
      || !generatedOperationsByDelegate.get(delegate)?.has(operation),
    );
    const inventory = [...new Set(
      analysis.calls.map(({ delegate, operation }) => `${delegate}.${operation}`),
    )].sort();
    const inventoryDigest = createHash("sha256").update(inventory.join("\n")).digest("hex");

    expect(fileCount).toBeGreaterThan(100);
    expect(analysis.unresolvedDynamicAccesses).toEqual([]);
    expect(violations).toEqual([]);
    // Independently pin both call-site count and unique operation inventory so
    // the audit cannot pass because its discovery silently stopped working.
    //
    // WIN-267 A4, 2026-09-08. RE-PINNED 751 -> 815, 304 -> 329, digest
    // 0b36ea83 -> 0c4fd159, and the suite was added to the agent job in
    // .github/workflows/ci.yml at the same time.
    //
    // WHY THE RE-PIN IS NOT A LAUNDERED REGRESSION. This file was RED on `v1`
    // for 1,064 commits because no CI job ran it: the agent job executes eight
    // individually-named Vitest files and this was not one of them. The pin
    // last moved in PR #120 (f5793473, 2026-08-24, 747 -> 751), so 64 net
    // production call sites accumulated unobserved. They were read before the
    // ratchet was raised. Layer split, measured with the SAME analyzer over
    // both trees: service 590 -> 641, controller 94 -> 108, MCP tool 54 -> 53,
    // other 13 -> 13. `agent-runtime/platos-tasks.controller.ts` (8),
    // `mcp-platform/tools/platos_tasks.ts` (12) and
    // `agent-runtime/platos-task-execution.service.ts` (2) were renamed to
    // `jobs.controller.ts` (9), `tools/jobs.ts` (11) and
    // `job-execution.service.ts` (2) — 22 sites out, 22 in. The rest is
    // list-endpoint totals (18 new `.count` sites), memory import/export,
    // attachments, the access-key bootstrap grant and postman executions.
    //
    // BUILD STATE. This census is TYPE-CHECKER driven, so the answer depends
    // on which workspace packages have been built, and both failure modes were
    // measured rather than assumed. Delete
    // `internal-packages/tenancy-database/dist` and this suite does not
    // under-count, it does not run: Vitest reports `Failed to resolve entry for
    // package "@platos/tenancy-database"` and collects nothing. Keep `dist` but
    // delete its fifteen `.d.ts` files — runtime import fine, types gone — and
    // the count silently reads 812 instead of 815. That quiet three-call-site
    // drift is why `scripts/ci-policy.test.mjs` asserts this suite runs AFTER
    // ci.yml's "Generate and build compiled Agent dependencies" step rather
    // than trusting a reader to notice. Measured under exactly the state the
    // agent job reaches before its Vitest steps — `pnpm install
    // --frozen-lockfile --ignore-scripts`, then `pnpm --filter
    // @platos/tenancy-database build && pnpm --filter
    // @internal/workload-identity build` (ci.yml "Generate and build compiled
    // Agent dependencies"). Re-measured after `pnpm build:v1` as well: 815 in
    // both states, so the pin does not depend on where in the job it runs.
    //
    // THE PIN IS JOINED TO THE ORACLE, NOT TO ITSELF. Running this same
    // analyzer against `apps/agent/src` as it stood at f5793473 reproduces
    // that commit's pinned triple exactly — 751 / 304 /
    // 0b36ea83f83a49ed4795881e9c9ccc00a6214c5e30ef654091d36dc13c2cc5a4 — which
    // is what establishes that 815 is real growth rather than a measurement
    // artifact of a different build state.
    // WIN-268 P2, 2026-09-09. RE-PINNED 815 -> 813, and the two are ACCOUNTED
    // FOR rather than absorbed.
    //
    // THE ARITHMETIC. Base `3b3f1ebb` measured with THIS analyzer: 815 app-wide,
    // of which `mcp-platform/**` held 125 —
    // `permission-gateway.service.ts` 8, `mcp-tool-acl.service.ts` 11,
    // `identity-resolver.service.ts` 5. Those three now hold ZERO and their
    // statements live in three store seams: `mcp-policy.store.ts` 7,
    // `entity-tool-policy.store.ts` 10, `mcp-identity.store.ts` 5.
    // 8 + 11 + 5 = 24 OUT; 7 + 10 + 5 = 22 IN; net -2, so 815 - 2 = 813 and
    // the directory's own 125 - 2 = 123.
    //
    // THE TWO THAT VANISHED ARE DUPLICATE STATEMENTS THE EXTRACTION MERGED, not
    // deleted behaviour. `organizationMcpPolicy.findMany` was written TWICE in
    // the gateway (once for tier 2, once for the operator listing) and is now
    // one method both call; `entityToolPolicy.upsert` was written THREE times in
    // the ACL (`upsert`, `bulk`, `autoInsert`) and is now two, with `autoInsert`
    // delegating. Both merged rows are `tools`-owned, which is why the ownership
    // split in `mcp-platform/orm-ownership-census.test.ts` moves `tools`
    // 35 -> 33 and leaves the other nine owners untouched — a cross-check that a
    // net-2 arrived at any other way would fail.
    //
    // NOT A LAUNDERED REDUCTION. This is the first time this pin has moved DOWN.
    // `orm-ownership-census.test.ts` reads this digit back out of this file, so
    // the two gates cannot be re-pinned independently, and its per-file ratchet
    // pins where each of the 123 remaining sites lives.
    //
    // BUILD STATE UNCHANGED from the note above: measured on the mini under
    // `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm --filter
    // @platos/tenancy-database build && pnpm --filter @internal/workload-identity
    // build`, which is the state ci.yml's agent job reaches before its Vitest
    // steps. Re-measured on base `3b3f1ebb` in the SAME state: 815.
    expect(analysis.calls.length).toBe(813);
    expect(inventory).toHaveLength(329);
    expect(inventoryDigest).toBe(
      "0c4fd159179dbf051d093ac039b87771c53d407adbf06e7aa79df0a3cc6f85ac",
    );
    // 120s, not 20s. Building the program and walking it three times takes
    // ~10-16s on an M-series laptop; a hosted runner is slower, and a gate that
    // goes red on wall-clock is a gate someone deletes. The budget bounds
    // nothing this suite asserts, so widening it removes a false red without
    // weakening any claim.
  }, 120_000);

  it("follows delegate aliases, object destructuring, method aliases, and bracket access", () => {
    const fileName = "/virtual/clean-prisma-inventory-fixture.ts";
    const source = `
      interface JobDelegate { findMany(): void; count(): void }
      interface PrismaClient { job: JobDelegate; $transaction(): void }
      declare const prisma: PrismaClient;
      const direct = prisma["job"];
      const { job: destructured } = prisma;
      const aliased = destructured;
      aliased["findMany"]();
      const { count: countJobs } = direct;
      countJobs();
    `;
    const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022 };
    const baseHost = ts.createCompilerHost(options);
    const sourceFile = ts.createSourceFile(fileName, source, options.target!, true);
    const host: ts.CompilerHost = {
      ...baseHost,
      fileExists: (path) => path === fileName || baseHost.fileExists(path),
      readFile: (path) => path === fileName ? source : baseHost.readFile(path),
      getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) =>
        path === fileName
          ? sourceFile
          : baseHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile),
    };
    const program = ts.createProgram([fileName], options, host);
    const analysis = createAnalyzer(program, [sourceFile])();

    expect(analysis.calls.map(({ delegate, operation }) => `${delegate}.${operation}`).sort()).toEqual([
      "job.count",
      "job.findMany",
    ]);
  });
});
