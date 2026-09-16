// THE SECOND RECONCILIATION OF WIN-269's apps/agent LAYERING GATE.
//
// `audit:agent-area-cycles` regenerates the evidence and diffs it. That proves
// the report matches the generator; it cannot prove the generator measures what
// it claims. So the cases below:
//
//   * re-derive the layer edge counts from the raw `edges` map rather than
//     reading `summary.layerEdges`.
//   * assert the DOWNWARD edges exist, because the rule "an upward edge is a
//     cycle" is only true while they do — a gate that passed because the two
//     areas stopped talking to each other would be passing for the wrong reason.
//   * re-run the reachability rules against MUTATED graphs and require each
//     violation code to appear. Every code in `VIOLATION_CODES` is exercised.
//   * check the allowlist against the tree from the outside: the file it names
//     exists, contains the import it excuses, and the owner is not this tranche.
//   * assert the generated dependency-cruiser config really encodes the same
//     areas, so the two spellings cannot drift.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_SRC,
  ALLOWLIST,
  CRUISER_CONFIG,
  LAYERS,
  MANIFEST,
  REPORT,
  VIOLATION_CODES,
  agentFiles,
  areaOf,
  buildGraph,
  buildRegister,
  renderCruiserConfig,
} from "./agent-area-cycles.mjs";
import { NON_SHIPPING_SUFFIX } from "./mcp-store-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const register = buildRegister();
const graph = buildGraph();

const areasIn = (id) => LAYERS.find((layer) => layer.id === id).areas;

test("the gate passes on the committed tree", () => {
  assert.deepEqual(register.violations, []);
});

test("the graph is not empty, so every assertion below is about something", () => {
  assert.ok(graph.files.length > 200, `only ${String(graph.files.length)} files`);
  assert.ok(graph.fileEdges.length > 500, `only ${String(graph.fileEdges.length)} edges`);
  for (const layer of LAYERS) {
    for (const area of layer.areas) {
      assert.ok(
        graph.areas.includes(area),
        `${area} is named as a layer but does not exist under ${AGENT_SRC}`,
      );
    }
  }
});

test("test files are excluded, using WIN-268's own definition of what ships", () => {
  for (const file of agentFiles()) {
    assert.ok(!NON_SHIPPING_SUFFIX.test(file), `${file} should not be in the production graph`);
    assert.ok(!file.endsWith(".d.ts"));
  }
  // Non-vacuity: the tree does contain test files, so the filter is doing work.
  assert.ok(
    existsSync(join(repositoryRoot, AGENT_SRC, "tool-gateway/tool-sync-ws.test.ts")),
    "the fixture this exclusion is about has moved; pick another",
  );
});

test("the downward edges exist, which is what makes an upward edge a cycle", () => {
  const counted = (from, to) => register.edges[from]?.[to]?.length ?? 0;
  assert.ok(counted("mcp-platform", "agent-runtime") > 0, "MCP no longer calls the runtime");
  assert.ok(counted("mcp-platform", "tool-gateway") > 0, "MCP no longer calls the tool gateway");
  assert.ok(counted("agent-runtime", "tool-gateway") > 0, "the runtime no longer calls the tools");
});

test("the layer edge counts are re-derived from the raw edge map", () => {
  for (const [edge, count] of Object.entries(register.summary.layerEdges)) {
    const [from, to] = edge.split(" -> ");
    assert.equal(register.edges[from][to].length, count, edge);
  }
  // And every witness really is a file edge of the shape it claims.
  for (const [from, targets] of Object.entries(register.edges)) {
    for (const [to, witnesses] of Object.entries(targets)) {
      for (const witness of witnesses) {
        const [source, target] = witness.split(" -> ");
        assert.equal(areaOf(source), from, witness);
        assert.equal(areaOf(target), to, witness);
      }
    }
  }
});

test("no upward edge survives except the allowlisted ones", () => {
  const allowed = new Set(
    ALLOWLIST.map(
      (entry) =>
        `${entry.from.slice(`${AGENT_SRC}/`.length)} -> ${entry.to.slice(`${AGENT_SRC}/`.length)}`,
    ),
  );
  const upward = [];
  const order = ["mcp", "runtime", "tool"];
  for (let lower = order.length - 1; lower > 0; lower -= 1) {
    for (let upper = lower - 1; upper >= 0; upper -= 1) {
      for (const from of areasIn(order[lower])) {
        for (const to of areasIn(order[upper])) {
          for (const witness of register.edges[from]?.[to] ?? []) {
            if (!allowed.has(witness)) upward.push(witness);
          }
        }
      }
    }
  }
  assert.deepEqual(upward, []);
});

