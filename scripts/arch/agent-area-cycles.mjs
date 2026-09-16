#!/usr/bin/env node
// WIN-269 (M4.3) — THE RUNTIME <-> TOOL <-> MCP LAYERING IN apps/agent, AS A
// REACHABILITY GATE AND NOT AS A COMMENT.
//
//   node scripts/arch/agent-area-cycles.mjs            # human report
//   node scripts/arch/agent-area-cycles.mjs --json     # machine-readable
//   node scripts/arch/agent-area-cycles.mjs --write    # regenerate evidence
//   node scripts/arch/agent-area-cycles.mjs --check    # fail on violation or drift
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL
//
// WIN-269's census row is "no runtime<->tool<->MCP import cycle remains". Before
// this file the tree's only defence was prose. `tool-gateway.module.ts` carried
// a comment saying that importing `McpPlatformModule` back "would create a
// circular module graph" and then registered a second copy of
// `MCPPermissionGatewayService` to dodge it — a comment that was right about
// Nest's MODULE graph and silent about the FILE graph, where the import it kept
// was itself half the cycle. `scripts/arch/arch-boundaries.mjs` could not have
// caught it: its `DEFAULT_SCAN_ROOTS` deliberately exclude `apps/agent`, because
// the strangler's migration locks live there. So apps/agent has never had a
// cycle gate, and this is it.
//
// ---------------------------------------------------------------------------
// THE RULE IS A LAYERING, AND THE LAYERING IS A REACHABILITY TEST
//
// Three layers, top to bottom:
//
//   MCP      apps/agent/src/mcp-platform, apps/agent/src/mcp-docs
//   RUNTIME  apps/agent/src/agent-runtime
//   TOOL     apps/agent/src/tool-gateway
//
// MCP transports call the runtime and the tool gateway; the runtime calls the
// tool gateway; nothing calls upward. An upward edge is a cycle BY CONSTRUCTION,
// because the downward edges are there — measured at the commit this landed on
// and recorded in `summary.layerEdges`: 15 MCP->runtime, 16 MCP->tool,
// 15 runtime->tool file imports.
//
// IT IS REACHABILITY AND NOT A PATH-VS-PATH RULE, deliberately. A rule that
// forbade only the DIRECT edge `tool-gateway -> mcp-platform` would pass on a
// tree where `tool-gateway -> monitoring -> ... -> mcp-platform`, and that is
// not a theoretical worry here: the edge this tranche removed from `privacy`
// (`erasure.controller.ts -> mcp-platform/token.service.ts`) closed a
// runtime->MCP cycle through `agent-runtime -> memory -> privacy -> mcp-platform`
// — three areas none of which is named in the clause. So the whole apps/agent
// area graph is built, and the question asked of it is "can TOOL reach RUNTIME
// or MCP by ANY path", not "is there an import statement".
//
// ---------------------------------------------------------------------------
// WHAT THE ALLOWLIST IS FOR, AND WHY IT IS NOT A QUIET ONE
//
// Exactly one upward edge survives:
//
//   apps/agent/src/agent-runtime/agent.controller.ts
//     -> apps/agent/src/mcp-platform/mcp-management.validation.ts
//
// `agent.controller.ts` is M3.1's (WIN-261) and this tranche may not edit it, so
// the edge cannot be removed here. It is allowlisted WITH ITS OWNER AND THE
// REASON, and three things stop that from becoming a hiding place:
//
//   * an entry whose edge no longer exists in the tree FAILS (AAC-4). It cannot
//     outlive the import it excuses.
//   * an entry that is not load-bearing — the rules pass without it — FAILS
//     (AAC-5). It cannot be widened "just in case".
//   * an entry missing an owner or a reason FAILS (AAC-6).
//
// And the register records, in `clause`, that WIN-269 IS NOT CLOSED while any
// entry stands, with the residual cycle spelled out. A green `--check` here
// means "the layering holds except for the named, owned edges", which is a
// different sentence from "the clause is met", and the report says so.
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT CLAIM
//
// apps/agent's WIDER area graph is not acyclic and this gate does not pretend
// otherwise: `summary.residualComponent` records, measured, the strongly
// connected component the other areas still form (`auth`, `providers`,
// `monitoring`, `channels`, `skills`, `streaming`, `trigger-bridge`, ...). Those
// cycles are real and they are not WIN-269's clause; recording them is how the
// number stops being a surprise to whoever owns them next.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NON_SHIPPING_SUFFIX } from "./mcp-store-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const MANIFEST = "docs/audits/win-269-agent-area-cycles.json";
export const REPORT = "docs/audits/win-269-agent-area-cycles.md";
export const CRUISER_CONFIG = ".dependency-cruiser.agent-areas.cjs";

