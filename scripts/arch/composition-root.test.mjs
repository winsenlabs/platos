// WIN-297 negative controls.
//
// Two of these are named in the issue's acceptance criteria and are the reason
// it exists: rule (j) `adapters-only-from-core` and rule (a) `no-infra-in-core`
// have never been exercised against real wiring, because until this issue there
// was no composition root to import an adapter and no `@nestjs/*` anywhere near
// a context. Both are now proven against the REAL repository tree — a copy of
// it, mutated — rather than against a synthetic fixture, which is the whole
// point: a rule proven only on fixtures is a rule proven against code somebody
// wrote to make it pass.
//
// Every check in `composition-root.mjs` is also mutated here. A gate nobody has
// watched go red is not evidence.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { check } from "./arch-boundaries.mjs";
import {
  COMPOSITION_ROOT_FILE,
  DYNAMIC_IMPORT_DECLARATION,
  DYNAMIC_IMPORT_FILE,
  auditCompositionRoot,
  parseBindingTable,
  parseSatisfactionKeys,
} from "./composition-root.mjs";
import { ADAPTERS, adapterBindings } from "./gen-v1-skeleton.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const V1_ROOTS = ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"];
const temporary = [];

after(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A copy of the real V1 tree. Build output and links are left behind. */
function realTreeCopy() {
  const root = mkdtempSync("/var/tmp/platos-composition-root-");
  temporary.push(root);
  for (const owned of V1_ROOTS) {
    cpSync(join(repositoryRoot, owned), join(root, owned), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|dist|\.turbo)([/\\]|$)/u.test(source),
    });
  }
  return root;
}

function edit(root, path, mutate) {
  const absolute = join(root, path);
  writeFileSync(absolute, mutate(readFileSync(absolute, "utf8")), "utf8");
}

function ruleIds(result) {
  return result.violations.map((violation) => violation.rule);
}

// ---------------------------------------------------------------------------
// Positive control. Everything below is meaningless if the live tree is dirty.
// ---------------------------------------------------------------------------

