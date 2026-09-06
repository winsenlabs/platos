#!/usr/bin/env node
// WIN-259 (M2.4) — the raw-secret RESPONSE census.
//
// WHAT IT COUNTS. A raw-secret response path is a place where secret material
// reaches a caller in a response body: a property whose NAME says the value is
// material, sitting in an object literal that a request-handling surface
// RETURNS. Not a request body, not a local variable, not a column read, not a
// JSON schema declaring the shape of an input — those are the four things a
// line-level grep cannot tell from a response, and this walks the TypeScript
// AST rather than lines for exactly that reason.
//
// WHY IT EXISTS AS A GATE RATHER THAN A ONE-OFF COUNT. The issue asks for these
// paths to be found, counted, named and — where V1 can reach them — closed. A
// number in a report goes stale the day it is written. This is the number, its
// dispositions, and a check that neither has drifted, so the next tranche
// inherits a list rather than a memory. Every site carries a DISPOSITION saying
// why it is still open and what would close it, and a site that appears without
// one is a hard failure.
//
//   node scripts/arch/secret-response-census.mjs           # check
//   node scripts/arch/secret-response-census.mjs --json    # machine-readable
//   node scripts/arch/secret-response-census.mjs --write   # regenerate evidence
//
// THE SURFACES SCANNED are the four this repository serves requests from: the
// NestJS controllers, the MCP tool table, the webapp's Remix routes, and the
// webapp's server-only services. A file outside them cannot answer a request,
// so a material property in it is not a response path.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const MANIFEST = "docs/audits/win-259-secret-response-census.json";

/** A file that can answer a request. Everything else is out of scope. */
export function isRequestSurface(path) {
  if (/\.test\.tsx?$|\.spec\.tsx?$/u.test(path)) return false;
  return (
    /\.controller\.ts$/u.test(path) ||
    /^apps\/agent\/src\/mcp-platform\/tools\/[^/]+\.ts$/u.test(path) ||
    /^apps\/webapp\/app\/routes\//u.test(path) ||
    /^apps\/webapp\/app\/services\/[^/]+\.server\.ts$/u.test(path)
  );
}

/**
 * Property names that carry secret MATERIAL to a caller.
 *
 * Deliberately a closed, specific list rather than the kernel's general
 * classifier. The classifier answers "could this field hold material" for a log
 * line, where over-hiding costs a field. Here the question is "does this named
 * response field hand a caller a usable credential", and the answer has to be
 * checkable by a reader against the file — so each name is one this repository
 * actually returns, not a word that might appear.
 */
export const MATERIAL_RESPONSE_KEYS = [
  "plaintextSecret",
  "serviceSecret",
  "webhookSecret",
  "webhookUrl",
  "webhookPath",
  "clientSecret",
  "client_secret",
  "signingSecret",
  "botToken",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "mcpToken",
  "bearerToken",
  "initialSecret",
];

/**
 * Names that LOOK material and are not. There is no code for this, and the
 * absence is the point.
 *
 *   `hasClientSecret` / `hasBotToken` — a boolean saying whether one is set. A
 *      presence flag is the projection a caller is SUPPOSED to get.
 *   `clientId` / `client_id` — public by construction; it rides the OAuth
 *      authorize URL.
 *
 * A `PRESENCE_ONLY_PREFIXES` filter for `has*` / `is*` was written first and
 * then DELETED, because the mutation sweep could not turn it red: the key list
 * above is closed, `hasClientSecret` is not in it, and no input reaches the
 * filter that the list has not already refused. A guard nothing can falsify is
 * a comment, so it is one — this one.
 *
 * `webhookPathRedacted` is the third shape and is NOT in this class: it names a
 * real property called `webhookPath` whose VALUE is redacted, so it needs the
 * `isRedactedValue` check below, which the sweep does turn red.
 */

