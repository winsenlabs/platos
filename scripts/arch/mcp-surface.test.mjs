#!/usr/bin/env node
// The MCP-surface gate's own evidence.
//
// Three kinds of case, and the third is the one that matters:
//
//   THE ANALYSER — every spelling this gate models, proved against a source
//   string, each with a NEGATIVE control beside it so a matcher that fired on
//   everything would fail rather than pass six times.
//
//   THE JUDGEMENT — every violation code, raised against a synthetic scan. The
//   live tree raises none by design, so without this half all four codes would
//   be unreachable text and nobody would know if one had stopped working.
//
//   THE LIVE TREE, JOINED TO SOMETHING THIS FILE DOES NOT CONTROL. The gate's
//   own count of platform MCP tool declarations is reconciled against the
//   COMMITTED manifest, which is produced by executing the servers' modules
//   rather than by reading them, and against an INDEPENDENT text scan with a
//   different definition of the word. Two AST walks agreeing is one walk; a walk
//   agreeing with an execution and with a grep is a measurement.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_MODULE,
  MANIFEST,
  PLATFORM_TOOLS_DIR,
  SERVER_INFO_BUILDER,
  VIOLATION_CODES,
  analyse,
  findDeclaredToolNames,
  findMcpVersionSpellings,
  judge,
  readContractConstants,
  scan,
} from "./mcp-surface.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const kinds = (source) => findMcpVersionSpellings("fixture.ts", source).map((s) => s.kind);

// ---------------------------------------------------------------------------
// THE ANALYSER
// ---------------------------------------------------------------------------

test("a protocolVersion string literal is a spelling", () => {
  assert.deepEqual(kinds('const r = { protocolVersion: "2025-06-18" };'), ["protocol-literal"]);
  assert.deepEqual(kinds("const r = { protocolVersion: `2025-06-18` };"), ["protocol-literal"]);
});

test("a protocolVersion read from the constant is NOT a spelling", () => {
  // The negative control. Without it a matcher that fired on the property NAME
  // would pass every positive case above and refuse the fix.
  assert.deepEqual(kinds("const r = { protocolVersion: MCP_PROTOCOL_VERSION };"), []);
});

test("a serverInfo object literal is a spelling, literal version or not", () => {
  assert.deepEqual(
    kinds('const r = { serverInfo: { name: "x", version: "0.1.0" } };'),
    ["server-info-literal"],
  );
  // THE INDIRECTION CASE. `version: LOCAL` is the shape the docs server's
  // capability probe had — a constant that was not THE constant — and a rule
  // that only refused literals would have blessed it.
  assert.deepEqual(kinds("const r = { serverInfo: { name: n, version: LOCAL } };"), [
    "server-info-literal",
  ]);
});

test("a serverInfo built by the one builder is a server, not a violation", () => {
  assert.deepEqual(kinds(`const r = { serverInfo: ${SERVER_INFO_BUILDER}(NAME) };`), [
    "server-info-call",
  ]);
});

test("a serverInfo assembled by anything else is refused rather than trusted", () => {
  // Not a literal and not the builder. The gate cannot follow it, so it does not
  // pretend to: the property being proved is "one function assembles every
  // serverInfo", and an expression nobody can resolve does not prove it.
  assert.deepEqual(kinds("const r = { serverInfo: cached };"), ["server-info-literal"]);
});

test("a version literal outside a serverInfo position is not this gate's business", () => {
  // The second negative control, and the reason this is an AST walk. Package
  // versions, skill-manifest versions and OpenAPI `info.version` are all
  // `version: "..."` and none of them is an MCP handshake.
  assert.deepEqual(kinds('const p = { name: "pkg", version: "0.1.0" };'), []);
  assert.deepEqual(kinds('const info = { title: "api", version: "M0.1" };'), []);
});

test("prose naming both axes is not a spelling", () => {
  // The contract module's own banner names `"2025-06-18"` and `"0.1.0"` while
  // explaining that nothing may spell them. A text scan would report the file
  // that fixes the problem as the file that has it.
  assert.deepEqual(
    kinds('// protocolVersion: "2025-06-18" used to be written here\nconst x = 1;'),
    [],
  );
});

test("a tool declaration is recognised by its four properties, and only by all four", () => {
  const handler =
    'const t = { name: "agents.list", description: "d", inputSchema: {}, execute: async () => 1 };';
  assert.deepEqual(findDeclaredToolNames("f.ts", handler), ["agents.list"]);
  // The negative control: the docs server's tool has three of the four and is a
  // DIFFERENT server's catalog, so it must not be counted into the platform's.
  assert.deepEqual(
    findDeclaredToolNames("f.ts", 'const t = { name: "search_docs", description: "d", inputSchema: {} };'),
    [],
  );
});

