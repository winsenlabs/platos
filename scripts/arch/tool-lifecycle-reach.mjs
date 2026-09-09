#!/usr/bin/env node
// WIN-269 (M4.3) — THE TOOL LIFECYCLE'S ORM REGISTER, AND THE COMPOSITION GAP
// THAT HOLDS IT.
//
// M4.3 refactors entities and the tool lifecycle — sync, discovery, registry,
// execution — and the external MCP adapters onto V1 use cases. WIN-268 built the
// same instrument for the MCP SURFACE (`apps/agent/src/mcp-platform`,
// `mcp-docs`, `apps/mcp-stdio`). This one measures the MACHINERY UNDERNEATH it:
// `apps/agent/src/tool-gateway`, which no register has ever scanned.
//
// THE TWO REGISTERS MUST NOT OVERLAP, AND THAT IS CHECKED RATHER THAN INTENDED.
// `assertDisjointRoots` below imports WIN-268's `SURFACE_ROOTS` and fails when
// any root of either register is a prefix of a root of the other. Two registers
// that could both claim a file would be two numbers to keep in agreement, and
// the day somebody widens one of the lists this fails instead of silently
// double-counting.
//
// THE SCANNER IS NOT RE-IMPLEMENTED. `sitesIn`, `schemaModels`, `delegateFor`,
// `composedContexts` and `contractMethods` are imported from
// `mcp-store-ownership.mjs`. A second AST walker would be a second definition of
// "what counts as a store reach", and the first thing that would go wrong is
// that the two registers would disagree about `$transaction`.
//
// WHAT IS DERIVED HERE AND FROM WHAT — five artifacts, none of them this file's:
//
//   1. the Prisma schema, for the delegate names (via `schemaModels`).
//   2. `scripts/arch/table-ownership.mjs`, for model -> owning context.
//   3. `apps/core-api/src/app.module.ts`, for what the root ACTUALLY composes.
//   4. `packages/contexts/<context>/contracts/index.ts`, for published methods.
//   5. `packages/contexts/tools/application/dependencies.ts`, for the SLOTS a
//      composed `tools` needs — the thing WIN-268 could name but not measure.
//      Every slot is classified against the composition root, so "compose
//      `tools`" stops being a plan and becomes a list of what is missing.
//
// THE DISPOSITIONS CARRY A JOIN THE VERDICTS CANNOT. A verdict says which of
// four structural states a site is in. A disposition names the CONTRACT METHOD
// that is the published form of the file — and every method it names is checked
// against the AST-read contract, so a disposition cannot name a method that does
// not exist and cannot go stale when one is renamed.
//
//   node scripts/arch/tool-lifecycle-reach.mjs            # human report
//   node scripts/arch/tool-lifecycle-reach.mjs --json     # machine-readable
//   node scripts/arch/tool-lifecycle-reach.mjs --write    # regenerate evidence
//   node scripts/arch/tool-lifecycle-reach.mjs --check    # fail on drift

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { OWNER } from "./table-ownership.mjs";
import {
  SURFACE_ROOTS as MCP_SURFACE_ROOTS,
  composedContexts,
  contextKey,
  contractMethods,
  delegateFor,
  schemaModels,
  sitesIn,
} from "./mcp-store-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const MANIFEST = "docs/audits/win-269-tool-lifecycle-reach.json";
export const REPORT = "docs/audits/win-269-tool-lifecycle-reach.md";