test("the live repository satisfies both the boundary rules and the composition-root audit", () => {
  const boundaries = check(repositoryRoot);
  assert.deepEqual(boundaries.violations, [], "the real tree must have zero boundary violations");
  assert.ok(boundaries.fileCount > 300, `expected a non-vacuous scan, got ${boundaries.fileCount} files`);

  const audit = auditCompositionRoot(repositoryRoot);
  assert.deepEqual(audit.problems, []);
  // THIRTY-ONE bindings across TWELVE directories (ADR M0.3 §15). Both are
  // asserted, so a change that collapsed them back to one number fails here.
  // 13 -> 17 (WIN-258 T5, three stores): `tools:ToolsRepository`,
  // `agents:AgentsRepository`, `agents:ScaffoldingRepository` and
  // `cost-monitoring:BudgetRepository`, so one directory now carries six.
  // 17 -> 22 (WIN-258 M2.3): tenancy's five NON-REPOSITORY driven ports get
  // slots, so that directory carries eleven.
  // 22 -> 30 (WIN-258 T5, three stores landing together): `channels` adds
  // `ChannelsRepository`, `governance` its FIVE canonical-store ports over five
  // canonical rows, and `secrets` its TWO over four, so that directory carries
  // NINETEEN. Both of `secrets`' are proven through the property that carries
  // them rather than through the adapter itself, and there that was FORCED:
  // `SecretsRepository` and `ToolsRepository` both declare a top-level
  // `appendAudit` with different signatures, so one interface cannot extend
  // both. The DIRECTORY count deliberately does not move through any of it,
  // which is the whole content of the amendment.
  // 30 -> 38 (WIN-258 T5, four times): `providers` adds `ProvidersRepository`, its ONE
  // canonical-store port over the four rows of §1 row 4, and `conversations`
  // adds FOUR — `ThreadRepository`, `TurnRepository`, `PostmanRepository` and
  // `ConversationsErasureStore` — so that directory carries TWENTY-EIGHT and the
  // ninth through twelfth owners arrive without a thirteenth directory. `providers` is
  // proven against the ADAPTER rather than through a property — its eighteen
  // method names collide with nothing the directory already publishes — which is
  // the contrast that makes `secrets`' two property proofs read as forced rather
  // than stylistic. `conversations`' four are proven through the property that
  // carries them, and there the reason is the middle one of the three: they
  // neither collide with each other nor are blocked from spreading, but
  // `ConversationsDependencies` names four SLOTS and a root has to hand each port
  // over under its own name.
  // 38 -> 40 (WIN-258 T5, a fifth time): `jobs` adds `JobsRepository` and
  // `ApprovalsRepository` over the two rows of §1 row 15, so that directory
  // carries TWENTY-NINE and the thirteenth owner arrives without a thirteenth
  // directory. Both are proven through the property that carries them, and there
  // too it was FORCED: `ApprovalsRepository` and `ConversationsErasureStore`
  // both declare a top-level `erase` with different signatures, so one interface
  // cannot extend both.
  // 41 -> 42 (WIN-258 T5, a FIFTEENTH owner): `files` adds `FilesRepository`,
  // its ONE canonical-store port over the two rows of §1 row 10, so that
  // directory carries THIRTY-TWO and the fifteenth owner arrives without a
  // thirteenth directory. It is proven against the ADAPTER rather than through a
  // property, like `providers`' — its fifteen method names collide with nothing
  // the directory already publishes.
  //
  // IT IS THE SECOND BINDING THIS TABLE HOLDS FOR ONE CONTEXT, and the pair is
  // the point rather than an accident: `objectstore-minio:ObjectStore` is also
  // owned by `files`. A row and a blob are two technologies behind two ports,
  // and `domain/destruction.ts` fixes blob-before-row precisely because no
  // transaction spans them.
  assert.equal(audit.bindingCount, adapterBindings().length);
  assert.equal(audit.bindingCount, 44);
  //
  // AND `memory` adds `MemoryRepository` and
  // `KnowledgeGraphRepository` over its three canonical rows, so that directory
  // carries TWENTY-EIGHT in all with `observability`'s. Both are proven through the property that carries them,
  // and there too it was FORCED: `KnowledgeGraphRepository` and
  // `TenancyRepository` both declare a top-level `findEntity` with different
  // signatures, so one interface cannot extend both. The DIRECTORY count is
  // unmoved a fourth time.
  //
  // 38 -> 39 (WIN-258 T5, the THIRTEENTH owner): `privacy` adds
  // `PrivacyRepository`, its ONE canonical-store port over the two rows of §1
  // row 18, so that directory carries TWENTY-EIGHT. It is proven against the
  // ADAPTER rather than through a property — like `providers`', and unlike
  // `secrets`', `skills`' and `memory`'s: `PrivacyRepository` is declared as
  // `OperationRepository` and `TombstoneRepository` composed into ONE interface,
  // and its ten method names collide with nothing the directory already
  // publishes, so nothing here forces a property. The DIRECTORY count is unmoved
  // a fifth time.
  assert.equal(ADAPTERS.length, 12);
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CONTROL 1 — rule (j) against real wiring.
// ---------------------------------------------------------------------------

test("rule (j): a context importing an adapter fails, now that adapters are really imported somewhere", () => {
  const root = realTreeCopy();
  edit(root, "packages/contexts/tenancy/application/index.ts", (source) =>
    `import type { OutboxAdapter } from "@platos/adapter-outbox";\n${source}\nexport type Leak = OutboxAdapter;\n`
  );
  const result = check(root);
  assert.ok(ruleIds(result).includes("adapters-only-from-core"), JSON.stringify(ruleIds(result)));
});

test("rule (j): apps/mcp-stdio may not import an adapter either — core-api is named, not 'an app'", () => {
  const root = realTreeCopy();
  edit(root, "apps/mcp-stdio/src/main.ts", (source) =>
    `import type { OutboxAdapter } from "@platos/adapter-outbox";\n${source}\nexport type Leak = OutboxAdapter;\n`
  );
  assert.ok(ruleIds(check(root)).includes("adapters-only-from-core"));
});

test("rule (j) NON-VACUITY: the real composition root imports twelve adapters and does NOT fire it", () => {
  // The control that matters. If rule (j) fired on apps/core-api too, the two
  // tests above would pass for the wrong reason and the rule would be useless.
  const result = check(repositoryRoot);
  const source = readFileSync(join(repositoryRoot, COMPOSITION_ROOT_FILE), "utf8");
  for (const adapter of ADAPTERS) {
    assert.ok(source.includes(`@platos/adapter-${adapter.dir}`), `composition root must import ${adapter.dir}`);
  }
  assert.equal(ruleIds(result).filter((id) => id === "adapters-only-from-core").length, 0);
});

// ---------------------------------------------------------------------------
// ACCEPTANCE CONTROL 2 — rule (a) with a real framework in the workspace.
// ---------------------------------------------------------------------------

test("rule (a): @nestjs inside a context domain/ fails", () => {
  const root = realTreeCopy();
  edit(root, "packages/contexts/identity-access/domain/session.ts", (source) =>
    `import { Injectable } from "@nestjs/common";\n${source}`
  );
  assert.ok(ruleIds(check(root)).includes("no-infra-in-core"));
});

test("rule (a): @nestjs inside a context application/ fails", () => {
  const root = realTreeCopy();
  edit(root, "packages/contexts/files/application/index.ts", (source) =>
    `import { Module } from "@nestjs/core";\n${source}`
  );
  assert.ok(ruleIds(check(root)).includes("no-infra-in-core"));
});

test("rule (a): a context's contracts/ is ALSO not a hiding place for the framework", () => {
  // contracts/ is outside rule (a)'s from-side, deliberately: the rule is about
  // the onion's core. This asserts the CURRENT behaviour explicitly so that if a
  // later issue decides contracts/ should be covered, the change is visible
  // rather than accidental.
  const root = realTreeCopy();
  edit(root, "packages/contexts/files/contracts/index.ts", (source) =>
    `import { Injectable } from "@nestjs/common";\n${source}`
  );
  const fired = ruleIds(check(root)).includes("no-infra-in-core");
  assert.equal(fired, false, "rule (a) is scoped to domain/ and application/; contracts/ is not in its from-side");
});

test("rule (a) NON-VACUITY: the same import inside apps/core-api is legal and does NOT fire", () => {
  // Without this, a rule that banned @nestjs everywhere would pass every test
  // above and make the composition root itself impossible. The real tree already
  // contains those imports, and the live scan is clean.
  const httpModule = readFileSync(join(repositoryRoot, "apps/core-api/src/http/http.module.ts"), "utf8");
  assert.ok(httpModule.includes('from "@nestjs/common"'), "the Nest module must really import the framework");
  const lifecycle = readFileSync(join(repositoryRoot, "apps/core-api/src/runtime/lifecycle.ts"), "utf8");
  assert.ok(lifecycle.includes('from "@nestjs/core"'));
  assert.deepEqual(check(repositoryRoot).violations, []);
});

// ---------------------------------------------------------------------------
// The composition-root audit's own mutation controls.
// ---------------------------------------------------------------------------

test("C1: a second file in core-api importing an adapter fails", () => {
  // Legal under rule (j) — it IS apps/core-api — and exactly what this gate adds.
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/rest/index.ts", (source) =>
    `import type { RedisCacheAdapter } from "@platos/adapter-redis-cache";\n${source}\nexport type Sneak = RedisCacheAdapter;\n`
  );
  assert.deepEqual(check(root).violations, [], "the mutation must be legal under the ADR rule set");
  const problems = auditCompositionRoot(root).problems;
  assert.ok(problems.some((problem) => problem.includes("transports/rest/index.ts imports an adapter package")));
});

test("C1: the composition root importing NO adapter fails as vacuous", () => {
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) => source.replaceAll("@platos/adapter-", "@platos/notanadapter-"));
  assert.ok(auditCompositionRoot(root).problems.some((problem) => problem.includes("would be vacuous")));
});