function listSurfaceFiles(root) {
  return execFileSync("git", ["ls-files", "apps/agent/src", "apps/webapp/app"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter(isRequestSurface)
    .sort();
}

function propertyName(node) {
  if (ts.isIdentifier(node.name ?? node)) return (node.name ?? node).text;
  if (ts.isStringLiteral(node.name ?? node)) return (node.name ?? node).text;
  return null;
}

function isMaterialResponseKey(name) {
  if (name === null) return false;
  return MATERIAL_RESPONSE_KEYS.includes(name);
}

/**
 * Is this object literal part of what a handler answers with?
 *
 * Walking UP from the literal rather than down from a handler is what keeps the
 * check honest about the shapes this repository actually uses: a returned
 * literal, a literal spread into one, a literal handed to `json(...)` or
 * `ok(...)`, and a literal nested inside any of those. A handler-first walk
 * would have to enumerate every decorator and every export name, and would miss
 * the next one.
 */
/** HTTP verb decorators. A method carrying one answers a request. */
const ROUTE_DECORATORS = ["Get", "Post", "Put", "Patch", "Delete", "All", "Sse", "Head", "Options"];

/** Remix's two server entry points. */
const REMIX_ENTRIES = ["loader", "action"];

/** The MCP tool table's handler property. */
const TOOL_HANDLERS = ["execute", "handler", "run"];

/**
 * Is this node inside a REQUEST HANDLER?
 *
 * Without this the walk counts a private parsing helper's `return` — the OAuth
 * controller's provider-config normaliser returns a `clientSecret` to its own
 * caller three frames below the handler, and an alert-channel normaliser
 * returns a `webhookUrl` on the way to a STORE. Both are internal plumbing, and
 * counting them would report a response path this repository does not have.
 * That over-count was measured before this function existed: 31 occurrences
 * became 22 once the enclosing frame had to be a handler.
 */
function namedIdentifier(node) {
  return node?.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : null;
}

function carriesRouteDecorator(node) {
  return (ts.getDecorators?.(node) ?? []).some((decorator) => {
    const call = decorator.expression;
    const callee = ts.isCallExpression(call) ? call.expression : call;
    return ts.isIdentifier(callee) && ROUTE_DECORATORS.includes(callee.text);
  });
}

function enclosingHandler(node) {
  let current = node.parent;
  while (current !== undefined) {
    const name = namedIdentifier(current);
    // The MCP tool table's `async execute(params, scope) { ... }` and the two
    // Remix entry points are named rather than decorated, so the NAME is
    // checked first — a route decorator on a method called `execute` would
    // otherwise never be reached.
    if (name !== null && TOOL_HANDLERS.includes(name)) return name;
    if (name !== null && REMIX_ENTRIES.includes(name)) return name;
    if (ts.isMethodDeclaration(current)) return carriesRouteDecorator(current) ? (name ?? "method") : null;
    if (ts.isFunctionDeclaration(current)) return null;
    current = current.parent;
  }
  return null;
}

function handlerBody(node) {
  let current = node.parent;
  while (current !== undefined) {
    if (
      ts.isMethodDeclaration(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current.body;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Is this local name RETURNED from the function that declares it?
 *
 * The MCP tool table's shape is `const result = { ...projectRow(row),
 * webhookSecret, ... }` followed by an audit call and then `return result`.
 * Without this the census misses two of the three one-time reveals in
 * `channels.ts` and reports the MCP surface as safer than the REST surface it
 * mirrors, which is the wrong way round for a count that exists to be acted on.
 */
function isReturnedLater(name, body) {
  if (body === undefined) return false;
  let returned = false;
  const visit = (node) => {
    if (returned) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const mentions = (inner) => {
        if (returned) return;
        if (ts.isIdentifier(inner) && inner.text === name) returned = true;
        else ts.forEachChild(inner, mentions);
      };
      mentions(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returned;
}

function reachesAResponse(node) {
  let current = node.parent;
  let hops = 0;
  while (current !== undefined && hops < 24) {
    if (ts.isReturnStatement(current)) return true;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return isReturnedLater(current.name.text, handlerBody(current));
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (["json", "ok", "Response", "respond"].includes(name)) return true;
      return false;
    }
    if (ts.isArrowFunction(current) || ts.isFunctionDeclaration(current)) {
      // A concise arrow body IS the return value.
      if (ts.isArrowFunction(current) && current.body === node) return true;
      return false;
    }
    if (ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) return false;
    current = current.parent;
    hops += 1;
  }
  return false;
}

/**
 * A JSON-schema literal describes an INPUT, not a response.
 *
 * `{ serviceSecret: { type: "string" } }` in an MCP tool table is the tool's
 * argument schema. Counting it would say this repository returns a secret when
 * it in fact accepts one, which is the opposite finding.
 */
/**
 * A property whose VALUE is already the redacted form is the fix, not the leak.
 *
 * `webhookPath: webhookPathRedacted(row.id)` returns a path with the secret
 * segment removed. Counting it would say a redaction is a leak and would push a
 * later reader to "close" the one site that is already closed.
 */
function isRedactedValue(property) {
  const value = property.initializer;
  if (value === undefined || !ts.isCallExpression(value)) return false;
  const callee = value.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : "";
  return /Redacted$/u.test(name);
}

function isSchemaDeclaration(property) {
  const value = property.initializer;
  if (value === undefined || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    (inner) =>
      ts.isPropertyAssignment(inner) &&
      propertyName(inner) === "type" &&
      inner.initializer !== undefined &&
      ts.isStringLiteral(inner.initializer),
  );
}

export function scanFile(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node) && reachesAResponse(node)) {
      const handler = enclosingHandler(node);
      if (handler === null) {
        ts.forEachChild(node, visit);
        return;
      }
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
          continue;
        }
        const name = propertyName(property);
        if (!isMaterialResponseKey(name)) continue;
        if (ts.isPropertyAssignment(property) && isSchemaDeclaration(property)) continue;
        if (ts.isPropertyAssignment(property) && isRedactedValue(property)) continue;
        const { line } = source.getLineAndCharacterOfPosition(property.getStart(source));
        found.push({ path, key: name, line: line + 1, handler });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function census(root = repositoryRoot) {
  const sites = [];
  for (const path of listSurfaceFiles(root)) {
    sites.push(...scanFile(path, readFileSync(join(root, path), "utf8")));
  }
  sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { surfaces: listSurfaceFiles(root).length, sites };
}

function readManifest(root) {
  return JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
}

/**
 * @param root repository root to scan.
 * @param overrides an alternative manifest, and the ONLY way this function's
 *   four drift rules can be exercised. Against the committed manifest they are
 *   all silent by construction — the tree and the file agree, which is what
 *   "green" means — so a suite that could not substitute a manifest could only
 *   assert that nothing is wrong, and would stay green with every one of them
 *   deleted. The mutation sweep found exactly that: three of the four survived
 *   until this parameter existed.
 */
export function check(root = repositoryRoot, overrides = null) {
  const live = census(root);
  const manifest = overrides ?? readManifest(root);
  const problems = [];

  const expected = new Map();
  for (const entry of manifest.sites) expected.set(`${entry.path}#${entry.key}`, entry);

  const seen = new Map();
  for (const site of live.sites) {
    const id = `${site.path}#${site.key}`;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  for (const [id, count] of seen) {
    const entry = expected.get(id);
    if (entry === undefined) {
      problems.push(`NEW      ${id} returns secret material and carries no disposition`);
      continue;
    }
    if (entry.occurrences !== count) {
      problems.push(
        `MOVED    ${id} occurs ${count} time(s); the manifest pins ${entry.occurrences}`,
      );
    }
  }
  for (const [id, entry] of expected) {
    if (!seen.has(id)) {
      problems.push(
        `CLOSED   ${id} is pinned as ${entry.disposition} but no longer occurs — ` +
          `remove it from the manifest and say in the note what closed it`,
      );
    }
  }
  if (live.surfaces !== manifest.surfaces) {
    problems.push(`SURFACES ${live.surfaces} request surfaces scanned; the manifest pins ${manifest.surfaces}`);
  }
  const pinnedTotal = manifest.sites.reduce((sum, entry) => sum + entry.occurrences, 0);
  if (pinnedTotal !== manifest.totalOccurrences) {
    problems.push(
      `TOTAL    the manifest's sites sum to ${pinnedTotal} but totalOccurrences says ${manifest.totalOccurrences}`,
    );
  }
  for (const entry of manifest.sites) {
    if (!DISPOSITIONS.includes(entry.disposition)) {
      problems.push(`BADDISP  ${entry.path}#${entry.key} carries unknown disposition ${entry.disposition}`);
    }
    if (typeof entry.why !== "string" || entry.why.length < 20) {
      problems.push(`NOWHY    ${entry.path}#${entry.key} carries no stated reason`);
    }
  }

  // The hand-found pass-through paths. Weaker than the scanner and deliberately
  // outside `totalOccurrences`: this proves the named line still exists, not
  // that it still reaches a response. It is here so that closing one of them
  // makes this file say so rather than leaving a stale claim standing.
  for (const entry of manifest.indirectSites) {
    if (!DISPOSITIONS.includes(entry.disposition)) {
      problems.push(`BADDISP  ${entry.path}#${entry.symbol} carries unknown disposition ${entry.disposition}`);
    }
    let text;
    try {
      text = readFileSync(join(root, entry.path), "utf8");
    } catch {
      problems.push(`GONE     ${entry.path} is pinned as an indirect path and no longer exists`);
      continue;
    }
    if (!text.includes(entry.evidence)) {
      problems.push(
        `EVIDENCE ${entry.path}#${entry.symbol} no longer contains its pinned line — ` +
          `if the path is closed, remove the row and say what closed it`,
      );
    }
  }
  return { live, problems };
}

/** What a site's continued existence means. */
export const DISPOSITIONS = [
  // The path is a legacy transport that V1 does not own. WIN-258 T6 (de-Prisma
  // the legacy transport files) is out of M2's scope and needs M4's REST
  // surface; closing the response shape needs the same surface.
  "m4-transport",
  // The response is the ONLY delivery of a secret this system just minted, and
  // the caller cannot obtain it again. Removing it would make the secret
  // unusable rather than safer. It is bounded: create/rotate only, never read.
  "one-time-reveal-by-design",
  // The response is a protocol requirement. The OAuth 2.0 token endpoint MUST
  // return `access_token`; a server that redacted it would not be an OAuth
  // server.
  "protocol-required",
];

function main() {
  if (process.argv.includes("--write")) {
    const live = census();
    const grouped = new Map();
    for (const site of live.sites) {
      const id = `${site.path}#${site.key}`;
      grouped.set(id, (grouped.get(id) ?? 0) + 1);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          surfaces: live.surfaces,
          totalOccurrences: live.sites.length,
          sites: [...grouped].map(([id, occurrences]) => ({
            path: id.slice(0, id.lastIndexOf("#")),
            key: id.slice(id.lastIndexOf("#") + 1),
            occurrences,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const result = check();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.problems.length > 0 ? 1 : 0;
    return;
  }
  if (process.argv.includes("--write")) {
    const live = census();
    const grouped = new Map();
    for (const site of live.sites) {
      const id = `${site.path}#${site.key}`;
      grouped.set(id, (grouped.get(id) ?? 0) + 1);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          surfaces: live.surfaces,
          totalOccurrences: live.sites.length,
          sites: [...grouped].map(([id, occurrences]) => ({
            path: id.split("#")[0],
            key: id.split("#")[1],
            occurrences,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const { live, problems } = result;
  process.stdout.write(
    `secret-response-census: ${live.sites.length} raw-secret response occurrence(s) across ` +
      `${new Set(live.sites.map((site) => site.path)).size} file(s) of ${live.surfaces} request surface(s)\n`,
  );
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  if (problems.length === 0) {
    process.stdout.write(
      "ok: every raw-secret response path carries a disposition and a stated reason, and none " +
        "has appeared or vanished without one.\n",
    );
  } else {
    process.stdout.write(`\n${problems.length} secret-response-census problem(s).\n`);
  }
  process.exitCode = problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("secret-response-census.mjs")) main();
