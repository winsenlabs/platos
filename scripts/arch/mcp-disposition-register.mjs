#!/usr/bin/env node
// WIN-268 (M4.2) — THE MCP DISPOSITION REGISTER. WHAT HAPPENS TO EVERY TOOL AND
// EVERY RESOURCE SURFACE THE PRODUCT SHIPS TODAY.
//
//   node scripts/arch/mcp-disposition-register.mjs            # human report
//   node scripts/arch/mcp-disposition-register.mjs --json     # machine-readable
//   node scripts/arch/mcp-disposition-register.mjs --write    # regenerate evidence
//   node scripts/arch/mcp-disposition-register.mjs --check    # fail on drift
//
// ---------------------------------------------------------------------------
// THE CENSUS ROW, AND THE DECISION THAT SHAPES IT
//
// WIN-268's row is "every current MCP tool/resource is mapped, deliberately
// retired or replaced". D18 (2026-09-15) settles the default: RETIRE NONE. The
// register maps every tool and every resource, and a tool is retired only with
// evidence that it is dead — so `RETIRED` is a class with an evidence
// requirement attached (RET-5 below), not a convenient bucket.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A DERIVATION AND NOT A SPREADSHEET
//
// A 205-row table typed by hand is a memory, and the standing finding of the
// 2026-09-02 verification is that an assertion comparing two things you control
// cannot fail. So EVERY ROW HERE IS JOINED OUT OF ARTIFACTS THIS FILE DOES NOT
// OWN, and the gate is what happens when they disagree:
//
//   1. `apps/agent/src/control-plane/operation-manifest.generated.json` — the
//      tool inventory and the REST inventory. Produced by
//      `apps/agent/scripts/generate-control-plane.mjs`, which EXECUTES the
//      servers' own modules through `runtime-mcp-catalog.ts` and records what
//      they report, and byte-compared by its own `--check`. Nothing in this file
//      can add a tool to it or take one away.
//   2. `scripts/arch/mcp-store-ownership.mjs` — WIN-268's ORM register. Its
//      `DISPOSITIONS` already record, PER DECLARING FILE, the published contract
//      method that is that file's use case, and its `contractMethods()` reads
//      the `<Pascal>Contract` interface by AST. THE MAPPED ROWS ARE DERIVED FROM
//      THOSE, not written here: this file contains no table of tool names.
//   3. `packages/contexts/<context>/contracts/index.ts` — the published methods,
//      read by the AST walk in (2). A disposition naming a method the contract
//      does not publish is a hard failure (RET-3), which is the same rule the
//      store-ownership register already enforces for its `movable` verdict.
//   4. `apps/agent/src/mcp-docs/docs-mcp.controller.ts` — the docs server's own
//      tool array and its declared JSON-RPC method list, read by AST. The Docs
//      tool and the `resources/list` / `resources/read` surfaces come from the
//      controller, so a `prompts/list` added there tomorrow arrives here
//      undispositioned and fails (RET-6) instead of being quietly absent.
//
// ---------------------------------------------------------------------------
// THE FOUR DISPOSITIONS, AND WHICH OF THEM CLOSE THE ROW
//
//   MAPPED    a published CONTRACT METHOD is the V1 form of this tool. The row
//             names `<context>.<method>` and the method is AST-verified.
//   REPLACED  a named V1 REST OPERATION carries the capability instead. The row
//             names the operation id(s), each verified to exist in the
//             manifest's REST inventory AND to name this tool back.
//   RETAINED  MCP is this tool's ONLY transport. D18 keeps it; the row records
//             the owning context(s) and what that context is waiting on, taken
//             from the store-ownership register. THIS IS THE OPEN REMAINDER and
//             the report says so — it is not a third way of saying "done".
//   RETIRED   evidence that it is dead. `RETIREMENTS` is EMPTY (D18), and an
//             entry added to it without evidence fails.
//
// The precedence is MAPPED over REPLACED: a contract method is the stronger
// mapping, and a tool that has both keeps the REST operations in `alsoServedBy`
// rather than losing them.
//
// WHAT A `MAPPED` ROW CLAIMS, EXACTLY. The store-ownership register records its
// methods PER FILE — "the contract method that is the published form of the
// file" — so a MAPPED row here says the tool's DECLARING FILE has a published
// contract method, not that a per-tool binding exists. Per-tool bindings arrive
// when the MCP transport itself moves to `apps/core-api/src/transports/mcp`.
// Saying that plainly is the difference between a register and a claim.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { OWNER } from "./table-ownership.mjs";
import {
  DISPOSITIONS as STORE_DISPOSITIONS,
  composedContexts,
  contractMethods,
} from "./mcp-store-ownership.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const MANIFEST = "docs/audits/win-268-mcp-disposition-register.json";
export const REPORT = "docs/audits/win-268-mcp-disposition-register.md";

