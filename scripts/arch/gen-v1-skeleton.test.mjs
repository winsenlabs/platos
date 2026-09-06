import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkAdapterTable,
  ADOPTED_PROJECTS,
  APPLICATION_ENTRY_PROJECTS,
  EXPECTED_PLACEHOLDER_FILE_COUNT,
  EXPECTED_SCAFFOLDING_FILE_COUNT,
  SCAFFOLDING_BASENAMES,
  TESTING_ENTRY_PROJECTS,
  checkSkeleton,
  isScaffoldingPath,
  projectPaths,
  renderSkeleton,
  selfCheck,
  tierCounts,
  writeSkeleton,
} from "./gen-v1-skeleton.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(repositoryRoot, "scripts/arch/gen-v1-skeleton.mjs");
const fixtures = [];

after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(adopted) {
  const root = mkdtempSync("/var/tmp/platos-generator-");
  fixtures.push(root);
  writeSkeleton(root, adopted);
  return root;
}

function write(root, path, text) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

const liveTotal = EXPECTED_SCAFFOLDING_FILE_COUNT + EXPECTED_PLACEHOLDER_FILE_COUNT - releasedByLiveAdoptions();

function releasedByLiveAdoptions() {
  const full = renderSkeleton([]);
  return full.size - renderSkeleton().size;
}

test("--list emits exactly the live sorted unique generated paths", () => {
  const paths = execFileSync("node", [generator, "--list"], { cwd: repositoryRoot, encoding: "utf8" }).trim().split("\n");
  assert.equal(paths.length, liveTotal);
  assert.equal(new Set(paths).size, liveTotal);
  assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(paths, [...renderSkeleton().keys()].sort());
});

