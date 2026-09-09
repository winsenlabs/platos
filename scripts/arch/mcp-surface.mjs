#!/usr/bin/env node
// WIN-268 (M4.2) P1 — THE MCP VERSION IS SPELLED ONCE, AND A SECOND SPELLING IS
// REFUSED RATHER THAN MERELY ABSENT.
//
//   node scripts/arch/mcp-surface.mjs           # check, exit 1 on violation
//   node scripts/arch/mcp-surface.mjs --json    # machine-readable
//   node scripts/arch/mcp-surface.mjs --report  # every spelling found, with its file
//
// ---------------------------------------------------------------------------
// WHY A LINT AND NOT A CONSTANT
//
// ADR M0.4 §2's REST row asks for a "no-bare-prefix lint (fail on any literal
// `api/v1`)" and `scripts/arch/contract-map.mjs` implements it, because the
// milestone had already learned that 24 controllers will each spell a prefix by
// hand if nothing stops them. The MCP row asks for the same discipline on a
// different axis — "one `PLATOS_MCP_CONTRACT` const (replaces `0.1.0` hardcoded
// in 3 files)" — and the same reasoning applies with more force, because an MCP
// version is invisible: a REST prefix that drifts 404s on the first request,
// while a server reporting the wrong `serverInfo.version` answers every request
// correctly and lies only to the client's compatibility logic.
//
// MEASURED BEFORE THE CHANGE, so the number this gate holds at zero is a real
// one rather than an aspiration. At `v1` @ 3b3f1ebb the tree carried SEVEN MCP
// version literals across THREE files:
//
//   apps/agent/src/mcp-platform/mcp-router.ts          :245 protocol, :252 contract
//   apps/agent/src/mcp-platform/mcp-entity.controller.ts :907 protocol, :911 contract
//   apps/agent/src/mcp-docs/docs-mcp.controller.ts     :262 protocol, :268 contract,
//                                                      :141 contract (the GET probe)
//
// ---------------------------------------------------------------------------
// THE FOUR THINGS IT REFUSES
//
//   MCP-1 PROTOCOL_LITERAL     a string literal in a `protocolVersion:` position
//   MCP-2 SERVER_INFO_LITERAL  a `serverInfo:` built as an object literal instead
//                              of by calling `mcpServerInfo(...)`
//   MCP-3 CONTRACT_DRIFT       the const and the generated manifest disagree
//   MCP-4 CATALOG_DRIFT        the manifest's tool count is not the number of
//                              tool handlers declared in the source tree
//
// MCP-2 IS A SHAPE RULE AND NOT A LITERAL RULE, deliberately. Refusing only the
// literal would let a file write `serverInfo: { name, version: someLocalConst }`
// and reintroduce the divergence one indirection later — which is exactly what
// the docs server's capability probe did with `"0.1.0"` while its handshake
// spelled the same number separately. Requiring the CALL means every server's
// `serverInfo` is assembled by one function, so the `_meta` contract block
// cannot be present on two servers and missing on the third.
//
// ---------------------------------------------------------------------------
// MCP-3 AND MCP-4 ARE THE HALF THAT CANNOT BE FAKED
//
// The 2026-09-02 verification's standing finding: an assertion comparing two
// things you control cannot fail. A lint that only checked "no literals outside
// this file" compares the tree to itself, and would pass on a tree whose one
// constant said something no server had ever reported.
//
// So the const is READ FROM THE SOURCE by an AST walk here, and joined to
// `operation-manifest.generated.json` — an artifact produced by a completely
// different mechanism (`apps/agent/scripts/generate-control-plane.mjs` EXECUTES
// the servers' own modules through `runtime-mcp-catalog.ts` and records what
// they report) and byte-compared by its own `--check`. The two agree only if the
// declaration and the runtime agree.
//
// And MCP-4 answers the question the tranche was told to answer rather than
// assume: HOW MANY TOOLS DOES PLATFORM MCP DECLARE? It is counted here, from the
// declarations, by a matcher written independently of the generator's, and
// required to equal the manifest's inventory. At 3b3f1ebb both say 202 across 35
// namespaces in 21 files, so the figure carried in ADR M0.4 §2 is CORRECT — and
// from here it cannot drift without a named failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The one file allowed to spell either version axis. */
export const CONTRACT_MODULE = "apps/agent/src/http/mcp-surface.ts";

/** The manifest the const is joined to. Produced by a different mechanism. */
export const MANIFEST = "apps/agent/src/control-plane/operation-manifest.generated.json";