/**
 * THE TOOL LIFECYCLE, AS PATHS AND NOT AS A GREP.
 *
 * `apps/agent/src/tool-gateway` is the whole of WIN-269's machinery: the
 * registry (`tool-registry.service.ts`), the sync socket
 * (`tool-sync-ws.service.ts`), routing (`tool-router.service.ts`), execution
 * (`tool-executor.service.ts`) and the external MCP adapters
 * (`mcp-transport/`).
 *
 * `apps/core-api/src/transports/tools` is the DESTINATION and holds nothing
 * today. It is listed for the reason WIN-268 lists its own: a register that
 * scanned only the origin could not notice the day a moved module arrived still
 * carrying a client.
 *
 * WHAT IS DELIBERATELY NOT HERE. `apps/agent/src/agent-runtime/` serves
 * `GET /api/v1/agent/entities` and the `/api/v1/agent/tools/*` family, and
 * WIN-261 (M3.1) owns that controller and its service. Scanning it here would
 * put two tranches' sites in one register and make each one's count depend on
 * the other's progress.
 */
export const LIFECYCLE_ROOTS = Object.freeze([
  "apps/agent/src/tool-gateway",
  "apps/core-api/src/transports/tools",
]);

/**
 * The boundary this register does not cross, named so the omission is a
 * DECISION rather than an oversight, and read back by the test.
 */
export const FOREIGN_OWNERSHIP = Object.freeze([
  {
    root: "apps/agent/src/agent-runtime",
    owner: "WIN-261 (M3.1)",
    reason:
      "AgentController and AgentService serve the entity and tool REST families; M3.1 owns their decomposition and this register would otherwise count its sites twice over two tranches.",
  },
]);

/** The context whose composition unblocks this surface. Checked, never assumed. */
export const SUBJECT_CONTEXT = "tools";

/** Where that context declares the bundle a composition root must fill. */
export const DEPENDENCY_DECLARATION = "packages/contexts/tools/application/dependencies.ts";

/** The interface inside it that names the slots. */
export const DEPENDENCY_INTERFACE = "ToolsDependencies";

/**
 * How each slot of `ToolsDependencies` is satisfied, and by what KIND of thing.
 *
 * REQUIRED FOR EVERY SLOT THE DECLARATION NAMES, and the declaration is read by
 * AST — so a slot added to the context appears here as a hard failure rather
 * than as a silently unclassified one. This is the half WIN-268 could not
 * compute: it could say "compose `tools` and 35 sites move" and could not say
 * what composing it would take.
 *
 * `kind` is one of:
 *   `peer`            another context, which this root must already compose
 *   `adapter`         a row of ADAPTER_BINDINGS
 *   `kernel`          a port the process itself holds
 *   `domain-default`  a published value of the context's own domain
 *   `root-satisfied`  built in the composition root, with no adapter directory
 *   `unsatisfied`     nothing in this tree implements it
 */
