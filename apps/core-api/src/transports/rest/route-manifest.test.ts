// THE JOIN BETWEEN THE ROUTE THIS PROCESS MOUNTS AND THE ROUTE THE MANIFEST
// DECLARES.
//
// A controller one segment off passes every behavioural case ever written for it
// — its handler is correct, its refusals are correct, its envelope is correct —
// and answers 404 in production. Nothing in a unit test can see that, because a
// unit test calls the method. Nothing in an integration test that fetches the
// path the test itself composed can see it either: that is an assertion between
// two things the same file controls, and this programme has already paid for
// those.
//
// SO BOTH SIDES COME FROM SOMEWHERE ELSE.
//
//   THE LEFT is reconstructed from the DECORATORS' OWN METADATA — the very
//   `PATH_METADATA`, `METHOD_METADATA` and `VERSION_METADATA` keys Nest's
//   `RoutePathFactory` reads when it builds the router — plus this deployable's
//   `applyApiSurface` constants. It is not a list of paths written here; delete a
//   segment from a `@Controller` and the left side moves.
//
//   THE RIGHT is `apps/agent/src/control-plane/operation-manifest.generated.json`,
//   read off disk. It is produced by a completely different mechanism (a
//   TypeScript AST walk in `apps/agent/scripts/generate-control-plane.mjs`) using
//   a completely different set of surface constants
//   (`apps/agent/src/http/api-surface.ts`), and it is the artifact every gate
//   downstream — the capability matrix, differential coverage, route parity, the
//   independent census — enumerates the REST surface from.
//
// So the two agree only if the runtime and the census agree, which is the whole
// claim. The manifest is also the reason `apps/core-api` may not IMPORT it: that
// file belongs to `apps/agent`, which is not a dependency of this deployable and
// must not become one. It is read as data, the same way `rest-chassis.test.ts`
// reads `docs/error-taxonomy.json`.

import { readFileSync } from "node:fs";

import {
  Body,
  Controller,
  Get,
  Module,
  Query,
  RequestMethod,
  VERSION_NEUTRAL,
  type PipeTransform,
} from "@nestjs/common";
import { afterAll, describe, expect, it } from "vitest";

import { loadPlatformConfiguration } from "../../config/platform.js";
import { API_URI_VERSION_PREFIX, API_VERSION } from "../../http/api-surface.js";
import { classifyRequest } from "../../http/idempotency-policy.js";
import { MCP_PATH_PREFIX, MCP_ROOT_SEGMENT, MCP_ROUTE_VERSION } from "../mcp/mcp-surface.js";
import { CoreApiHttpModule } from "../../http/http.module.js";
import { HealthController } from "../../http/health.controller.js";
import { NotFoundController } from "../../http/not-found.controller.js";
import { startCoreApi, type RunningCoreApi } from "../../runtime/lifecycle.js";

interface ManifestOperation {
  readonly method: string;
  readonly path: string;
  readonly implementations: readonly {
    readonly controller: string;
    readonly handler: string;
    readonly source: string;
    readonly requiresOperator: boolean;
  }[];
}

const MANIFEST = JSON.parse(
  readFileSync(
    new URL("../../../../../apps/agent/src/control-plane/operation-manifest.generated.json", import.meta.url),
    "utf8",
  ),
) as { readonly inventories: { readonly restOperations: readonly ManifestOperation[] } };

/** The scan root the generator attributes this deployable's routes to. */
const CORE_API_ROOT = "apps/core-api/src/transports";

// ---------------------------------------------------------------------------
// THE METADATA KEYS, DERIVED FROM NEST'S OWN DECORATORS RATHER THAN NAMED.
//
// `PATH_METADATA`, `METHOD_METADATA`, `VERSION_METADATA` and
// `MODULE_METADATA.CONTROLLERS` are exported only from `@nestjs/common/constants`,
// a subpath this project's module resolution will not type. Writing the four
// strings out would work and would be a silent lie the day Nest renamed one: the
// reads below would return `undefined`, the reconstructed template would collapse
// to `/api/v1`, and the join would fail with a message about the wrong thing.
//
// So the keys are MEASURED. A throwaway class is decorated with values nothing
// else could hold, and the key carrying each value is read back off it. That is a
// join to the framework's own implementation, and it fails loudly — right here,
// with a message naming the probe — if a key ever moves.
// ---------------------------------------------------------------------------

