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
    // M2 INTEGRATION DELTA — 104 -> 948. Twelve adopting slices make disjoint
    // projects real, so the census is the sum of all of them, not any one
    // branch's pin:
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
    //   397 -> 441  +44: WIN-256 makes `eventing` real (ADR M0.3 §1 row 17).
    //               Again no rule changed — in particular `no-infra-in-core` and
    //               the `eventing -> tenancy` DAG edge held against a context
    //               whose legacy original imported @nestjs, ioredis and a Prisma
    //               client directly.
    //   441 -> 496  +55: WIN-256 makes `skills` real. The files that matter to
    //               these rules are the four driven ports and the fourteen
    //               domain modules: `domain/` and `application/` import
    //               `@platos/kernel`, their own siblings, and the published
    //               `contracts/` of `tenancy` and `files` — nothing else. The
    //               network fetch, the environment-key directory and the
    //               confined runtime are reachable only as port interfaces,
    //               which is what keeps a context that fetches URLs and runs
    //               sandboxed code free of every banned import. No rule needed
    //               changing.
    //   496 -> 547  +51: WIN-256 makes `jobs` real. It is the first adopted
    //               context that CALLS a kernel decoupling port rather than only
    //               holding one — `request-approval.ts` suspends a run through
    //               `DurableRuntime` and `resolve-approval.ts` resumes it — so
    //               the no-infra-in-core and domain-imports-only-kernel rules
    //               judged that shape for the first time here. Neither needed
    //               changing.
    //   547 -> 624  +77: WIN-256 makes `memory` real (ADR M0.3 §1 row 8). Its
    //               own row states the boundary this gate now polices for the
    //               first time — extraction is initiated on a `TurnFinalized`
    //               event and the context "never imports conversations" — so
    //               rule (d) is judging an ABSENCE rather than an edge. Its two
    //               permitted peers, `tenancy` and `providers`, are both
    //               imported and both on its allow-list; `conversations`
    //               appears nowhere in the tree. No rule needed changing.
    //   624 -> 687  +63: WIN-256 makes `cost-monitoring` real (ADR M0.3 §1 row
    //               13). It is the first adopted context that depends on
    //               another ADOPTED context rather than only on leaves —
    //               `providers` — so it is the first real exercise of rule (d)
    //               across a TWO-HOP path in the DAG: its application layer
    //               calls `ProvidersContract.priceModelUsage` through the
    //               published contract entrypoint, and `providers` in turn
    //               imports `tenancy` and `secrets`. Neither rule needed
    //               changing, and the (c) contracts-only rule is what keeps
    //               this context out of `providers/domain`, where the rate
    //               arithmetic it wanted actually lives.
    //   687 -> 735  +48: WIN-256 makes `privacy` real (ADR M0.3 §1 row 18). The
    //               context that consumes the kernel `ErasureTarget[]` is also
    //               the one most able to violate the contracts-only edge rule,
    //               and it does not — it imports `@platos/kernel` and
    //               `@platos/context-tenancy` and nothing else. No rule needed
    //               changing. Measured, not carried: the branch claimed +48 on
    //               its own tree and the audit over the integrated tree prints
    //               735, which is the same delta.
    //   735 -> 783  +48: WIN-256 makes `observability` real (ADR M0.3 §1 row
    //               16). This is rule (a) no-infra-in-core judged on the context
    //               most tempted to break it: its whole job is writing to a
    //               column store, and its domain and application layers still
    //               import no client for one. The ClickHouse SDK lives behind
    //               the `ObservabilitySink` port and is bound only in
    //               `packages/adapters/clickhouse-observability`; the
    //               whole-package grep for `@platos/adapter-*` returns nothing
    //               and its only peer import is `@platos/context-tenancy`, which
    //               is on its §1 allow-list. No rule was changed, weakened, or
    //               given an exception. This row was MISSING from this ledger
    //               when observability landed — the region auto-merged while the
    //               assert below was reconciled — so the prose said 735 while
    //               the gate enforced 783. Restored here rather than left to
    //               drift.
    //   783 -> 850  +67: WIN-256 makes `agents` real (ADR M0.3 §1 context 5).
    //               Measured over the integrated tree, not carried.
    //
    //   850 -> 905  +55: WIN-256 makes `tools` real (ADR M0.3 §1 context 7).
    //               Two rules are exercised here for the first time against
    //               production code:
    //
    //                 (g) identity-isolation. `tools` is the first adopted
    //                     context on the FAR side of that rule — it imports
    //                     `@platos/context-identity-access` one way, which is
    //                     exactly the §3 `auth -> tool-gateway` inversion, and
    //                     the rule proves the reverse edge is absent.
    //
    //                 (h) SDK containment for `@modelcontextprotocol`. The
    //                     context declares the `ToolDispatch` port the SDK will
    //                     sit behind; no file under `domain/` or `application/`
    //                     names the package, which is what makes the rule
    //                     enforceable rather than aspirational once the adapter
    //                     lands.
    //
    //               Its four peer dependencies are the widest allow-list any
    //               adopted context has, and no rule needed changing. Measured
    //               over the integrated tree, not carried.
    //   905 -> 906   +1: WIN-256's unproven-guard wave adds
    //               packages/contexts/tools/contracts/operator-gate.test.ts,
    //               the suite that proves the operator gate on all fourteen
    //               published methods that have one. It is a contracts-layer
    //               file and rule (c) judges it: it imports this context's own
    //               `contracts/index.js`, its `domain/index.js` and its
    //               `application/testing/index.js`, and no peer context at all.
    //               Every other file that wave touches already existed, so the
    //               census moves by exactly one.
    //
    //   906 -> 948  +42: WIN-256 makes `channels` real (ADR M0.3 §1 row 9) — 27
    //               source and 15 test files, replacing its 4 released
    //               placeholders in place. What it adds to this gate's evidence
    //               is the ADR M0.3 §3 INVERSION judged on real code: `channels`
    //               enqueues a turn through the kernel's `DurableRuntime` port
    //               and must never call `conversations`. The whole-package grep
    //               for a `@platos/context-conversations` import returns
    //               nothing, and so does the grep for `@platos/adapter-*`, so
    //               rules (b) and (c) hold a production tree rather than a
    //               fixture. Its only two peer imports are
    //               `@platos/context-tenancy` and
    //               `@platos/context-identity-access`, both on its §1
    //               allow-list. No rule was changed, weakened, or given an
    //               exception.
    //
    //   948 -> 1031 +83: WIN-256 makes `governance` real (ADR M0.3 §1 row 14).
    //               It is the first adopted context that IMPLEMENTS TWO KERNEL
    //               PORTS rather than only consuming them — `SafetyEventSink`
    //               and `ErasureTarget` — which is what deletes the `auth ->
    //               monitoring` edge ADR M0.3 §3 records without creating an
    //               identity-access -> governance one in its place. Rule (g)
    //               `identity-isolation` needed no change and no exception: the
    //               two contexts never name each other, the composition root
    //               binds them, and `packages/kernel` is the only module both
    //               import. The 83 are NET of the 4 generated placeholders
    //               adoption released and this code replaced in place, and one
    //               of the 83 exists only because the ADR M0.3 §6 budget bit in
    //               its warning band and a test double was split rather than
    //               waived. The governance branch's own ledger said "the 82 are
    //               NET" one line above calling them 83; 83 is the number the
    //               audit measures over the integrated tree, and the 82 is
    //               dropped rather than carried.
    //
    // The branches pinned partial sums because each saw only its own slice:
    // WIN-297 branched from WIN-256 before providers and pinned 310 + 22 = 332;
    // WIN-256's providers tip pinned 375; the eventing branch pinned
    // 397 + 44 = 441, the skills branch pinned 397 + 55 = 452, the jobs branch
    // pinned 397 + 51 = 448, the memory branch pinned 397 + 77 = 474 and the
    // cost-monitoring branch pinned 397 + 63 = 460, the privacy branch pinned
    // 397 + 48 = 445, the observability branch pinned 397 + 48 = 445 as well,
    // the agents branch pinned 397 + 67 = 464, the tools branch pinned
    // 397 + 56 = 453 and the channels branch pinned 397 + 42 = 439, each blind
    // to the others. The governance branch alone branched from the agents
    // branch rather than from v1, so it could see agents' +67 and pinned
    // 397 + 67 + 83 = 547 — a partial sum too, blind to the other nine.
    // All sixteen slices are disjoint and eventing, skills, jobs, memory,
    // cost-monitoring, privacy, observability, agents, tools, channels,
    // governance, the conversations prerequisite and the model router adapter
    // move this census on INDEPENDENT axes, so the integrated census is their
    // SUM and not any pin:
    // 397 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 83 = 1031, and the
    // last two rows below carry it to 1073.
    // Written out so a DELETION CANNOT HIDE INSIDE AN ADDITION: this census only
    // ever grows, because adoption replaces four placeholders in place and adds
    // the rest, so a fall in this number is always a finding.
    //
    // The two rules WIN-297 exists to exercise both held. Rule (j) now judges
    // TWELVE REAL ADAPTER IMPORTS instead of a generated placeholder list, and
    // rule (a) judges them with @nestjs/* genuinely present in the workspace one
    // directory from context code. Neither was changed, weakened or
    // reinterpreted; their real-tree negative controls are in
    // scripts/arch/composition-root.test.mjs.
    //  1031 -> 1039 +8: WIN-256's `conversations` prerequisite. Four source
    //               files and four suites under packages/contexts/providers
    //               (prompt, prompt-cache, generation, run-model-generation),
    //               which is what puts the inference surface on the ModelRouter
    //               port. Nothing was deleted, so the +8 is 4 + 4 with no
    //               subtraction hidden inside it. The rule this change ADDS,
    //               `inference-sdk-only`, judges all 1039 — not the 405 its own
    //               branch could see — and finds nothing: the surface is built
    //               entirely out of types this repository owns, which is the
    //               property that makes it satisfiable at all, and the eleven
    //               contexts adopted since that branch left v1 name no `ai` or
    //               `@ai-sdk/*` import either. Its own mutation proofs are the
    //               four fixtures above. This slice adopts NO project, so it is
    //               the one wave-B delta that moves this census without moving
    //               the generator-ownership count beside it.
    //  1039 -> 1073 +34: WIN-256's MODEL ROUTER ADAPTER. Fifteen source modules
    //               and fifteen suites under packages/adapters/model-router-
    //               providers, plus two domain modules and two suites under
    //               packages/contexts/providers. Nothing was deleted — the two
    //               declaration placeholders adoption released were REPLACED in
    //               place by real files of the same names — so the +34 is
    //               32 + 2 with no subtraction hidden inside it. Its own branch
    //               pinned 397 + 8 + 34 = 439, blind to the eleven contexts
    //               adopted since it left v1; the +34 is the part that
    //               conserves and 439 is not the number here.
    //
    //               `inference-sdk-only` stops being a rule with nothing to
    //               judge. It now judges a package that really does import `ai`
    //               and four `@ai-sdk/*` bindings, and finds nothing, because
    //               that package is its declared home. Every other one of the
    //               1073 is judged by the same rule against the same source
    //               pattern and none of them reaches for it — which is the
    //               property the whole extraction turns on, and which was
    //               previously true only because no file anywhere imported the
    //               framework at all.
    //
    //  1073 -> 1091 +18: WIN-257 OPERATOR IDENTITY (M2.2), tranches 1, 3, 4 and
    //               5. Its own branch pinned 397 -> 399 -> 403 -> 411 -> 415 on
    //               v1, blind to the thirteen rows adopted since it left; the
    //               +18 is the part that conserves and 415 is not the number
    //               here. Broken out the same way:
    //
    //                 +2  T1 adds the first implementation of the published
    //                     IdentityAccessContract and its refusal suite, both
    //                     under packages/contexts/identity-access/application/.
    //                     No rule needed changing: the facade imports its own
    //                     domain/, its own application/ and the kernel, and the
    //                     composition root reaching it through the newly
    //                     published `./application/index.js` subpath is core-api
    //                     importing a context, which rule (c) judges only
    //                     between two CONTEXTS.
    //
    //                 +4  T3 adds the two transactional writes the product had
    //                     no home for -- create-organization.ts and
    //                     create-project.ts -- and a suite for each, all four
    //                     under packages/contexts/tenancy/application/. Each
    //                     imports its own context's domain/ and the kernel,
    //                     which is what rules (a) and (d) already allow.
    //
    //                 +8  T4 adds the missing read models, four files per
    //                     context. tenancy gains domain/visibility.ts -- the
    //                     rule ported out of `operatorVisibleProjectWhere`,
    //                     which until now existed only as a Prisma where clause
    //                     in apps/webapp -- plus application/operator-read-models.ts
    //                     and a suite for each. identity-access gains
    //                     domain/end-user.ts and application/list-end-users.ts
    //                     with their suites. Rule (b) `domain-purity` is what
    //                     makes the first pair interesting: the rule is now
    //                     expressible with no Prisma type in scope at all,
    //                     which is why it can be a domain file.
    //
    //                 +4  T5 moves the session-cookie exchange contract out of
    //                     apps/webapp -- the cookie name, the __Host- prefix,
    //                     Secure, HttpOnly, SameSite, Path, the absent Domain
    //                     and the TTL -- into domain/session-cookie.ts, with its
    //                     suite. Rule (b) `domain-purity` is the interesting one
    //                     again: the shape is decided with no framework in
    //                     scope, so `createCookie` stays a serialisation detail
    //                     on the far side of the seam. The other two are a
    //                     SPLIT, not new behaviour: the facade's cookie cases
    //                     took identity-access-service.test.ts to 501 effective
    //                     lines, one over the section 6 hard limit, so it was
    //                     split along the seam the budget was pointing at rather
    //                     than the limit being raised.
    //
    //               No rule was added, removed, weakened or reinterpreted by any
    //               of the four, and the census still only ever grows.
    //  1091 -> 1165 +74: WIN-256 adopts `conversations`, the SEVENTEENTH AND
    //               LAST context (ADR M0.3 section 1 row 16). 78 real .ts files
    //               stand where 4 generated placeholders stood, so the delta is
    //               a NET — 78 - 4 = 74 — and it is written as that subtraction
    //               rather than as a bare +74, because the four released
    //               placeholders are the only files this slice removes and a
    //               deletion elsewhere must not be able to hide behind them.
    //               The `inference-sdk-only` rule is the one to watch here: this
    //               context is the turn-execution engine, so it is the package
    //               most tempted to import `ai` or `@ai-sdk/*` directly, and it
    //               imports neither — the tool loop, the step budget and the
    //               cache breakpoints all sit BEHIND `providers`' ModelRouter
    //               port. All 1113 files satisfy every rule, the eleven edges
    //               out of this context are legal and there are ZERO edges in,
    //               which is the second half of row 16 and what makes this
    //               context the DAG sink.
    //               The conversations branch pinned 1039 -> 1113 and its own sum
    //               ended `+ 8 + 74`, blind to the adapter and to WIN-257, both
    //               of which landed on the integration branch after it was cut.
    //               1113 is not the number here: the three deltas are disjoint
    //               and SUM, 1039 + 34 + 18 + 74 = 1165.
    //  1165 -> 1177 +12: WIN-258 adopts `packages/adapters/postgres-tenancy`,
    //               the SECOND adapter and the first PostgreSQL one. 14 real .ts
    //               files stand where 2 generated placeholders stood, so the
    //               delta is a NET -- 14 - 2 = 12 -- written as that subtraction
    //               for the same reason as conversations' above: the two
    //               released placeholders are the only files this slice removes
    //               and a deletion elsewhere must not hide behind them. Its
    //               `.sql` fixture and its `mutations.json` are not source and
    //               are not counted here; the v1 ledger counts all sixteen.
    //               The rule to watch here is the NEW one, `tenancy-prisma-only`:
    //               this is the only package in the V1 layout that may import
    //               the ORM or the generated client package, and `src/client.ts`
    //               is the only file in it that does. Before this slice the rule
    //               did not exist and the ORM had no home at all -- it was banned
    //               inside a context's domain/ and application/ and permitted
    //               everywhere else. The rule is proved non-vacuous by adding
    //               the import to a context file and watching it turn red.
    assert.equal(result.fileCount, 1177, "the generated V1 source census must stay exact");
    assert.equal(result.fileCount, 397 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 83 + 8 + 34 + 18 + 74 + 12);
    assert.equal(result.violations.length, 0, "the current tree must have zero boundary violations");
  });
});