test("C6: dropping one adapter import fails", () => {
  // The specifier is matched rather than the whole import line. WIN-258 T4 added
  // a second name to it — `OutboxEventStore`, the seam the composition root
  // proves `postgres-tenancy` satisfies — and a control anchored on the exact
  // one-name line stopped matching and started passing vacuously. Anchoring on
  // the specifier is what the audit itself looks for.
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace(/^import type \{[^}]*\} from "@platos\/adapter-outbox";\n/mu, "")
  );
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) => problem.includes("does not import @platos/adapter-outbox"))
  );
});

test("C2: a port renamed in the binding table fails against the ADR ownership map", () => {
  // WIN-258 T2: the comparison is now a SET of (adapter, port, owner) triples,
  // so a renamed port fails in BOTH directions at once — the declared triple is
  // not one the ADR gives, and the one the ADR gives is missing.
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace('adapter: "redis-cache", port: "Cache"', 'adapter: "redis-cache", port: "EventBus"')
  );
  const problems = auditCompositionRoot(root).problems;
  assert.ok(problems.some((problem) => problem.includes("names redis-cache -> memory EventBus")));
  assert.ok(problems.some((problem) => problem.includes("omits redis-cache -> memory Cache")));
});

test("C2: an owner reassigned in the binding table fails", () => {
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace('adapter: "objectstore-minio", port: "ObjectStore", owner: "files"',
      'adapter: "objectstore-minio", port: "ObjectStore", owner: "memory"')
  );
  const problems = auditCompositionRoot(root).problems;
  assert.ok(problems.some((problem) => problem.includes("names objectstore-minio -> memory ObjectStore")));
  assert.ok(problems.some((problem) => problem.includes("omits objectstore-minio -> files ObjectStore")));
});

