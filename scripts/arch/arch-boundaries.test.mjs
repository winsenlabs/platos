// Non-vacuity proof for the Platos V1 architecture-boundary checker.
//
// The V1 bounded-context skeleton exists and is scanned in the real repository.
// These tests independently prove mutation sensitivity: each builds a temporary
// ADR M0.3 §4 tree and asserts the rule CATCHES a violation and PASSES a
// compliant counterpart.
//
// Fixtures live under os.tmpdir() and are never tracked, so they may reference
// real vendor package names freely. The proofs deliberately use non-reserved
// vendor tokens (@prisma, @clickhouse, @platos/*) so this committed test file
// stays within the repository vocabulary boundary; the rule logic is identical
// across every vendor entry in the banned/containment lists.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { check } from "./arch-boundaries.mjs";

const tempRoots = [];
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

// Build a fixture tree from { "relative/path.ts": "file contents" } and return
// its absolute root.
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "arch-fixture-"));
  tempRoots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  return root;
}

function ruleIds(result) {
  return new Set(result.violations.map((v) => v.rule));
}
function has(result, id) {
  return ruleIds(result).has(id);
}

describe("ADR M0.3 boundary enforcement — each rule catches a violation and passes a compliant fixture", () => {
  it("(a) no-infra-in-core: domain/application must not import an infrastructure SDK", () => {
    const bad = fixture({
      "packages/contexts/tools/domain/tool.ts": `import { PrismaClient } from "@prisma/client";\nexport const x = new PrismaClient();\n`,
    });
    assert.ok(has(check(bad), "no-infra-in-core"), "importing @prisma from domain must fire");

    const good = fixture({
      "packages/contexts/tools/domain/tool.ts": `import type { Clock } from "@platos/kernel/ports";\nexport const late = (c: Clock) => c;\n`,
    });
    assert.ok(!has(check(good), "no-infra-in-core"), "kernel-only domain import must pass");
  });

  it("(b) no-core-to-adapter: domain/application must not reach out to adapters/transport", () => {
    const bad = fixture({
      "packages/contexts/tools/application/use-case.ts": `import { repo } from "../adapters/prisma-repo";\nexport const run = () => repo;\n`,
    });
    assert.ok(has(check(bad), "no-core-to-adapter"), "application importing its own adapters must fire");

    const good = fixture({
      "packages/contexts/tools/application/use-case.ts": `import { Tool } from "../domain/tool";\nexport const run = (t: Tool) => t;\n`,
    });
    assert.ok(!has(check(good), "no-core-to-adapter"), "application importing its own domain must pass");
  });

  it("domain-imports-only-kernel: a context domain may import only its own domain and the kernel", () => {
    const bad = fixture({
      "packages/contexts/tools/domain/tool.ts": `import { thing } from "../application/use-case";\nexport const x = thing;\n`,
    });
    assert.ok(has(check(bad), "domain-imports-only-kernel"), "domain importing own application must fire");

    const good = fixture({
      "packages/contexts/tools/domain/tool.ts": `import type { Money } from "@platos/kernel/vo";\nexport type T = Money;\n`,
    });
    assert.ok(!has(check(good), "domain-imports-only-kernel"), "domain importing kernel must pass");
  });

  it("(c) cross-context-contracts-only: importing another context's non-contracts subpath fails", () => {
    // conversations -> tools IS a permitted DAG edge, so this isolates the
    // contracts-only rule from the DAG rule.
    const bad = fixture({
      "packages/contexts/conversations/application/turn.ts": `import { exec } from "@platos/context-tools/application/execute";\nexport const run = () => exec();\n`,
    });
    const r = check(bad);
    assert.ok(has(r, "cross-context-contracts-only"), "importing tools/application must fire");
    assert.ok(!has(r, "context-dag-allow-list"), "conversations->tools is DAG-allowed, so the DAG rule must stay silent");

    const good = fixture({
      "packages/contexts/conversations/application/turn.ts": `import type { ToolExecution } from "@platos/context-tools/contracts";\nexport const run = (t: ToolExecution) => t;\n`,
    });
    assert.ok(
      !has(check(good), "cross-context-contracts-only"),
      "importing tools/contracts must pass"
    );
  });

  it("(d) context-dag-allow-list: a cross-context edge absent from §1 domainDeps fails", () => {
    // privacy may depend only on tenancy (+ kernel). privacy -> tools is not in
    // the allow-list; using a contracts import isolates the DAG rule from the
    // contracts-only rule.
    const bad = fixture({
      "packages/contexts/privacy/application/erase.ts": `import type { ToolExecution } from "@platos/context-tools/contracts";\nexport const run = (t: ToolExecution) => t;\n`,
    });
    const r = check(bad);
    assert.ok(has(r, "context-dag-allow-list"), "privacy->tools must fire (not in allow-list)");
    assert.ok(!has(r, "cross-context-contracts-only"), "a contracts import must not trip contracts-only");

    const good = fixture({
      "packages/contexts/privacy/application/erase.ts": `import type { TenantScope } from "@platos/context-tenancy/contracts";\nexport const run = (s: TenantScope) => s;\n`,
    });
    assert.ok(!has(check(good), "context-dag-allow-list"), "privacy->tenancy is allowed, must pass");
  });

  it("(e) no-cross-context-cycles: a mutual cross-context import is a cycle", () => {
    const bad = fixture({
      "packages/contexts/tenancy/application/a.ts": `import type { A } from "@platos/context-identity-access/contracts";\nexport const a = (x: A) => x;\n`,
      "packages/contexts/identity-access/application/b.ts": `import type { B } from "@platos/context-tenancy/contracts";\nexport const b = (x: B) => x;\n`,
    });
    assert.ok(has(check(bad), "no-cross-context-cycles"), "a mutual import must fire the acyclic backstop");

    const good = fixture({
      "packages/contexts/tenancy/application/a.ts": `import type { A } from "@platos/context-identity-access/contracts";\nexport const a = (x: A) => x;\n`,
    });
    assert.ok(!has(check(good), "no-cross-context-cycles"), "a single forward edge must pass");
  });

  it("(f) kernel-is-leaf: the kernel must not import a context, an adapter, or an SDK", () => {
    const bad = fixture({
      "packages/kernel/src/ports.ts": `import { PrismaClient } from "@prisma/client";\nexport const x = PrismaClient;\n`,
    });
    assert.ok(has(check(bad), "kernel-is-leaf"), "kernel importing @prisma must fire");

    const bad2 = fixture({
      "packages/kernel/src/ports.ts": `import type { ToolExecution } from "@platos/context-tools/contracts";\nexport type T = ToolExecution;\n`,
    });
    assert.ok(has(check(bad2), "kernel-is-leaf"), "kernel importing a context must fire");

    const good = fixture({
      "packages/kernel/src/ports.ts": `import type { Clock } from "./clock";\nexport type T = Clock;\n`,
    });
    assert.ok(!has(check(good), "kernel-is-leaf"), "kernel importing its own file must pass");
  });

  it("(g) identity-isolation: identity-access must not import tools/providers/cost-monitoring/governance/channels", () => {
    const bad = fixture({
      "packages/contexts/identity-access/application/auth.ts": `import type { ToolRegistry } from "@platos/context-tools/contracts";\nexport const a = (t: ToolRegistry) => t;\n`,
    });
    assert.ok(has(check(bad), "identity-isolation"), "identity-access -> tools must fire");

    const good = fixture({
      "packages/contexts/identity-access/application/auth.ts": `import type { Clock } from "@platos/kernel/ports";\nexport const a = (c: Clock) => c;\n`,
    });
    assert.ok(!has(check(good), "identity-isolation"), "identity-access -> kernel must pass");
  });

  it("(h) sdk-containment: a vendor SDK may be imported only from its single owning adapter", () => {
    // @clickhouse belongs solely to packages/adapters/clickhouse-observability.
    const bad = fixture({
      "packages/contexts/observability/adapters/sink.ts": `import { createClient } from "@clickhouse/client";\nexport const c = createClient();\n`,
    });
    assert.ok(has(check(bad), "clickhouse-sdk-only"), "@clickhouse outside its adapter must fire");

    const good = fixture({
      "packages/adapters/clickhouse-observability/client.ts": `import { createClient } from "@clickhouse/client";\nexport const c = createClient();\n`,
    });
    assert.ok(!has(check(good), "clickhouse-sdk-only"), "@clickhouse inside its adapter must pass");
  });

  it("(i) no-shared-package: no shared/common/util/misc/helpers/lib package may be imported", () => {
    const bad = fixture({
      "apps/core-api/src/main.ts": `import { deepMerge } from "@platos/shared/object";\nexport const x = deepMerge;\n`,
    });
    assert.ok(has(check(bad), "no-shared-package"), "importing a shared package must fire");

    const good = fixture({
      "apps/core-api/src/main.ts": `import type { Clock } from "@platos/kernel/ports";\nexport const x: Clock | null = null;\n`,
    });
    assert.ok(!has(check(good), "no-shared-package"), "importing the kernel must pass");
  });

  it("(j) adapters-only-from-core: only apps/core-api may import packages/adapters/*", () => {
    const bad = fixture({
      "packages/contexts/tools/application/use-case.ts": `import { sink } from "@platos/adapter-clickhouse-observability/sink";\nexport const s = sink;\n`,
    });
    assert.ok(has(check(bad), "adapters-only-from-core"), "a context importing an adapter must fire");

    const good = fixture({
      "apps/core-api/src/main.ts": `import { sink } from "@platos/adapter-clickhouse-observability/sink";\nexport const s = sink;\n`,
    });
    assert.ok(!has(check(good), "adapters-only-from-core"), "core-api importing an adapter must pass");
  });

  it("(k) webapp-no-prisma: the webapp must not import Prisma directly", () => {
    // Proven by pointing an explicit scan at a webapp-shaped fixture; the
    // default scan excludes legacy apps/webapp during the strangler window.
    const bad = fixture({
      "apps/webapp/app/routes/loader.ts": `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();\n`,
    });
    assert.ok(
      has(check(bad, { scanRoots: ["apps/webapp"] }), "webapp-no-prisma"),
      "webapp importing @prisma must fire"
    );

    const good = fixture({
      "apps/webapp/app/routes/loader.ts": `export async function loader() { return fetch("/api/v1/threads"); }\n`,
    });
    assert.ok(
      !has(check(good, { scanRoots: ["apps/webapp"] }), "webapp-no-prisma"),
      "webapp calling core-api over HTTP must pass"
    );
  });

  it("the real repository scan is clean and non-vacuous", () => {
    const result = check(new URL("../..", import.meta.url).pathname);
    // WIN-256 OBSERVABILITY DELTA — 397 -> 445, ONE merged delta on top of the
    // M2 integration note below. +48: making `packages/contexts/observability`
    // real hands the boundary gate 48 more files (33 source, 15 test),
    // replacing its 4 released placeholders in place.
    //
    // What it adds to the gate's evidence is rule (a) no-infra-in-core judged on
    // the context most tempted to break it. This context's whole job is writing
    // to a column store, and its domain and application layers still import no
    // client for one: the ClickHouse SDK lives behind the `ObservabilitySink`
    // port and is bound only in `packages/adapters/clickhouse-observability`.
    // The whole-package grep for `@platos/adapter-*` returns nothing, and its
    // only peer import is `@platos/context-tenancy`, which is on its §1
    // allow-list. No rule was changed, weakened, or given an exception to
    // accommodate the context.
    //
    // The source branch pinned 375 + 48 = 423: it branched before WIN-297's two
    // apps (+22). 397 + 48 = 445 is the reconciled value.
    //
    // ---- the M2 integration delta this one sits on, kept verbatim ----
    // M2 INTEGRATION DELTA — 104 -> 397. Three adopting slices make disjoint
    // projects real, so the census is the sum of all three, not either branch's
    // pin:
    //
    //   104 -> 310  The 104 was the all-placeholder skeleton. WIN-256 made
    //               packages/kernel and four contexts real (identity-access,
    //               secrets, tenancy, files), so the gate polices 310 files of
    //               which ~206 are hand-written production source. This was the
    //               first time these rules judged real code, and no rule needed
    //               changing to accommodate it.
    //   310 -> 375  +65: WIN-256 makes `providers` real (ADR M0.3 §1 context
    //               4). It is the first adopted context with TWO peer
    //               dependencies, so the first real exercise of the (c)
    //               contracts-only and (d) DAG allow-list rules against
    //               production code rather than a fixture — it imports
    //               `@platos/context-tenancy` and `@platos/context-secrets`,
    //               both on its allow-list, and neither rule needed changing.
    //   375 -> 397  +22: WIN-297 adds 20 files making apps/core-api a bootable
    //               composition root (entry point, config, runtime ports,
    //               lifecycle, health, the binding table and their tests) and 2
    //               making apps/mcp-stdio a real stdio binary, minus nothing —
    //               its 9 released placeholders were replaced in place.
    //
    // WIN-297 branched from WIN-256 before the providers commit and so pinned
    // 310 + 22 = 332; WIN-256's tip pinned 375 and never saw the apps.
    // 375 + 22 = 332 + 65 = 397.
    //
    // The two rules WIN-297 exists to exercise both held. Rule (j) now judges
    // TWELVE REAL ADAPTER IMPORTS instead of a generated placeholder list, and
    // rule (a) judges them with @nestjs/* genuinely present in the workspace one
    // directory from context code. Neither was changed, weakened or
    // reinterpreted; their real-tree negative controls are in
    // scripts/arch/composition-root.test.mjs.
    assert.equal(result.fileCount, 445, "the generated V1 source census must stay exact");
    assert.equal(result.violations.length, 0, "the current tree must have zero boundary violations");
  });
});