const PROBE_CONTROLLER_PATH = "win267-r1-probe-controller-path";
const PROBE_METHOD_PATH = "win267-r1-probe-method-path";
const PROBE_VERSION = "win267-r1-probe-version";

/**
 * WIN-268 (M4.2) — two pipes nothing else in the process holds.
 *
 * They are IDENTIFIABLE BY VALUE, which is what lets the paramtype numbers below
 * be measured rather than written. `@Query` is `RouteParamtypes.QUERY` and `@Body`
 * is `RouteParamtypes.BODY`; both are integers in an enum this project cannot
 * import (`@nestjs/common/enums`, an untyped subpath, the same problem the four
 * metadata keys above have), and hard-coding `4` would read `undefined` the day
 * Nest reordered the enum — leaving every route looking as though it had no pipes,
 * which is silently the permissive answer.
 */
const QUERY_PROBE_PIPE: PipeTransform = { transform: (value: unknown) => value };
const BODY_PROBE_PIPE: PipeTransform = { transform: (value: unknown) => value };

@Controller({ path: PROBE_CONTROLLER_PATH, version: PROBE_VERSION })
class MetadataProbeController {
  @Get(PROBE_METHOD_PATH)
  probe(): void {
    // Never called. Its decorators are the measurement.
  }

  @Get(`${PROBE_METHOD_PATH}-args`)
  probeArguments(
    @Query(QUERY_PROBE_PIPE) _query: unknown,
    @Body(BODY_PROBE_PIPE) _body: unknown,
  ): void {
    // Never called either. The two pipes above are the measurement.
  }
}

/** One `__routeArguments__` entry as Nest's `assignMetadata` writes it. */
interface RouteArgument {
  readonly index: number;
  readonly pipes?: readonly PipeTransform[];
}
type RouteArguments = Readonly<Record<string, RouteArgument>>;

@Module({ controllers: [MetadataProbeController] })
class MetadataProbeModule {}

/** The single metadata key on `target` whose value satisfies `holds`. */
function metadataKey(target: object, holds: (value: unknown) => boolean, what: string): string {
  const keys = (Reflect.getMetadataKeys(target) as readonly (string | symbol)[]).filter(
    (key): key is string => typeof key === "string",
  );
  const found = keys.filter((key) => holds(Reflect.getMetadata(key, target)));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one Nest metadata key to carry ${what}; found ${String(found.length)} (${keys.join(", ")})`,
    );
  }
  return found[0] as string;
}

const PATH_KEY = metadataKey(
  MetadataProbeController,
  (value) => value === PROBE_CONTROLLER_PATH,
  "a controller path",
);
const VERSION_KEY = metadataKey(
  MetadataProbeController,
  (value) => value === PROBE_VERSION,
  "a controller version",
);
const PROBE_HANDLER = (MetadataProbeController.prototype as unknown as Record<string, unknown>)["probe"] as object;
const METHOD_KEY = metadataKey(
  PROBE_HANDLER,
  (value) => value === RequestMethod.GET,
  "a route's HTTP method",
);
const CONTROLLERS_KEY = metadataKey(
  MetadataProbeModule,
  (value) => Array.isArray(value) && value.includes(MetadataProbeController),
  "a module's controller list",
);

/**
 * `__routeArguments__` — MEASURED, like the four keys above and for the same
 * reason.
 *
 * It is the one Nest metadata key written against a PROPERTY of the constructor
 * rather than against the class or the method, so `metadataKey` cannot find it:
 * `Reflect.getMetadataKeys(C)` does not list keyed metadata. Hence the direct
 * search over `getMetadataKeys(controller, handlerName)`.
 */
const ROUTE_ARGS_KEY = ((): string => {
  const keys = Reflect.getMetadataKeys(MetadataProbeController, "probeArguments") as readonly (
    | string
    | symbol
  )[];
  const found = keys.filter(
    (key): key is string =>
      typeof key === "string" &&
      Object.values(
        (Reflect.getMetadata(key, MetadataProbeController, "probeArguments") ?? {}) as RouteArguments,
      ).some((argument) => (argument.pipes ?? []).includes(QUERY_PROBE_PIPE)),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one Nest metadata key to carry a handler's parameter pipes; found ${String(found.length)}`,
    );
  }
  return found[0] as string;
})();

