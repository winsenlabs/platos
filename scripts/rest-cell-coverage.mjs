#!/usr/bin/env node
// WIN-267 — THE PER-REST-CELL COVERAGE REGISTER.
//
// The clause is "all capability-matrix REST cells have contract/integration
// tests". Until now nothing in the tree could answer it per cell. Three
// artifacts looked as though they might and none of them did:
//
//   * `route-capability-parity --completion` measures 107 webapp Remix route
//     capabilities. Its `http` entries name 29 distinct method+endpoint pairs,
//     so a fully green completion gate speaks for 29 of the REST cells.
//   * `differential-coverage` counts TWIN-RUN scenarios, not test cases, so a
//     cell exercised by an integration suite still reads `uncovered` there.
//   * `capability-matrix` enumerates the cells and carries no test field at all.
//
// This register is the missing join. For every REST operation the M0.2 matrix
// enumerates it names the contract or integration test cases that exercise it,
// and the join is DERIVED on every run from two things this file does not own:
//
//   THE LEFT   `docs/audits/M0.2-capability-matrix.json` surfaces.rest, and
//              `apps/agent/src/control-plane/operation-manifest.generated.json`
//              for each cell's controller/handler implementations. The two are
//              reconciled against each other first: a cell with no manifest
//              operation, or a manifest operation with no cell, fails the run
//              before any coverage is computed. Neither is written here.
//   THE RIGHT  every tracked test file, enumerated from `git ls-files` — the
//              INDEX, not a directory walk of a warm tree — and parsed. There
//              is no list of test files in this repository to keep current and
//              none is introduced here.
//
// WHAT "EXERCISES" MEANS, AND ITS STATED LIMITS.
//
// Two evidence kinds, both mechanical, both deliberately CONSERVATIVE, because
// the failure that matters for this clause is claiming coverage that does not
// exist. Under-counting leaves work visible; over-counting deletes it.
//
//   `handler`  the test file binds the implementing controller — `new
//              XController(`, a Nest `get(XController)`/`resolve(XController)`,
//              or a `: XController` annotation — and calls `.<handler>(`. This
//              is how every apps/agent controller suite in this tree is
//              written.
//   `http`     the test file issues a request whose METHOD and PATH normalise
//              onto the cell's route template. A literal segment in the
//              template must be matched EXACTLY; only a `:param` segment
//              accepts an arbitrary value. A path that matches more than one
//              cell joins NONE of them and is recorded as ambiguous, so a
//              vague URL can never inflate two rows at once.
//
// NEITHER KIND PROVES AN ASSERTION. A test that calls a handler and asserts
// nothing joins here exactly as one that asserts everything does. That is a
// limit, it is stated in the artifact as well as here, and it is the right
// trade for this gate: the register's job is to find the cells NOTHING touches,
// and for that a lower bound on execution is the sound direction to err in.
//
// THE M3.1 CARVE-OUT IS A DEPENDENCY, NOT A COVERAGE CLAIM. Decision D14 carves
// the AgentController cells out to WIN-261 (M3.1), which owns that file. They
// are recorded with status `m3.1-dependency` and counted in NEITHER the covered
// nor the residue total; the artifact publishes all three numbers so the
// carve-out cannot be mistaken for progress. A carved-out cell that happens to
// be joined anyway still reports its evidence, so the carve-out never hides
// work already done.
//
// Usage: node scripts/rest-cell-coverage.mjs [--write|--check]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export const JSON_PATH = "docs/audits/win-267-rest-cell-coverage.json";
export const CAPABILITY_MATRIX_PATH = "docs/audits/M0.2-capability-matrix.json";
export const MANIFEST_PATH = "apps/agent/src/control-plane/operation-manifest.generated.json";

/** The controller M3.1 owns. Decision D14; standing scope boundary of 2026-09-15. */
export const M31_CONTROLLER = "AgentController";
export const M31_OWNER = "WIN-261 (M3.1)";