/** Where platform MCP tool handlers are declared. */
export const PLATFORM_TOOLS_DIR = "apps/agent/src/mcp-platform/tools";

/** The trees a production MCP server could live in. */
export const SCAN_ROOTS = Object.freeze(["apps", "packages", "internal-packages"]);

export const VIOLATION_CODES = Object.freeze([
  "MCP-1-PROTOCOL_LITERAL",
  "MCP-2-SERVER_INFO_LITERAL",
  "MCP-3-CONTRACT_DRIFT",
  "MCP-4-CATALOG_DRIFT",
]);

/**
 * The builder every `serverInfo` must be produced by.
 *
 * Named rather than inferred so the failure message can say what to call, and so
 * renaming the function is a deliberate edit to this gate rather than a silent
 * widening of it.
 */
export const SERVER_INFO_BUILDER = "mcpServerInfo";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  "generated",
]);

function isProductionSource(path) {
  if (!/\.(?:ts|tsx)$/u.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  return !/\.(?:test|spec)\.tsx?$/u.test(path);
}

export function walk(directory, out = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function sourceFile(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

function lineOf(file, node) {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function propertyName(property) {
  const name = property.name;
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function isStringish(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * Every MCP version spelling in one source string.
 *
 * AN AST WALK AND NOT A TEXT SCAN, for the reason `env-access.mjs` gives about
 * `process.env`: this repository documents its decisions in prose, and the
 * banner of the contract module names both `"2025-06-18"` and `"0.1.0"` while
 * explaining that nothing may spell them. A line scan would report the file that
 * FIXES the problem as the file that has it, and would then be weakened until it
 * was quiet.
 */
export function findMcpVersionSpellings(path, source) {
  const file = sourceFile(path, source);
  const found = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      if (name === "protocolVersion" && isStringish(node.initializer)) {
        found.push({
          path,
          line: lineOf(file, node),
          kind: "protocol-literal",
          value: node.initializer.text,
        });
      }
      if (name === "serverInfo") {
        const initializer = node.initializer;
        if (ts.isObjectLiteralExpression(initializer)) {
          const version = initializer.properties.find(
            (property) => propertyName(property) === "version",
          );
          found.push({
            path,
            line: lineOf(file, node),
            kind: "server-info-literal",
            value:
              version !== undefined &&
              ts.isPropertyAssignment(version) &&
              isStringish(version.initializer)
                ? version.initializer.text
                : "(non-literal)",
          });
        } else if (
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === SERVER_INFO_BUILDER
        ) {
          found.push({ path, line: lineOf(file, node), kind: "server-info-call", value: SERVER_INFO_BUILDER });
        } else {
          // Neither a literal nor the builder: a variable, a spread, a
          // conditional. Reported as a literal-class violation because the
          // property it is proving is "one function assembles every serverInfo",
          // and an expression this gate cannot follow does not prove it.
          found.push({ path, line: lineOf(file, node), kind: "server-info-literal", value: "(indirect)" });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The contract constants, read out of the ONE module by AST.
 *
 * Read rather than imported so this gate needs no TypeScript runtime and no
 * build step, which is what lets it run in the same breath as the other
 * `scripts/arch` audits.
 */
export function readContractConstants(source) {
  const file = sourceFile(CONTRACT_MODULE, source);
  const values = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = node.initializer;
      if (isStringish(initializer)) values.set(node.name.text, initializer.text);
      else if (ts.isNumericLiteral(initializer)) values.set(node.name.text, Number(initializer.text));
      else if (
        ts.isAsExpression(initializer) &&
        ts.isArrayLiteralExpression(initializer.expression) &&
        initializer.expression.elements.every((element) => isStringish(element))
      ) {
        values.set(
          node.name.text,
          initializer.expression.elements.map((element) => element.text),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

/**
 * The platform MCP tool handlers DECLARED in the source tree.
 *
 * The shape is the one the tool factories use: an object literal carrying
 * `name`, `description`, `inputSchema` and `execute`. It is deliberately the
 * same predicate `generate-control-plane.mjs` uses, written separately, because
 * the point of the join is that two independent walks of the same tree produce
 * the same set — not that one walk agrees with itself.
 */
export function findDeclaredToolNames(path, source) {
  const file = sourceFile(path, source);
  const names = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Set(
        node.properties.map((property) => propertyName(property)).filter((name) => name !== null),
      );
      if (
        properties.has("name") &&
        properties.has("description") &&
        properties.has("inputSchema") &&
        properties.has("execute")
      ) {
        const nameProperty = node.properties.find((property) => propertyName(property) === "name");
        if (
          nameProperty !== undefined &&
          ts.isPropertyAssignment(nameProperty) &&
          isStringish(nameProperty.initializer)
        ) {
          names.push(nameProperty.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

export function scan() {
  const spellings = [];
  let fileCount = 0;
  for (const root of SCAN_ROOTS) {
    for (const absolute of walk(join(repositoryRoot, root))) {
      if (!isProductionSource(absolute)) continue;
      fileCount += 1;
      const path = relative(repositoryRoot, absolute).split("\\").join("/");
      const source = readFileSync(absolute, "utf8");
      // A cheap pre-filter so the AST is only built for files that could carry
      // one. It is a SUPERSET of what the walk matches, so nothing is missed:
      // every spelling the AST finds names one of these two properties.
      if (!source.includes("protocolVersion") && !source.includes("serverInfo")) continue;
      spellings.push(...findMcpVersionSpellings(path, source));
    }
  }

  const declaredTools = [];
  for (const absolute of walk(join(repositoryRoot, PLATFORM_TOOLS_DIR))) {
    if (!isProductionSource(absolute)) continue;
    const path = relative(repositoryRoot, absolute).split("\\").join("/");
    for (const name of findDeclaredToolNames(path, readFileSync(absolute, "utf8"))) {
      declaredTools.push({ name, path });
    }
  }

  const constants = readContractConstants(readFileSync(join(repositoryRoot, CONTRACT_MODULE), "utf8"));
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, MANIFEST), "utf8"));

  return { fileCount, spellings, declaredTools, constants, manifest };
}

function expect(violations, code, condition, message) {
  if (!condition) violations.push({ code, path: CONTRACT_MODULE, line: 0, message });
}

export function judge(result) {
  const violations = [];

  for (const spelling of result.spellings) {
    if (spelling.path === CONTRACT_MODULE) continue;
    if (spelling.kind === "protocol-literal") {
      violations.push({
        code: "MCP-1-PROTOCOL_LITERAL",
        path: spelling.path,
        line: spelling.line,
        message:
          `protocolVersion is spelled as the literal ${JSON.stringify(spelling.value)}; ` +
          `import MCP_PROTOCOL_VERSION from ${CONTRACT_MODULE} instead. The MCP protocol date is ` +
          "negotiated with the client and is a different axis from the Platos contract major " +
          "(ADR M0.4 §2 MCP row, §7 D2).",
      });
    }
    if (spelling.kind === "server-info-literal") {
      violations.push({
        code: "MCP-2-SERVER_INFO_LITERAL",
        path: spelling.path,
        line: spelling.line,
        message:
          `serverInfo is assembled here (${spelling.value}) instead of by calling ${SERVER_INFO_BUILDER}(...) ` +
          `from ${CONTRACT_MODULE}. One builder is what keeps the _meta contract block on every server ` +
          "rather than on the two somebody remembered.",
      });
    }
  }

  const contract = result.manifest.mcpContract;
  expect(
    violations,
    "MCP-3-CONTRACT_DRIFT",
    contract !== undefined && contract !== null,
    `${MANIFEST} carries no mcpContract block; regenerate the control plane`,
  );
  if (contract !== undefined && contract !== null) {
    const major = result.constants.get("PLATOS_MCP_CONTRACT_MAJOR");
    const protocol = result.constants.get("MCP_PROTOCOL_VERSION");
    const platformScopes = result.constants.get("PLATFORM_MCP_SCOPES");
    const entityScopes = result.constants.get("ENTITY_MCP_SCOPES");
    expect(
      violations,
      "MCP-3-CONTRACT_DRIFT",
      major === contract.major,
      `the declared contract major (${JSON.stringify(major)}) is not the major the servers reported ` +
        `into the manifest (${JSON.stringify(contract.major)})`,
    );
    expect(
      violations,
      "MCP-3-CONTRACT_DRIFT",
      typeof contract.version === "string" && contract.version.startsWith(`${String(major)}.`),
      `the manifest's serverInfo.version (${JSON.stringify(contract.version)}) does not carry the ` +
        `declared major ${JSON.stringify(major)}`,
    );
    expect(
      violations,
      "MCP-3-CONTRACT_DRIFT",
      protocol === contract.protocolVersion,
      `the declared MCP protocol revision (${JSON.stringify(protocol)}) is not the one the servers ` +
        `reported (${JSON.stringify(contract.protocolVersion)})`,
    );
    expect(
      violations,
      "MCP-3-CONTRACT_DRIFT",
      JSON.stringify(platformScopes) === JSON.stringify(contract.platformScopes),
      `the declared platform scope set (${JSON.stringify(platformScopes)}) is not the one the manifest ` +
        `records (${JSON.stringify(contract.platformScopes)}); narrowing one is a v2 event (ADR M0.4 §4)`,
    );
    expect(
      violations,
      "MCP-3-CONTRACT_DRIFT",
      JSON.stringify(entityScopes) === JSON.stringify(contract.entityScopes),
      `the declared entity scope set (${JSON.stringify(entityScopes)}) is not the one the manifest ` +
        `records (${JSON.stringify(contract.entityScopes)}); narrowing one is a v2 event (ADR M0.4 §4)`,
    );
    expect(
      violations,
      "MCP-3-CONTRACT_DRIFT",
      typeof contract.catalogDigest === "string" && /^[0-9a-f]{64}$/u.test(contract.catalogDigest),
      `the manifest's catalogDigest is not a sha-256 digest (${JSON.stringify(contract.catalogDigest)})`,
    );
  }

  const manifestTools = result.manifest.inventories.mcpTools.map((tool) => tool.name).sort();
  const declaredNames = result.declaredTools.map((tool) => tool.name).sort();
  const onlyDeclared = declaredNames.filter((name) => !manifestTools.includes(name));
  const onlyManifest = manifestTools.filter((name) => !declaredNames.includes(name));
  expect(
    violations,
    "MCP-4-CATALOG_DRIFT",
    onlyDeclared.length === 0 && onlyManifest.length === 0,
    `the platform MCP catalog measured from ${PLATFORM_TOOLS_DIR} (${String(declaredNames.length)} tools) ` +
      `is not the manifest's inventory (${String(manifestTools.length)} tools): ` +
      `${String(onlyDeclared.length)} declared-only, ${String(onlyManifest.length)} manifest-only`,
  );
  expect(
    violations,
    "MCP-4-CATALOG_DRIFT",
    result.manifest.inventories.mcpTools.every(
      (tool) => typeof tool.schemaHash === "string" && /^[0-9a-f]{64}$/u.test(tool.schemaHash),
    ),
    "every manifest tool must carry a sha-256 schemaHash (ADR M0.4 §5)",
  );

  return {
    fileCount: result.fileCount,
    spellingCount: result.spellings.length,
    literalCount: result.spellings.filter(
      (spelling) => spelling.path !== CONTRACT_MODULE && spelling.kind !== "server-info-call",
    ).length,
    serverCount: result.spellings.filter((spelling) => spelling.kind === "server-info-call").length,
    declaredToolCount: result.declaredTools.length,
    manifestToolCount: manifestTools.length,
    namespaceCount: new Set(declaredNames.map((name) => name.split(".")[0])).size,
    toolFileCount: new Set(result.declaredTools.map((tool) => tool.path)).size,
    spellings: result.spellings,
    violations,
  };
}

export function analyse() {
  return judge(scan());
}

function main(argv) {
  const result = analyse();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.violations.length === 0 ? 0 : 1;
    return;
  }
  if (argv.includes("--report")) {
    for (const spelling of result.spellings) {
      console.log(`  ${spelling.path}:${String(spelling.line)} ${spelling.kind} ${spelling.value}`);
    }
  }
  console.log(
    `mcp-surface: scanned ${String(result.fileCount)} production source file(s) under ${SCAN_ROOTS.join(", ")}; ` +
      `${String(result.serverCount)} server(s) build serverInfo through ${SERVER_INFO_BUILDER}, ` +
      `${String(result.literalCount)} hand-spelled version(s) outside ${CONTRACT_MODULE}; ` +
      `platform MCP declares ${String(result.declaredToolCount)} tool(s) across ` +
      `${String(result.namespaceCount)} namespace(s) in ${String(result.toolFileCount)} file(s), ` +
      `joined to the manifest's ${String(result.manifestToolCount)}`,
  );
  for (const violation of result.violations) {
    const where = violation.line > 0 ? `${violation.path}:${String(violation.line)}` : violation.path;
    console.log(`${violation.code} ${where}: ${violation.message}`);
  }
  if (result.violations.length > 0) {
    console.log(`FAIL: ${String(result.violations.length)} MCP surface violation(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "ok: both MCP version axes are spelled once, every server builds its serverInfo through the one " +
      "builder, and the declared catalog is the manifest's catalog.",
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) main(process.argv.slice(2));