/** The operation manifest. Produced by a different mechanism; never written here. */
export const OPERATION_MANIFEST =
  "apps/agent/src/control-plane/operation-manifest.generated.json";

/** The docs MCP server, whose tool array and method list are read by AST. */
export const DOCS_CONTROLLER = "apps/agent/src/mcp-docs/docs-mcp.controller.ts";

/** The identifier holding the docs server's catalog. */
export const DOCS_TOOL_ARRAY = "DOCS_MCP_TOOLS";

/**
 * The JSON-RPC methods that are the PROTOCOL rather than a capability.
 *
 * Named so the omission is a decision. `initialize` and `notifications/ping` are
 * the handshake; `tools/list` and `tools/call` are the envelope every tool row
 * in this register already covers. Everything else the docs server declares is a
 * SURFACE and needs a disposition — which is how `resources/list` and
 * `resources/read` arrive here without being typed in.
 */
export const PROTOCOL_METHODS = Object.freeze([
  "initialize",
  "notifications/ping",
  "tools/list",
  "tools/call",
]);

/** The closed set of dispositions. */
export const DISPOSITIONS = Object.freeze(["MAPPED", "REPLACED", "RETAINED", "RETIRED"]);

/**
 * THE RETIREMENTS. EMPTY, BY D18.
 *
 * An entry is `{ surface, evidence: { claim, command, observed } }`: what is
 * claimed dead, the command that was run to find out, and what it printed. RET-5
 * fails on an entry missing any of the three, so "retired" cannot become the
 * cheap answer for a tool nobody wants to think about.
 */
export const RETIREMENTS = Object.freeze([]);

/**
 * What `waitingOn` says when WIN-268's store-ownership register has nothing to
 * say about a tool's declaring file.
 *
 * It is not a gap. That register disposes EVERY file holding an ORM site and
 * fails on an orphan disposition, so a file it does not name provably holds no
 * store reach at all — it delegates to a Nest service instead. The value records
 * that fact rather than leaving the column blank and letting a reader guess.
 */
export const NO_ORM_SITE = "no-orm-site-in-declaring-file";

/** Distinct guards, distinct codes. */
export const VIOLATION_CODES = Object.freeze([
  "RET-1-UNDISPOSITIONED_TOOL",
  "RET-2-ORPHAN_ROW",
  "RET-3-METHOD_NOT_PUBLISHED",
  "RET-4-REPLACEMENT_NOT_FOUND",
  "RET-5-RETIRED_WITHOUT_EVIDENCE",
  "RET-6-UNDISPOSITIONED_SURFACE",
]);

function readJson(path, root = repositoryRoot) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

/**
 * The docs server's catalog and declared surfaces, by AST.
 *
 * Read rather than grepped because the array is `[SEARCH_DOCS_TOOL] as const`:
 * a regex over the file would have to know that the element is an identifier and
 * that its `name` lives in another declaration. The walk follows the identifier.
 */