export const DEPENDENCY_SLOTS = Object.freeze({
  repository: {
    kind: "adapter",
    source: "postgres-tenancy:ToolsRepository",
    note: "a declared, satisfied binding with its own conformance differential in packages/adapters/postgres-tenancy/src/tools-conformance.integration.test.ts.",
  },
  dispatch: {
    kind: "root-satisfied",
    source: "packages/contexts/tools/adapters",
    note: "the ToolDispatch port, and the ONLY unimplemented thing between this tree and a composed `tools`. ADR M0.3 §5.1 rule (h) (`SDK_CONTAINMENT.mcp-sdk-only-in-tools`) binds `@modelcontextprotocol/*` to `^packages/contexts/tools/(adapters|transport)/` and to nowhere else, so this port cannot be a `packages/adapters/` directory and cannot be a binding row; it is built in the composition root from the factory that home publishes, the way `Judge` is. FOUR CONCRETE STEPS, each measured rather than guessed: (1) the directory does not exist; (2) `gen-v1-skeleton.mjs` OWNS every context package.json `exports` map — it emits `.`, `./application/ports/index.js` and two conditional subpaths — so `./adapters/index.js` needs a THIRD list there beside APPLICATION_ENTRY_PROJECTS and TESTING_ENTRY_PROJECTS, with its own honesty check; (3) the same generator owns runtime dependencies through ADAPTER_RUNTIME_DEPENDENCIES, which is keyed on `packages/adapters/` directories and has no row shape for a context's own adapter, so `@modelcontextprotocol/sdk` has nowhere to be declared yet; (4) `apps/core-api` may import it — `firesCrossContextContractsOnly` requires the FROM side to be a context and an app is not one — so no boundary rule needs changing. WIN-269 landed the prerequisite instead: `DispatchTarget` now names its `transport`, without which the port is not implementable at all.",
  },
  digest: {
    kind: "root-satisfied",
    source: "packages/contexts/tools/adapters",
    note: "the ContentDigest port — lowercase hex SHA-256 over node:crypto, and the cheap half of the pair. `apps/core-api/src/composition/adapter-bindings.ts` states outright that ContentDigest is `a synchronous host hash with no failure channel and no row`, so it is satisfied where the dispatch is rather than by a binding, and `GOVERNANCE_ROOT_SATISFIED_PORTS = [\"Judge\"]` is the precedent for a port the composition root fills itself. It needs no SDK and no new list; it is only here because it shares a home with the dispatch.",
  },
  clock: { kind: "kernel", source: "kernel", note: "the process clock." },
  ids: { kind: "kernel", source: "kernel", note: "the process id generator." },
  unitOfWork: {
    kind: "adapter",
    source: "postgres-tenancy:UnitOfWork",
    note: "the same unit of work `secrets` and `providers` are already composed over.",
  },
  policy: {
    kind: "domain-default",
    source: "DEFAULT_TOOLS_POLICY",
    note: "published from the context's own `.` entry point beside DEFAULT_PROVIDERS_POLICY, which this root already takes.",
  },
  tenancy: { kind: "peer", source: "tenancy", note: "composed." },
  identityAccess: { kind: "peer", source: "identity-access", note: "composed." },
  secrets: { kind: "peer", source: "secrets", note: "composed." },
  providers: { kind: "peer", source: "providers", note: "composed." },
});

/**
 * The four verdicts, in the order a site becomes movable.
 *
 * The vocabulary is WIN-268's on purpose: two registers over one tree that
 * classified sites differently would need a translation table before their
 * counts could be added.
 */
export const VERDICTS = Object.freeze({
  moved: "MOVED — the site is already inside apps/core-api/src/transports and reaches a contract",
  blockedOnContext:
    "BLOCKED-ON-CONTEXT — the owning context publishes a contract that the composition root does not compose, so no transport can reach it",
  blockedOnContract:
    "BLOCKED-ON-CONTRACT — the owning context IS composed, and publishes no method for this use case",
  blockedOnAdapter:
    "BLOCKED-ON-ADAPTER — the row is written by the kernel outbox adapter, not by a context",
});

/**
 * WHY EACH FILE'S SITES ARE STILL WHERE THEY ARE — one entry per file, REQUIRED.
 *
 * `waitingOn` is one of `context-composition`, `contract-method`,
 * `transport-move`.
 *
 * `methods` NAMES THE PUBLISHED FORM OF THE FILE, and is the join a verdict
 * cannot make. Every entry is checked against the contract read by AST from
 * `packages/contexts/<owner>/contracts/index.ts`: a method that is not published
 * is a hard failure, so this column cannot describe a contract that does not
 * exist and cannot survive a rename.
 */
