#!/usr/bin/env node
// WIN-268 P3 — what the MCP tool modules reach past their context to touch.
//
// THE PROBLEM THIS EXISTS TO MEASURE. `apps/agent/src/mcp-platform/tools/` holds
// the platform MCP tool implementations, and they talk to PostgreSQL through a
// Prisma client handed in as `prisma: any`. ADR M0.3 §5.2's cutting rule is that
// every canonical row has exactly ONE context permitted to write it;
// `scripts/arch/sole-writer.mjs` enforces that, and its own banner records the
// blind spot this file closes:
//
//     "any write issued outside `packages/contexts` and `packages/adapters`
//      (an app, a script, a migration) is out of scope by construction."
//
// The legacy agent is the largest such write. Until the tool modules reach their
// owning context's published contract, the cutting rule is unenforced exactly
// where it is most violated — so this audit ATTRIBUTES every delegate call in
// those modules to the canonical owner, and states, per call site, which
// published contract method the use case would land on and which of them have
// no method to land on at all.
//
// WHY IT DOES NOT REIMPLEMENT THE MATCHER. `sole-writer.mjs` closed seven ways
// of spelling one Prisma call (direct, element-access, destructured, aliased,
// computed method, and raw DML through both raw APIs) after an independent
// verification found six of seven invisible to an earlier regex. A second
// matcher here would be a second thing to keep sensitive, and it would be the
// weaker of the two. `findWrites` is imported and used as-is; this file adds
// attribution and reporting on top of it, and nothing else.
//
// WHAT IT IS JOINED TO — none of it is this file's to move (ADR M0.3 lesson: an
// assertion comparing two things you control cannot fail):
//
//   * the canonical SCHEMA — `internal-packages/tenancy-database/prisma/schema.prisma`,
//     through `canonicalTables()`;
//   * the OWNERSHIP map — `scripts/arch/table-ownership.mjs`'s `OWNER`, which is
//     ADR M0.3 §1's SOLE WRITER column as data;
//   * each owner's PUBLISHED CONTRACT — every route named below must resolve to
//     a real method on `packages/contexts/<owner>`'s `*Contract` declaration, or
//     this audit fails. A route to a method that does not exist is the failure
//     mode a hand-written map has, and it is refused here rather than shipped;
//   * the COMPOSITION ROOT — whether an owner is composed today is READ from
//     `apps/core-api/src/app.module.ts`'s value imports, never declared here.
//
// Usage:
//   node scripts/arch/mcp-tool-store-reach.mjs            # check (default)
//   node scripts/arch/mcp-tool-store-reach.mjs --write    # (re)write the artifacts
//   node scripts/arch/mcp-tool-store-reach.mjs --json     # machine-readable

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { check as archBoundariesCheck } from "./arch-boundaries.mjs";
import { COMPOSITION_ROOT_FILE } from "./composition-root.mjs";
import { canonicalTables, findWrites } from "./sole-writer.mjs";
import { OWNER } from "./table-ownership.mjs";
import { CONTEXT_NAMES } from "./boundary-rules.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// ── THE TREE THIS AUDIT SPEAKS FOR ──────────────────────────────────────────
//
// PATH CONSTANTS, NOT STRING LITERALS. A fix declared complete after grepping
// one script for a literal broke the build when the next file held the same path
// in a constant. Every consumer — the test suite, the artifacts, the boundary
// ledger below — enumerates from these.

/** The directory WIN-268 P3 is taking off Prisma. */
export const SCAN_ROOT = "apps/agent/src/mcp-platform/tools";

/** Where the composition root decides which contexts exist at run time. */
export const COMPOSITION_ROOT_MODULE = "apps/core-api/src/app.module.ts";

/** The published-contract file every context has, and its fallback. */
export const CONTRACT_ENTRY = "contracts/index.ts";
export const CONTEXT_PACKAGES = "packages/contexts";

/** The legacy app the tool modules live in, and its dependency manifest. */
export const HOST_APP_MANIFEST = "apps/agent/package.json";

export const JSON_ARTIFACT = "docs/audits/win-268-mcp-tool-store-reach.json";
export const MD_ARTIFACT = "docs/audits/win-268-mcp-tool-store-reach.md";