/**
 * The two `RouteParamtypes` values, read off the probe by WHICH PIPE they carry.
 *
 * `entry.split(":")[0]` is the paramtype and the rest is the parameter index —
 * `assignMetadata`'s own key shape. Identifying each by its probe pipe is what
 * makes this a measurement of Nest's enum rather than a copy of it.
 */
function probeParamtype(pipe: PipeTransform, what: string): string {
  const declared = (Reflect.getMetadata(ROUTE_ARGS_KEY, MetadataProbeController, "probeArguments") ??
    {}) as RouteArguments;
  const found = Object.entries(declared).filter(([, argument]) =>
    (argument.pipes ?? []).includes(pipe),
  );
  if (found.length !== 1) {
    throw new Error(`expected exactly one probe parameter to carry the ${what} pipe`);
  }
  return (found[0] as [string, RouteArgument])[0].split(":")[0] as string;
}

const QUERY_PARAMTYPE = probeParamtype(QUERY_PROBE_PIPE, "query");
const BODY_PARAMTYPE = probeParamtype(BODY_PROBE_PIPE, "body");

const VERB = new Map<number, string>([
  [RequestMethod.GET, "GET"],
  [RequestMethod.POST, "POST"],
  [RequestMethod.PUT, "PUT"],
  [RequestMethod.PATCH, "PATCH"],
  [RequestMethod.DELETE, "DELETE"],
  [RequestMethod.ALL, "ALL"],
]);

interface MountedRoute {
  readonly id: string;
  readonly controller: string;
  readonly handler: string;
  /** The handler's compiled body, read at run time. See `operator protection`. */
  readonly body: string;
  /**
   * The pipes this handler declares on its `@Query` and `@Body` parameters.
   *
   * WIN-268 (M4.2). Carried so `expectedRefusal` can ASK them what an empty probe
   * does instead of predicting it from the verb — see that function's note.
   */
  readonly queryPipes: readonly PipeTransform[];
  readonly bodyPipes: readonly PipeTransform[];
}

/** The pipes one handler declares on one parameter kind. */
function declaredPipes(
  controller: new (...args: never[]) => object,
  handlerName: string,
  paramtype: string,
): readonly PipeTransform[] {
  const declared = (Reflect.getMetadata(ROUTE_ARGS_KEY, controller, handlerName) ??
    {}) as RouteArguments;
  const pipes: PipeTransform[] = [];
  for (const [entry, argument] of Object.entries(declared)) {
    if (entry.split(":")[0] !== paramtype) continue;
    pipes.push(...(argument.pipes ?? []));
  }
  return pipes;
}

/** Join path fragments the way `RoutePathFactory.appendToAllIfDefined` does. */
function joinSegments(...fragments: readonly (string | undefined)[]): string {
  const parts: string[] = [];
  for (const fragment of fragments) {
    if (fragment === undefined) continue;
    for (const segment of fragment.split("/")) {
      if (segment !== "") parts.push(segment);
    }
  }
  return `/${parts.join("/")}`;
}

/**
 * Every route the five registered controllers mount, reconstructed from metadata.
 *
 * THE CONTROLLER LIST IS READ OFF THE MODULE, not written here. `MODULE_METADATA
 * .CONTROLLERS` on `CoreApiHttpModule` is the same array Nest's
 * `reflectControllers` reads, so a controller added to `transports/` and left out
 * of the module is absent from the LEFT side and the join fails — which is the
 * same omission `assertStrictRootsHaveNoUnregisteredControllers` refuses in the
 * generator, caught here from the runtime side as well.
 */