export const DISPOSITIONS = Object.freeze({
  "apps/agent/src/tool-gateway/tool-registry.service.ts": {
    contexts: ["tools", "tenancy", "agents", "<client-level>"],
    waitingOn: "context-composition",
    methods: { tools: ["registerTools", "listTools", "setToolEnabled", "findTools"] },
    note: "The registry IS `ToolsContract.registerTools` plus its readers. `packages/contexts/tools/application/register-tools.ts` is the published form of the idempotent-replace write, including the prune, and `read-tools.ts` of the two listings. Its `Entity`/`Environment` scope reads are `tenancy.findEntity` and the environment half of the same pair check; the `AgentBinding` fan-out that decides which agents see a tool is `agents`', which is not composed. Blocked on composing `tools`.",
  },
  "apps/agent/src/tool-gateway/tool-executor.service.ts": {
    contexts: ["tools", "tenancy", "secrets", "identity-access"],
    waitingOn: "context-composition",
    methods: { tools: ["executeTool", "resolvePermission"] },
    note: "`ToolsContract.executeTool` is this file, and `application/execute-tool.ts` plus `resolve-transport.ts` are the published form of its route resolution, credential substitution and health fold. The `Credential` read is `secrets`' — reached through the vault authorization `ExecuteToolCommand` already carries — and the `McpOidcSession` read is `identity-access`', which publishes no lookup of one. Blocked on composing `tools`.",
  },
  "apps/agent/src/tool-gateway/tool-sync-ws.service.ts": {
    contexts: ["tenancy", "secrets", "tools"],
    waitingOn: "context-composition",
    methods: { tools: ["registerTools"] },
    note: "The `/tools/sync` socket authenticates a wire backend and pushes its declaration into the same `registerTools` write discovery uses, so its registration half is already published. What is NOT published is the socket's own lifecycle: `Entity.connectionStatus` is a liveness fact `tenancy` owns the row for and publishes no writer of, and the `ToolHealth` upsert is `tools`'. Blocked on composing `tools`; the connection-status write needs a `tenancy` method that does not exist.",
  },
  "apps/agent/src/tool-gateway/mcp-transport/entity-mcp-discovery.service.ts": {
    contexts: ["tools", "tenancy"],
    waitingOn: "context-composition",
    methods: { tools: ["discoverEntityTools"] },
    note: "`ToolsContract.discoverEntityTools` is this file exactly — same fan-out over the project's environments, same convergence on `registerTools`, same stamp onto the client row. `application/discover-entity-tools.ts`'s own header states the `Entity`-is-project-scoped/`EnvironmentEntityTool`-is-environment-scoped rule this service implements by hand. Blocked on composing `tools`.",
  },
  "apps/agent/src/tool-gateway/mcp-transport/entity-mcp-discovery-scheduler.service.ts": {
    contexts: ["tools"],
    waitingOn: "context-composition",
    methods: { tools: ["discoverEntityTools"] },
    note: "One `EntityMcpClient.findMany` that selects the stale clients a sweep should re-discover. The sweep ITSELF is `discoverEntityTools` per entity; the selection is not published by `ToolsContract` at all, and a scheduler is a runtime concern rather than a transport, so this file is the one in this root whose destination is a durable job rather than a route.",
  },
});

/** Files under the lifecycle roots, excluding tests. */
export function lifecycleFiles(root = repositoryRoot) {
  const found = [];
  for (const lifecycleRoot of LIFECYCLE_ROOTS) {
    const absolute = join(root, lifecycleRoot);
    let entries;
    try {
      entries = statSync(absolute);
    } catch {
      continue;
    }
    if (!entries.isDirectory()) continue;
    walk(absolute, root, found);
  }
  return found.sort();
}

function walk(absolute, root, found) {
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) {
      walk(child, root, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.includes(".test.")) continue;
    found.push(relative(root, child).split("\\").join("/"));
  }
}

/**
 * The two registers may not claim the same file.
 *
 * Prefix-wise in BOTH directions, because widening either list is how the
 * overlap would arrive: WIN-268 adding `apps/agent/src` would swallow this one,
 * and this one adding `apps/agent` would swallow that.
 */
export function assertDisjointRoots(
  mine = LIFECYCLE_ROOTS,
  theirs = MCP_SURFACE_ROOTS,
) {
  const clashes = [];
  for (const a of mine) {
    for (const b of theirs) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        clashes.push(`${a} overlaps ${b}`);
      }
    }
  }
  return clashes;
}