/** The tree this gate measures. One constant; nothing greps a literal. */
export const AGENT_SRC = "apps/agent/src";

/**
 * The layers, top to bottom. The ORDER IS THE RULE: an edge from a lower layer
 * to a higher one is a violation, and `LAYERS` is what says which is which.
 */
export const LAYERS = Object.freeze([
  Object.freeze({ id: "mcp", areas: Object.freeze(["mcp-platform", "mcp-docs"]) }),
  Object.freeze({ id: "runtime", areas: Object.freeze(["agent-runtime"]) }),
  Object.freeze({ id: "tool", areas: Object.freeze(["tool-gateway"]) }),
]);

/**
 * THE ALLOWLIST. One entry, and every field of it is load-bearing.
 *
 * `owner` is who must remove it — not a team name for decoration, the tranche
 * that owns the file. `reason` is why this tranche did not.
 */
export const ALLOWLIST = Object.freeze([
  Object.freeze({
    from: "apps/agent/src/agent-runtime/agent.controller.ts",
    to: "apps/agent/src/mcp-platform/mcp-management.validation.ts",
    owner: "M3.1 (WIN-261)",
    reason:
      "AgentController imports the MCP management request validators to serve the " +
      "`/entities/:entityId/mcp/*` routes. M3.1 owns apps/agent AgentController and " +
      "AgentService and this tranche may not edit either file, so the edge cannot be " +
      "inverted here. The fix is M3.1's: the validators are a leaf and move behind a " +
      "tool-gateway-owned seam exactly as context-resolver, context-automap and the " +
      "postman handle did, or the routes move to core-api with the rest of M3.1's " +
      "controller. While this entry stands, WIN-269 is NOT closed.",
  }),
]);

/** The codes. Distinct guards get distinct codes so a failure names itself. */
export const VIOLATION_CODES = Object.freeze([
  "AAC-1-TOOL_REACHES_RUNTIME",
  "AAC-2-TOOL_REACHES_MCP",
  "AAC-3-RUNTIME_REACHES_MCP",
  "AAC-4-STALE_ALLOWLIST_ENTRY",
  "AAC-5-UNUSED_ALLOWLIST_ENTRY",
  "AAC-6-UNOWNED_ALLOWLIST_ENTRY",
]);

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

/**
 * Every production file under `AGENT_SRC`.
 *
 * `NON_SHIPPING_SUFFIX` is IMPORTED from WIN-268's register rather than
 * rewritten, so the two instruments cannot disagree about what ships. A second
 * spelling of "what is a test file" is a second answer waiting to happen.
 */
export function agentFiles(root = repositoryRoot) {
  const base = join(root, AGENT_SRC);
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry)) continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/u.test(entry)) continue;
      if (entry.endsWith(".d.ts")) continue;
      if (NON_SHIPPING_SUFFIX.test(entry)) continue;
      found.push(relative(base, path));
    }
  };
  walk(base);
  return found.sort();
}

/**
 * Relative specifiers, static and dynamic.
 *
 * `agent.controller.ts` reaches `context-automap` through `await import(...)`,
 * and a scanner that read only `import ... from` would have called that edge
 * absent — so the dynamic form and `require(` are matched too. A bundler follows
 * all three; so does a cycle.
 */
const SPECIFIER = new RegExp(
  [
    String.raw`(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']`,
    String.raw`import\s*\(\s*["']([^"']+)["']\s*\)`,
    String.raw`require\(\s*["']([^"']+)["']\s*\)`,
  ].join("|"),
  "gu",
);