export function docsSurfaces(root = repositoryRoot) {
  const source = ts.createSourceFile(
    DOCS_CONTROLLER,
    readFileSync(join(root, DOCS_CONTROLLER), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const objectLiterals = new Map();
  const arrays = new Map();
  const methodLists = [];

  const literalName = (node) => {
    for (const property of node.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "name" &&
        ts.isStringLiteral(property.initializer)
      ) {
        return property.initializer.text;
      }
    }
    return null;
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let initializer = node.initializer;
      while (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (ts.isObjectLiteralExpression(initializer)) {
        objectLiterals.set(node.name.text, literalName(initializer));
      } else if (ts.isArrayLiteralExpression(initializer)) {
        arrays.set(node.name.text, initializer.elements);
      }
    }
    // `methods: [ ... ]` — the declared JSON-RPC surface list.
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "methods" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      const entries = node.initializer.elements
        .filter((element) => ts.isStringLiteral(element))
        .map((element) => element.text);
      if (entries.length > 0) methodLists.push(entries);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const elements = arrays.get(DOCS_TOOL_ARRAY);
  if (!elements) {
    throw new Error(`${DOCS_CONTROLLER}: no ${DOCS_TOOL_ARRAY} array found`);
  }
  const tools = [];
  for (const element of elements) {
    if (ts.isIdentifier(element)) {
      const name = objectLiterals.get(element.text);
      if (!name) throw new Error(`${DOCS_CONTROLLER}: ${element.text} declares no string name`);
      tools.push(name);
    } else if (ts.isObjectLiteralExpression(element)) {
      const name = literalName(element);
      if (!name) throw new Error(`${DOCS_CONTROLLER}: a ${DOCS_TOOL_ARRAY} entry has no name`);
      tools.push(name);
    }
  }
  if (tools.length === 0) throw new Error(`${DOCS_CONTROLLER}: ${DOCS_TOOL_ARRAY} is empty`);

  const declared = [...new Set(methodLists.flat())];
  if (declared.length === 0) throw new Error(`${DOCS_CONTROLLER}: no declared methods list found`);
  const surfaces = declared.filter((method) => !PROTOCOL_METHODS.includes(method)).sort();

  return { tools: tools.sort(), declared: declared.sort(), surfaces };
}

/** Every method every OWNED context publishes, keyed by context. AST-read. */
function publishedMethods(root = repositoryRoot) {
  const byContext = new Map();
  for (const owner of new Set(Object.values(OWNER))) {
    if (owner.startsWith("<")) continue;
    byContext.set(owner, contractMethods(owner, root) ?? []);
  }
  return byContext;
}

/**
 * The four artifacts, read once.
 *
 * Separated from `deriveRows` and `auditRows` so the AUDIT can be run against a
 * set of rows this process did not derive — which is the whole point of RET-1,
 * RET-2 and RET-6. See `auditRows`.
 */
export function readSources(root = repositoryRoot) {
  const manifest = readJson(OPERATION_MANIFEST, root);
  return {
    tools: manifest.inventories.mcpTools,
    restById: new Map(manifest.inventories.restOperations.map((row) => [row.id, row])),
    published: publishedMethods(root),
    composed: new Set(composedContexts(root)),
    docs: docsSurfaces(root),
    retired: new Map(RETIREMENTS.map((entry) => [entry.surface, entry])),
  };
}

/** The rows, derived. No table of tool names lives in this file. */
export function deriveRows(sources) {
  const { tools, docs, retired } = sources;
  const rows = [];

  for (const tool of tools) {
    const store = STORE_DISPOSITIONS[tool.source];
    const named = store?.methods ?? {};
    const methods = [];
    for (const [context, list] of Object.entries(named)) {
      for (const method of list) methods.push(`${context}.${method}`);
    }
    methods.sort();

    const rest = [...(tool.restMappings ?? [])].sort();

    let disposition;
    if (retired.has(tool.name)) {
      disposition = "RETIRED";
    } else if (methods.length > 0) {
      disposition = "MAPPED";
    } else if (tool.classification === "MAPPED") {
      disposition = "REPLACED";
    } else {
      disposition = "RETAINED";
    }

    rows.push({
      surface: tool.name,
      kind: "tool",
      server: "platform",
      declaredIn: tool.source,
      classification: tool.classification,
      disposition,
      mappedTo: methods,
      replacedBy: disposition === "REPLACED" ? rest : [],
      alsoServedBy: disposition === "MAPPED" ? rest : [],
      owningContexts: store?.contexts ?? [],
      waitingOn: store?.waitingOn ?? NO_ORM_SITE,
      retirement: retired.get(tool.name) ?? null,
    });
  }

  for (const name of docs.tools) {
    rows.push({
      surface: name,
      kind: "tool",
      server: "docs",
      declaredIn: DOCS_CONTROLLER,
      classification: "MCP_ONLY",
      disposition: retired.has(name) ? "RETIRED" : "RETAINED",
      mappedTo: [],
      replacedBy: [],
      alsoServedBy: [],
      owningContexts: [],
      waitingOn: "docs-mcp-bridge-deployable",
      retirement: retired.get(name) ?? null,
    });
  }

  for (const surface of docs.surfaces) {
    rows.push({
      surface,
      kind: "resource",
      server: "docs",
      declaredIn: DOCS_CONTROLLER,
      classification: "MCP_ONLY",
      disposition: retired.has(surface) ? "RETIRED" : "RETAINED",
      mappedTo: [],
      replacedBy: [],
      alsoServedBy: [],
      owningContexts: [],
      waitingOn: "docs-mcp-bridge-deployable",
      retirement: retired.get(surface) ?? null,
    });
  }

  rows.sort((a, b) => (a.server + a.kind + a.surface).localeCompare(b.server + b.kind + b.surface));
  return rows;
}

/**
 * THE GATE. Both directions, plus the three joins a row could otherwise invent.
 *
 * `rows` IS A PARAMETER, and `--check` passes the COMMITTED register's rows, not
 * the ones this process just derived. That is what makes RET-1, RET-2 and RET-6
 * able to fail at all: a gate that compared freshly-derived rows to the manifest
 * they were derived from would be comparing the tree to itself, and the 2026-09-02
 * verification's standing finding is that such an assertion cannot fail. Run
 * against the committed artifact, a tool the servers started reporting since the
 * register was last regenerated is RET-1, and a row somebody typed into the JSON
 * by hand is RET-2.
 */
export function auditRows(rows, sources) {
  const { tools, restById, published, docs } = sources;
  const violations = [];
  const dispositioned = new Set(rows.map((row) => `${row.server}:${row.surface}`));

  // RET-1 — manifest -> register. A tool the servers report that the committed
  // register has no row for.
  for (const tool of tools) {
    if (!dispositioned.has(`platform:${tool.name}`)) {
      violations.push({
        code: "RET-1-UNDISPOSITIONED_TOOL",
        surface: tool.name,
        detail: `declared in ${tool.source} and dispositioned nowhere`,
      });
    }
  }

  // RET-6 — the docs server's declared surfaces, same direction.
  for (const surface of [...docs.tools, ...docs.surfaces]) {
    if (!dispositioned.has(`docs:${surface}`)) {
      violations.push({
        code: "RET-6-UNDISPOSITIONED_SURFACE",
        surface,
        detail: `declared by ${DOCS_CONTROLLER} and dispositioned nowhere`,
      });
    }
  }

  // RET-2 — register -> manifest. A row for something no server declares.
  const declaredPlatform = new Set(tools.map((tool) => tool.name));
  const declaredDocs = new Set([...docs.tools, ...docs.surfaces]);
  for (const row of rows) {
    const known = row.server === "docs" ? declaredDocs : declaredPlatform;
    if (!known.has(row.surface)) {
      violations.push({
        code: "RET-2-ORPHAN_ROW",
        surface: row.surface,
        detail: `dispositioned but no ${row.server} server declares it`,
      });
    }
    if (!DISPOSITIONS.includes(row.disposition)) {
      violations.push({
        code: "RET-2-ORPHAN_ROW",
        surface: row.surface,
        detail: `disposition ${row.disposition} is not one of ${DISPOSITIONS.join(", ")}`,
      });
    }
  }

  // RET-3 — a MAPPED row may not name a contract method that is not published.
  for (const row of rows) {
    for (const entry of row.mappedTo) {
      const [context, method] = entry.split(".");
      const methods = published.get(context);
      if (!methods || !methods.includes(method)) {
        violations.push({
          code: "RET-3-METHOD_NOT_PUBLISHED",
          surface: row.surface,
          detail: `names ${entry}, which ${context} does not publish`,
        });
      }
    }
  }

  // RET-4 — a REPLACED row may not name a REST operation that does not exist,
  // and the operation has to name the tool BACK. A one-way join would pass on a
  // register that pointed every tool at one real route.
  for (const row of rows) {
    for (const id of row.replacedBy) {
      const operation = restById.get(id);
      if (!operation) {
        violations.push({
          code: "RET-4-REPLACEMENT_NOT_FOUND",
          surface: row.surface,
          detail: `names ${id}, which the REST inventory does not contain`,
        });
        continue;
      }
      if (!(operation.mcpTools ?? []).includes(row.surface)) {
        violations.push({
          code: "RET-4-REPLACEMENT_NOT_FOUND",
          surface: row.surface,
          detail: `names ${id}, which does not map back to this tool`,
        });
      }
    }
    if (row.disposition === "REPLACED" && row.replacedBy.length === 0) {
      violations.push({
        code: "RET-4-REPLACEMENT_NOT_FOUND",
        surface: row.surface,
        detail: "classified MAPPED by the manifest but names no REST operation",
      });
    }
  }

  // RET-5 — D18. A retirement without evidence is not a retirement.
  for (const entry of RETIREMENTS) {
    const evidence = entry.evidence ?? {};
    if (!entry.surface || !evidence.claim || !evidence.command || !evidence.observed) {
      violations.push({
        code: "RET-5-RETIRED_WITHOUT_EVIDENCE",
        surface: entry.surface ?? "<unnamed>",
        detail:
          "D18 retires a tool only with evidence it is dead: name the claim, the command run, and what it printed",
      });
    }
    if (!declaredPlatform.has(entry.surface) && !declaredDocs.has(entry.surface)) {
      violations.push({
        code: "RET-5-RETIRED_WITHOUT_EVIDENCE",
        surface: entry.surface ?? "<unnamed>",
        detail: "retires something no server declares",
      });
    }
  }

  return violations;
}

function summarise(rows, sources) {
  const { tools, composed, docs } = sources;
  const byDisposition = {};
  for (const name of DISPOSITIONS) byDisposition[name] = 0;
  for (const row of rows) byDisposition[row.disposition] += 1;

  const byClassification = {};
  for (const row of rows) {
    if (row.server !== "platform") continue;
    byClassification[row.classification] = (byClassification[row.classification] ?? 0) + 1;
  }

  const waiting = {};
  for (const row of rows) {
    if (row.disposition !== "RETAINED") continue;
    waiting[row.waitingOn] = (waiting[row.waitingOn] ?? 0) + 1;
  }

  return {
    rows: rows.length,
    platformTools: tools.length,
    docsTools: docs.tools.length,
    docsResourceSurfaces: docs.surfaces.length,
    docsDeclaredMethods: docs.declared,
    byDisposition,
    byClassification,
    composedContexts: [...composed].sort(),
    retainedWaitingOn: waiting,
    retirements: RETIREMENTS.length,
  };
}

export function buildRegister(root = repositoryRoot) {
  const sources = readSources(root);
  const rows = deriveRows(sources);
  return {
    issue: "WIN-268",
    milestone: "M4.2",
    decision: "D18 — retire none by default; a tool is retired only with evidence it is dead",
    sources: {
      operationManifest: OPERATION_MANIFEST,
      storeOwnershipRegister: "scripts/arch/mcp-store-ownership.mjs",
      docsController: DOCS_CONTROLLER,
    },
    dispositions: [...DISPOSITIONS],
    violationCodes: [...VIOLATION_CODES],
    protocolMethods: [...PROTOCOL_METHODS],
    violations: auditRows(rows, sources),
    summary: summarise(rows, sources),
    rows,
  };
}

function renderReport(register) {
  const lines = [];
  const s = register.summary;
  lines.push("# WIN-268 (M4.2) — the MCP disposition register");
  lines.push("");
  lines.push("GENERATED — `node scripts/arch/mcp-disposition-register.mjs --write`.");
  lines.push("");
  lines.push(`Decision applied: **${register.decision}**.`);
  lines.push("");
  lines.push(
    `${String(s.rows)} rows: ${String(s.platformTools)} platform/entity MCP tools from ` +
      `\`${register.sources.operationManifest}\`, ${String(s.docsTools)} docs tool(s) and ` +
      `${String(s.docsResourceSurfaces)} docs resource surface(s) read by AST from ` +
      `\`${register.sources.docsController}\`.`,
  );
  lines.push("");
  lines.push("## Dispositions");
  lines.push("");
  lines.push("| disposition | rows | what it claims |");
  lines.push("| --- | --- | --- |");
  const meaning = {
    MAPPED:
      "a published contract method is the V1 form of the declaring file; the row names `<context>.<method>` and the method is AST-verified",
    REPLACED:
      "a named V1 REST operation carries the capability; the row names the operation id(s), each verified present in the REST inventory and mapping back to this tool",
    RETAINED:
      "MCP is the only transport. D18 keeps it. **This is the open remainder**, not a third way of saying done",
    RETIRED: "evidence that it is dead. Empty by D18",
  };
  for (const name of register.dispositions) {
    lines.push(`| \`${name}\` | ${String(s.byDisposition[name])} | ${meaning[name]} |`);
  }
  lines.push("");
  lines.push("Manifest classification of the platform rows, for the join:");
  lines.push("");
  lines.push("| classification | rows |");
  lines.push("| --- | --- |");
  for (const [name, count] of Object.entries(s.byClassification).sort()) {
    lines.push(`| \`${name}\` | ${String(count)} |`);
  }
  lines.push("");
  lines.push("## What the gate refuses");
  lines.push("");
  for (const code of register.violationCodes) lines.push(`- \`${code}\``);
  lines.push("");
  lines.push(
    "RET-1/RET-6 are the manifest -> register direction: a tool or surface a server " +
      "declares and the committed register has no row for. RET-2 is the register -> " +
      "manifest direction. RET-3 joins a mapped row to the AST-read contract; RET-4 " +
      "joins a replaced row to the REST inventory IN BOTH DIRECTIONS, because a " +
      "one-way join would pass on a register that pointed every tool at one real route.",
  );
  lines.push("");
  lines.push("## The open remainder");
  lines.push("");
  lines.push(
    `${String(s.byDisposition.RETAINED)} rows are RETAINED. They are the part of the census ` +
      "row that is NOT closed: MCP is still their only transport. Grouped by what the " +
      "store-ownership register says their declaring file is waiting on:",
  );
  lines.push("");
  lines.push("| waiting on | rows |");
  lines.push("| --- | --- |");
  for (const [reason, count] of Object.entries(s.retainedWaitingOn).sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${reason}\` | ${String(count)} |`);
  }
  lines.push("");
  lines.push(`Contexts the composition root actually composes: ${s.composedContexts.join(", ")}.`);
  lines.push("");
  lines.push("## Rows");
  lines.push("");
  lines.push(
    "A MAPPED row names the contract method published for the tool's DECLARING " +
      "FILE — the unit `scripts/arch/mcp-store-ownership.mjs` records — not a " +
      "per-tool binding. Per-tool bindings arrive when the MCP transport moves to " +
      "`apps/core-api/src/transports/mcp`.",
  );
  lines.push("");
  lines.push("| surface | server | kind | disposition | contract method (file-level) / REST replacement | waiting on |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of register.rows) {
    const target =
      row.disposition === "MAPPED"
        ? row.mappedTo.map((entry) => `\`${entry}\``).join(", ")
        : row.disposition === "REPLACED"
          ? row.replacedBy.map((entry) => `\`${entry}\``).join(", ")
          : row.disposition === "RETIRED"
            ? `retired: ${row.retirement?.evidence?.claim ?? ""}`
            : "—";
    lines.push(
      `| \`${row.surface}\` | ${row.server} | ${row.kind} | ${row.disposition} | ${target} | \`${row.waitingOn}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const register = buildRegister();
  const manifestPath = join(repositoryRoot, MANIFEST);
  const reportPath = join(repositoryRoot, REPORT);
  const manifestText = `${JSON.stringify(register, null, 2)}\n`;
  const reportText = `${renderReport(register)}`;

  if (argv.includes("--json")) {
    process.stdout.write(manifestText);
    return;
  }
  if (argv.includes("--write")) {
    writeFileSync(manifestPath, manifestText, "utf8");
    writeFileSync(reportPath, reportText, "utf8");
    process.stdout.write(`wrote ${MANIFEST}, ${REPORT}\n`);
    if (register.violations.length > 0) {
      process.stderr.write(
        `NOTE: ${String(register.violations.length)} violation(s) recorded; --check will fail.\n`,
      );
    }
    return;
  }
  if (argv.includes("--check")) {
    let failed = false;

    // THE AUDIT RUNS AGAINST THE COMMITTED ROWS, not the ones just derived.
    // A tool the servers began reporting since the register was last written is
    // absent from the committed artifact and comes back as RET-1; a row typed
    // into the JSON by hand comes back as RET-2. Auditing the derived rows would
    // compare the tree to itself and could never fail.
    let committed = null;
    try {
      committed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      committed = null;
    }
    if (committed === null || !Array.isArray(committed.rows)) {
      process.stderr.write(
        `drift: ${MANIFEST} is missing or has no rows. Run: node scripts/arch/mcp-disposition-register.mjs --write\n`,
      );
      failed = true;
    }
    const audited = committed?.rows ?? register.rows;
    for (const violation of auditRows(audited, readSources())) {
      process.stderr.write(`${violation.code}: ${violation.surface} — ${violation.detail}\n`);
      failed = true;
    }
    for (const [label, path, expected] of [
      [MANIFEST, manifestPath, manifestText],
      [REPORT, reportPath, reportText],
    ]) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== expected) {
        process.stderr.write(
          `drift: ${label} is stale. Run: node scripts/arch/mcp-disposition-register.mjs --write\n`,
        );
        failed = true;
      }
    }
    if (failed) {
      process.exitCode = 1;
      return;
    }
    const s = register.summary;
    process.stdout.write(
      `ok: ${String(s.rows)} surfaces dispositioned ` +
        `(MAPPED ${String(s.byDisposition.MAPPED)}, REPLACED ${String(s.byDisposition.REPLACED)}, ` +
        `RETAINED ${String(s.byDisposition.RETAINED)}, RETIRED ${String(s.byDisposition.RETIRED)})\n`,
    );
    return;
  }

  process.stdout.write(reportText);
}

if (process.argv[1] && process.argv[1].endsWith("mcp-disposition-register.mjs")) main();