/** The slots `ToolsDependencies` declares, read from the declaration by AST. */
export function declaredSlots(root = repositoryRoot) {
  const path = join(root, DEPENDENCY_DECLARATION);
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(DEPENDENCY_DECLARATION, text, ts.ScriptTarget.ES2022, true);
  const slots = [];
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === DEPENDENCY_INTERFACE) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
          slots.push(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (slots.length === 0) {
    throw new Error(`no members parsed from ${DEPENDENCY_INTERFACE} in ${DEPENDENCY_DECLARATION}`);
  }
  return slots;
}

/**
 * IS THIS OWNER COMPOSED? — asked in the composition root's OWN vocabulary.
 *
 * `table-ownership.mjs` names a context by its DIRECTORY (`identity-access`) and
 * `ComposedContexts` names it by its PROPERTY (`identityAccess`). Comparing the
 * two directly is a join that silently never matches for the four hyphenated
 * contexts, and the first symptom is a composed context reported as
 * `blockedOnContext` — which is a wrong answer that looks like a right one.
 * `contextKey` is the translation the sibling register already publishes.
 */
function isComposed(owner, composed) {
  return composed.has(contextKey(owner));
}

function verdictFor(site, owner, composed) {
  if (site.file.startsWith("apps/core-api/src/transports/")) return "moved";
  if (owner === "<client-level>") return "blockedOnContract";
  return isComposed(owner, composed) ? "blockedOnContract" : "blockedOnContext";
}

