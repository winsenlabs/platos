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
    // M2 INTEGRATION DELTA — 104 -> 850. Eleven adopting slices make disjoint
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
    // The branches pinned partial sums because each saw only its own slice:
    // WIN-297 branched from WIN-256 before providers and pinned 310 + 22 = 332;
    // WIN-256's providers tip pinned 375; the eventing branch pinned
    // 397 + 44 = 441, the skills branch pinned 397 + 55 = 452, the jobs branch
    // pinned 397 + 51 = 448, the memory branch pinned 397 + 77 = 474 and the
    // cost-monitoring branch pinned 397 + 63 = 460, the privacy branch pinned
    // 397 + 48 = 445, the observability branch pinned 397 + 48 = 445 as well,
    // the agents branch pinned 397 + 67 = 464 and the tools branch pinned
    // 397 + 56 = 453, each blind to the others.
    // All twelve slices are disjoint and eventing, skills, jobs, memory,
    // cost-monitoring, privacy, observability, agents and tools move this census
    // on INDEPENDENT axes, so the integrated census is their SUM and not any
    // pin: 397 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 = 906.
    //
    // The two rules WIN-297 exists to exercise both held. Rule (j) now judges
    // TWELVE REAL ADAPTER IMPORTS instead of a generated placeholder list, and
    // rule (a) judges them with @nestjs/* genuinely present in the workspace one
    // directory from context code. Neither was changed, weakened or
    // reinterpreted; their real-tree negative controls are in
    // scripts/arch/composition-root.test.mjs.
    assert.equal(result.fileCount, 906, "the generated V1 source census must stay exact");
    assert.equal(result.violations.length, 0, "the current tree must have zero boundary violations");
  });
});