/**
 * THE RATCHET. Measured, then pinned by hand; it may only ever be LOWERED.
 *
 * The artifact check below already fails on any drift between the committed
 * document and a fresh measurement — but the repair for a drift failure is
 * "regenerate", and an agent that regenerates without reading has silently
 * raised a count more than once in this programme. This constant is the second
 * mechanism: it lives in SOURCE, a regeneration does not move it, and a tranche
 * that ADDS a delegate call to these modules fails here with a message saying so
 * even when the artifact is perfectly in sync.
 *
 * 69 = 22 writes + 47 reads, measured on `v1` @ 3b3f1ebb. See the artifact for
 * the per-file split and `mcp-tool-store-reach.test.mjs` for the mutation that
 * proves this line is load-bearing.
 */
export const MAX_DELEGATE_CALLS = 69;

// ── THE BOUNDARY LEDGER ─────────────────────────────────────────────────────
//
// WHY A LEDGER AND NOT A NEW RULE. The acceptance for this tranche is that
// "arch-boundaries refuses a Prisma import from every module you convert". It
// already does: `tenancy-prisma-only` in `scripts/arch/boundary-rules.mjs` names
// `@platos/tenancy-database` and gives it ONE home, and running the real
// enforcer over this directory —
//
//     node scripts/arch/arch-boundaries.mjs --root . --scan-root apps/agent/src/mcp-platform/tools
//
// — refuses five files today. What was missing is not a rule; it is that
// `DEFAULT_SCAN_ROOTS` does not include the legacy agent, so the rule never runs
// here and nothing notices a SIXTH file acquiring the import.
//
// The alternative considered and REJECTED was adding this directory to
// `DEFAULT_SCAN_ROOTS`. That turns `pnpm audit:arch-boundaries` red on the base,
// and the only ways to green it are to convert the five (which this tranche
// cannot: see the artifact's "why the conversion does not land here") or to widen
// `tenancy-prisma-only`'s home to include them — which would weaken a live rule
// to make a new one pass. Neither is acceptable.
//
// So the ledger is a RATCHET on the real enforcer's real output. Every violation
// the rule set finds in this directory is written down, by file and rule. A new
// one is RED. A removed one is RED too, until somebody deletes the line
// deliberately — which is what makes the list SHRINK rather than drift.
// `kind` separates the rows a CONVERSION has to clear from the rows a test
// harness legitimately holds. An integration test that proves what these tools
// do against a real database must construct a real client; counting it beside
// `alert_channels.ts` would say the conversion had four files to go when it has
// four, or six, depending on who is reading. `productionPrismaImports` in the
// totals answers the question the tranche is actually judged on.
export const BOUNDARY_LEDGER = Object.freeze([
  Object.freeze({ rule: "tenancy-prisma-only", file: "alert_channels.ts", violations: 1, kind: "production" }),
  Object.freeze({ rule: "tenancy-prisma-only", file: "index.ts", violations: 1, kind: "production" }),
  Object.freeze({ rule: "tenancy-prisma-only", file: "jobs.ts", violations: 1, kind: "production" }),
  Object.freeze({ rule: "tenancy-prisma-only", file: "platos-control.ts", violations: 1, kind: "production" }),
  Object.freeze({ rule: "tenancy-prisma-only", file: "platos-control.memory.test.ts", violations: 1, kind: "test" }),
  Object.freeze({ rule: "tenancy-prisma-only", file: "end-users-tenancy-postgres.integration.test.ts", violations: 1, kind: "test" }),
  Object.freeze({ rule: "tenancy-prisma-only", file: "macros-replay-postgres.integration.test.ts", violations: 1, kind: "test" }),
  // NOT PRISMA, AND KEPT ANYWAY. The same run refuses five more imports in this
  // directory, and leaving them out would make the ledger a claim about Prisma
  // rather than about this directory's boundary state — so the next tranche
  // would meet them as a surprise instead of as a line item.
  Object.freeze({ rule: "durable-runtime-sdk-only", file: "jobs.ts", violations: 1, kind: "production" }),
  Object.freeze({ rule: "inference-sdk-only", file: "reflection.ts", violations: 4, kind: "production" }),
]);

/** The rows a conversion has to clear: production files still holding the ORM. */
export function productionPrismaImports() {
  return BOUNDARY_LEDGER.filter((entry) => entry.rule === "tenancy-prisma-only" && entry.kind === "production");
}