export function mountedRoutes(): readonly MountedRoute[] {
  const controllers = (Reflect.getMetadata(CONTROLLERS_KEY, CoreApiHttpModule) ??
    []) as readonly (new (...args: never[]) => object)[];
  const routes: MountedRoute[] = [];
  for (const controller of controllers) {
    const controllerPath = Reflect.getMetadata(PATH_KEY, controller) as string | undefined;
    const version = Reflect.getMetadata(VERSION_KEY, controller) as string | symbol | undefined;
    // TWO SURFACES, TWO VERSION EXPRESSIONS, AND EVERY CONTROLLER IS ON EXACTLY
    // ONE OF THEM.
    //
    // WIN-268 (M4.2) P1. Until this tranche every controller in the static array
    // was REST and declared `API_VERSION`. The two MCP token mints are the first
    // that do not, and the difference is ADR M0.4 §2's: the REST major is a URL
    // segment and the MCP major is `serverInfo.version`, negotiated inside the
    // JSON-RPC handshake. Putting a version in an MCP URL would be a third axis
    // nobody negotiated.
    //
    // The partition is by the VERSION the controller declares, and the PATH is
    // then required to match — so a REST controller that quietly went
    // version-neutral, or an MCP controller mounted under `/api/v1`, fails here
    // rather than in production. `expectedVersion` is read off the surface
    // constants, never typed: `transports/mcp/mcp-surface.ts` is the one place
    // `VERSION_NEUTRAL` is chosen for this surface, exactly as `api-surface.ts`
    // is for the other.
    const isMcp = version === MCP_ROUTE_VERSION;
    expect(
      version,
      `${controller.name} must declare either ${API_VERSION} (REST) or the MCP surface's version`,
    ).toBe(isMcp ? MCP_ROUTE_VERSION : API_VERSION);
    if (isMcp) {
      expect(
        controllerPath ?? "",
        `${controller.name} is version-neutral and must therefore be an MCP route`,
      ).toMatch(new RegExp(`^${MCP_ROOT_SEGMENT}/`, "u"));
    }
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor") continue;
      const handler = prototype[name];
      if (typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METHOD_KEY, handler) as number | undefined;
      if (method === undefined) continue;
      const methodPath = Reflect.getMetadata(PATH_KEY, handler) as string | undefined;
      const verb = VERB.get(method);
      expect(verb, `${controller.name}.${name} declares an unknown HTTP method`).toBeDefined();
      // The version prefix is applied for a REST route and OMITTED for an MCP
      // one, which is `RoutePathFactory`'s own behaviour under
      // `VERSION_NEUTRAL`. Composed from the two surfaces' constants rather than
      // written out, so a moved segment moves the LEFT side of the join too.
      const template = isMcp
        ? joinSegments(controllerPath, methodPath)
        : joinSegments(`${API_URI_VERSION_PREFIX}${API_VERSION}`, controllerPath, methodPath);
      routes.push({
        id: `${String(verb)} ${template}`,
        controller: controller.name,
        handler: name,
        body: Function.prototype.toString.call(handler),
        queryPipes: declaredPipes(controller, name, QUERY_PARAMTYPE),
        bodyPipes: declaredPipes(controller, name, BODY_PARAMTYPE),
      });
    }
  }
  return routes;
}

/**
 * Whether the probe below sends a request body on this method.
 *
 * ONE PREDICATE, READ TWICE. The probe loop and `expectedRefusal` used to decide
 * this separately — the loop on `GET || DELETE`, the expectation on `=== "POST"` —
 * and the two agreed only for as long as `POST` was the only verb in this tree
 * that carried a body. WIN-268 (M4.2) added a `PUT`, and the disagreement showed
 * up as the expectation predicting `TRANSPORT_CONTEXT_UNAVAILABLE` for a route the
 * probe was in fact sending `{}` to. Deriving both from this function is what
 * makes the next verb cost nothing.
 */
function probeSendsBody(method: string): boolean {
  return method !== "GET" && method !== "DELETE";
}

/**
 * What a route answers to an empty, keyless probe against an uncomposed process.
 *
 * READ OUT OF THE POLICY TABLE, not listed here. `classifyRequest` is the very
 * function the gate calls, so a template moving between classes moves this
 * expectation with it — the alternative is a second opinion about which routes
 * the mint contract binds.
 *
 * THE SECOND BRANCH IS DERIVED BY ASKING THE ROUTE'S OWN PIPES, and WIN-268 (M4.2)
 * is why it had to become that.
 *
 * It used to read `probeSendsBody(row.method) ? INVALID : CONTEXT_UNAVAILABLE`,
 * whose stated premise was "a route with no body to validate gets as far as
 * `requireTenancy`". That premise held only while every validating pipe in the
 * tree sat on a `@Body`. The four MCP token lifecycle routes carry their tenancy
 * in the QUERY — two are `GET` and one is `DELETE`, and their templates are fixed
 * by `http/idempotency-policy.ts` — so `environmentId` is a required query
 * parameter and its pipe refuses the empty probe before the handler runs. The
 * prediction was wrong for three routes, and it was wrong in the DIRECTION that
 * matters: it expected a route to reach the context check when in fact nothing
 * about the context had been consulted.
 *
 * SO THE PIPES ARE EXECUTED RATHER THAN CLASSIFIED. Every pipe the handler
 * declares on a parameter the probe actually populates is handed `{}` — the exact
 * value Express gives a `@Query()` with no query string, and the parsed value of
 * the probe's `"{}"` body — and a pipe that throws is a route refused before the
 * handler. Nothing here decides which pipes those are: they come off Nest's own
 * `__routeArguments__`, measured above, so adding a query pipe to a route moves
 * this expectation with it and a route that ever authenticated before validating
 * would show up as a changed code.
 *
 * A `@Query` PIPE ON A ROUTE THAT ACCEPTS AN EMPTY QUERY IS UNAFFECTED, which is
 * the case a "does it have a query pipe" test would have got wrong:
 * `UNPAGED_QUERY_PIPE` refuses `?limit=` and passes `{}`, so `GET /api/v1/projects`
 * still reaches `requireTenancy` and still answers
 * `TRANSPORT_CONTEXT_UNAVAILABLE`. Asking the pipe is what tells the two apart.
 */