test("C2: an entry removed from the binding table fails", () => {
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace(/\n\s*Object\.freeze\(\{ adapter: "channel-slack"[^\n]*\n/u, "\n")
  );
  const problems = auditCompositionRoot(root).problems;
  assert.ok(problems.some((problem) => problem.includes("binding table omits channel-slack")));
  assert.ok(problems.some((problem) => problem.includes("declares 43 binding(s)")));
});

test("C3: an adapter missing its compile-time satisfaction entry fails", () => {
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace(/\n\s*"durable-runtime:DurableRuntime": true,/u, "")
  );
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) =>
      problem.includes("PORT_SATISFACTION has no entry for durable-runtime:DurableRuntime")
    )
  );
});

test("C4: a run-time-resolved import anywhere else fails", () => {
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/app.module.ts", (source) =>
    `${source}\nexport async function sneak(name: string): Promise<unknown> {\n  return await import(name);\n}\n`
  );
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) => problem.includes("resolves an import specifier at run time"))
  );
});

test("C4: removing the declared finding from the one permitted place fails", () => {
  const root = realTreeCopy();
  edit(root, DYNAMIC_IMPORT_FILE, (source) => source.replace(DYNAMIC_IMPORT_DECLARATION, "note"));
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) => problem.includes("no longer carries its declared finding"))
  );
});

test("C4: a LITERAL dynamic import is not flagged — the rule is about invisibility, not syntax", () => {
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/app.module.ts", (source) =>
    `${source}\nexport async function load(): Promise<unknown> {\n  return await import("./config/schema.js");\n}\n`
  );
  assert.deepEqual(auditCompositionRoot(root).problems, []);
});

test("the audit reads code, not prose: import( in a comment or a string is ignored", () => {
  // The first draft used a regex and reported two false positives on the live
  // tree within a minute. This pins the fix.
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/app.module.ts", (source) =>
    `${source}\n// Callers used to do: await import(specifier)\nexport const SNIPPET = "await import(name)";\n`
  );
  assert.deepEqual(auditCompositionRoot(root).problems, []);
});

// ---------------------------------------------------------------------------
// The parsers, independently.
// ---------------------------------------------------------------------------

