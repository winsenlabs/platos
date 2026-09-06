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

import { MATERIAL_RESPONSE_KEYS, check, isRequestSurface, scanFile } from "./secret-response-census.mjs";

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