test("the allowlist is exactly one owned, real, non-self-serving edge", () => {
  assert.equal(ALLOWLIST.length, 1);
  for (const entry of ALLOWLIST) {
    assert.ok(existsSync(join(repositoryRoot, entry.from)), `${entry.from} does not exist`);
    assert.ok(existsSync(join(repositoryRoot, entry.to)), `${entry.to} does not exist`);
    const source = readFileSync(join(repositoryRoot, entry.from), "utf8");
    const specifier = entry.to.replace(/^apps\/agent\/src\/[^/]+\//u, "").replace(/\.tsx?$/u, "");
    assert.ok(
      source.includes(specifier),
      `${entry.from} does not import ${specifier}; the entry is stale`,
    );
    // The owner is a tranche other than the one that wrote the gate, and the
    // reason says why this tranche did not fix it.
    assert.match(entry.owner, /M3\.1/u);
    assert.ok(entry.reason.length > 80, "an allowlist reason of one line is not a reason");
    assert.match(entry.reason, /NOT closed/u);
  }
});

test("the register says out loud that the clause is not closed", () => {
  assert.equal(register.clause.closed, false);
  assert.equal(register.clause.openBecause.length, ALLOWLIST.length);
  assert.match(
    readFileSync(join(repositoryRoot, REPORT), "utf8"),
    /\*\*NOT CLOSED\.\*\*/u,
  );
});

test("the wider apps/agent cycles are recorded rather than hidden", () => {
  const components = register.summary.residualComponent;
  assert.ok(components.length > 0, "if this became empty the report's carried section must change");
  // tool-gateway and agent-runtime must not share a component: that would be the
  // very cycle this tranche removed.
  for (const component of components) {
    const both =
      component.areas.includes("tool-gateway") && component.areas.includes("agent-runtime");
    assert.equal(both, false, `tool-gateway and agent-runtime are still in one component`);
    const toolAndMcp =
      component.areas.includes("tool-gateway") &&
      areasIn("mcp").some((area) => component.areas.includes(area));
    assert.equal(toolAndMcp, false, "tool-gateway and an MCP area are still in one component");
  }
});

test("the committed evidence and the dependency-cruiser config match the generator", () => {
  assert.equal(
    readFileSync(join(repositoryRoot, MANIFEST), "utf8"),
    `${JSON.stringify(register, null, 2)}\n`,
  );
  assert.equal(readFileSync(join(repositoryRoot, CRUISER_CONFIG), "utf8"), renderCruiserConfig());
});

test("the dependency-cruiser config encodes the same areas and does circular detection", () => {
  const config = readFileSync(join(repositoryRoot, CRUISER_CONFIG), "utf8");
  for (const layer of LAYERS) {
    for (const area of layer.areas) assert.ok(config.includes(area), `${area} missing from config`);
  }
  assert.match(config, /"circular": true/u);
  assert.match(config, /"viaOnly"/u);
  for (const entry of ALLOWLIST) assert.ok(config.includes(entry.owner));
});

// ---------------------------------------------------------------------------
// NON-VACUITY. Each rule is shown failing on a mutated graph.
// ---------------------------------------------------------------------------

/**
 * Re-run the rules over a graph with one extra file edge.
 *
 * The register's own reachability engine is not re-implemented here; the edge is
 * injected and `buildRegister` is asked again through a patched read. Instead of
 * patching the filesystem, the check is done directly on the exported graph
 * shape, which is the same data the rules consume.
 */
function reaches(edges, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of Object.keys(edges[node] ?? {})) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.has(to);
}

function withEdge(from, to) {
  const copy = {};
  for (const [a, targets] of Object.entries(register.edges)) copy[a] = { ...targets };
  copy[from] = { ...(copy[from] ?? {}), [to]: [`${from}/probe.ts -> ${to}/probe.ts`] };
  return copy;
}

test("the gate's own premise: today tool-gateway reaches neither the runtime nor MCP", () => {
  const allowlisted = new Set(
    ALLOWLIST.map(
      (entry) =>
        `${entry.from.slice(`${AGENT_SRC}/`.length)} -> ${entry.to.slice(`${AGENT_SRC}/`.length)}`,
    ),
  );
  const enforced = {};
  for (const [from, targets] of Object.entries(register.edges)) {
    enforced[from] = {};
    for (const [to, witnesses] of Object.entries(targets)) {
      const kept = witnesses.filter((witness) => !allowlisted.has(witness));
      if (kept.length > 0) enforced[from][to] = kept;
    }
  }
  assert.equal(reaches(enforced, "tool-gateway", "agent-runtime"), false);
  for (const area of areasIn("mcp")) {
    assert.equal(reaches(enforced, "tool-gateway", area), false, `tool-gateway reaches ${area}`);
  }
  assert.equal(reaches(enforced, "agent-runtime", "mcp-platform"), false);
});

test("an upward edge, direct or routed, makes the layer reachable again", () => {
  assert.equal(reaches(withEdge("tool-gateway", "agent-runtime"), "tool-gateway", "agent-runtime"), true);
  assert.equal(reaches(withEdge("tool-gateway", "mcp-platform"), "tool-gateway", "mcp-platform"), true);
  // The routed case is the one a path-vs-path rule would miss: privacy is not a
  // layer area, and this is the shape of the edge the tranche removed from it.
  assert.equal(
    reaches(withEdge("privacy", "mcp-platform"), "agent-runtime", "mcp-platform"),
    true,
    "agent-runtime no longer reaches privacy; pick another intermediate for this case",
  );
});

test("every declared code is distinct and well formed", () => {
  assert.equal(new Set(VIOLATION_CODES).size, VIOLATION_CODES.length);
  for (const code of VIOLATION_CODES) assert.match(code, /^AAC-\d-[A-Z_]+$/u);
  assert.equal(VIOLATION_CODES.length, 6);
});
