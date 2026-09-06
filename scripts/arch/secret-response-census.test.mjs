// The census, held to its own claims.
//
// Every case here is a FIXTURE fed to `scanFile` rather than a re-run of the
// repository scan, for the reason the repository scan is not evidence about the
// scanner: it agrees with a manifest this author also wrote. A fixture states
// what the scanner should say about a shape, and the four precision rules the
// manifest's `method` section claims are each pinned by a fixture that would
// pass without them.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MANIFEST,
  MATERIAL_RESPONSE_KEYS,
  check,
  isRequestSurface,
  scanFile,
} from "./secret-response-census.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function committedManifest() {
  return JSON.parse(readFileSync(new URL(`../../${MANIFEST}`, import.meta.url), "utf8"));
}

const CONTROLLER = "apps/agent/src/x/y.controller.ts";
const TOOL = "apps/agent/src/mcp-platform/tools/y.ts";
const ROUTE = "apps/webapp/app/routes/a/route.tsx";

test("a handler returning material is counted", () => {
  const found = scanFile(
    CONTROLLER,
    `class C {
       @Post("x")
       async create() { return { id: 1, webhookSecret: s }; }
     }`,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].key, "webhookSecret");
  assert.equal(found[0].handler, "create");
});

test("a method with NO route decorator is not a handler", () => {
  const found = scanFile(
    CONTROLLER,
    `class C {
       private parse() { return { clientSecret: cfg.clientSecret }; }
     }`,
  );
  assert.deepEqual(found, []);
});

test("a private helper's return inside a handler's file is not a response", () => {
  const found = scanFile(
    CONTROLLER,
    `function normalise(cfg) { return { webhookUrl: cfg.webhookUrl }; }`,
  );
  assert.deepEqual(found, []);
});

test("a JSON schema declaring an INPUT is not a response", () => {
  const found = scanFile(
    TOOL,
    `export const t = [{
       async execute() {
         return { properties: { serviceSecret: { type: "string" } } };
       }
     }];`,
  );
  assert.deepEqual(found, []);
});

test("a value that is already redacted is not a leak", () => {
  const found = scanFile(
    TOOL,
    `export const t = [{
       async execute() { return { webhookPath: webhookPathRedacted(id) }; }
     }];`,
  );
  assert.deepEqual(found, []);
});

// The closed key list is what refuses these, not a `has*` / `is*` filter. One
// was written and deleted when the sweep could not turn it red — the list had
// already refused every input that would have reached it.
test("a presence flag beside the material is not the material", () => {
  const found = scanFile(
    TOOL,
    `export const t = [{
       async execute() { return { hasClientSecret: true, isSigningSecret: false }; }
     }];`,
  );
  assert.deepEqual(found, []);
});

test("a literal assigned to a local the handler RETURNS is counted", () => {
  const found = scanFile(
    TOOL,
    `export const t = [{
       async execute() {
         const result = { id, webhookSecret, webhookUrl: full(id, webhookSecret) };
         audit(result.id);
         return result;
       }
     }];`,
  );
  assert.deepEqual(
    found.map((site) => site.key).sort(),
    ["webhookSecret", "webhookUrl"],
  );
});

test("a literal assigned to a local the handler does NOT return is ignored", () => {
  const found = scanFile(
    TOOL,
    `export const t = [{
       async execute() {
         const credentials = { clientSecret, signingSecret };
         await store.save(credentials);
         return { ok: true };
       }
     }];`,
  );
  assert.deepEqual(found, []);
});

test("a Remix loader and action are handlers; a sibling export is not", () => {
  const counted = scanFile(ROUTE, `export async function action() { return { plaintextSecret: t }; }`);
  assert.equal(counted.length, 1);
  assert.equal(counted[0].handler, "action");
  const ignored = scanFile(ROUTE, `export async function helper() { return { plaintextSecret: t }; }`);
  assert.deepEqual(ignored, []);
});