test("the binding-table parser reads all FORTY-FOUR bindings, across twelve directories", () => {
  const source = readFileSync(join(repositoryRoot, COMPOSITION_ROOT_FILE), "utf8");
  const entries = parseBindingTable(source);
  const bindings = adapterBindings();
  assert.equal(entries.length, bindings.length);
  assert.equal(bindings.length, 44);
  assert.equal(ADAPTERS.length, 12);
  assert.deepEqual(
    entries.map((entry) => `${entry.adapter}:${entry.port}`).sort(),
    bindings.map((binding) => `${binding.adapter}:${binding.port}`).sort()
  );
  assert.deepEqual(
    parseSatisfactionKeys(source).sort(),
    bindings.map((binding) => `${binding.adapter}:${binding.port}`).sort()
  );
  // A directory with thirty-three bindings appears THIRTY-THREE TIMES in the
  // flattening and once in the directory set. Both halves are asserted so a
  // change that collapsed the table back to one row per directory cannot pass
  // here. It is thirty-three rather than two because WIN-258 T5 landed all of
  // tranche 5's canonical stores in this one directory — `tools` publishes one
  // port, `agents` two, `cost-monitoring` one, `channels` one, `governance`
  // FIVE, `secrets` two and `skills` one, all over the same client as tenancy's
  // and identity-access's — and WIN-258 M2.3 then gave tenancy's five
  // NON-REPOSITORY ports slots on the same directory that already satisfied
  // them, and WIN-258 T5 then added `providers`' one, `conversations`' four,
  // `skills`' one, `memory`'s two, `privacy`'s one, `jobs`' two, `files`' one,
  // `observability`'s one and `eventing`'s one.
  // 1 + 1 + 1 + 2 + 1 + 1 + 5 + 2 + 5 + 1 + 4 + 1 + 2 + 1 + 2 + 1 + 1 + 1 = 33.
  assert.equal(entries.filter((entry) => entry.adapter === "postgres-tenancy").length, 33);
  assert.equal(new Set(entries.map((entry) => entry.adapter)).size, 12);
});

test("the parser reads a WRAPPED entry, not only a one-line one", () => {
  // The trailing comma a formatter adds when it wraps an entry used to end the
  // match, silently dropping the binding. It failed closed — the dropped row was
  // reported as omitted — but a gate should not depend on how a line was broken.
  const wrapped = `Object.freeze({\n    adapter: "x",\n    port: "Y",\n    owner: "z",\n  }),`;
  assert.deepEqual(parseBindingTable(wrapped), [{ adapter: "x", port: "Y", owner: "z" }]);
  assert.deepEqual(parseBindingTable('{ adapter: "x", port: "Y", owner: "z" }'), [
    { adapter: "x", port: "Y", owner: "z" },
  ]);
});

// ---------------------------------------------------------------------------
// WIN-258 T2 (ADR M0.3 §15). The binding table now holds MANY ports per
// DIRECTORY. These are the three refusals that widening did not take with it —
// an adapter satisfying a port it was not bound to, a declared binding with no
// proof, and a port with no satisfying adapter.
// ---------------------------------------------------------------------------

test("§15 refusal: PORT_SATISFACTION proving a pair that was never bound fails", () => {
  // The direction the directory-keyed table could not see at all: an EXTRA
  // entry was simply invisible, so a compile-time "proof" that an adapter
  // implements a port nobody bound it to sat in the file unchallenged.
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace('"postgres-tenancy:TenancyRepository": true,',
      '"postgres-tenancy:TenancyRepository": true,\n  "postgres-tenancy:Cache": true,')
  );
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) =>
      problem.includes("PORT_SATISFACTION proves postgres-tenancy:Cache, which is not a declared binding")
    )
  );
});

test("§15 refusal: a binding table row the ADR does not declare fails", () => {
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace('{ adapter: "outbox", port: "OutboxWriter", owner: "kernel" }',
      '{ adapter: "outbox", port: "Cache", owner: "memory" }')
  );
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) =>
      problem.includes("binding table names outbox -> memory Cache, which is not one of the 44 declared bindings")
    )
  );
});

