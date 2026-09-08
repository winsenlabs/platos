// THE ROUTE THIS CONTROLLER ACTUALLY SERVES, JOINED TO TWO FILES IT DOES NOT OWN.
//
// The claim this tranche makes is "a one-time-secret mint the policy classes
// `required` now has a handler in `apps/core-api`". That claim is only worth
// something if the path the handler is MOUNTED AT is the path the policy binds —
// and nothing about writing `@Controller("agent/channels")` next to a table
// saying `/api/v1/agent/channels/:id/rotate-secret` makes those the same string.
// A route mounted one segment off would satisfy every behavioural test in this
// file, answer 404 in production, and leave the gate reserving keys for an
// operation nothing serves.
//
// SO THE TEMPLATE IS RECONSTRUCTED FROM THE DECORATORS' OWN METADATA — the same
// metadata Nest's router reads — and joined to:
//
//   1. `idempotency-policy.ts`, which must class it `required`; and
//   2. `apps/agent/src/control-plane/operation-manifest.generated.json`, the
//      frozen surface's own generated inventory of 300 REST operations, which
//      must contain it with that method.
//
// Neither is a constant this file writes, and (2) is generated from the oracle's
// controllers by a different gate entirely. Renaming the route, dropping
// `@Version`, or changing the prefix breaks the join in a way no amount of
// editing THIS file quietly hides.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { AppModule } from "../app.module.js";
import { API_PREFIX, API_VERSION } from "./api-surface.js";
import { CoreApiHttpModule } from "./http.module.js";
import { classifyRequest, OPERATION_POLICIES } from "./idempotency-policy.js";
import { SecretMintController } from "./secret-mint.controller.js";

/**
 * The metadata keys NEST ITSELF reads, taken from Nest itself.
 *
 * `@nestjs/common/constants` is a real file in the package and is NOT in its
 * `exports` map, so a static `import` of it does not type-resolve. Requiring it
 * at run time gets the same three strings from the same source of truth — which
 * matters, because the alternative is writing `"path"`, `"method"` and
 * `"__version__"` into this file and asserting a reconstruction against keys
 * this file invented. If a Nest upgrade renames one, every lookup below returns
 * `undefined` and `mounts at least one route` goes red rather than every join
 * passing over an empty list.
 */
const { PATH_METADATA, METHOD_METADATA, VERSION_METADATA } = createRequire(import.meta.url)(
  "@nestjs/common/constants",
) as Record<string, string>;

interface ManifestOperation {
  readonly method: string;
  readonly path: string;
}

const MANIFEST = JSON.parse(
  readFileSync(
    new URL("../../../../apps/agent/src/control-plane/operation-manifest.generated.json", import.meta.url),
    "utf8",
  ),
) as { readonly inventories: { readonly restOperations: readonly ManifestOperation[] } };

/** Nest's `RequestMethod` enum, back to the verb the manifest and policy spell. */
const VERB: Readonly<Record<number, string>> = Object.freeze({
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
});

interface MountedRoute {
  readonly method: string;
  readonly template: string;
}

/**
 * Every route this controller mounts, reconstructed the way the router mounts it.
 *
 * `prefix + version` is how `enableVersioning({type: URI, prefix: "api/v"})`
 * composes a URI-versioned path, so this reads `API_PREFIX`/`API_VERSION` from
 * the SAME module `lifecycle.ts` passes to Nest. A route that dropped
 * `@Version` reconstructs without the version segment and stops matching the
 * policy — which is the failure, not a false pass.
 */
function mountedRoutes(controller: Function = SecretMintController): readonly MountedRoute[] {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as unknown as Record<string, unknown>;
  const routes: MountedRoute[] = [];
  for (const property of Object.getOwnPropertyNames(prototype)) {
    if (property === "constructor") continue;
    const handler = prototype[property];
    if (typeof handler !== "function") continue;
    const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (methodPath === undefined) continue;
    const verb = VERB[Reflect.getMetadata(METHOD_METADATA, handler) as number];
    const version = Reflect.getMetadata(VERSION_METADATA, handler) as string | undefined;
    const segments = [
      API_PREFIX,
      `v${version ?? ""}`,
      controllerPath,
      methodPath,
    ].filter((segment) => segment.length > 0);
    routes.push({
      method: verb ?? "UNKNOWN",
      template: `/${segments.join("/")}`,
    });
  }
  return routes;
}

