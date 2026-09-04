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

  // The four proofs below are the non-vacuity evidence for `inference-sdk-only`
  // (ADR M0.3 §14). They are separate `it` blocks rather than one, because the
  // two spellings fail for different mechanical reasons — one is caught by the
  // `from ...` pattern and the other by the call pattern in
  // `extractSpecifiers` — and a single test that asserted both would go red
  // without saying which half broke.
  //
  // `findings` asserts the whole violation record, not just the rule id. A test
  // that only checked "some violation with this id exists" would still pass if
  // the rule fired on the wrong file or named the wrong specifier.
  function findings(result, id) {
    return result.violations
      .filter((v) => v.rule === id)
      .map((v) => `${v.from} -> ${v.specifier}`)
      .sort();
  }

  it("(h) inference-sdk-only: a STATIC import of the inference framework from a context fails", () => {
    const bad = fixture({
      "packages/contexts/conversations/application/turn.ts": `import { generateText } from "ai";\nimport { anthropic } from "@ai-sdk/anthropic";\nexport const run = () => generateText({ model: anthropic("m") });\n`,
    });
    assert.deepEqual(
      findings(check(bad), "inference-sdk-only"),
      [
        "packages/contexts/conversations/application/turn.ts -> @ai-sdk/anthropic",
        "packages/contexts/conversations/application/turn.ts -> ai",
      ],
      "both the framework and its provider binding must be reported, by file and by specifier"
    );

    const good = fixture({
      "packages/contexts/conversations/application/turn.ts": `import type { ModelRoutePlan } from "@platos/context-providers/contracts";\nexport const run = (p: ModelRoutePlan) => p;\n`,
    });
    assert.deepEqual(
      findings(check(good), "inference-sdk-only"),
      [],
      "asking providers for the route instead must pass"
    );
  });

  it("(h) inference-sdk-only: a DYNAMIC import() of the inference framework fails identically", () => {
    // The evasion this rule has to survive: the ban is on the module, not on one
    // spelling of the import. Quoted and backtick call forms are both static
    // specifiers and both must be caught.
    const quoted = fixture({
      "packages/contexts/conversations/application/turn.ts": `export const run = async () => (await import("ai")).generateText;\n`,
    });
    assert.deepEqual(
      findings(check(quoted), "inference-sdk-only"),
      ["packages/contexts/conversations/application/turn.ts -> ai"],
      "a quoted dynamic import must fire"
    );

    const backtick = fixture({
      "packages/contexts/conversations/application/turn.ts":
        "export const run = async () => (await import(`@ai-sdk/openai`)).openai;\n",
    });
    assert.deepEqual(
      findings(check(backtick), "inference-sdk-only"),
      ["packages/contexts/conversations/application/turn.ts -> @ai-sdk/openai"],
      "a backtick dynamic import must fire too"
    );

    const required = fixture({
      "packages/contexts/conversations/application/turn.ts": `export const run = () => require("ai");\n`,
    });
    assert.deepEqual(
      findings(check(required), "inference-sdk-only"),
      ["packages/contexts/conversations/application/turn.ts -> ai"],
      "the CommonJS call form must fire too"
    );
  });

  it("(h) inference-sdk-only: the providers adapter is the one home, and only that adapter", () => {
    const home = fixture({
      "packages/adapters/model-router-providers/src/adapter.ts": `import { generateText } from "ai";\nimport { anthropic } from "@ai-sdk/anthropic";\nexport const g = () => generateText({ model: anthropic("m") });\n`,
    });
    assert.deepEqual(
      findings(check(home), "inference-sdk-only"),
      [],
      "the sole holder of the framework must be allowed to hold it"
    );

    // A different adapter is NOT the home. Without this the rule would read as
    // "adapters may do as they please", which is not what §5.1(h) says.
    const neighbour = fixture({
      "packages/adapters/redis-cache/src/cache.ts": `import { embed } from "ai";\nexport const e = embed;\n`,
    });
    assert.deepEqual(
      findings(check(neighbour), "inference-sdk-only"),
      ["packages/adapters/redis-cache/src/cache.ts -> ai"],
      "another adapter importing the framework must fire"
    );

    const kernel = fixture({
      "packages/kernel/src/ports.ts": `import type { LanguageModel } from "ai";\nexport type M = LanguageModel;\n`,
    });
    assert.deepEqual(
      findings(check(kernel), "inference-sdk-only"),
      ["packages/kernel/src/ports.ts -> ai"],
      "the kernel importing the framework must fire"
    );
  });

  it("(h) inference-sdk-only: `ai` is matched as a package, not as a two-letter prefix", () => {
    // The bug this rule is one careless character away from: every other entry
    // in SDK_CONTAINMENT is a prefix, and a prefix spelled `ai` condemns every
    // package whose name merely starts with those bytes. These four are real
    // npm package names and none of them is the inference framework.
    const innocent = fixture({
      "packages/contexts/conversations/application/turn.ts": `import Airtable from "airtable";\nimport aigle from "aigle";\nimport { ai } from "./ai.js";\nimport x from "@aikit/core";\nexport const t = [Airtable, aigle, ai, x];\n`,
    });
    assert.deepEqual(
      findings(check(innocent), "inference-sdk-only"),
      [],
      "a package that merely begins with those two letters must not be condemned"
    );

    // ...while a subpath of the real package still is.
    const subpath = fixture({
      "packages/contexts/conversations/application/turn.ts": `import { MCPClient } from "ai/mcp-stdio";\nexport const c = MCPClient;\n`,
    });
    assert.deepEqual(
      findings(check(subpath), "inference-sdk-only"),
      ["packages/contexts/conversations/application/turn.ts -> ai/mcp-stdio"],
      "a subpath of the framework is still the framework"
    );
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
    //   397 -> 405  +8: WIN-256's `conversations` prerequisite. Four source
    //               files and four suites under packages/contexts/providers
    //               (prompt, prompt-cache, generation, run-model-generation),
    //               which is what puts the inference surface on the ModelRouter
    //               port. Nothing was deleted, so the +8 is 4 + 4 with no
    //               subtraction hidden inside it. The rule this change ADDS,
    //               `inference-sdk-only`, judges all 405 and finds nothing:
    //               the surface is built entirely out of types this repository
    //               owns, which is the property that makes it satisfiable at
    //               all. Its own mutation proofs are the four fixtures above.
    assert.equal(result.fileCount, 397 + 8, "the generated V1 source census must stay exact");
    assert.equal(result.violations.length, 0, "the current tree must have zero boundary violations");
  });
});