// ---------------------------------------------------------------------------
// THE JUDGEMENT — every code reachable
// ---------------------------------------------------------------------------

function syntheticScan(overrides = {}) {
  return {
    fileCount: 1,
    spellings: [],
    declaredTools: [{ name: "agents.list", path: `${PLATFORM_TOOLS_DIR}/index.ts` }],
    constants: new Map([
      ["PLATOS_MCP_CONTRACT_MAJOR", 1],
      ["MCP_PROTOCOL_VERSION", "2025-06-18"],
      ["PLATFORM_MCP_SCOPES", ["mcp:read", "mcp:write"]],
      ["ENTITY_MCP_SCOPES", ["mcp:tools"]],
    ]),
    manifest: {
      mcpContract: {
        version: "1.0.0",
        major: 1,
        protocolVersion: "2025-06-18",
        catalogDigest: "a".repeat(64),
        platformScopes: ["mcp:read", "mcp:write"],
        entityScopes: ["mcp:tools"],
      },
      inventories: { mcpTools: [{ name: "agents.list", schemaHash: "b".repeat(64) }] },
    },
    ...overrides,
  };
}

const codesOf = (result) => [...new Set(result.violations.map((v) => v.code))].sort();

test("a clean synthetic tree raises nothing — the controls below are not vacuous", () => {
  assert.deepEqual(judge(syntheticScan()).violations, []);
});

test("MCP-1: a protocol literal outside the contract module is refused", () => {
  const result = judge(
    syntheticScan({
      spellings: [{ path: "apps/agent/src/x.ts", line: 3, kind: "protocol-literal", value: "2025-06-18" }],
    }),
  );
  assert.deepEqual(codesOf(result), ["MCP-1-PROTOCOL_LITERAL"]);
});

test("MCP-1/2: the contract module itself is exempt, and only it", () => {
  const result = judge(
    syntheticScan({
      spellings: [
        { path: CONTRACT_MODULE, line: 9, kind: "protocol-literal", value: "2025-06-18" },
        { path: CONTRACT_MODULE, line: 11, kind: "server-info-literal", value: "1.0.0" },
      ],
    }),
  );
  assert.deepEqual(result.violations, []);
});

test("MCP-2: a hand-assembled serverInfo is refused", () => {
  const result = judge(
    syntheticScan({
      spellings: [{ path: "apps/agent/src/y.ts", line: 5, kind: "server-info-literal", value: "0.1.0" }],
    }),
  );
  assert.deepEqual(codesOf(result), ["MCP-2-SERVER_INFO_LITERAL"]);
});

test("MCP-3: a major the servers did not report is refused", () => {
  const scanned = syntheticScan();
  scanned.constants.set("PLATOS_MCP_CONTRACT_MAJOR", 2);
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-3-CONTRACT_DRIFT"]);
});

test("MCP-3: a protocol revision the servers did not report is refused", () => {
  const scanned = syntheticScan();
  scanned.constants.set("MCP_PROTOCOL_VERSION", "2024-11-05");
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-3-CONTRACT_DRIFT"]);
});

test("MCP-3: a NARROWED scope set is refused — the change no client can observe", () => {
  // ADR M0.4 §4: removing a grant is invisible to a client whose token still
  // validates, which is why it must bump the major. This is the only place the
  // change is observable at all.
  const scanned = syntheticScan();
  scanned.constants.set("PLATFORM_MCP_SCOPES", ["mcp:read"]);
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-3-CONTRACT_DRIFT"]);
});

test("MCP-3: a missing contract block is refused rather than skipped", () => {
  const scanned = syntheticScan();
  delete scanned.manifest.mcpContract;
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-3-CONTRACT_DRIFT"]);
});

test("MCP-4: a tool declared in source and absent from the manifest is refused", () => {
  const scanned = syntheticScan();
  scanned.declaredTools.push({ name: "agents.create", path: `${PLATFORM_TOOLS_DIR}/index.ts` });
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-4-CATALOG_DRIFT"]);
});

test("MCP-4: a tool in the manifest and absent from source is refused", () => {
  const scanned = syntheticScan();
  scanned.manifest.inventories.mcpTools.push({ name: "ghost.tool", schemaHash: "c".repeat(64) });
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-4-CATALOG_DRIFT"]);
});