// WHY THE LEDGER COUNTS RATHER THAN NAMES THE SPECIFIER. `scripts/vocabulary-boundary.mjs`
// reserves the word this repository spells one of those package names with, and
// an artifact carrying the literal would need a line/column-pinned exception
// that the next edit above it invalidates. A count per (rule, file) ratchets
// exactly as tightly — a new import under any rule moves it — and the artifact
// prints the command that names them.

// ── THE ROUTES ──────────────────────────────────────────────────────────────
//
// One row per (model, delegate method) pair this directory actually issues. The
// `route` is the published contract method the use case lands on; `null` means
// THERE IS NO SUCH METHOD, and `missing` names the use case that would have to
// be published for the call site to be converted. That pairing is the whole
// point: "stop at any call site whose use case is not on a contract rather than
// reaching past it — then name the missing use case and its owning context."
//
// A NAMED ROUTE IS CHECKED, NOT TRUSTED. `resolveContractMethods` reads the
// owner package's own `*Contract` declaration and this audit fails if a route
// names a method that is not on it. That is what stops this table from becoming
// a wish list: it can only ever name methods somebody actually published.
const ROUTES = Object.freeze([
  // agents — Macro is the macro recorder's canonical row.
  { model: "Macro", method: "create", route: "stopRecording" },
  { model: "Macro", method: "findMany", route: "listMacros" },
  { model: "Macro", method: "findFirst", route: "describeMacro" },
  { model: "Macro", method: "update", route: "updateMacro" },
  { model: "Macro", method: "delete", route: "removeMacro" },
  // agents — the environment binding of an agent version.
  { model: "AgentBinding", method: "findMany", route: null, missing: "listAgentBindings" },
  { model: "AgentBinding", method: "findFirst", route: null, missing: "describeAgentBinding" },

  // jobs
  { model: "Job", method: "findMany", route: "listJobs" },
  { model: "Job", method: "findFirst", route: "describeJob" },
  { model: "Job", method: "create", route: "registerJob" },
  // `registerJob` is a REGISTRATION, not a patch: the MCP `jobs.update` tool
  // sends a partial and expects the untouched columns to survive, which is a
  // different use case and not a spelling of the same one.
  { model: "Job", method: "update", route: null, missing: "updateJob" },
  { model: "Job", method: "deleteMany", route: null, missing: "removeJob" },

  // cost-monitoring
  { model: "AlertChannel", method: "findMany", route: "listAlertChannels" },
  { model: "AlertChannel", method: "findFirst", route: "describeAlertChannel" },
  { model: "AlertChannel", method: "create", route: "createAlertChannel" },
  { model: "AlertChannel", method: "update", route: "updateAlertChannel" },
  { model: "AlertChannelConfiguration", method: "count", route: null, missing: "countCredentialReferences" },
  { model: "AlertDelivery", method: "create", route: "deliverCrossing" },
  { model: "AlertDelivery", method: "update", route: null, missing: "recordDeliveryRetry" },
  { model: "AlertDelivery", method: "findUniqueOrThrow", route: null, missing: "describeDelivery" },
  { model: "AlertDeliveryRetry", method: "create", route: null, missing: "recordDeliveryRetry" },

  // identity-access — the tier this context is sole writer of.
  { model: "EndUser", method: "findFirst", route: null, missing: "describeEndUser" },
  { model: "EndUserIdentity", method: "findMany", route: null, missing: "listEndUserIdentities" },
  { model: "EndUserIdentity", method: "findFirst", route: null, missing: "findEndUserIdentity" },
  { model: "EndUserIdentity", method: "findUnique", route: null, missing: "findEndUserIdentity" },
  { model: "EndUserIdentity", method: "create", route: null, missing: "linkEndUserIdentity" },
  { model: "EndUserIdentity", method: "update", route: null, missing: "linkEndUserIdentity" },
  { model: "EndUserIdentity", method: "delete", route: null, missing: "unlinkEndUserIdentity" },
  { model: "McpBearerToken", method: "count", route: null, missing: "countMcpBearerTokens" },
  { model: "OAuthClient", method: "findMany", route: null, missing: "listOAuthClients" },
  { model: "OAuthAccessToken", method: "findMany", route: null, missing: "listOAuthAccessTokens" },

  // conversations
  { model: "Turn", method: "findFirst", route: "describeTurn" },
  // An aggregate count + max(updatedAt) for ONE end user. `pageThreads` answers
  // a page, not a tally, and a caller that paged to count would be reading every
  // row of a tenant to render two numbers.
  { model: "Thread", method: "aggregate", route: null, missing: "summariseEndUserThreads" },

  // tenancy
  { model: "Project", method: "findMany", route: "listVisibleProjects" },
  { model: "Entity", method: "findMany", route: "listProjectEntities" },
  { model: "Environment", method: "findMany", route: null, missing: "listProjectEnvironments" },

  // tools
  { model: "EntityMcpConfig", method: "findUnique", route: "describeMcpSurface" },
  { model: "EntityMcpConfig", method: "upsert", route: "configureMcpSurface" },
  { model: "EnvironmentEntityTool", method: "findMany", route: "listEntityToolPolicies" },
  { model: "EnvironmentEntityTool", method: "upsert", route: "setEntityToolPolicy" },
  { model: "Tool", method: "findFirst", route: "findTools" },
  { model: "Tool", method: "create", route: "registerTools" },
  { model: "ToolHealth", method: "findMany", route: null, missing: "readToolHealth" },

  // providers
  { model: "ProviderKey", method: "findMany", route: "listProviderKeys" },

  // governance
  { model: "SafetyEvent", method: "findMany", route: "pageSafetyEvents" },

  // memory
  { model: "Memory", method: "delete", route: "forget" },
]);