/**
 * Which test files are read. This is a PATTERN over the index, not a list.
 *
 * `.test.` and `.spec.` are the two suffixes this repository uses; the four
 * extensions are the ones its runners load. A suite that lands under a new
 * extension is invisible here, which would UNDER-count, so the residue stays a
 * lower bound rather than becoming a false claim.
 */
export const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/u;

export const HTTP_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export const STATUSES = Object.freeze(["covered", "uncovered", "m3.1-dependency"]);

export const EVIDENCE_KINDS = Object.freeze([
  Object.freeze({
    id: "handler",
    derivation:
      "the test file binds the implementing controller (new X(...), Nest get(X)/resolve(X), or a : X annotation) " +
      "and calls the manifest's handler method on something",
    limit:
      "it does not prove the call asserted anything, and a file binding two controllers that share a handler name " +
      "joins both",
  }),
  Object.freeze({
    id: "http",
    derivation:
      "the test file issues a request whose method and normalised path land on the cell's route template; literal " +
      "template segments must match exactly and a path matching more than one cell joins none",
    limit:
      "a URL composed at run time from values this parser cannot see is invisible, so a tested cell can read as " +
      "residue; that is the safe direction",
  }),
]);

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/**
 * Every tracked test file, from the index.
 *
 * `git ls-files` rather than a directory walk: an audit that hashes a warm
 * working tree reports on files no reviewer will ever see, and this programme
 * has already paid for that once.
 */
export function enumerateTestFiles(root = repositoryRoot) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return listed
    .split("\0")
    .filter((path) => path !== "" && TEST_FILE_PATTERN.test(path))
    .sort();
}

// ---------------------------------------------------------------------------
// The `handler` evidence kind
// ---------------------------------------------------------------------------

const CONTROLLER_BINDING = new RegExp(
  String.raw`\b(?:new\s+([A-Z][A-Za-z0-9_]*Controller)\s*\(` +
    String.raw`|(?:get|resolve)\(\s*([A-Z][A-Za-z0-9_]*Controller)\s*\)` +
    String.raw`|:\s*([A-Z][A-Za-z0-9_]*Controller)\b)`,
  "gu",
);

/** The controller classes a test file actually instantiates or resolves. */
export function extractControllerBindings(text) {
  const bound = new Set();
  for (const match of text.matchAll(CONTROLLER_BINDING)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) bound.add(name);
  }
  return bound;
}

export function callsHandler(text, handler) {
  if (!/^[A-Za-z_$][\w$]*$/u.test(handler)) return false;
  return new RegExp(String.raw`\.${handler}\s*\(`, "u").test(text);
}

// ---------------------------------------------------------------------------
// The `http` evidence kind
// ---------------------------------------------------------------------------

const STRING_LITERAL = String.raw`(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\x60((?:\\.|[^\x60\\])*)\x60)`;

/**
 * Local path builders, so a suite that names its routes once is still readable.
 *
 * `const variables = (environment) => \`/environments/${environment}/variables\``
 * is how `identity-tenancy-rest.integration.test.ts` writes two of its routes.
 * Without one level of expansion those two cells would read as residue while a
 * real suite exercises them, which is a WRONG residue rather than a cautious
 * one. Expansion is ONE level deep and only over `const` bindings in the same
 * file: anything deeper is a program, and a register that runs a program to
 * find its routes has stopped being a register.
 */
export function extractLocalTemplates(text) {
  const templates = new Map();
  const declarations = [
    // const NAME = "…" | const NAME = (args) => `…`
    new RegExp(
      String.raw`\bconst\s+([A-Za-z_$][\w$]*)\s*(?:=\s*\([^)]*\)\s*(?::\s*[^=]+)?=>\s*|=\s*)` + STRING_LITERAL,
      "gu",
    ),
    // function NAME(args): string { return `…` }
    new RegExp(
      String.raw`\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*return\s*` + STRING_LITERAL,
      "gu",
    ),
  ];
  for (const declaration of declarations) {
    for (const match of text.matchAll(declaration)) {
      const name = match[1];
      const value = match[2] ?? match[3] ?? match[4];
      if (name === undefined || value === undefined) continue;
      if (!templates.has(name)) templates.set(name, value);
    }
  }
  // One more pass for `const path = otherBuilder(...)`, which is how a suite
  // that already named its route once uses it a second time. Resolving it is
  // the difference between a residue row that is TRUE and one that says "no
  // test touches this" about a route a suite fetches on every case.
  const alias = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/gu;
  for (const match of text.matchAll(alias)) {
    const name = match[1];
    const source = match[2];
    if (name === undefined || source === undefined || templates.has(name)) continue;
    const value = templates.get(source);
    if (value !== undefined) templates.set(name, value);
  }
  return templates;
}