test("--check accepts the live generated tree and reports both ownership tiers", () => {
  const output = execFileSync("node", [generator, "--check"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.match(output, /^ok: /u);
  assert.match(output, new RegExp(`${EXPECTED_SCAFFOLDING_FILE_COUNT} scaffolding`, "u"));
  assert.match(output, new RegExp(`= ${liveTotal} generated file\\(s\\)`, "u"));
  // 94 -> 95 (WIN-297): apps/core-api -> packages/kernel. The composition root
  // binds three kernel-hosted ports (OutboxWriter, DurableRuntime, EventBus) and
  // implements the three kernel ports that have no adapter (Clock, IdGenerator,
  // Logger), so it must be able to name them. Reasoned in full on
  // EXPECTED_EDGE_COUNT in the generator.
  // 96 -> 97 (WIN-258 T5): packages/adapters/postgres-tenancy ->
  // packages/contexts/tools, the reference the adapter needs to name the port it
  // satisfies. Reasoned in full on EXPECTED_EDGE_COUNT in the generator.
  // 97 -> 98 (WIN-258 T5): packages/adapters/postgres-tenancy ->
  // packages/contexts/agents, the reference the adapter needs to name the two
  // canonical-store ports it satisfies. ONE edge for TWO bindings, because a
  // project reference is per package.
  // 98 -> 99 (WIN-258 T5): packages/adapters/postgres-tenancy ->
  // packages/contexts/cost-monitoring, the fifth owner of the one PostgreSQL
  // client (ADR M0.3 §15).
  // 99 -> 102 (WIN-258 T5): packages/adapters/postgres-tenancy ->
  // packages/contexts/channels, -> packages/contexts/governance and ->
  // packages/contexts/secrets, the sixth, seventh and eighth owners of that same
  // client. THREE edges for EIGHT bindings. The count is READ BACK from the
  // generator here rather than computed, which is the whole point of this case.
  assert.match(output, /32 V1 projects and 103 project edges/u);
});

test("writing a complete generated tree is byte-idempotent", () => {
  const root = fixture();
  const before = new Map([...renderSkeleton().keys()].map((path) => [path, readFileSync(join(root, path), "utf8")]));
  writeSkeleton(root);
  for (const [path, bytes] of before) assert.equal(readFileSync(join(root, path), "utf8"), bytes, path);
  assert.deepEqual(checkSkeleton(root), []);
});

test("stale, missing, and extra owned files each fail closed", () => {
  for (const [kind, mutate, expected] of [
    // Sample an UNADOPTED placeholder: an adopted project's source tree is
    // released by design, and its own controls live in the adoption tests below.
    //
    // THE SAMPLE IS NOT ARBITRARY and it is not a name to force: it must be a
    // project ABSENT from ADOPTED_PROJECTS, because an adopted project has no
    // generated source files left to be stale, missing or extra. The adoption
    // tests below prove the other half — that an adopted project's source tree
    // is released rather than merely unchecked.
    //
    // IT HAS MOVED THREE TIMES, AND EACH MOVE IS AN ADOPTION CATCHING UP WITH
    // IT. `packages/contexts/tools` on the M2 trunk; the tools branch moved it
    // to `memory` because it was adopting `tools`, and WIN-297 had already moved
    // the MISSING case off `apps/mcp-stdio/src/main.ts` for the same reason.
    // `memory` is adopted on THIS trunk, so the tools branch's choice arrived
    // here naming a project that no longer has the files — an auto-merge with no
    // textual conflict and a red test.
    //
    // FOURTH MOVE, and the last one that can be made within the context tier.
    // It named `conversations`, whose own comment predicted that "a future
    // adoption of `conversations` must move it again, to whatever is still
    // unadopted then" — and WIN-256 adopting the seventeenth and last context is
    // that adoption. It failed with ENOENT rather than passing quietly, which is
    // the behaviour that comment was relying on. NO CONTEXT IS UNADOPTED NOW, so
    // the sample moves to the ADAPTER tier, which is entirely generated: twelve
    // projects, two placeholders each, none of them adopted. The `extra` case
    // keeps its file inside the same project so all three sample one place.
    ["stale", (root) => writeFileSync(join(root, "packages/adapters/durable-runtime/src/index.ts"), "stale\n"), "STALE   packages/adapters/durable-runtime/src/index.ts"],
    ["missing", (root) => rmSync(join(root, "packages/adapters/durable-runtime/src/adapter.ts")), "MISSING packages/adapters/durable-runtime/src/adapter.ts"],
    ["extra", (root) => write(root, "packages/adapters/durable-runtime/src/extra.ts", "export {};\n"), "EXTRA   packages/adapters/durable-runtime/src/extra.ts"],
  ]) {
    const root = fixture();
    mutate(root);
    assert.ok(checkSkeleton(root).includes(expected), kind);
  }
});

// ---------------------------------------------------------------------------
// Two-tier ownership (WIN-256). The scaffolding tier is never released; the
// source tier is released only by an explicit, monotonic adoption.
// ---------------------------------------------------------------------------

test("the scaffolding tier is exactly 97 files and is only ever manifests, tsconfigs and READMEs", () => {
  const files = renderSkeleton([]);
  const { scaffolding, placeholders, total } = tierCounts(files);
  assert.equal(scaffolding, EXPECTED_SCAFFOLDING_FILE_COUNT);
  assert.equal(placeholders, EXPECTED_PLACEHOLDER_FILE_COUNT);
  assert.equal(total, 201, "an unadopted skeleton is still the M1 201-file tree");

  const scaffoldingPaths = [...files.keys()].filter((path) => isScaffoldingPath(path));
  assert.equal(scaffoldingPaths.length, EXPECTED_SCAFFOLDING_FILE_COUNT);
  for (const path of scaffoldingPaths) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    assert.ok(
      path === "tsconfig.json" || SCAFFOLDING_BASENAMES.includes(basename),
      `${path} is counted as scaffolding but is not a scaffolding file`
    );
  }
  assert.equal(projectPaths().length * SCAFFOLDING_BASENAMES.length + 1, EXPECTED_SCAFFOLDING_FILE_COUNT);
});

test("adopting a project releases exactly that project's source placeholders and nothing else", () => {
  const adopted = ["packages/contexts/identity-access"];
  const before = renderSkeleton([]);
  const after = renderSkeleton(adopted);

  const released = [...before.keys()].filter((path) => !after.has(path));
  assert.deepEqual(released.sort(), [
    "packages/contexts/identity-access/application/index.ts",
    "packages/contexts/identity-access/application/ports/index.ts",
    "packages/contexts/identity-access/contracts/index.ts",
    "packages/contexts/identity-access/domain/index.ts",
  ]);
  assert.equal(tierCounts(after).scaffolding, EXPECTED_SCAFFOLDING_FILE_COUNT, "scaffolding is never released");
  for (const basename of SCAFFOLDING_BASENAMES) {
    assert.ok(after.has(`packages/contexts/identity-access/${basename}`), `${basename} stayed generated`);
  }
});

test("real source under an adopted project is accepted; the same file under a peer project is still EXTRA", () => {
  const adopted = ["packages/contexts/identity-access"];
  const root = fixture(adopted);

  write(root, "packages/contexts/identity-access/domain/session.ts", "export interface Session { readonly id: string; }\n");
  write(root, "packages/contexts/identity-access/domain/nested/deep.ts", "export {};\n");
  assert.deepEqual(checkSkeleton(root, adopted), [], "adopted source tree is released");

  // NEGATIVE CONTROL: adoption is per project. A peer context is untouched.
  write(root, "packages/contexts/secrets/domain/session.ts", "export interface Session { readonly id: string; }\n");
  assert.ok(
    checkSkeleton(root, adopted).includes("EXTRA   packages/contexts/secrets/domain/session.ts"),
    "adoption must not release a project that was not adopted"
  );
});

test("adoption releases the source tree only — scaffolding still fails closed on stale and missing", () => {
  const adopted = ["packages/contexts/identity-access"];

  const missing = fixture(adopted);
  rmSync(join(missing, "packages/contexts/identity-access/package.json"));
  assert.ok(
    checkSkeleton(missing, adopted).includes("MISSING packages/contexts/identity-access/package.json"),
    "an adopted project still owes its manifest"
  );

  const stale = fixture(adopted);
  writeFileSync(join(stale, "packages/contexts/identity-access/tsconfig.json"), "{}\n");
  assert.ok(
    checkSkeleton(stale, adopted).includes("STALE   packages/contexts/identity-access/tsconfig.json"),
    "an adopted project's tsconfig carries its project references and stays byte-compared"
  );
});

test("un-adopting a project that still holds real files fails closed (monotonicity)", () => {
  const adopted = ["packages/contexts/identity-access"];
  const root = fixture(adopted);
  write(root, "packages/contexts/identity-access/domain/session.ts", "export interface Session { readonly id: string; }\n");
  assert.deepEqual(checkSkeleton(root, adopted), []);

  // Removing the entry to make a failure go away cannot succeed: the real file
  // becomes EXTRA and every released placeholder comes back MISSING.
  const problems = checkSkeleton(root, []);
  assert.ok(problems.includes("EXTRA   packages/contexts/identity-access/domain/session.ts"));
  assert.ok(problems.includes("MISSING packages/contexts/identity-access/domain/index.ts"));
});

test("selfCheck rejects an adoption entry that is not a V1 project, and a duplicate entry", () => {
  assert.deepEqual(selfCheck(), [], "the live registry is valid");
  // WIN-258 T5. All THREE registries are supplied empty. `selfCheck` judges the
  // testing-entry list against the SAME adoption argument, so leaving it to
  // default would import the live list into a case about an empty one and
  // report `tools` and `cost-monitoring` unadopted — a true statement about a
  // registry this case is not describing.
  assert.deepEqual(selfCheck([], [], []), [], "an empty registry is valid");

  assert.deepEqual(selfCheck(["packages/contexts/not-a-context"], [], []), [
    "ADOPTED_PROJECTS names packages/contexts/not-a-context, which is not a V1 project",
  ]);
  assert.deepEqual(selfCheck(["apps/core-api", "apps/core-api"], [], []), [
    "ADOPTED_PROJECTS names apps/core-api more than once",
  ]);
});

// ---------------------------------------------------------------------------
// WIN-257: a context may publish its use cases only when this root composes it.
// ---------------------------------------------------------------------------

test("selfCheck rejects an application entry that is not an adopted context", () => {
  const adopted = ["packages/contexts/identity-access"];

  assert.deepEqual(
    selfCheck(adopted, ["packages/contexts/agents"], []),
    ["APPLICATION_ENTRY_PROJECTS names packages/contexts/agents, which is not adopted"],
    "an unadopted context's application/index.ts is a generated placeholder",
  );
  assert.deepEqual(
    selfCheck(adopted, ["apps/core-api"], []),
    [
      "APPLICATION_ENTRY_PROJECTS names apps/core-api, which is not a context",
      "APPLICATION_ENTRY_PROJECTS names apps/core-api, which is not adopted",
    ],
    "apps/core-api is adopted but is not a context; both clauses fire",
  );
  assert.deepEqual(selfCheck(adopted, [...adopted, ...adopted], []), [
    "APPLICATION_ENTRY_PROJECTS names packages/contexts/identity-access more than once",
  ]);
});

// ---------------------------------------------------------------------------
// WIN-258 T5: a context may publish its in-memory doubles only when the adapter
// measured against them can actually import them.
// ---------------------------------------------------------------------------

test("selfCheck rejects a testing entry that is not an adopted context", () => {
  const adopted = ["packages/contexts/identity-access"];

  assert.deepEqual(
    selfCheck(adopted, [], ["packages/contexts/agents"]),
    ["TESTING_ENTRY_PROJECTS names packages/contexts/agents, which is not adopted"],
    "an unadopted context's application/testing/ tree is generated placeholders",
  );
  assert.deepEqual(
    selfCheck(adopted, [], ["apps/core-api"]),
    [
      "TESTING_ENTRY_PROJECTS names apps/core-api, which is not a context",
      "TESTING_ENTRY_PROJECTS names apps/core-api, which is not adopted",
    ],
    "apps/core-api is adopted but is not a context; both clauses fire",
  );
  assert.deepEqual(selfCheck(adopted, [], [...adopted, ...adopted]), [
    "TESTING_ENTRY_PROJECTS names packages/contexts/identity-access more than once",
  ]);
  // And the two lists are judged SEPARATELY: naming a project on one says
  // nothing about the other, which is the property that keeps a mistake in
  // either from being reported under the other's name.
  assert.deepEqual(
    selfCheck(adopted, ["packages/contexts/agents"], ["packages/contexts/skills"]),
    [
      "APPLICATION_ENTRY_PROJECTS names packages/contexts/agents, which is not adopted",
      "TESTING_ENTRY_PROJECTS names packages/contexts/skills, which is not adopted",
    ],
  );
});

test("publishing the doubles entry point is what the list decides, nothing else", () => {
  const withoutEntry = renderSkeleton(ADOPTED_PROJECTS, [], []);
  const withEntry = renderSkeleton(ADOPTED_PROJECTS, [], ["packages/contexts/identity-access"]);
  const manifest = "packages/contexts/identity-access/package.json";

  assert.ok(!withoutEntry.get(manifest).includes("./application/testing/index.js"));
  assert.ok(withEntry.get(manifest).includes('"./application/testing/index.js"'));
  assert.equal(
    withoutEntry.size,
    withEntry.size,
    "publishing a subpath adds no file; it edits one manifest",
  );

  for (const path of withEntry.keys()) {
    if (path === manifest) continue;
    assert.equal(withEntry.get(path), withoutEntry.get(path), `${path} must not move`);
  }
});

test("the live testing registry is adopted, is a context, and is named once", () => {
  const known = new Set(projectPaths());
  for (const project of TESTING_ENTRY_PROJECTS) {
    assert.ok(known.has(project), `${project} is not a V1 project`);
    assert.ok(ADOPTED_PROJECTS.includes(project), `${project} is not adopted`);
  }
  assert.equal(
    new Set(TESTING_ENTRY_PROJECTS).size,
    TESTING_ENTRY_PROJECTS.length,
    "no duplicate testing entries",
  );
});

test("publishing the application entry point is what the list decides, nothing else", () => {
  const withoutEntry = renderSkeleton(ADOPTED_PROJECTS, []);
  const withEntry = renderSkeleton(ADOPTED_PROJECTS, ["packages/contexts/identity-access"]);
  const manifest = "packages/contexts/identity-access/package.json";

  assert.ok(!withoutEntry.get(manifest).includes("./application/index.js"));
  assert.ok(withEntry.get(manifest).includes('"./application/index.js"'));
  assert.equal(
    withoutEntry.size,
    withEntry.size,
    "publishing a subpath adds no file; it edits one manifest",
  );

  // Every other context manifest is byte-identical either way: the list is a
  // per-project decision and not a global flag.
  for (const path of withEntry.keys()) {
    if (path === manifest) continue;
    assert.equal(withEntry.get(path), withoutEntry.get(path), `${path} must not move`);
  }
});

test("the live adoption registry is a subset of the real projects", () => {
  const known = new Set(projectPaths());
  for (const project of ADOPTED_PROJECTS) assert.ok(known.has(project), `${project} is not a V1 project`);
  assert.equal(new Set(ADOPTED_PROJECTS).size, ADOPTED_PROJECTS.length, "no duplicate adoptions");
});

// ---------------------------------------------------------------------------
// Build artifacts are not source (WIN-256 finding; latent since M1).
// ---------------------------------------------------------------------------

test("gitignored build artifacts are never reported as EXTRA", () => {
  const root = fixture();
  for (const artifact of [
    "packages/kernel/.turbo/turbo-build.log",
    "packages/contexts/tools/.turbo/turbo-build.log",
    "packages/kernel/dist/index.js",
    "packages/kernel/node_modules/x/index.js",
  ]) {
    write(root, artifact, "artifact\n");
  }
  assert.deepEqual(
    checkSkeleton(root),
    [],
    "a plain `turbo run build` must not turn every project into a phantom EXTRA"
  );
});

// ---------------------------------------------------------------------------
// WIN-257 T2: the published entry list must stay HONEST.
//
// `APPLICATION_ENTRY_PROJECTS` is documented as the contexts whose
// `application/index.js` a V1 project actually imports, and until now nothing
// checked that sentence. selfCheck can see that an entry is an adopted context;
// it cannot see whether anything imports the subpath the entry publishes, which
// is the exact dead surface WIN-297 declined to create. This closes the loop
// from the other end by reading the importers.
//
// WIN-258 T5 WIDENED WHAT COUNTS AS AN IMPORTER, and the widening is the point
// rather than an accommodation. Until this tranche the composition root was the
// only V1 project that had ever imported a use-case entry, so "imported" and
// "imported by apps/core-api" were the same set and this test read one file.
// They are not the same set any more: `packages/adapters/postgres-tenancy`
// imports `@platos/context-agents/application/index.js` for the in-memory
// `AgentsRepository` and `ScaffoldingRepository`, because the conformance
// differential runs ONE scenario through the double and through PostgreSQL and
// compares the two observation lists verbatim. That import is a real consumer of
// a real published subpath, so the entry is not dead surface — and the property
// this test exists to keep, that nothing is published which nothing imports, is
// unchanged. What would break it is narrowing the search back to one file and
// deleting the entry, which is why the scan is over every V1 source file.
// ---------------------------------------------------------------------------

const COMPOSITION_ROOT = "apps/core-api/src/app.module.ts";

/** Which contexts a source file imports a use-case entry point from. */
function entryPointsImportedBy(source) {
  const specifier = /from "@platos\/context-([a-z-]+)\/application\/index\.js"/gu;
  const imported = new Set();
  for (const match of source.matchAll(specifier)) imported.add(`packages/contexts/${match[1]}`);
  return imported;
}

/** Every V1 source file that could import one: the composition root and the packages. */
function v1SourceFiles() {
  const files = [join(repositoryRoot, COMPOSITION_ROOT)];
  const roots = ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api/src", "apps/mcp-stdio"];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mts|tsx)$/u.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) walk(join(repositoryRoot, root));
  return files;
}

test("every published application entry point is imported by a V1 project", () => {
  const imported = new Set();
  for (const file of v1SourceFiles()) {
    for (const entry of entryPointsImportedBy(readFileSync(file, "utf8"))) imported.add(entry);
  }

  assert.deepEqual(
    [...imported].sort(),
    [...APPLICATION_ENTRY_PROJECTS].sort(),
    "an entry nobody imports is dead surface, and an import with no entry cannot resolve",
  );

  // The composition root is still an importer, and still the only one for the
  // two WIN-257 entries. Asserted separately so a change that stopped composing
  // them and left the adapter's import standing cannot pass on the union alone.
  const byRoot = entryPointsImportedBy(readFileSync(join(repositoryRoot, COMPOSITION_ROOT), "utf8"));
  assert.deepEqual(
    [...byRoot].sort(),
    ["packages/contexts/identity-access", "packages/contexts/tenancy"],
  );

  // The negative control: the extractor must be able to SEE an absence. A list
  // naming a context nothing imports the entry of has to disagree with the tree.
  assert.notDeepEqual(
    [...imported].sort(),
    [...APPLICATION_ENTRY_PROJECTS, "packages/contexts/memory"].sort(),
  );
  assert.equal(
    entryPointsImportedBy('import { x } from "@platos/context-tenancy";').size,
    0,
    "importing a context's CONTRACTS is not importing its use-case entry point",
  );
});

// ---------------------------------------------------------------------------
// WIN-258 T2 (ADR M0.3 §15) — the adapter table now permits MANY ports per
// DIRECTORY, and these are the refusals that widening did not take with it.
//
// The check is called with a SUPPLIED table rather than by editing the module,
// so each refusal runs in CI on every change instead of once, by hand, in a
// throwaway script.
// ---------------------------------------------------------------------------

const LIVE_ADAPTERS = [
  // WIN-258 T5 added the third binding, `cost-monitoring:BudgetRepository`. The
  // fixture copy has to carry it or the first case below — the non-vacuity
  // anchor every refusal here stands on — is comparing the refusals against a
  // table the tree no longer has.
  { dir: "postgres-tenancy", port: "TenancyRepository", owner: "tenancy",
    additional: [
      { port: "IdentityAccessRepository", owner: "identity-access" },
      // WIN-258 T5. The THIRD binding on the one shared directory.
      { port: "ToolsRepository", owner: "tools" },
      // WIN-258 T5: `agents` publishes TWO canonical-store ports and one
      // directory satisfies both. A copy that stopped short would make every
      // refusal below assert against a table the live one no longer looks like.
      { port: "AgentsRepository", owner: "agents" },
      { port: "ScaffoldingRepository", owner: "agents" },
      // WIN-258 T5. The SIXTH, `cost-monitoring`'s.
      { port: "BudgetRepository", owner: "cost-monitoring" },
      // WIN-258 T5. The SEVENTH, `channels`'.
      { port: "ChannelsRepository", owner: "channels" },
      // WIN-258 T5: `governance` publishes FIVE canonical-store ports and one
      // directory satisfies all five, because five separate rows in the one
      // PostgreSQL database are five repositories behind one client.
      { port: "SafetyLedger", owner: "governance" },
      { port: "RatingsRepository", owner: "governance" },
      { port: "CriteriaRepository", owner: "governance" },
      { port: "EvalsRepository", owner: "governance" },
      { port: "GoldenSetsRepository", owner: "governance" },
      // WIN-258 M2.3. Tenancy's five NON-REPOSITORY driven ports, which now
      // carry binding slots of their own on the directory that already
      // satisfied them. SEVENTEEN bindings on one row.
      { port: "TenancyLocks", owner: "tenancy" },
      { port: "OperatorSessionRevoker", owner: "tenancy" },
      { port: "EnvironmentAccessKeyRevocationCounter", owner: "tenancy" },
      { port: "InvitationTokenIssuer", owner: "tenancy" },
      { port: "OperatorDirectory", owner: "tenancy" },
      // WIN-258 T5. The fixture copy carries `secrets`' two ports for the reason
      // it carries every other row: the mutations below are measured against a
      // table that is otherwise identical to the live one, so a copy missing a
      // binding would make the refusal COUNTS wrong rather than the refusals.
      { port: "SecretsRepository", owner: "secrets" },
      { port: "EnvironmentVariableRepository", owner: "secrets" },
      // WIN-258 T5. The NINTH owner, `providers`', over the four rows of §1
      // row 4. ONE port and not two: the context publishes three, and only this
      // one is a canonical store.
      { port: "ProvidersRepository", owner: "providers" },
    ], note: "n" },
  { dir: "outbox", port: "OutboxWriter", owner: "kernel", note: "n" },
  { dir: "durable-runtime", port: "DurableRuntime", owner: "kernel", note: "n" },
  { dir: "clickhouse-observability", port: "ObservabilitySink", owner: "observability", note: "n" },
  { dir: "objectstore-minio", port: "ObjectStore", owner: "files", note: "n" },
  { dir: "redis-ratelimit", port: "RateLimiter", owner: "identity-access", note: "n" },
  { dir: "redis-cache", port: "Cache", owner: "memory", note: "n" },
  { dir: "redis-streams", port: "EventBus", owner: "kernel", note: "n" },
  { dir: "model-router-providers", port: "ModelRouter", owner: "providers", note: "n" },
  { dir: "channel-slack", port: "ChannelAdapter", owner: "channels", note: "n" },
  { dir: "notifier-email", port: "Notifier", owner: "cost-monitoring", note: "n" },
  { dir: "notifier-webhook", port: "Notifier", owner: "cost-monitoring", note: "n" },
];

test("the live adapter table passes its own check, and the fixture copy of it does too", () => {
  // Non-vacuity for everything below: the mutations are the ONLY reason those
  // cases go red.
  assert.deepEqual(checkAdapterTable(), []);
  assert.deepEqual(checkAdapterTable(LIVE_ADAPTERS), []);
});

test("§15 refusal: a THIRTEENTH adapter directory fails, even though bindings may exceed twelve", () => {
  const errors = checkAdapterTable([
    ...LIVE_ADAPTERS,
    { dir: "notifier-sms", port: "Notifier", owner: "cost-monitoring", note: "n" },
  ]);
  assert.ok(errors.some((error) => error.includes("names 12 concrete adapter directories; ADAPTERS has 13")));
});

test("§15 refusal: a THIRTY-SECOND binding fails, even though a directory may hold more than one", () => {
  const widened = LIVE_ADAPTERS.map((adapter) =>
    adapter.dir === "postgres-tenancy"
      ? { ...adapter, additional: [...adapter.additional, { port: "Cache", owner: "memory" }] }
      : adapter
  );
  const errors = checkAdapterTable(widened);
  assert.ok(errors.some((error) => error.includes("declares 31 adapter bindings; ADAPTERS flattens to 32")));
});

test("§15 refusal: an ADDITIONAL binding's owner is held to the same check as the primary one", () => {
  const invented = LIVE_ADAPTERS.map((adapter) =>
    adapter.dir === "postgres-tenancy"
      ? { ...adapter, additional: [{ port: "IdentityAccessRepository", owner: "auth" }] }
      : adapter
  );
  assert.ok(
    checkAdapterTable(invented).some((error) =>
      error.includes("postgres-tenancy assigns IdentityAccessRepository to unknown owner auth")
    )
  );
});

test("§15 refusal: a port gaining a SECOND home fails unless it is named as multi-home", () => {
  const shared = LIVE_ADAPTERS.map((adapter) =>
    adapter.dir === "redis-cache" ? { ...adapter, port: "EventBus", owner: "kernel" } : adapter
  );
  assert.ok(
    checkAdapterTable(shared).some((error) => error.includes("kernel:EventBus is satisfied by"))
  );
  // And `Notifier`, the one port ADR M0.3 §4 gives two homes, is NOT flagged —
  // the allow-list is what makes this a rule rather than a blanket ban.
  assert.deepEqual(checkAdapterTable(LIVE_ADAPTERS), []);
});

test("§15 refusal: one directory declaring the same port twice fails", () => {
  const doubled = LIVE_ADAPTERS.map((adapter) =>
    adapter.dir === "postgres-tenancy"
      ? { ...adapter, additional: [{ port: "TenancyRepository", owner: "tenancy" }] }
      : adapter
  );
  assert.ok(
    checkAdapterTable(doubled).some((error) =>
      error.includes("postgres-tenancy declares TenancyRepository more than once")
    )
  );
});

test("§15 refusal: the multi-home allow-list must still be earned", () => {
  // `Notifier` with only one home left means the allow-list entry is stale, and
  // a stale exemption is a hole. It fails in that direction too.
  const single = LIVE_ADAPTERS.filter((adapter) => adapter.dir !== "notifier-webhook");
  assert.ok(
    checkAdapterTable(single).some((error) =>
      error.includes("cost-monitoring:Notifier is declared as a multi-home port but has 1 home(s)")
    )
  );
});