function refusesEmptyProbe(route: MountedRoute): boolean {
  const applicable = [
    ...route.queryPipes,
    ...(probeSendsBody(route.id.split(" ")[0] ?? "") ? route.bodyPipes : []),
  ];
  for (const pipe of applicable) {
    try {
      pipe.transform({}, { type: "custom" });
    } catch {
      return true;
    }
  }
  return false;
}

function expectedRefusal(row: ManifestOperation, mounted: MountedRoute): string {
  if (classifyRequest(row.method, row.path) === "required") return "IDEMPOTENCY_KEY_REQUIRED";
  return refusesEmptyProbe(mounted) ? "TRANSPORT_REQUEST_INVALID" : "TRANSPORT_CONTEXT_UNAVAILABLE";
}

/**
 * The mounted route each manifest row names.
 *
 * A THROW AND NOT A FALLBACK: the case above has already asserted the two sides
 * are the same set, so a miss here means that assertion was weakened and the
 * expectation would otherwise quietly fall back to a default.
 */
function mountedFor(row: ManifestOperation): MountedRoute {
  const id = `${row.method} ${row.path}`;
  const found = mountedRoutes().find((route) => route.id === id);
  if (found === undefined) throw new Error(`${id} is declared in the manifest and is not mounted`);
  return found;
}

function manifestRoutes(): readonly ManifestOperation[] {
  return MANIFEST.inventories.restOperations.filter((operation) =>
    operation.implementations.some((implementation) =>
      implementation.source.startsWith(`${CORE_API_ROOT}/`),
    ),
  );
}