/**
 * Normalises a path expression as written in a test into a comparable path.
 *
 * A LEADING interpolation is a base URL or a version prefix — `${base}`,
 * `${API_VERSION_PREFIX}` — and is dropped rather than turned into a wildcard
 * segment, because it stands for zero or more segments this parser cannot
 * resolve and the match is a SUFFIX match anyway. Every other interpolation
 * becomes exactly one wildcard segment, which is what a path parameter is.
 */
export function normalisePathExpression(expression, templates = new Map()) {
  let text = expression;
  for (let round = 0; round < 2; round += 1) {
    text = text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*(?:\([^{}]*\))?\s*\}/gu, (whole, name) => {
      const replacement = templates.get(name);
      return replacement === undefined ? whole : replacement;
    });
  }
  text = text.replace(/^\$\{[^{}]*\}/u, "");
  if (!text.startsWith("/")) return null;
  text = text.split("?")[0] ?? "";
  text = text.split("#")[0] ?? "";
  text = text.replace(/\$\{[^{}]*\}/gu, "*");
  text = text.replace(/\/{2,}/gu, "/");
  if (text.length > 1) text = text.replace(/\/+$/u, "");
  return text === "" ? null : text;
}

const CALL_SITE_PATTERNS = Object.freeze([
  // call("POST", "/bff/session"), request("GET", `${PREFIX}/projects`)
  new RegExp(String.raw`["'](${HTTP_METHODS.join("|")})["']\s*,\s*${STRING_LITERAL}`, "gu"),
  // call("GET", variables(ID.env)) — the path is a local builder, not a literal
  new RegExp(String.raw`["'](${HTTP_METHODS.join("|")})["']\s*,\s*([A-Za-z_$][\w$]*)\s*\(`, "gu"),
  // supertest and friends: request(app).post("/mcp/platform/tokens")
  new RegExp(String.raw`\.(${HTTP_METHODS.map((method) => method.toLowerCase()).join("|")})\(\s*${STRING_LITERAL}`, "gu"),
  // fetch/inject option objects: { method: "PUT", url: "/x" }
  new RegExp(
    String.raw`method\s*:\s*["'](${HTTP_METHODS.join("|")})["'][\s\S]{0,200}?url\s*:\s*${STRING_LITERAL}`,
    "gu",
  ),
  // `fetch(url)` with no method is a GET, by the fetch standard. The method is
  // a constant of the FORM rather than a token in the source, so it is written
  // into the pattern as one — omitting this kind would make every plain
  // `fetch` invisible and put genuinely exercised GET cells in the residue.
  new RegExp(String.raw`\b(fetch)\(\s*${STRING_LITERAL}`, "gu"),
]);

/** The capture groups of the `fetch(` pattern carry a function name, not a method. */
const IMPLICIT_GET = "FETCH";

const BUILDER_CALL = new RegExp(String.raw`^["'](${HTTP_METHODS.join("|")})["']\s*,\s*([A-Za-z_$][\w$]*)\s*\($`, "u");

/** Every (method, path) request this test file issues, as far as the source says. */
export function extractHttpCallSites(text) {
  const templates = extractLocalTemplates(text);
  const sites = [];
  for (const pattern of CALL_SITE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const token = (match[1] ?? "").toUpperCase();
      const method = token === IMPLICIT_GET ? "GET" : token;
      if (!HTTP_METHODS.includes(method)) continue;
      let expression = match[2] ?? match[3] ?? match[4];
      const builder = BUILDER_CALL.exec(match[0]);
      if (builder !== null) {
        expression = templates.get(builder[2] ?? "");
        if (expression === undefined) continue;
      }
      if (expression === undefined) continue;
      const path = normalisePathExpression(expression, templates);
      if (path === null) continue;
      sites.push({ method, path });
    }
  }
  return sites;
}