// ── measurement ─────────────────────────────────────────────────────────────

/** A test or spec file, by the same shape every other audit in this tree uses. */
export const TEST_FILE = /\.(?:test|spec)\.tsx?$/u;

/**
 * The PRODUCTION sources whose store reach is being measured.
 *
 * TESTS ARE EXCLUDED, and the distinction is load-bearing rather than tidy. This
 * audit answers "what does the tool module reach past its context to touch",
 * and an integration test that seeds two tenants and drives a real client is not
 * the module reaching anywhere — it is the harness that PROVES what the module
 * does. Counting it would make the ratchet punish the act of testing against a
 * real database, which is the thing this programme keeps asking for.
 *
 * The boundary ledger below does NOT make the same exclusion, because it mirrors
 * the real enforcer's output and the enforcer judges every file. Each ledger row
 * carries a `kind` instead, so "how many PRODUCTION files still hold the ORM
 * import" stays answerable.
 */
function listToolSources(root) {
  const directory = join(root, SCAN_ROOT);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !TEST_FILE.test(entry))
    .filter((entry) => statSync(join(directory, entry)).isFile())
    .sort();
}

/**
 * Which contexts the composition root actually BUILDS.
 *
 * Read as a VALUE import from `@platos/context-<name>`, because that is the
 * distinction the composition root itself draws: it imports the contract TYPE of
 * all seventeen and the factory of the four it composes, and a type import
 * disappears at run time. Nothing here is declared; delete a factory import from
 * `app.module.ts` and this answer changes with it.
 */
export function composedContexts(root = repositoryRoot) {
  const path = join(root, COMPOSITION_ROOT_MODULE);
  if (!existsSync(path)) return [];
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const composed = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause?.isTypeOnly !== false) continue;
    const named = statement.importClause.namedBindings;
    // `import type { X }` is caught above; `import { type X }` names no value.
    if (named && ts.isNamedImports(named) && named.elements.every((element) => element.isTypeOnly)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    const match = /^@platos\/context-([a-z-]+)(?:\/|$)/u.exec(specifier.text);
    if (match && CONTEXT_NAMES.includes(match[1])) composed.add(match[1]);
  }
  return [...composed].sort();
}

/**
 * The method names on a context's published `*Contract`.
 *
 * It scans the package rather than only `contracts/index.ts` because the entry
 * point is not always where the declaration lives: `conversations` publishes
 * `export type { ConversationsContract } from "../application/conversations-contract.js"`,
 * and a reader that stopped at the barrel would conclude that context publishes
 * no methods at all — and would then accept any route naming one.
 */