test("a request BODY sent outward is not a response", () => {
  const found = scanFile(
    CONTROLLER,
    `class C {
       @Post("x")
       async exchange() {
         await fetch(url, { body: JSON.stringify({ client_secret: s }) });
         return { ok: true };
       }
     }`,
  );
  assert.deepEqual(found, []);
});

test("only the four request surfaces are in scope", () => {
  assert.equal(isRequestSurface("apps/agent/src/x/y.controller.ts"), true);
  assert.equal(isRequestSurface("apps/agent/src/mcp-platform/tools/y.ts"), true);
  assert.equal(isRequestSurface("apps/webapp/app/routes/a/route.tsx"), true);
  assert.equal(isRequestSurface("apps/webapp/app/services/z.server.ts"), true);
  assert.equal(isRequestSurface("apps/agent/src/auth/auth.service.ts"), false);
  assert.equal(isRequestSurface("apps/agent/src/x/y.controller.test.ts"), false);
});

test("the key list is non-empty and every entry is a real response field name", () => {
  assert.ok(MATERIAL_RESPONSE_KEYS.length >= 15);
  for (const key of MATERIAL_RESPONSE_KEYS) assert.match(key, /^[a-z][A-Za-z_]*$/u);
});

test("the repository check passes and is not vacuous", () => {
  const { live, problems } = check();
  assert.deepEqual(problems, []);
  // A scanner that found nothing would also report no problems, so the count is
  // asserted from below. The exact number is pinned in the manifest, not here.
  assert.ok(live.sites.length >= 20, `expected the census to find sites, found ${live.sites.length}`);
  assert.ok(live.surfaces >= 100, `expected the census to scan surfaces, scanned ${live.surfaces}`);
});

// THE FOUR DRIFT RULES, each exercised against a SUBSTITUTED manifest.
//
// Against the committed manifest all four are silent, because the tree and the
// file agree — that is what green means. So a suite that could not substitute a
// manifest could only assert that nothing is wrong, and would stay green with
// any of them deleted. The mutation sweep proved that: three of the four
// survived their removal until `check` took an override.

test("a raw-secret response path with no disposition is refused", () => {
  const manifest = committedManifest();
  const dropped = manifest.sites.shift();
  manifest.totalOccurrences -= dropped.occurrences;
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(
    problems.some((problem) => problem.startsWith("NEW") && problem.includes(dropped.key)),
    problems.join("\n"),
  );
});

test("a disposition for a path that no longer exists is refused", () => {
  const manifest = committedManifest();
  manifest.sites.push({
    path: "apps/agent/src/gone/away.controller.ts",
    key: "plaintextSecret",
    occurrences: 1,
    disposition: "m4-transport",
    why: "a row for a file that is not there, so the CLOSED rule has something to find",
  });
  manifest.totalOccurrences += 1;
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(
    problems.some((problem) => problem.startsWith("CLOSED")),
    problems.join("\n"),
  );
});

test("a reveal DUPLICATED inside a file it already appears in is refused", () => {
  const manifest = committedManifest();
  manifest.sites[0].occurrences += 1;
  manifest.totalOccurrences += 1;
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(
    problems.some((problem) => problem.startsWith("MOVED")),
    problems.join("\n"),
  );
});

test("an indirect path whose evidence line is gone is refused", () => {
  const manifest = committedManifest();
  manifest.indirectSites[0].evidence = "a line that is certainly not in that file";
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(
    problems.some((problem) => problem.startsWith("EVIDENCE")),
    problems.join("\n"),
  );
});

test("a row carrying no reason, or an unknown disposition, is refused", () => {
  const manifest = committedManifest();
  manifest.sites[0].why = "short";
  manifest.sites[1].disposition = "because-i-said-so";
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(problems.some((problem) => problem.startsWith("NOWHY")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.startsWith("BADDISP")), problems.join("\n"));
});

test("a totalOccurrences that disagrees with its own rows is refused", () => {
  const manifest = committedManifest();
  manifest.totalOccurrences += 7;
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(problems.some((problem) => problem.startsWith("TOTAL")), problems.join("\n"));
});
