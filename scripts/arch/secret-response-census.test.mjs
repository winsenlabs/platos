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
  regenerate,
  scanFile,
  serializeManifest,
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

test("only the five request surfaces are in scope", () => {
  assert.equal(isRequestSurface("apps/agent/src/x/y.controller.ts"), true);
  assert.equal(isRequestSurface("apps/agent/src/mcp-platform/tools/y.ts"), true);
  assert.equal(isRequestSurface("apps/webapp/app/routes/a/route.tsx"), true);
  assert.equal(isRequestSurface("apps/webapp/app/services/z.server.ts"), true);
  // WIN-268 (M4.2) P1 — THE FIFTH. The whole V1 transport tree, not just the
  // controllers in it: ADR M0.3 §6's 500-line budget forces a route's response
  // projection into a sibling file, so a controller-only scan reported this tree
  // as clean no matter what its routes returned.
  assert.equal(isRequestSurface("apps/core-api/src/transports/mcp/token-mint.ts"), true);
  assert.equal(isRequestSurface("apps/core-api/src/transports/rest/envelope.ts"), true);
  // And the negative controls, unchanged: a service is not a surface, a test is
  // not a surface, and the tree OUTSIDE `transports/` is not one either — the
  // composition root and the process edge answer no request.
  assert.equal(isRequestSurface("apps/agent/src/auth/auth.service.ts"), false);
  assert.equal(isRequestSurface("apps/agent/src/x/y.controller.test.ts"), false);
  assert.equal(isRequestSurface("apps/core-api/src/composition/registry.ts"), false);
  assert.equal(isRequestSurface("apps/core-api/src/transports/mcp/token-mint.test.ts"), false);
});

test("a V1 transport PROJECTION is a handler, and one outside that tree is not", () => {
  // The gap WIN-268 P1 found by building the first V1 route that returns a
  // credential. `mintedTokenResource(...)` is a function declaration, and
  // `enclosingHandler` returns null for one — correct everywhere else, and wrong
  // in the one tree whose line budget forces projections out of the handler.
  const projection = [
    "export function mintedTokenResource(minted) {",
    "  return { tokenId: minted.credentialId, token: minted.token };",
    "}",
  ].join("\n");
  assert.deepEqual(
    scanFile("apps/core-api/src/transports/mcp/token-mint.ts", projection).map((site) => site.key),
    ["token"],
  );
  // THE NEGATIVE CONTROL, and it is what keeps the widening honest: the same
  // function shape in a file that is NOT a V1 transport stays invisible, because
  // a helper that happens to build an object with a credential-shaped field in
  // it is not a response.
  assert.deepEqual(scanFile("apps/agent/src/auth/helper.ts", projection), []);
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

// ── THE ROUND TRIP (M4 finish) ──────────────────────────────────────────────
//
// `--write` used to print `{surfaces, totalOccurrences, sites:[{path,key,
// occurrences}]}` to stdout. Feeding that back to `check()` threw
// `manifest.indirectSites is not iterable`, and it dropped every `disposition`
// and every `why` — the half of this artifact a human wrote. So the file's own
// `$schema-note` described a workflow ("generated by --write, then annotated")
// that could not be performed, and the pin was maintained by hand.
//
// THE FIRST CASE IS THE PROOF AND IT IS A BYTE COMPARISON. Anything weaker — a
// field-by-field deepEqual, a count — would pass for a writer that reordered
// keys or lost the prose, and either would make the next regeneration a diff
// nobody could review.

test("--write reproduces the committed manifest BYTE FOR BYTE", () => {
  const { manifest, introduced, closed } = regenerate(REPOSITORY_ROOT);
  const committedBytes = readFileSync(new URL(`../../${MANIFEST}`, import.meta.url), "utf8");
  assert.equal(serializeManifest(manifest), committedBytes);
  assert.deepEqual(introduced, []);
  assert.deepEqual(closed, []);
});

test("what --write produces is what check() READS", () => {
  const { manifest } = regenerate(REPOSITORY_ROOT);
  // The old writer omitted `indirectSites` entirely and this threw rather than
  // failing, which is why the two halves could drift with nothing noticing.
  assert.ok(Array.isArray(manifest.indirectSites));
  assert.deepEqual(check(REPOSITORY_ROOT, manifest).problems, []);
});

test("--write carries every hand-written disposition through", () => {
  const previous = committedManifest();
  const marked = previous.sites[0];
  marked.why = `${marked.why} MARKER-9f2c that only a human could have written.`;
  const { manifest } = regenerate(REPOSITORY_ROOT, previous);
  const regenerated = manifest.sites.find(
    (site) => site.path === marked.path && site.key === marked.key,
  );
  assert.equal(regenerated.why, marked.why);
  assert.equal(regenerated.disposition, marked.disposition);
  // And the hand-found indirect rows, which the scanner cannot find at all.
  assert.deepEqual(manifest.indirectSites, previous.indirectSites);
  assert.equal(manifest["$schema-note"], previous["$schema-note"]);
});

test("a NEW site is written with NO disposition, reported, and leaves the check RED", () => {
  const previous = committedManifest();
  const forgotten = previous.sites.shift();
  const id = `${forgotten.path}#${forgotten.key}`;
  const { manifest, introduced } = regenerate(REPOSITORY_ROOT, previous);
  assert.deepEqual(introduced, [id]);
  const written = manifest.sites.find(
    (site) => site.path === forgotten.path && site.key === forgotten.key,
  );
  // A regenerator that could invent a disposition would be the cheapest way to
  // launder a new raw-secret response path into a green manifest.
  assert.equal(written.disposition, null);
  assert.equal(written.why, null);
  const { problems } = check(REPOSITORY_ROOT, manifest);
  assert.ok(problems.some((problem) => problem.startsWith("BADDISP") && problem.includes(forgotten.key)), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.startsWith("NOWHY") && problem.includes(forgotten.key)), problems.join("\n"));
});

test("a CLOSED site is dropped and reported so the note can say what closed it", () => {
  const previous = committedManifest();
  previous.sites.push({
    path: "apps/agent/src/gone/away.controller.ts",
    key: "apiKey",
    occurrences: 1,
    disposition: "m4-transport",
    why: "a row whose emitter this regeneration finds has been deleted from the tree.",
  });
  const { manifest, closed } = regenerate(REPOSITORY_ROOT, previous);
  assert.deepEqual(closed, ["apps/agent/src/gone/away.controller.ts#apiKey"]);
  assert.ok(
    !manifest.sites.some((site) => site.path === "apps/agent/src/gone/away.controller.ts"),
  );
  // The counts follow the TREE, never the file it is rewriting.
  assert.equal(
    manifest.totalOccurrences,
    manifest.sites.reduce((sum, site) => sum + site.occurrences, 0),
  );
});