export function buildRegister(root = repositoryRoot) {
  const rootClashes = assertDisjointRoots();
  if (rootClashes.length > 0) {
    throw new Error(`the two ORM registers claim overlapping roots: ${rootClashes.join("; ")}`);
  }

  const delegates = new Map(schemaModels(root).map((model) => [delegateFor(model), model]));
  const composed = new Set(composedContexts(root));
  const files = lifecycleFiles(root);

  const sites = [];
  const perFile = new Map();
  for (const file of files) {
    for (const site of sitesIn(file, delegates, root)) {
      const owner = site.model === null ? "<client-level>" : OWNER[site.model];
      if (owner === undefined) {
        throw new Error(
          `${site.model} has no owner in table-ownership.mjs; the schema and the ownership table have drifted`,
        );
      }
      const row = { ...site, owner, verdict: verdictFor(site, owner, composed) };
      sites.push(row);
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
  }

  // Every file holding a site needs a disposition, and every disposition needs a
  // file: an entry for a file that no longer reaches a store is a permission
  // nobody is watching.
  const problems = [];
  for (const file of perFile.keys()) {
    if (DISPOSITIONS[file] === undefined) problems.push(`${file} holds ORM sites and has no disposition`);
  }
  for (const file of Object.keys(DISPOSITIONS)) {
    if (!perFile.has(file)) problems.push(`${file} has a disposition and holds no ORM site`);
  }

  // THE JOIN. Every method a disposition names must be published by the contract
  // it names it on, read from that context's own contracts/index.ts.
  const methodsByContext = new Map();
  for (const [file, disposition] of Object.entries(DISPOSITIONS)) {
    for (const [context, methods] of Object.entries(disposition.methods ?? {})) {
      if (!methodsByContext.has(context)) {
        methodsByContext.set(context, new Set(contractMethods(context, root)));
      }
      const published = methodsByContext.get(context);
      for (const method of methods) {
        if (!published.has(method)) {
          problems.push(
            `${file} names ${context}.${method}, which that context's contract does not publish`,
          );
        }
      }
      if (!disposition.contexts.includes(context)) {
        problems.push(`${file} names methods on ${context}, which is not among its owning contexts`);
      }
    }
  }

  // The composition gap, per slot, against the declaration read by AST.
  const slots = declaredSlots(root);
  const dependency = [];
  for (const slot of slots) {
    const entry = DEPENDENCY_SLOTS[slot];
    if (entry === undefined) {
      problems.push(`${DEPENDENCY_INTERFACE} declares ${slot}, which DEPENDENCY_SLOTS does not classify`);
      continue;
    }
    dependency.push({
      slot,
      ...entry,
      ...(entry.kind === "peer" ? { composed: isComposed(entry.source, composed) } : {}),
    });
  }
  for (const slot of Object.keys(DEPENDENCY_SLOTS)) {
    if (!slots.includes(slot)) {
      problems.push(`DEPENDENCY_SLOTS classifies ${slot}, which ${DEPENDENCY_INTERFACE} does not declare`);
    }
  }

  const byOwner = {};
  const byVerdict = {};
  for (const site of sites) {
    byOwner[site.owner] = (byOwner[site.owner] ?? 0) + 1;
    byVerdict[site.verdict] = (byVerdict[site.verdict] ?? 0) + 1;
  }

  const unblockedByComposing = isComposed(SUBJECT_CONTEXT, composed)
    ? 0
    : sites.filter((site) => site.owner === SUBJECT_CONTEXT).length;

  return {
    roots: [...LIFECYCLE_ROOTS],
    foreignOwnership: FOREIGN_OWNERSHIP.map((entry) => ({ ...entry })),
    subjectContext: SUBJECT_CONTEXT,
    subjectComposed: isComposed(SUBJECT_CONTEXT, composed),
    composedContexts: [...composed].sort(),
    files: files.length,
    filesWithSites: perFile.size,
    totalSites: sites.length,
    delegateSites: sites.filter((site) => site.shape === "delegate").length,
    clientSites: sites.filter((site) => site.shape === "client").length,
    byOwner,
    byVerdict,
    unblockedByComposingSubject: unblockedByComposing,
    dependency,
    dispositions: Object.fromEntries(
      Object.entries(DISPOSITIONS).map(([file, disposition]) => [
        file,
        { ...disposition, sites: perFile.get(file) ?? 0 },
      ]),
    ),
    sites: sites.map((site) => ({
      file: site.file,
      line: site.line,
      shape: site.shape,
      model: site.model,
      operation: site.operation,
      owner: site.owner,
      verdict: site.verdict,
    })),
    problems,
  };
}

function renderReport(register) {
  const lines = [];
  lines.push("# WIN-269 (M4.3) — the tool lifecycle's ORM register");
  lines.push("");
  lines.push(
    "Generated by `scripts/arch/tool-lifecycle-reach.mjs`. Do not edit by hand: `pnpm audit:tool-lifecycle-reach` regenerates it and `--check` fails when the tree and this file disagree.",
  );
  lines.push("");
  lines.push(
    `**${register.totalSites} ORM call sites** across ${register.filesWithSites} of ${register.files} non-test files under ${register.roots.map((root) => `\`${root}\``).join(" and ")} — ${register.delegateSites} model-delegate calls and ${register.clientSites} client-level reaches.`,
  );
  lines.push("");
  lines.push(
    "This register is DISJOINT from WIN-268's by construction: `assertDisjointRoots` compares both root lists prefix-wise in both directions and the build fails on any overlap, so the two counts may be added.",
  );
  lines.push("");

  lines.push("## Verdicts");
  lines.push("");
  lines.push("| verdict | sites | meaning |");
  lines.push("| --- | ---: | --- |");
  for (const [verdict, meaning] of Object.entries(VERDICTS)) {
    const count = register.byVerdict[verdict] ?? 0;
    lines.push(`| \`${verdict}\` | ${count} | ${meaning} |`);
  }
  lines.push("");

  lines.push("## Ownership split");
  lines.push("");
  lines.push("| owning context | sites | composed |");
  lines.push("| --- | ---: | --- |");
  const owners = Object.entries(register.byOwner).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [owner, count] of owners) {
    const composed =
      owner === "<client-level>"
        ? "n/a"
        : register.composedContexts.includes(contextKey(owner))
          ? "yes"
          : "**no**";
    lines.push(`| \`${owner}\` | ${count} | ${composed} |`);
  }
  lines.push("");

  lines.push(`## What composing \`${register.subjectContext}\` would take, slot by slot`);
  lines.push("");
  lines.push(
    `\`${DEPENDENCY_INTERFACE}\` is read from \`${DEPENDENCY_DECLARATION}\` by AST, so a slot added to the context appears here as a failure rather than as an omission. ${register.subjectComposed ? "The context IS composed." : `The context is NOT composed; composing it makes ${register.unblockedByComposingSubject} of the ${register.totalSites} sites below reachable from a transport, on top of the 35 WIN-268 measured on the MCP surface.`}`,
  );
  lines.push("");
  lines.push("| slot | kind | satisfied by | note |");
  lines.push("| --- | --- | --- | --- |");
  for (const slot of register.dependency) {
    const source = slot.kind === "peer" ? `${slot.source} (${slot.composed ? "composed" : "**not composed**"})` : slot.source;
    lines.push(`| \`${slot.slot}\` | \`${slot.kind}\` | \`${source}\` | ${slot.note} |`);
  }
  lines.push("");

  lines.push("## What each file is waiting on");
  lines.push("");
  lines.push("| file | sites | owning contexts | waiting on | published form | what is missing |");
  lines.push("| --- | ---: | --- | --- | --- | --- |");
  for (const [file, disposition] of Object.entries(register.dispositions)) {
    const methods = Object.entries(disposition.methods ?? {})
      .map(([context, names]) => names.map((name) => `\`${context}.${name}\``).join(", "))
      .join("; ");
    lines.push(
      `| \`${file}\` | ${disposition.sites} | ${disposition.contexts.map((context) => `\`${context}\``).join(", ")} | \`${disposition.waitingOn}\` | ${methods === "" ? "—" : methods} | ${disposition.note} |`,
    );
  }
  lines.push("");

  lines.push("## The boundary this register does not cross");
  lines.push("");
  lines.push("| root | owner | why |");
  lines.push("| --- | --- | --- |");
  for (const entry of register.foreignOwnership) {
    lines.push(`| \`${entry.root}\` | ${entry.owner} | ${entry.reason} |`);
  }
  lines.push("");

  lines.push("## Every site");
  lines.push("");
  lines.push("| file:line | shape | row | operation | owner | verdict |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const site of register.sites) {
    lines.push(
      `| \`${site.file}:${site.line}\` | ${site.shape} | ${site.model === null ? "—" : `\`${site.model}\``} | \`${site.operation}\` | \`${site.owner}\` | \`${site.verdict}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const register = buildRegister();

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(register, null, 2)}\n`);
    process.exit(register.problems.length === 0 ? 0 : 1);
  }

  const manifest = `${JSON.stringify(register, null, 2)}\n`;
  const report = `${renderReport(register)}`;

  if (argv.includes("--write")) {
    writeFileSync(join(repositoryRoot, MANIFEST), manifest);
    writeFileSync(join(repositoryRoot, REPORT), report);
    process.stdout.write(`wrote ${MANIFEST} and ${REPORT}\n`);
    for (const problem of register.problems) process.stdout.write(`  problem: ${problem}\n`);
    process.exit(register.problems.length === 0 ? 0 : 1);
  }

  if (argv.includes("--check")) {
    const failures = [...register.problems];
    for (const [path, expected] of [
      [MANIFEST, manifest],
      [REPORT, report],
    ]) {
      let actual;
      try {
        actual = readFileSync(join(repositoryRoot, path), "utf8");
      } catch {
        failures.push(`${path} is missing; run pnpm generate:tool-lifecycle-reach`);
        continue;
      }
      if (actual !== expected) failures.push(`${path} is stale; run pnpm generate:tool-lifecycle-reach`);
    }
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.stdout.write(
      `tool-lifecycle-reach: ${register.totalSites} sites, ${failures.length} problem(s)\n`,
    );
    process.exit(failures.length === 0 ? 0 : 1);
  }

  process.stdout.write(`${report}\n`);
  for (const problem of register.problems) process.stderr.write(`  problem: ${problem}\n`);
  process.exit(register.problems.length === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith("tool-lifecycle-reach.mjs")) main();