describe("WIN-267 R1 — the mounted route and the declared route are the same route", () => {
  it("reads the framework's own metadata keys, measured rather than named", () => {
    // The probe is decorated with values nothing else in the process holds, so
    // each key is identified by what it CARRIES. If this case ever fails, every
    // reconstruction below is reading `undefined` and the join is meaningless.
    expect(Reflect.getMetadata(PATH_KEY, MetadataProbeController)).toBe(PROBE_CONTROLLER_PATH);
    expect(Reflect.getMetadata(VERSION_KEY, MetadataProbeController)).toBe(PROBE_VERSION);
    expect(Reflect.getMetadata(PATH_KEY, PROBE_HANDLER)).toBe(PROBE_METHOD_PATH);
    expect(Reflect.getMetadata(METHOD_KEY, PROBE_HANDLER)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(CONTROLLERS_KEY, MetadataProbeModule)).toEqual([MetadataProbeController]);
  });

  it("is not vacuous: this deployable mounts routes and the manifest declares some", () => {
    // WITHOUT THIS THE WHOLE FILE PASSES ON AN EMPTY TREE. Two empty sets are
    // equal, and a controller deleted from the module plus a manifest regenerated
    // afterwards would satisfy every assertion below while serving nothing.
    expect(mountedRoutes().length).toBeGreaterThan(0);
    expect(manifestRoutes().length).toBe(mountedRoutes().length);
  });

  it("mounts exactly the method/path pairs the manifest attributes to this tree", () => {
    const mounted = [...new Set(mountedRoutes().map((route) => route.id))].sort();
    const declared = [...new Set(manifestRoutes().map((row) => `${row.method} ${row.path}`))].sort();
    // ONE EQUALITY, BOTH SIDES MEASURED. A route mounted and not declared is an
    // ungoverned surface; a route declared and not mounted is a 404 in
    // production with a green census.
    expect(mounted).toEqual(declared);
  });

  it("mounts every route under ONE of the two canonical prefixes, with no hand-written version", () => {
    const rest = `/${API_URI_VERSION_PREFIX}${API_VERSION}/`;
    const seen = { rest: 0, mcp: 0 };
    for (const route of mountedRoutes()) {
      // Both prefixes are composed from their surfaces' constants rather than
      // typed here: the point is that every route inherits ONE of the two
      // decisions, not that it matches a string this test happens to hold.
      if (route.id.includes(` ${MCP_PATH_PREFIX}`)) {
        seen.mcp += 1;
        // AND AN MCP ROUTE MUST NOT CARRY THE REST MAJOR. Without this the case
        // would pass for a route mounted at `/api/v1/mcp/...`, which is the
        // third version axis ADR M0.4 §2 refuses.
        expect(route.id).not.toContain(rest);
        continue;
      }
      seen.rest += 1;
      expect(route.id).toContain(` ${rest}`);
    }
    // NOT VACUOUS IN EITHER DIRECTION: both surfaces are populated, so a
    // partition that had swallowed one of them fails here.
    expect(seen.rest).toBeGreaterThan(0);
    expect(seen.mcp).toBeGreaterThan(0);
  });

  it("keeps the process edge off the versioned surface", () => {
    // The two controllers that answer at the application root. If either lost
    // `VERSION_NEUTRAL`, `/livez` would move to `/api/v1/livez` and the terminal
    // 404 would stop answering an unrouted request — the failure that would take
    // a fleet down on a rolling restart.
    for (const edge of [HealthController, NotFoundController]) {
      expect(Reflect.getMetadata(VERSION_KEY, edge), `${edge.name} must be version-neutral`).toBe(
        VERSION_NEUTRAL,
      );
    }
    const registered = (Reflect.getMetadata(CONTROLLERS_KEY, CoreApiHttpModule) ??
      []) as readonly unknown[];
    expect(registered).not.toContain(HealthController);
    expect(registered).not.toContain(NotFoundController);
  });

  it("records operator protection where the guard is actually called, and only there", () => {
    // AN INDEPENDENT SECOND READING. The manifest's `requiresOperator` comes from
    // a TypeScript AST walk over SOURCE text in
    // `apps/agent/scripts/generate-control-plane.mjs`. This reads the COMPILED
    // function body back out of the running class. Two different artifacts, two
    // different mechanisms, one claim — and the claim is falsifiable in both
    // directions because `DELETE /api/v1/bff/session` deliberately authenticates
    // nobody, so a blanket "true" and a blanket "false" both fail.
    const declared = new Map(
      manifestRoutes().map((row) => [
        `${row.method} ${row.path}`,
        row.implementations.some((implementation) => implementation.requiresOperator),
      ]),
    );
    // THE TWO SEAM NAMES, and the second is not a synonym. WIN-268 P1: a mint
    // calls `mintingOperator`, which is `authenticateOperator` PLUS the refusal
    // that an impersonated session may not mint a durable credential. Reading
    // only the first name would record a route that authenticates an operator
    // more strictly as authenticating none. The generator's own
    // `OPERATOR_SCOPE_CALLS` list carries the same two names for the same
    // reason, which is what keeps these two readings independent rather than
    // divergent.
    const seams = ["authenticateOperator", "mintingOperator"];
    const observed = mountedRoutes().map((route) => ({
      id: route.id,
      guarded: seams.some((seam) => route.body.includes(seam)),
    }));
    expect(observed.filter((route) => route.guarded).length).toBeGreaterThan(0);
    expect(observed.filter((route) => !route.guarded).length).toBeGreaterThan(0);
    for (const route of observed) {
      expect(declared.get(route.id), `${route.id} is not in the manifest`).toBe(route.guarded);
    }
  });
});

// ---------------------------------------------------------------------------
// AND THE SAME JOIN, AGAINST THE PROCESS `main.ts` STARTS.
//
// The cases above read metadata. Metadata is what Nest READS, not what Express
// SERVES, and one thing sits between them that no decorator records: the ORDER
// controllers are registered in. `NotFoundController` answers `@All("{*path}")`,
// Express matches in registration order, and a business controller registered
// after it answers 404 for every route it declares — with every unit case still
// green and the manifest still correct.
//
// So each declared route is ISSUED, against a real server, and required not to be
// the terminal handler's answer. No container is needed and none is used: with no
// store configured the contexts are absent, so a mounted route answers
// `TRANSPORT_CONTEXT_UNAVAILABLE` and an unmounted one answers
// `TRANSPORT_ROUTE_NOT_FOUND`. Those are two different codes on purpose — that is
// what `contextUnavailable` was minted for — and telling them apart is the whole
// measurement.
// ---------------------------------------------------------------------------