test("MCP-4: a manifest tool with no schemaHash is refused", () => {
  const scanned = syntheticScan();
  scanned.manifest.inventories.mcpTools[0].schemaHash = undefined;
  assert.deepEqual(codesOf(judge(scanned)), ["MCP-4-CATALOG_DRIFT"]);
});

test("every declared violation code is reachable", () => {
  // Without this, a code could be deleted from the judgement and only its
  // declaration would remain — a refusal nothing can produce.
  const raised = new Set();
  const cases = [
    { spellings: [{ path: "a.ts", line: 1, kind: "protocol-literal", value: "x" }] },
    { spellings: [{ path: "a.ts", line: 1, kind: "server-info-literal", value: "x" }] },
  ];
  for (const override of cases) for (const v of judge(syntheticScan(override)).violations) raised.add(v.code);
  const drift = syntheticScan();
  drift.constants.set("PLATOS_MCP_CONTRACT_MAJOR", 9);
  for (const v of judge(drift).violations) raised.add(v.code);
  const catalog = syntheticScan();
  catalog.manifest.inventories.mcpTools = [];
  for (const v of judge(catalog).violations) raised.add(v.code);
  assert.deepEqual([...raised].sort(), [...VIOLATION_CODES].sort());
});

// ---------------------------------------------------------------------------
// THE LIVE TREE
// ---------------------------------------------------------------------------

test("the live tree is clean", () => {
  const result = analyse();
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
});

test("the live tree carries exactly three MCP servers, all through one builder", () => {
  const result = analyse();
  // Platform (`mcp-router.ts`), Entity (`mcp-entity.controller.ts`) and Docs
  // (`docs-mcp.controller.ts`). A fourth would be a surface nobody versioned.
  assert.equal(result.serverCount, 3);
  assert.equal(result.literalCount, 0);
});

test("the constants the gate reads are the constants the module exports", () => {
  // A join to the module's own runtime rather than to the parse: if the AST
  // reader ever failed to see an initializer it would silently return an empty
  // map and every MCP-3 comparison would pass against `undefined`.
  const constants = readContractConstants(readFileSync(join(repositoryRoot, CONTRACT_MODULE), "utf8"));
  assert.equal(typeof constants.get("MCP_PROTOCOL_VERSION"), "string");
  assert.equal(typeof constants.get("PLATOS_MCP_CONTRACT_MAJOR"), "number");
  assert.ok(Array.isArray(constants.get("PLATFORM_MCP_SCOPES")));
  assert.ok(Array.isArray(constants.get("ENTITY_MCP_SCOPES")));
});

test("the tool count is corroborated by an independent text scan", () => {
  // A DIFFERENT TOOL AND A DIFFERENT DEFINITION. `git grep -c` over the
  // declaration line shape counts occurrences of a source pattern; the gate
  // counts object literals with four properties. They are required to agree, and
  // a disagreement means one of the two has stopped seeing part of the tree.
  const result = analyse();
  const output = execFileSync(
    "grep",
    [
      "-rEh",
      '^[[:space:]]+name: "[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+",$',
      PLATFORM_TOOLS_DIR,
      "--include=*.ts",
      "--exclude=*.test.ts",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const textCount = output.split("\n").filter((line) => line.trim() !== "").length;
  assert.equal(
    result.declaredToolCount,
    textCount,
    `AST walk found ${String(result.declaredToolCount)} tool declarations; the text scan found ${String(textCount)}`,
  );
});

test("the manifest's tool inventory is the source's, name for name", () => {
  const scanned = scan();
  const declared = [...new Set(scanned.declaredTools.map((tool) => tool.name))].sort();
  const inventory = scanned.manifest.inventories.mcpTools.map((tool) => tool.name).sort();
  assert.deepEqual(declared, inventory);
  // NOT VACUOUS. Two empty sets are equal, and this file's whole value would be
  // a tree with no tools in it.
  assert.ok(declared.length > 100, `expected a real catalog; found ${String(declared.length)}`);
});

test("the committed manifest carries the contract block the servers report", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, MANIFEST), "utf8"));
  assert.equal(typeof manifest.mcpContract.catalogDigest, "string");
  assert.match(manifest.mcpContract.catalogDigest, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.mcpContract.rateTableVersion, null);
  // Every tool carries its own hash, which is what makes a narrowed input schema
  // a visible diff rather than a silent break (ADR M0.4 §5).
  for (const tool of manifest.inventories.mcpTools) {
    assert.match(tool.schemaHash, /^[0-9a-f]{64}$/u, `${tool.name} has no schema hash`);
  }
});