test("§15 refusal: the SECOND binding of a two-port directory needs its own proof", () => {
  // The case a directory-keyed table structurally could not hold: one binding
  // proven, the other merely asserted, with the compiler unable to notice
  // because a missing obligation is not a wrong one.
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace(/\n\s*"postgres-tenancy:IdentityAccessRepository": true,/u, "")
  );
  assert.ok(
    auditCompositionRoot(root).problems.some((problem) =>
      problem.includes("PORT_SATISFACTION has no entry for postgres-tenancy:IdentityAccessRepository")
    )
  );
});

test("§15 refusal: a declared binding with no row in the table fails", () => {
  const root = realTreeCopy();
  edit(root, COMPOSITION_ROOT_FILE, (source) =>
    source.replace(/\n\s*Object\.freeze\(\{\n\s*adapter: "postgres-tenancy",\n\s*port: "IdentityAccessRepository",\n\s*owner: "identity-access",\n\s*\}\),/u, "")
  );
  const problems = auditCompositionRoot(root).problems;
  assert.ok(
    problems.some((problem) =>
      problem.includes("binding table omits postgres-tenancy -> identity-access IdentityAccessRepository")
    )
  );
  assert.ok(problems.some((problem) => problem.includes("declares 43 binding(s)")));
});

test("the satisfaction parser reports absence rather than an empty list", () => {
  assert.equal(parseSatisfactionKeys("export const NOTHING = 1;\n"), null);
});

// ---------------------------------------------------------------------------
// The compile-time binding proof can actually fail.
// ---------------------------------------------------------------------------

test("PORT_SATISFACTION rejects an adapter that stops implementing its port", () => {
  // A compile-time proof nobody has watched fail is not evidence. This compiles
  // the REAL kernel port and the REAL outbox adapter against the REAL `Satisfies`
  // pattern, twice: once as they are, and once with the adapter's `extends`
  // clause removed.
  const root = mkdtempSync("/var/tmp/platos-satisfies-");
  temporary.push(root);
  mkdirSync(join(root, "kernel"), { recursive: true });
  mkdirSync(join(root, "outbox"), { recursive: true });
  cpSync(join(repositoryRoot, "packages/kernel/src"), join(root, "kernel"), { recursive: true });
  cpSync(join(repositoryRoot, "packages/adapters/outbox/src"), join(root, "outbox"), { recursive: true });

  const probe = (adapterSource) => {
    writeFileSync(join(root, "outbox/adapter.ts"), adapterSource, "utf8");
    writeFileSync(
      join(root, "probe.ts"),
      [
        'import type { OutboxWriter } from "./kernel/index.js";',
        'import type { OutboxAdapter } from "./outbox/adapter.js";',
        "type Satisfies<Adapter, Port> = Adapter extends Port ? true : never;",
        "export const proof: Satisfies<OutboxAdapter, OutboxWriter> = true;",
        "",
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext",
          target: "ES2022", skipLibCheck: true,
          // The adapter imports its port by package name, exactly as it does in
          // the repository. Mapping it to the copied kernel SOURCE keeps this
          // fixture free of node_modules while still compiling the real files.
          baseUrl: ".", paths: { "@platos/kernel": ["./kernel/index.ts"] },
        },
        include: ["probe.ts"],
      }, null, 2)}\n`,
      "utf8"
    );
    return spawnSync(join(repositoryRoot, "node_modules/.bin/tsc"), ["-p", root], { encoding: "utf8" });
  };

  const original = readFileSync(join(repositoryRoot, "packages/adapters/outbox/src/adapter.ts"), "utf8");
  const intact = probe(original);
  assert.equal(intact.status, 0, `the unmutated adapter must compile:\n${intact.stdout}${intact.stderr}`);

  const broken = probe(original.replace("extends OutboxWriter ", ""));
  assert.notEqual(broken.status, 0, "an adapter that stops implementing its port must break the build");
  assert.match(`${broken.stdout}${broken.stderr}`, /is not assignable to type 'never'/u);
});