function segmentsOf(path) {
  return path.split("/").filter((segment) => segment !== "");
}

/**
 * Does a path written in a test land on this route template?
 *
 * SUFFIX match, because a test composes its base URL and version prefix from a
 * constant this parser dropped. A LITERAL template segment must be matched
 * exactly — a wildcard does NOT satisfy one — so `/agent/skills/*` cannot claim
 * `/agent/skills/health`. A `:param` segment accepts anything, which is what a
 * parameter is. At least one literal segment must participate, so a bare
 * `/*\/*` matches nothing.
 */
export function matchesRouteTemplate(testPath, cellPath) {
  const test = segmentsOf(testPath);
  const cell = segmentsOf(cellPath);
  if (test.length === 0 || test.length > cell.length) return false;
  const offset = cell.length - test.length;
  let literals = 0;
  for (let index = 0; index < test.length; index += 1) {
    const left = test[index] ?? "";
    const right = cell[offset + index] ?? "";
    if (right.startsWith(":")) continue;
    if (left !== right) return false;
    literals += 1;
  }
  return literals > 0;
}

// ---------------------------------------------------------------------------
// Reconciliation: the denominator is two artifacts agreeing, not one opinion
// ---------------------------------------------------------------------------

export function reconcileDenominator(restCells, manifestOperations) {
  const failures = [];
  const cellIds = new Set(restCells.map((cell) => cell.id));
  const manifestIds = new Set(manifestOperations.map((operation) => operation.id));
  const missingFromManifest = [...cellIds].filter((id) => !manifestIds.has(id)).sort();
  const missingFromMatrix = [...manifestIds].filter((id) => !cellIds.has(id)).sort();
  if (missingFromManifest.length > 0) {
    failures.push(
      `${missingFromManifest.length} capability-matrix REST cell(s) have no operation in ${MANIFEST_PATH}: ` +
        `${missingFromManifest.slice(0, 5).join(", ")}${missingFromManifest.length > 5 ? ", …" : ""}`,
    );
  }
  if (missingFromMatrix.length > 0) {
    failures.push(
      `${missingFromMatrix.length} manifest REST operation(s) are in no capability-matrix cell: ` +
        `${missingFromMatrix.slice(0, 5).join(", ")}${missingFromMatrix.length > 5 ? ", …" : ""}`,
    );
  }
  for (const operation of manifestOperations) {
    if (!Array.isArray(operation.implementations) || operation.implementations.length === 0) {
      failures.push(`manifest operation ${operation.id} names no implementation; it cannot be joined to a test`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export function buildRegister(input) {
  const { restCells, manifestOperations, testFiles } = input;
  const failures = [...reconcileDenominator(restCells, manifestOperations)];

  const operationById = new Map(manifestOperations.map((operation) => [operation.id, operation]));
  const byMethod = new Map();
  for (const operation of manifestOperations) {
    if (!byMethod.has(operation.method)) byMethod.set(operation.method, []);
    (byMethod.get(operation.method) ?? []).push(operation);
  }

  const evidence = new Map();
  const addEvidence = (id, kind, file) => {
    if (!evidence.has(id)) evidence.set(id, new Map());
    const perCell = evidence.get(id) ?? new Map();
    const key = `${kind}:${file}`;
    if (!perCell.has(key)) perCell.set(key, { kind, file });
  };

  const controllerIndex = new Map();
  let ambiguousSites = 0;
  let httpSites = 0;

  for (const { path: file, text } of testFiles) {
    for (const controller of extractControllerBindings(text)) {
      if (!controllerIndex.has(controller)) controllerIndex.set(controller, []);
      (controllerIndex.get(controller) ?? []).push(file);
    }
    for (const site of extractHttpCallSites(text)) {
      httpSites += 1;
      const candidates = (byMethod.get(site.method) ?? []).filter((operation) =>
        matchesRouteTemplate(site.path, operation.path),
      );
      if (candidates.length === 0) continue;
      if (candidates.length > 1) {
        ambiguousSites += 1;
        continue;
      }
      addEvidence((candidates[0] ?? {}).id, "http", file);
    }
  }

  const textByFile = new Map(testFiles.map((entry) => [entry.path, entry.text]));
  for (const operation of manifestOperations) {
    for (const implementation of operation.implementations ?? []) {
      for (const file of controllerIndex.get(implementation.controller) ?? []) {
        if (callsHandler(textByFile.get(file) ?? "", implementation.handler)) {
          addEvidence(operation.id, "handler", file);
        }
      }
    }
  }

  const rows = restCells
    .map((cell) => {
      const operation = operationById.get(cell.id);
      const implementations = operation?.implementations ?? [];
      const controllers = [...new Set(implementations.map((entry) => entry.controller))].sort();
      const sources = [...new Set(implementations.map((entry) => entry.source))].sort();
      const carvedOut = implementations.length > 0 && implementations.every((entry) => entry.controller === M31_CONTROLLER);
      const found = [...(evidence.get(cell.id) ?? new Map()).values()].sort((left, right) =>
        `${left.kind}${left.file}` < `${right.kind}${right.file}` ? -1 : 1,
      );
      const status = carvedOut ? "m3.1-dependency" : found.length > 0 ? "covered" : "uncovered";
      const row = {
        id: cell.id,
        method: cell.method,
        path: cell.path,
        owner: cell.owner,
        requiresOperator: Boolean(cell.requiresOperator),
        controllers,
        sources,
        status,
        evidence: found,
      };
      if (status === "m3.1-dependency") {
        row.blockedBy = M31_OWNER;
        row.reason =
          `served by ${M31_CONTROLLER}, which M3.1 owns (decision D14); this register records the dependency ` +
          "rather than counting the cell as covered";
      } else if (status === "uncovered") {
        row.blockedBy = "WIN-267";
        row.reason =
          "no tracked test file yields either join: none binds an implementing controller and calls its handler, " +
          "and no resolvable request site lands on this route template. A suite that composes its URL at run time " +
          "from a value this parser cannot read reaches here too, which is why the row states what was MEASURED " +
          "rather than claiming nothing exercises the cell";
      }
      return row;
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return { rows, failures, telemetry: { httpSites, ambiguousSites, testFiles: testFiles.length } };
}

export function summarise(rows) {
  const byStatus = { covered: 0, uncovered: 0, "m3.1-dependency": 0 };
  const byEvidenceKind = { handler: 0, http: 0 };
  const byDeployable = {};
  for (const row of rows) {
    byStatus[row.status] += 1;
    const kinds = new Set(row.evidence.map((entry) => entry.kind));
    for (const kind of kinds) byEvidenceKind[kind] += 1;
    for (const source of row.sources) {
      const deployable = source.startsWith("apps/core-api") ? "apps/core-api" : source.startsWith("apps/agent") ? "apps/agent" : "other";
      byDeployable[deployable] ??= { cells: 0, covered: 0, uncovered: 0, "m3.1-dependency": 0 };
      byDeployable[deployable].cells += 1;
      byDeployable[deployable][row.status] += 1;
    }
  }
  return {
    cells: rows.length,
    covered: byStatus.covered,
    residue: byStatus.uncovered,
    m31Dependency: byStatus["m3.1-dependency"],
    joinable: rows.length - byStatus["m3.1-dependency"],
    byEvidenceKind,
    byDeployable,
  };
}

export function registerDigest(rows) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((row) => [row.id, row.status, row.evidence.map((entry) => `${entry.kind}:${entry.file}`)]),
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export function buildArtifact(root = repositoryRoot) {
  const capability = readJson(root, CAPABILITY_MATRIX_PATH);
  const manifest = readJson(root, MANIFEST_PATH);
  const restCells = capability.surfaces.rest;
  const manifestOperations = manifest.inventories.restOperations;
  const files = enumerateTestFiles(root).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));

  const { rows, failures, telemetry } = buildRegister({ restCells, manifestOperations, testFiles: files });
  const summary = summarise(rows);

  return {
    failures,
    artifact: {
      version: 1,
      issue: "WIN-267",
      milestone: "M4.1",
      title: "Per-REST-cell contract/integration test register",
      decision: "D14 — broad reading: every M0.2 REST cell; the AgentController cells are an explicit M3.1 dependency",
      enumeratedFrom: [CAPABILITY_MATRIX_PATH, MANIFEST_PATH],
      testFilesFrom: "git ls-files, filtered by TEST_FILE_PATTERN",
      generatedBy: "scripts/rest-cell-coverage.mjs",
      evidenceKinds: EVIDENCE_KINDS,
      statedLimit:
        "an evidence row proves a test file EXECUTES the cell, not that it asserts anything about it; the register " +
        "is a lower bound on execution and therefore an upper bound on nothing — residue is the set of cells no " +
        "tracked test file touches at all",
      m31Dependency: {
        controller: M31_CONTROLLER,
        owner: M31_OWNER,
        cells: summary.m31Dependency,
        countedAs: "neither covered nor residue; the third number is published so the carve-out cannot read as progress",
      },
      telemetry,
      summary,
      digest: registerDigest(rows),
      rows,
    },
  };
}

function formatSummary(artifact) {
  const { summary } = artifact;
  return [
    `[rest-cell-coverage] ${summary.cells} REST cells: ${summary.covered} covered, ${summary.residue} residue, ` +
      `${summary.m31Dependency} ${M31_OWNER} dependency`,
    `[rest-cell-coverage] joinable denominator ${summary.joinable}; evidence by kind ` +
      `handler=${summary.byEvidenceKind.handler} http=${summary.byEvidenceKind.http}`,
    `[rest-cell-coverage] read ${artifact.telemetry.testFiles} tracked test files, ${artifact.telemetry.httpSites} ` +
      `request site(s), ${artifact.telemetry.ambiguousSites} ambiguous and therefore unjoined`,
    `[rest-cell-coverage] digest ${artifact.digest}`,
  ].join("\n");
}

function main(argv) {
  const write = argv.includes("--write");
  const check = argv.includes("--check") || !write;
  const { failures, artifact } = buildArtifact();

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`[rest-cell-coverage] FAIL ${failure}\n`);
    return 1;
  }

  const serialised = `${JSON.stringify(artifact, null, 2)}\n`;
  if (write) {
    writeFileSync(join(repositoryRoot, JSON_PATH), serialised);
    process.stdout.write(`${formatSummary(artifact)}\n[rest-cell-coverage] wrote ${JSON_PATH}\n`);
    return 0;
  }

  let committed;
  try {
    committed = readFileSync(join(repositoryRoot, JSON_PATH), "utf8");
  } catch {
    process.stderr.write(`[rest-cell-coverage] FAIL ${JSON_PATH} is missing; run node scripts/rest-cell-coverage.mjs --write\n`);
    return 1;
  }
  if (check && committed !== serialised) {
    const previous = JSON.parse(committed);
    process.stderr.write(
      `[rest-cell-coverage] FAIL the committed register no longer matches the tree.\n` +
        `  committed: ${previous.summary?.covered} covered / ${previous.summary?.residue} residue / ` +
        `${previous.summary?.m31Dependency} M3.1, digest ${previous.digest}\n` +
        `  measured : ${artifact.summary.covered} covered / ${artifact.summary.residue} residue / ` +
        `${artifact.summary.m31Dependency} M3.1, digest ${artifact.digest}\n` +
        "  A cell that lost its only test, a route that landed with none, or a moved denominator all reach here.\n" +
        "  Regenerate with node scripts/rest-cell-coverage.mjs --write and read the diff before committing it.\n",
    );
    return 1;
  }
  process.stdout.write(`${formatSummary(artifact)}\n[rest-cell-coverage] committed register matches the tree\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)));
}