export function resolveContractMethods(context, root = repositoryRoot) {
  const packageDirectory = join(root, CONTEXT_PACKAGES, context);
  if (!existsSync(packageDirectory)) return null;
  const methods = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".turbo", "testing"].includes(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      if (/\.(?:test|spec)\.tsx?$/u.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      const visit = (node) => {
        if (ts.isInterfaceDeclaration(node) && /Contract$/u.test(node.name.text)) {
          for (const member of node.members) {
            if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
              methods.add(member.name.text);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(packageDirectory);
  return methods;
}

/**
 * WHY THE CONVERSION DOES NOT LAND IN THIS TREE — measured, not asserted.
 *
 * The brief for this tranche is "route each call site to its owning context's
 * published contract". The table above says which method each would land on. The
 * two facts below say why none of them can be called from where these modules
 * live, and both are READ from files this audit does not own, so the day either
 * changes the artifact changes with it and this paragraph has to move.
 *
 *   1. `apps/agent` declares no dependency on any `@platos/context-*` package.
 *      A module cannot import a contract its package has not got.
 *   2. `scripts/arch/composition-root.mjs` names ONE file entitled to bind an
 *      adapter to a port, and it is in `apps/core-api`. So `apps/agent` cannot
 *      construct a context either — even for the four call sites whose route
 *      exists AND whose owner is composed today, there is nothing in this
 *      process holding the composed instance.
 *
 * That is the honest boundary of WIN-268 P3, and it is a composition problem
 * rather than a per-call-site one: it is not that these tool modules are hard to
 * convert, it is that the seam they would convert ONTO does not reach them.
 */
export function measureBlockers(root = repositoryRoot) {
  const manifestPath = join(root, HOST_APP_MANIFEST);
  let contextDependencies = [];
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    contextDependencies = Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    })
      .filter((name) => name.startsWith("@platos/context-"))
      .sort();
  }
  return {
    hostApp: HOST_APP_MANIFEST,
    contextDependenciesDeclared: contextDependencies,
    compositionRootFile: COMPOSITION_ROOT_FILE,
    hostAppIsCompositionRoot: COMPOSITION_ROOT_FILE.startsWith("apps/agent/"),
  };
}

/** Every delegate call these modules issue, attributed to its canonical owner. */
export function measure(root = repositoryRoot) {
  const tables = canonicalTables(root);
  const files = [];
  const calls = [];

  for (const name of listToolSources(root)) {
    const virtualPath = `${SCAN_ROOT}/${name}`;
    const text = readFileSync(join(root, SCAN_ROOT, name), "utf8");
    const found = findWrites(virtualPath, text, tables);
    const owned = [
      ...found.writes.map((write) => ({ ...write, kind: "write" })),
      ...found.reads.map((read) => ({ ...read, kind: "read" })),
    ].sort((left, right) => left.line - right.line);
    if (owned.length === 0 && found.unattributable.length === 0) continue;

    const owners = [...new Set(owned.map((call) => OWNER[call.model]))].filter(Boolean).sort();
    files.push({
      file: name,
      writes: found.writes.length,
      reads: found.reads.length,
      unattributable: found.unattributable.length,
      owners,
    });
    for (const call of owned) {
      calls.push({
        file: name,
        line: call.line,
        kind: call.kind,
        model: call.model,
        method: call.method,
        owner: OWNER[call.model] ?? null,
      });
    }
  }

  const composed = composedContexts(root);
  const composedSet = new Set(composed);
  const routeFor = new Map(ROUTES.map((route) => [`${route.model}.${route.method}`, route]));

  const reach = [];
  const seen = new Map();
  for (const call of calls) {
    const key = `${call.model}.${call.method}`;
    const existing = seen.get(key);
    if (existing) {
      existing.callSites += 1;
      continue;
    }
    const route = routeFor.get(key) ?? null;
    const row = {
      model: call.model,
      method: call.method,
      kind: call.kind,
      owner: call.owner,
      composed: call.owner !== null && composedSet.has(call.owner),
      route: route?.route ?? null,
      missing: route?.route ? null : (route?.missing ?? null),
      callSites: 1,
    };
    seen.set(key, row);
    reach.push(row);
  }
  reach.sort((left, right) =>
    left.owner === right.owner
      ? `${left.model}.${left.method}`.localeCompare(`${right.model}.${right.method}`)
      : String(left.owner).localeCompare(String(right.owner)),
  );

  const writes = files.reduce((total, file) => total + file.writes, 0);
  const reads = files.reduce((total, file) => total + file.reads, 0);
  const routed = reach.filter((row) => row.route !== null).reduce((total, row) => total + row.callSites, 0);
  // The number that decides the tranche: a call site is convertible only if the
  // use case is PUBLISHED and its owner is BUILT. Either half missing and there
  // is nothing to call.
  const convertible = reach
    .filter((row) => row.route !== null && row.composed)
    .reduce((total, row) => total + row.callSites, 0);

  return {
    scanRoot: SCAN_ROOT,
    generatedBy: relative(repositoryRoot, fileURLToPath(import.meta.url)).replaceAll("\\", "/"),
    composedContexts: composed,
    totals: {
      files: files.length,
      writes,
      reads,
      delegateCalls: writes + reads,
      unattributable: files.reduce((total, file) => total + file.unattributable, 0),
      owners: [...new Set(files.flatMap((file) => file.owners))].length,
      routableCallSites: routed,
      unroutableCallSites: writes + reads - routed,
      routableOnAComposedOwner: convertible,
      productionPrismaImports: productionPrismaImports().length,
    },
    blockers: measureBlockers(root),
    files,
    reach,
    calls,
  };
}

/**
 * The boundary ledger, verified against the REAL enforcer over this directory.
 *
 * Set equality in BOTH directions. A new violation is a regression; a
 * disappeared one is progress that has to be WRITTEN DOWN, because a ledger that
 * quietly shrinks is a ledger nobody can use to tell progress from a rule that
 * stopped firing.
 */
export function checkBoundaryLedger(root = repositoryRoot) {
  const { violations } = archBoundariesCheck(root, { scanRoots: [SCAN_ROOT] });
  const observed = new Map();
  for (const violation of violations) {
    const file = violation.from.slice(`${SCAN_ROOT}/`.length);
    const key = `${violation.rule} ${file}`;
    observed.set(key, (observed.get(key) ?? 0) + 1);
  }
  const declared = new Map(BOUNDARY_LEDGER.map((entry) => [`${entry.rule} ${entry.file}`, entry]));
  const problems = [];

  for (const [key, count] of observed) {
    const entry = declared.get(key);
    if (entry === undefined) {
      problems.push(`boundary ledger: UNDECLARED [${key.split(" ")[0]}] ${SCAN_ROOT}/${key.split(" ")[1]} (${count})`);
    } else if (entry.violations !== count) {
      problems.push(
        `boundary ledger: [${entry.rule}] ${SCAN_ROOT}/${entry.file} now fires ${count} time(s), ` +
          `the ledger says ${entry.violations}`,
      );
    }
  }
  for (const entry of BOUNDARY_LEDGER) {
    if (!observed.has(`${entry.rule} ${entry.file}`)) {
      problems.push(
        `boundary ledger: [${entry.rule}] ${SCAN_ROOT}/${entry.file} no longer fires; ` +
          "delete the line to record the progress",
      );
    }
    // `kind` decides which rows a conversion still owes, so it is DERIVED from
    // the filename rather than believed. Without this, a production file could
    // be relabelled "test" and drop out of the number the tranche is judged on.
    const expected = TEST_FILE.test(entry.file) ? "test" : "production";
    if (entry.kind !== expected) {
      problems.push(
        `boundary ledger: ${SCAN_ROOT}/${entry.file} is declared "${entry.kind}" and its name says "${expected}"`,
      );
    }
  }
  return problems;
}

// ── validation ──────────────────────────────────────────────────────────────

/** Every route names a method its owner actually publishes. */
export function checkRoutes(root = repositoryRoot) {
  const problems = [];
  const cache = new Map();
  for (const route of ROUTES) {
    const owner = OWNER[route.model];
    if (!owner) {
      problems.push(`route ${route.model}.${route.method}: no canonical owner in table-ownership.mjs`);
      continue;
    }
    if (route.route === null) {
      if (!route.missing) problems.push(`route ${route.model}.${route.method}: unrouted rows must NAME the missing use case`);
      continue;
    }
    if (!cache.has(owner)) cache.set(owner, resolveContractMethods(owner, root));
    const methods = cache.get(owner);
    if (methods === null) {
      problems.push(`route ${route.model}.${route.method}: owner "${owner}" has no package under ${CONTEXT_PACKAGES}/`);
      continue;
    }
    if (!methods.has(route.route)) {
      problems.push(
        `route ${route.model}.${route.method} -> ${owner}.${route.route}(): that method is not on the published contract`,
      );
    }
  }
  return problems;
}

/** Every measured (model, method) pair has a row in ROUTES. */
export function checkRouteCoverage(measurement) {
  const declared = new Set(ROUTES.map((route) => `${route.model}.${route.method}`));
  return measurement.reach
    .filter((row) => !declared.has(`${row.model}.${row.method}`))
    .map((row) => `${row.model}.${row.method} (${row.owner}) is reached ${row.callSites}x and has no ROUTES row`);
}

export function renderMarkdown(measurement) {
  const lines = [];
  lines.push("# WIN-268 P3 — MCP tool modules: what they reach past their context to touch");
  lines.push("");
  lines.push("<!-- GENERATED by scripts/arch/mcp-tool-store-reach.mjs — do not edit by hand. -->");
  lines.push("");
  lines.push(
    `Every Prisma delegate call under \`${measurement.scanRoot}\`, attributed to the context ADR M0.3 §1`,
    "names as its SOLE WRITER, with the published contract method the use case would land on.",
    "The matcher is `scripts/arch/sole-writer.mjs`'s, unchanged; the ownership is",
    "`scripts/arch/table-ownership.mjs`'s; the composed set is read from the composition root.",
  );
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(`- files holding a delegate call: **${measurement.totals.files}**`);
  lines.push(`- writes: **${measurement.totals.writes}**`);
  lines.push(`- reads: **${measurement.totals.reads}**`);
  lines.push(`- delegate calls: **${measurement.totals.delegateCalls}**`);
  lines.push(`- distinct owning contexts reached: **${measurement.totals.owners}**`);
  lines.push(`- call sites with a published contract method: **${measurement.totals.routableCallSites}**`);
  lines.push(`- call sites with none: **${measurement.totals.unroutableCallSites}**`);
  lines.push(`- call sites whose route exists AND whose owner is composed: **${measurement.totals.routableOnAComposedOwner}**`);
  lines.push(`- unattributable calls: **${measurement.totals.unattributable}**`);
  lines.push(
    `- PRODUCTION files still importing the ORM: **${measurement.totals.productionPrismaImports}**` +
      " (the rows a conversion has to clear; test harnesses are counted separately in the ledger)",
  );
  lines.push("");
  lines.push(`Contexts composed at the root today: ${measurement.composedContexts.map((name) => `\`${name}\``).join(", ")}.`);
  lines.push("");
  lines.push("## Why the conversion does not land here");
  lines.push("");
  lines.push("Two facts, both read off the tree rather than asserted:");
  lines.push("");
  lines.push(
    `1. \`${measurement.blockers.hostApp}\` declares ` +
      (measurement.blockers.contextDependenciesDeclared.length === 0
        ? "**no** `@platos/context-*` dependency"
        : `these context dependencies: ${measurement.blockers.contextDependenciesDeclared.map((name) => `\`${name}\``).join(", ")}`) +
      ". A module cannot import a contract its package has not got.",
  );
  lines.push(
    `2. \`scripts/arch/composition-root.mjs\` names \`${measurement.blockers.compositionRootFile}\` as the ONE file` +
      " entitled to bind an adapter to a port, and it is " +
      (measurement.blockers.hostAppIsCompositionRoot ? "inside" : "**not** inside") +
      " the host app. So the host app cannot construct a context either.",
  );
  lines.push("");
  lines.push(
    `Together those put the reachable work at **${measurement.totals.routableOnAComposedOwner}** call site(s) ` +
      "if the seam existed, and at **0** until it does. WIN-268 P3 is therefore a composition problem before " +
      "it is a per-call-site one.",
  );
  lines.push("");
  lines.push("## By file");
  lines.push("");
  lines.push("| file | writes | reads | owners reached |");
  lines.push("| --- | ---: | ---: | --- |");
  for (const file of measurement.files) {
    lines.push(`| \`${file.file}\` | ${file.writes} | ${file.reads} | ${file.owners.join(", ")} |`);
  }
  lines.push("");
  lines.push("## By canonical row");
  lines.push("");
  lines.push("`route` is a method on the owner's published contract. `missing` names the use case");
  lines.push("that would have to be published before the call site can be converted.");
  lines.push("");
  lines.push("| owner | composed | row | delegate | call sites | route | missing use case |");
  lines.push("| --- | :---: | --- | --- | ---: | --- | --- |");
  for (const row of measurement.reach) {
    lines.push(
      `| ${row.owner} | ${row.composed ? "yes" : "no"} | \`${row.model}\` | \`${row.method}\` | ${row.callSites} | ` +
        `${row.route ? `\`${row.route}()\`` : "—"} | ${row.missing ? `\`${row.missing}()\`` : "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Boundary ledger");
  lines.push("");
  lines.push("What the real enforcer reports for this directory:");
  lines.push("");
  lines.push("```");
  lines.push(`node scripts/arch/arch-boundaries.mjs --root . --scan-root ${measurement.scanRoot}`);
  lines.push("```");
  lines.push("");
  lines.push("| rule | file | violations | kind |");
  lines.push("| --- | --- | ---: | --- |");
  for (const entry of BOUNDARY_LEDGER) {
    lines.push(`| \`${entry.rule}\` | \`${entry.file}\` | ${entry.violations} | ${entry.kind} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function artifactPayload(measurement) {
  return {
    ...measurement,
    boundaryLedger: BOUNDARY_LEDGER,
    maxDelegateCalls: MAX_DELEGATE_CALLS,
  };
}

export function check(root = repositoryRoot) {
  const measurement = measure(root);
  const problems = [...checkRoutes(root), ...checkRouteCoverage(measurement), ...checkBoundaryLedger(root)];

  if (measurement.totals.delegateCalls > MAX_DELEGATE_CALLS) {
    problems.push(
      `${measurement.totals.delegateCalls} delegate calls under ${SCAN_ROOT}, above the pinned ceiling of ` +
        `${MAX_DELEGATE_CALLS}. This tranche takes call sites OUT; MAX_DELEGATE_CALLS may only be lowered.`,
    );
  }

  const jsonPath = join(root, JSON_ARTIFACT);
  const expected = `${JSON.stringify(artifactPayload(measurement), null, 2)}\n`;
  if (!existsSync(jsonPath)) {
    problems.push(`${JSON_ARTIFACT} is missing; run \`node scripts/arch/mcp-tool-store-reach.mjs --write\``);
  } else if (readFileSync(jsonPath, "utf8") !== expected) {
    problems.push(`${JSON_ARTIFACT} does not match a fresh measurement; regenerate it and read the diff`);
  }

  const mdPath = join(root, MD_ARTIFACT);
  const expectedMarkdown = renderMarkdown(measurement);
  if (!existsSync(mdPath)) {
    problems.push(`${MD_ARTIFACT} is missing; run \`node scripts/arch/mcp-tool-store-reach.mjs --write\``);
  } else if (readFileSync(mdPath, "utf8") !== expectedMarkdown) {
    problems.push(`${MD_ARTIFACT} does not match a fresh measurement; regenerate it and read the diff`);
  }

  return { measurement, problems };
}

export function write(root = repositoryRoot) {
  const measurement = measure(root);
  writeFileSync(join(root, JSON_ARTIFACT), `${JSON.stringify(artifactPayload(measurement), null, 2)}\n`);
  writeFileSync(join(root, MD_ARTIFACT), renderMarkdown(measurement));
  return measurement;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes("--write")) {
    const measurement = write();
    process.stdout.write(
      `mcp-tool-store-reach: wrote ${JSON_ARTIFACT} and ${MD_ARTIFACT} ` +
        `(${measurement.totals.delegateCalls} delegate calls in ${measurement.totals.files} file(s))\n`,
    );
  } else {
    const result = check();
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `mcp-tool-store-reach: ${result.measurement.totals.delegateCalls} delegate call(s) ` +
          `(${result.measurement.totals.writes} write, ${result.measurement.totals.reads} read) in ` +
          `${result.measurement.totals.files} file(s) under ${SCAN_ROOT}; ` +
          `${result.measurement.totals.unroutableCallSites} have no published contract method\n`,
      );
      for (const problem of result.problems) process.stdout.write(`FAIL ${problem}\n`);
    }
    process.exit(result.problems.length === 0 ? 0 : 1);
  }
}