function resolveSpecifier(fromFile, specifier, known) {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(`/${fromFile}`), specifier).slice(1);
  for (const candidate of [
    `${target}.ts`,
    `${target}.tsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
    target,
  ]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

export function areaOf(file) {
  const slash = file.indexOf("/");
  return slash === -1 ? "<root>" : file.slice(0, slash);
}

/**
 * The file graph, projected to areas, keeping every file edge as the witness.
 *
 * The witnesses matter more than the counts: a failing rule has to be able to
 * say WHICH import to delete, or the gate is a riddle.
 */
export function buildGraph(root = repositoryRoot) {
  const files = agentFiles(root);
  const known = new Set(files);
  const areaEdges = new Map();
  const fileEdges = [];
  for (const file of files) {
    const source = readFileSync(join(root, AGENT_SRC, file), "utf8");
    const seen = new Set();
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      const target = resolveSpecifier(file, specifier, known);
      if (!target || target === file || seen.has(target)) continue;
      seen.add(target);
      fileEdges.push({ from: file, to: target });
      const a = areaOf(file);
      const b = areaOf(target);
      if (a === b) continue;
      if (!areaEdges.has(a)) areaEdges.set(a, new Map());
      if (!areaEdges.get(a).has(b)) areaEdges.get(a).set(b, []);
      areaEdges.get(a).get(b).push(`${file} -> ${target}`);
    }
  }
  const areas = [...new Set(files.map(areaOf))].sort();
  return { files, areas, areaEdges, fileEdges };
}

/** Shortest area path from `from` to `to`, or null. Used as the witness. */
function shortestPath(areaEdges, from, to) {
  if (from === to) return null;
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of areaEdges.get(node)?.keys() ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, node);
      if (next === to) {
        const path = [to];
        let cursor = to;
        while (previous.get(cursor) !== null) {
          cursor = previous.get(cursor);
          path.unshift(cursor);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** Tarjan. Used only to RECORD the residual component, never to gate on it. */
function components(areas, areaEdges) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  const strong = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of areaEdges.get(node)?.keys() ?? []) {
      if (!index.has(next)) {
        strong(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let popped;
      do {
        popped = stack.pop();
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      found.push(component.sort());
    }
  };
  for (const area of areas) if (!index.has(area)) strong(area);
  return found.filter((component) => component.length > 1).sort((a, b) => b.length - a.length);
}

function withoutEdges(areaEdges, removed) {
  const copy = new Map();
  for (const [from, targets] of areaEdges) {
    const next = new Map();
    for (const [to, witnesses] of targets) {
      const kept = witnesses.filter((witness) => !removed.has(witness));
      if (kept.length > 0) next.set(to, kept);
    }
    if (next.size > 0) copy.set(from, next);
  }
  return copy;
}

const layerAreas = (id) => LAYERS.find((layer) => layer.id === id).areas;

/**
 * The three reachability rules, run against a given graph.
 *
 * Returned rather than thrown so `--check` can evaluate the SAME rules twice:
 * once with the allowlist applied (the gate) and once without it (the clause).
 */
function evaluate(areaEdges) {
  const violations = [];
  const check = (code, fromLayer, toLayer) => {
    for (const from of layerAreas(fromLayer)) {
      for (const to of layerAreas(toLayer)) {
        const path = shortestPath(areaEdges, from, to);
        if (!path) continue;
        const first = areaEdges.get(path[0])?.get(path[1]) ?? [];
        violations.push({ code, from, to, path, firstHop: [...first].sort() });
      }
    }
  };
  check("AAC-1-TOOL_REACHES_RUNTIME", "tool", "runtime");
  check("AAC-2-TOOL_REACHES_MCP", "tool", "mcp");
  check("AAC-3-RUNTIME_REACHES_MCP", "runtime", "mcp");
  return violations;
}

export function buildRegister(root = repositoryRoot) {
  const { files, areas, areaEdges, fileEdges } = buildGraph(root);

  const structural = [];
  for (const entry of ALLOWLIST) {
    if (!entry.owner || !entry.reason) {
      structural.push({
        code: "AAC-6-UNOWNED_ALLOWLIST_ENTRY",
        from: entry.from,
        to: entry.to,
        detail: "an allowlisted edge must name the tranche that owns it and why it stands",
      });
    }
  }

  // An allowlist entry is written in repository-relative paths; the graph is
  // keyed relative to AGENT_SRC. Translate once, here, so the entry reads the
  // way a human would grep for it.
  const present = new Set(fileEdges.map((edge) => `${edge.from} -> ${edge.to}`));
  const witnessFor = (entry) =>
    `${relative(AGENT_SRC, entry.from)} -> ${relative(AGENT_SRC, entry.to)}`;

  const stale = [];
  for (const entry of ALLOWLIST) {
    if (!present.has(witnessFor(entry))) {
      stale.push({
        code: "AAC-4-STALE_ALLOWLIST_ENTRY",
        from: entry.from,
        to: entry.to,
        detail: "the import this entry excuses is not in the tree; delete the entry",
      });
    }
  }

  const removed = new Set(ALLOWLIST.map(witnessFor));
  const enforcedGraph = withoutEdges(areaEdges, removed);
  const enforced = evaluate(enforcedGraph);
  const clause = evaluate(areaEdges);

  // LOAD-BEARING: an entry earns its place only if putting its edge back breaks
  // a rule. Anything else is an allowlist growing by habit.
  const unused = [];
  for (const entry of ALLOWLIST) {
    const others = new Set(
      ALLOWLIST.filter((other) => other !== entry).map(witnessFor),
    );
    if (evaluate(withoutEdges(areaEdges, others)).length === enforced.length) {
      unused.push({
        code: "AAC-5-UNUSED_ALLOWLIST_ENTRY",
        from: entry.from,
        to: entry.to,
        detail: "no rule fails when this edge is put back; the entry excuses nothing",
      });
    }
  }

  const violations = [...enforced, ...stale, ...unused, ...structural];

  const layerEdgeCounts = {};
  for (const layer of LAYERS) {
    for (const from of layer.areas) {
      for (const other of LAYERS) {
        for (const to of other.areas) {
          const witnesses = areaEdges.get(from)?.get(to);
          if (witnesses && witnesses.length > 0) {
            layerEdgeCounts[`${from} -> ${to}`] = witnesses.length;
          }
        }
      }
    }
  }

  return {
    issue: "WIN-269",
    milestone: "M4.3",
    agentSrc: AGENT_SRC,
    layers: LAYERS.map((layer) => ({ id: layer.id, areas: [...layer.areas] })),
    allowlist: ALLOWLIST.map((entry) => ({ ...entry })),
    violationCodes: [...VIOLATION_CODES],
    violations,
    clauseViolations: clause,
    summary: {
      files: files.length,
      areas: areas.length,
      fileEdges: fileEdges.length,
      layerEdges: layerEdgeCounts,
      allowlisted: ALLOWLIST.length,
      residualComponent: components(areas, areaEdges).map((component) => ({
        size: component.length,
        areas: component,
      })),
    },
    clause: {
      row: "no runtime<->tool<->MCP import cycle remains",
      closed: clause.length === 0,
      openBecause:
        clause.length === 0
          ? []
          : ALLOWLIST.map(
              (entry) =>
                `${relative(AGENT_SRC, entry.from)} -> ${relative(AGENT_SRC, entry.to)} (owner ${entry.owner})`,
            ),
    },
    edges: Object.fromEntries(
      [...areaEdges]
        .map(([from, targets]) => [
          from,
          Object.fromEntries([...targets].map(([to, w]) => [to, [...w].sort()]).sort()),
        ])
        .sort(),
    ),
  };
}

// The dependency-cruiser encoding of the same rules.
//
// WHY IT IS EMITTED AND NOT HAND-WRITTEN: two spellings of a rule drift, and the
// repository already learned that once (`gen-dependency-cruiser.mjs` exists for
// the same reason). `--check` byte-compares the committed file, so the config
// and this gate cannot disagree.
//
// dependency-cruiser is NOT a dependency of this repository — `arch-boundaries`
// is deliberately the zero-dependency enforcer — so the config is run with an
// ephemeral install; `renderCruiserConfig` writes the exact command into the
// generated file's header.
//
// THE GLOB AND NOT THE DIRECTORY. dependency-cruiser 16 walks a bare directory
// with its default extension set and reports "0 modules cruised" on a TypeScript
// tree, which reads as a pass. TWO MORE SILENT PASSES were found the same way and
// are why the emitted options look as they do: without `typescript` resolvable
// beside dependency-cruiser every relative `.ts` import resolves to `unknown` and
// no rule matches, and `tsConfig: apps/agent/tsconfig.json` aborts with TS18003
// because dependency-cruiser resolves a tsconfig's `include` globs against the
// CWD. Measured at the commit this landed on, the glob form cruises 397 modules
// and 1681 dependencies and finds no violation; the mutation that puts a
// `tool-gateway -> agent-runtime` import back is reported by BOTH
// `agent-tool-layer-below-runtime` and the `no-agent-area-cycles` circular rule.
//
// The `no-agent-area-cycles` rule is `circular` restricted with `viaOnly` to the
// four layer areas, which is the clause's own sentence in dependency-cruiser's
// vocabulary: a cycle every hop of which is runtime, tool or MCP.
export function renderCruiserConfig() {
  const mcp = layerAreas("mcp").join("|");
  const runtime = layerAreas("runtime").join("|");
  const tool = layerAreas("tool").join("|");
  const layerPath = `^${AGENT_SRC}/(${[...layerAreas("mcp"), ...layerAreas("runtime"), ...layerAreas("tool")].join("|")})/`;
  const allowlistPathNot = ALLOWLIST.map((entry) =>
    entry.from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
  ).join("|");

  const forbidden = [
    {
      name: "no-agent-area-cycles",
      comment:
        "WIN-269 — no import cycle whose every hop is one of apps/agent's MCP, runtime or tool areas.",
      severity: "error",
      from: { path: layerPath },
      to: { circular: true, viaOnly: { path: layerPath } },
    },
    {
      name: "agent-tool-layer-below-runtime",
      comment: "WIN-269 — apps/agent tool-gateway may not import agent-runtime.",
      severity: "error",
      from: { path: `^${AGENT_SRC}/(${tool})/` },
      to: { path: `^${AGENT_SRC}/(${runtime})/` },
    },
    {
      name: "agent-tool-layer-below-mcp",
      comment: "WIN-269 — apps/agent tool-gateway may not import an MCP transport.",
      severity: "error",
      from: { path: `^${AGENT_SRC}/(${tool})/` },
      to: { path: `^${AGENT_SRC}/(${mcp})/` },
    },
    {
      name: "agent-runtime-below-mcp",
      comment:
        "WIN-269 — apps/agent agent-runtime may not import an MCP transport. " +
        `Allowlisted, owned by ${ALLOWLIST[0]?.owner ?? "nobody"}: ${ALLOWLIST.map((e) => e.from).join(", ")}`,
      severity: "error",
      from: { path: `^${AGENT_SRC}/(${runtime})/`, pathNot: allowlistPathNot },
      to: { path: `^${AGENT_SRC}/(${mcp})/` },
    },
  ];

  const options = {
    // NO `tsConfig`. dependency-cruiser resolves a tsconfig's `include` globs
    // against the CWD rather than against the tsconfig's own directory, so
    // pointing it at `apps/agent/tsconfig.json` (whose include is `src/**/*`)
    // aborts with TS18003 from the repository root. apps/agent's intra-app
    // imports are all relative, so nothing here needs the path aliases.
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\\.(test|spec|test-fixture)\\.tsx?$" },
    tsPreCompilationDeps: true,
    reporterOptions: { text: { highlightFocused: true } },
  };

  return `// GENERATED — do not edit by hand.
// Source of truth: scripts/arch/agent-area-cycles.mjs
// Regenerate:      node scripts/arch/agent-area-cycles.mjs --write
// Drift gate:      node scripts/arch/agent-area-cycles.mjs --check
//
// Run it (dependency-cruiser is intentionally NOT a dependency of this repo):
//   npx --yes dependency-cruiser@16 --config ${CRUISER_CONFIG} \\
//       --output-type err "${AGENT_SRC}/**/*.ts"
//
// The GLOB and not the directory: a bare directory makes dependency-cruiser 16
// report "0 modules cruised" on a TypeScript tree, which reads as a pass.
//
// The zero-dependency gate is \`node scripts/arch/agent-area-cycles.mjs --check\`,
// which is what CI runs; this config is the same rules in dependency-cruiser's
// own vocabulary, so the circular detection can be pointed at the same graph.

module.exports = ${JSON.stringify({ forbidden, options }, null, 2)};
`;
}

function renderReport(register) {
  const lines = [];
  lines.push(`# WIN-269 (M4.3) — apps/agent runtime <-> tool <-> MCP layering`);
  lines.push("");
  lines.push("GENERATED — `node scripts/arch/agent-area-cycles.mjs --write`.");
  lines.push("");
  lines.push(
    `Measured over \`${register.agentSrc}\`: ${register.summary.files} production files, ` +
      `${register.summary.areas} areas, ${register.summary.fileEdges} intra-app file edges.`,
  );
  lines.push("");
  lines.push("## The layering");
  lines.push("");
  lines.push("| layer | areas |");
  lines.push("| --- | --- |");
  for (const layer of register.layers) {
    lines.push(`| ${layer.id} | ${layer.areas.join(", ")} |`);
  }
  lines.push("");
  lines.push("Edges between the layer areas, as measured:");
  lines.push("");
  lines.push("| edge | file imports |");
  lines.push("| --- | --- |");
  for (const [edge, count] of Object.entries(register.summary.layerEdges).sort()) {
    lines.push(`| \`${edge}\` | ${String(count)} |`);
  }
  lines.push("");
  lines.push("## What the gate forbids");
  lines.push("");
  for (const code of register.violationCodes) lines.push(`- \`${code}\``);
  lines.push("");
  lines.push(
    "AAC-1..3 are REACHABILITY tests over the whole apps/agent area graph, not " +
      "path-vs-path tests: an upward edge routed through `monitoring`, `memory` or " +
      "`privacy` fails them exactly as a direct import does.",
  );
  lines.push("");
  lines.push("## The allowlist");
  lines.push("");
  if (register.allowlist.length === 0) {
    lines.push("Empty.");
  } else {
    for (const entry of register.allowlist) {
      lines.push(`### \`${entry.from}\``);
      lines.push("");
      lines.push(`- imports \`${entry.to}\``);
      lines.push(`- **owner: ${entry.owner}**`);
      lines.push(`- ${entry.reason}`);
      lines.push("");
    }
  }
  lines.push("## Is the clause closed?");
  lines.push("");
  lines.push(`Census row: _${register.clause.row}_`);
  lines.push("");
  if (register.clause.closed) {
    lines.push("**Closed.** No allowlist entry stands and no rule fails.");
  } else {
    lines.push(
      "**NOT CLOSED.** The gate passes because the edges below are allowlisted, " +
        "and an allowlisted cycle is still a cycle. It closes when its owner removes it:",
    );
    lines.push("");
    for (const reason of register.clause.openBecause) lines.push(`- \`${reason}\``);
  }
  lines.push("");
  lines.push("## Carried, and not this clause");
  lines.push("");
  if (register.summary.residualComponent.length === 0) {
    lines.push("The apps/agent area graph is acyclic.");
  } else {
    for (const component of register.summary.residualComponent) {
      lines.push(
        `- a strongly connected component of ${String(component.size)} areas: ` +
          component.areas.map((area) => `\`${area}\``).join(", "),
      );
    }
    lines.push("");
    lines.push(
      "These are real import cycles and this gate does not fail on them: they are " +
        "not the runtime<->tool<->MCP clause and they belong to areas no M4 tranche " +
        "owns. They are recorded so the number is known rather than discovered.",
    );
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

function describe(violation) {
  if (violation.path) {
    return `${violation.code}: ${violation.path.join(" -> ")} (first hop: ${violation.firstHop.join(", ")})`;
  }
  return `${violation.code}: ${violation.from} -> ${violation.to} — ${violation.detail}`;
}

function main() {
  const argv = process.argv.slice(2);
  const register = buildRegister();
  const manifestPath = join(repositoryRoot, MANIFEST);
  const reportPath = join(repositoryRoot, REPORT);
  const cruiserPath = join(repositoryRoot, CRUISER_CONFIG);
  const manifestText = `${JSON.stringify(register, null, 2)}\n`;
  const reportText = renderReport(register);
  const cruiserText = renderCruiserConfig();

  if (argv.includes("--json")) {
    process.stdout.write(manifestText);
    return;
  }

  if (argv.includes("--write")) {
    writeFileSync(manifestPath, manifestText, "utf8");
    writeFileSync(reportPath, reportText, "utf8");
    writeFileSync(cruiserPath, cruiserText, "utf8");
    process.stdout.write(`wrote ${MANIFEST}, ${REPORT}, ${CRUISER_CONFIG}\n`);
    if (register.violations.length > 0) {
      process.stderr.write(
        `NOTE: ${String(register.violations.length)} violation(s) recorded; --check will fail.\n`,
      );
    }
    return;
  }

  if (argv.includes("--check")) {
    let failed = false;
    for (const violation of register.violations) {
      process.stderr.write(`${describe(violation)}\n`);
      failed = true;
    }
    const compare = [
      [MANIFEST, manifestPath, manifestText],
      [REPORT, reportPath, reportText],
      [CRUISER_CONFIG, cruiserPath, cruiserText],
    ];
    for (const [label, path, expected] of compare) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== expected) {
        process.stderr.write(
          `drift: ${label} is stale. Run: node scripts/arch/agent-area-cycles.mjs --write\n`,
        );
        failed = true;
      }
    }
    if (failed) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `ok: apps/agent layering holds; ${String(register.allowlist.length)} allowlisted edge(s); ` +
        `clause ${register.clause.closed ? "CLOSED" : "NOT closed"}\n`,
    );
    return;
  }

  process.stdout.write(reportText);
  if (register.violations.length > 0) {
    process.stdout.write("\nVIOLATIONS\n");
    for (const violation of register.violations) process.stdout.write(`  ${describe(violation)}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("agent-area-cycles.mjs")) main();