describe("WIN-267 R1 — every declared route is REACHABLE in the process, in registration order", () => {
  let running: RunningCoreApi | null = null;

  afterAll(async () => {
    await running?.stop("test");
  });

  it("answers each declared route from its handler, and a near-miss from the terminal one", async () => {
    const platform = loadPlatformConfiguration({
      PLATOS_ENVIRONMENT: "test",
      PLATOS_CORE_API_PORT: "0",
      PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    });
    expect(platform.ok, JSON.stringify(platform)).toBe(true);
    if (!platform.ok) return;
    running = await startCoreApi({ configuration: platform.value.core });
    const base = `http://${running.host}:${String(running.port)}`;

    // NOT VACUOUS: no context is composed, which is the state that makes the two
    // codes distinguishable. If one ever were, this case would be reading a
    // different answer and would say so here rather than silently weakening.
    expect(running.app.contexts.identityAccess).toBeUndefined();

    const answers: string[] = [];
    for (const row of manifestRoutes()) {
      // `:param` segments are filled with a value that names itself, so a
      // response that echoed one would be obvious. Nothing reads it — the
      // contexts are absent — but a future reader should not have to wonder.
      const path = row.path.replace(/:[A-Za-z0-9_]+/gu, "probe-parameter");
      const response = await fetch(`${base}${path}`, {
        method: row.method,
        headers: { "content-type": "application/json" },
        ...(probeSendsBody(row.method) ? { body: "{}" } : {}),
      });
      const body = (await response.json()) as { readonly error?: { readonly code?: string } };
      answers.push(`${row.method} ${row.path} -> ${String(body.error?.code)}`);
    }
    // THE EXPECTED CODE IS DERIVED FROM THE ROW, not listed by hand. Every
    // declared POST carries a body pipe, and a pipe runs BEFORE the handler, so
    // an empty body is refused with `TRANSPORT_REQUEST_INVALID` and never reaches
    // the context check. That ordering is itself worth pinning: a malformed
    // request is refused before anything authenticates, and a route that ever
    // authenticated first would show up here as a changed code.
    //
    // EXCEPT ON A ONE-TIME-SECRET MINT, WHERE AN EARLIER GATE ANSWERS FIRST, and
    // that is the strongest evidence in this file that WIN-268 P1 landed what it
    // set out to. `http/idempotency-policy.ts` classes the two MCP token mints
    // `required`, and the gate is module MIDDLEWARE — it runs before routing, so
    // it refuses a keyless request with `IDEMPOTENCY_KEY_REQUIRED` before the
    // body pipe ever sees it. Before this tranche those two templates were bound
    // by that gate and served by NOTHING: a caller that sent a key was reserved,
    // admitted, and handed the terminal 404. The expected code is read out of
    // the SAME policy table the gate consults, so it cannot drift from it.
    expect(answers).toEqual(
      manifestRoutes().map(
        (row) =>
          `${row.method} ${row.path} -> ${expectedRefusal(row, mountedFor(row))}`,
      ),
    );
    // AND THE PROPERTY THAT MATTERS, STATED SEPARATELY so it survives any future
    // change to the codes above: not one declared route reached the terminal
    // handler.
    for (const answer of answers) expect(answer).not.toContain("TRANSPORT_ROUTE_NOT_FOUND");

    // THE NEGATIVE CONTROL. Without it the case above would pass against a
    // process that answered `TRANSPORT_CONTEXT_UNAVAILABLE` to everything. One
    // segment off in each direction — a wrong version and a missing prefix — and
    // both must reach the terminal handler.
    for (const miss of ["/api/v2/organizations", "/organizations", "/api/v1/organisations"]) {
      const response = await fetch(`${base}${miss}`);
      const body = (await response.json()) as { readonly error?: { readonly code?: string } };
      expect(body.error?.code, `${miss} must not be served`).toBe("TRANSPORT_ROUTE_NOT_FOUND");
    }

    // AND THE PROCESS EDGE STILL ANSWERS AT THE ROOT.
    expect((await fetch(`${base}/livez`)).status).toBe(200);
  }, 60_000);
});