describe("the secret-mint controller's mounted routes", () => {
  const routes = mountedRoutes();

  it("mounts at least one route", () => {
    // Guards the reconstruction itself. If the metadata keys ever change, every
    // join below would pass vacuously over an empty list — which is the shape
    // of the unfalsifiable assertion this programme keeps paying for.
    expect(routes.length).toBeGreaterThan(0);
  });

  it("carries the version segment, so `api/v1` appears in NO source literal", () => {
    // T2 deleted twenty-four hand-written `api/v1` literals. This is the case
    // that fails if one is reintroduced here by dropping `@Version` and writing
    // the path out longhand instead.
    for (const route of routes) {
      expect(route.template.startsWith(`/${API_PREFIX}/v${API_VERSION}/`)).toBe(true);
    }
    const source = readFileSync(new URL("./secret-mint.controller.ts", import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toContain(`${API_PREFIX}/v${API_VERSION}`);
  });

  it("serves a template the idempotency policy classes `required`", () => {
    // THE JOIN THAT MATTERS. Not "the policy has eight required rows" — that is
    // a fact about the policy — but "the template THIS CONTROLLER MOUNTS is one
    // of them".
    const required = new Set(
      OPERATION_POLICIES.filter((policy) => policy.class === "required").map(
        (policy) => `${policy.method} ${policy.template}`,
      ),
    );
    for (const route of routes) {
      expect([...required]).toContain(`${route.method} ${route.template}`);
    }
  });

  it("is classified `required` by the gate's own matcher on a CONCRETE path", () => {
    // `classifyRequest` is what the middleware actually calls, and it takes a
    // pathname rather than a template. A template that matched the table but
    // whose compiled pattern did not match a real request would leave the mint
    // ungated, which is the failure this case is for.
    for (const route of routes) {
      const concrete = route.template.replace(/:[^/]+/gu, "a-real-id");
      expect(classifyRequest(route.method, concrete)).toBe("required");
    }
  });

  it("serves an operation the FROZEN SURFACE'S generated manifest already has", () => {
    // The manifest is generated from `apps/agent`'s controllers by a different
    // gate. A route this process invented — one the oracle never served — would
    // be a V1 surface that is not the frozen surface, and it fails here.
    const known = new Set(
      MANIFEST.inventories.restOperations.map((operation) => `${operation.method} ${operation.path}`),
    );
    expect(known.size).toBeGreaterThan(0);
    for (const route of routes) {
      expect([...known]).toContain(`${route.method} ${route.template}`);
    }
  });
});

// ---------------------------------------------------------------------------
// HOW MANY OF THE EIGHT ARE SERVED, AS A MEASUREMENT RATHER THAN A SENTENCE.
//
// WIN-260 (d) closes when all eight `required` mints have a handler in
// `apps/core-api`. A commit message claiming "one of eight" is worth nothing the
// day after it is written, so the split is pinned HERE, derived from the
// module's OWN controller list and the policy's OWN table:
//
//   * every `required` template is either SERVED (some controller in
//     `CoreApiHttpModule` mounts it) or UNSERVED and named below with the issue
//     that owns it;
//   * the two sets together are exactly the eight, so a mint cannot be dropped
//     from both and disappear.
//
// A tranche that serves another mint FAILS this suite until it moves the pin,
// which is the point: progress against (d) becomes visible in a diff instead of
// being asserted in prose.
// ---------------------------------------------------------------------------

/**
 * Why each unserved mint is unserved, and whose ground it is.
 *
 * NOT A LIST OF EXCUSES — a list of ADDRESSES. Each value names the issue that
 * owns the route, so a reader chasing "why is (d) still open" gets four issue
 * numbers rather than a shrug.
 */
const UNSERVED: Readonly<Record<string, string>> = Object.freeze({
  "POST /api/v1/agent/access-key":
    "WIN-261 (M3.1) — AgentController.createOrRotateAccessKey; decomposing that 7k-line controller is its ground, not T4's.",
  "POST /api/v1/agent/entities/:entityId/regenerate-secret":
    "WIN-261 (M3.1) — AgentController.regenerateEntitySecret; same owner, same reason.",
  "POST /mcp/platform/tokens": "M4.2 (MCP) — the MCP transport's own ground.",
  "POST /mcp/entity/:entityId/tokens": "M4.2 (MCP) — the MCP transport's own ground.",
  "POST /api/v1/entities/:entityId/session-tokens":
    "T4's, and BLOCKED: minting a bearer session token needs identity-access's TokenMinter port, which no adapter directory satisfies. Serving it would add a route that can only ever answer MINT_CONTEXT_UNCOMPOSED.",
  "POST /api/v1/public/guest-token":
    "T4's, and BLOCKED on the same TokenMinter port, which is identity-access's alone.",
  "POST /api/v1/agent/providers/keys/:id/rotate-secret":
    "T4's, and BLOCKED: providers.rotateProviderKeySecret IS published, but the providers context is unassembled — ProviderProbeCache is bound to no adapter (see PROVIDERS_UNASSEMBLED).",
});

/** Every controller the process actually registers, from the module itself. */
function registeredControllers(): readonly Function[] {
  const stub = { contexts: {}, configuration: {} } as unknown as AppModule;
  const dynamic = CoreApiHttpModule.forApplication(stub, { phase: "starting" });
  return (dynamic.controllers ?? []) as readonly Function[];
}

describe("the eight one-time-secret mints, and how many have a handler", () => {
  const required = OPERATION_POLICIES.filter((policy) => policy.class === "required").map(
    (policy) => `${policy.method} ${policy.template}`,
  );
  const mounted = new Set(
    registeredControllers()
      .flatMap((controller) => mountedRoutes(controller))
      .map((route) => `${route.method} ${route.template}`),
  );
  const served = required.filter((operation) => mounted.has(operation));
  const unserved = required.filter((operation) => !mounted.has(operation));

  it("still has exactly EIGHT required mints, so the denominator cannot drift", () => {
    // Joined to the policy table. If a ninth mint is classed `required` — or one
    // of the eight is demoted — this fails before any count below is read.
    expect(required).toHaveLength(8);
  });

  it("serves exactly the mints this tranche took, and no others by accident", () => {
    // THE PIN. T4 took ONE. Serving a second without moving this line is the
    // failure; so is silently losing the one that is served.
    expect(served).toEqual(["POST /api/v1/agent/channels/:id/rotate-secret"]);
  });

  it("names an owning issue for every mint that is NOT served", () => {
    // Every unserved mint must be ACCOUNTED FOR. A route that is neither served
    // nor named here is a mint nobody has taken and nobody has admitted to.
    for (const operation of unserved) {
      expect(Object.keys(UNSERVED)).toContain(operation);
      expect(UNSERVED[operation]?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("accounts for all eight exactly once, so none is dropped from both sets", () => {
    expect(served.length + unserved.length).toBe(8);
    expect(new Set([...served, ...unserved]).size).toBe(8);
    // And the excuse table describes the unserved set exactly — no stale entry
    // for a mint that has since been served, and no missing one.
    expect(new Set(Object.keys(UNSERVED))).toEqual(new Set(unserved));
  });

  it("leaves WIN-260 (d) OPEN, and says so in a way that fails when it closes", () => {
    // The honest statement of where the clause stands, written so that CLOSING
    // it breaks this case. A tranche that serves the eighth mint must come here
    // and delete this — which is the only kind of "not done yet" worth having.
    expect(served.length).toBeLessThan(8);
    expect(served).toHaveLength(1);
  });
});
