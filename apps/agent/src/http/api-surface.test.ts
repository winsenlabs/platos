import "reflect-metadata";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Module, VERSION_NEUTRAL, VersioningType, Controller, Get } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";

import manifest from "../control-plane/operation-manifest.generated.json";
import {
  API_GLOBAL_PREFIX,
  API_VERSION,
  API_V1_PREFIX,
  GLOBAL_PREFIX_EXCLUDE,
  UNVERSIONED_ROOT_SEGMENTS,
  applyApiSurface,
} from "./api-surface";

import { AgentController } from "../agent-runtime/agent.controller";
import { AttachmentUploadController } from "../agent-runtime/attachment-upload.controller";
import { ChatStreamController } from "../agent-runtime/chat-stream.controller";
import { ChannelAppsController } from "../agent-runtime/channel-apps.controller";
import { ChannelsController } from "../agent-runtime/channels.controller";
import { JobExecutionController } from "../agent-runtime/job-execution.controller";
import { JobsController } from "../agent-runtime/jobs.controller";
import { PublicGuestTokenController } from "../auth/public-guest-token.controller";
import { SessionTokenController } from "../auth/session-token.controller";
import { ChannelAppEventsController } from "../channels/channel-app-events.controller";
import { ChannelAppOAuthController } from "../channels/channel-app-oauth.controller";
import { ChannelLinkController } from "../channels/channel-link.controller";
import { ChannelsInboundController } from "../channels/channels-inbound.controller";
import { FilesController } from "../files/files.controller";
import { HealthController } from "../health/health.controller";
import { DocsMcpController } from "../mcp-docs/docs-mcp.controller";
import { McpEntityController } from "../mcp-platform/mcp-entity.controller";
import { McpPlatformController } from "../mcp-platform/mcp-platform.controller";
import { MemoryController } from "../memory/memory.controller";
import { MemoryFeedbackAdminController } from "../memory/memory-feedback-admin.controller";
import { MetricsController } from "../monitoring/metrics.controller";
import { OAuthController } from "../oauth/oauth.controller";
import { OpenApiController } from "../openapi/openapi.controller";
import { PerformanceEvidenceController } from "../performance-evidence/performance-evidence.controller";
import { ErasureController } from "../privacy/erasure.controller";
import { ProvidersController } from "../providers/providers.controller";
import { SkillsController } from "../skills/skills.controller";
import { InternalExecuteToolController } from "../trigger-bridge/internal-execute-tool.controller";

/**
 * WIN-267 (M4.1) T1 — ROUTE IDENTITY.
 *
 * The claim T1 has to earn is narrow and total: the version stopped being 24
 * hand-written literals, and NOT ONE of the 300 REST operations moved. A route
 * that silently moves is a broken client, so the claim cannot be checked against
 * a list written here — it is checked against
 * `control-plane/operation-manifest.generated.json`, which
 * `apps/agent/scripts/generate-control-plane.mjs` emits by AST-walking the
 * controllers, and which `--check` refuses to let drift from the committed copy.
 *
 * THREE MECHANISMS, NOTHING SHARED BETWEEN THEM.
 *
 *   1. The generator composes paths STATICALLY from the TypeScript AST, reading
 *      the prefix/version/exclusion constants out of `api-surface.ts`.
 *   2. This test composes them at RUNTIME by giving the real controllers to a
 *      real Nest application, calling the same `applyApiSurface` that `main.ts`
 *      calls, and reading the route table back out of Express — Nest's
 *      `RoutePathFactory`, not arithmetic written here.
 *   3. `scripts/rest-census-independent.mjs` globs the controller files and
 *      reconciles decorator counts against the same manifest without using the
 *      generator's allowlist at all.
 *
 * The committed manifest did not change by one byte across this migration, which
 * is what makes (1) evidence rather than assumption; this file is what makes it
 * true of the router and not only of the AST.
 *
 * WHY THE DI METADATA IS STRIPPED BELOW. Vitest transforms TypeScript with
 * esbuild, which does not implement `emitDecoratorMetadata`, so
 * `design:paramtypes` is absent and Nest cannot resolve a single constructor
 * argument — with or without this change. The thing under test is the ROUTER:
 * `PATH_METADATA`, `VERSION_METADATA` and the HTTP-method decorators, none of
 * which this file touches. Erasing the constructor-injection metadata (and
 * running Nest in `preview` mode, which never calls a constructor or a lifecycle
 * hook) lets the router run over the real classes without standing a database
 * up. If a route decorator were what got erased, every assertion below would go
 * red, which is the direction that matters.
 */

const PRODUCTION_CONTROLLERS = [
  AgentController,
  AttachmentUploadController,
  // M4 finish — the POST twin of `AgentController`'s chat-stream GET, so a user
  // message stops travelling in the upstream REQUEST LINE. ADR M0.4 §1.3: adding
  // a route is additive-in-major; narrowing the BFF's ceiling would not be.
  ChatStreamController,
  ChannelAppsController,
  ChannelsController,
  JobExecutionController,
  JobsController,
  PublicGuestTokenController,
  SessionTokenController,
  ChannelAppEventsController,
  ChannelAppOAuthController,
  ChannelLinkController,
  ChannelsInboundController,
  FilesController,
  HealthController,
  DocsMcpController,
  McpEntityController,
  McpPlatformController,
  MemoryController,
  MemoryFeedbackAdminController,
  MetricsController,
  OAuthController,
  OpenApiController,
  PerformanceEvidenceController,
  ErasureController,
  ProvidersController,
  SkillsController,
  InternalExecuteToolController,
] as const;

type Ctor = (typeof PRODUCTION_CONTROLLERS)[number];

/** The scan root this deployable's routes are attributed to in the manifest. */
const AGENT_ROOT = "apps/agent/src";

/**
 * The manifest operations THIS DEPLOYABLE SERVES.
 *
 * WIN-268 (M4.2) P1 — A PRE-EXISTING RED, REPAIRED. Every case below joins the
 * AGENT's Nest router to the manifest, and the manifest stopped being a census
 * of one application in M4.1 (WIN-267 R1): it gained a second scan root,
 * `apps/core-api/src/transports`, and eight operations served by a DIFFERENT
 * process. Nothing here was taught about it, so three cases in this file have
 * been red on `v1` since that tranche — measured at 3b3f1ebb, where they report
 * five core-api controllers "the agent does not serve" and 252 versioned
 * operations against a pin of 244 (244 + 8). `route-manifest.test.ts` filters to
 * the OTHER root for exactly this reason and has done since the day it was
 * written; this side simply never gained the mirror of that filter.
 *
 * WHY IT IS FIXED HERE. This tranche adds two more core-api controllers, so the
 * failure message grows from five names to seven and a reader would reasonably
 * read the growth as this branch's doing. The filter is the same one line the
 * sibling file already carries, and restoring it turns three cases that could
 * not pass back into the join they were written to be.
 *
 * IT IS A FILTER AND NOT AN EXCLUSION LIST. A core-api route is identified by
 * the SOURCE the manifest records for its implementation, so a route that moved
 * between the deployables moves between these sets on its own.
 */
const MANIFEST_OPERATIONS = (
  manifest.inventories.restOperations as ReadonlyArray<{
    id: string;
    method: string;
    path: string;
    implementations: ReadonlyArray<{ controller: string; source: string }>;
  }>
).flatMap((operation) => {
  const served = operation.implementations.filter(
    (implementation) =>
      implementation.source === AGENT_ROOT || implementation.source.startsWith(`${AGENT_ROOT}/`),
  );
  // An operation with no agent implementation is another deployable's route and
  // is not this router's to serve. One with SOME is served here too — the two
  // MCP token mints are served by both — and is kept, carrying only the
  // implementations this application actually mounts.
  return served.length === 0 ? [] : [{ ...operation, implementations: served }];
});

/**
 * Erase constructor/property injection so the container has nothing to resolve.
 * Route metadata is deliberately untouched.
 */
function stripInjectionMetadata(controller: Ctor): void {
  Reflect.defineMetadata("design:paramtypes", [], controller);
  Reflect.defineMetadata("self:paramtypes", [], controller);
  Reflect.defineMetadata("self:properties_metadata", [], controller);
}

/** Every `METHOD /path` Express is actually serving. */
function registeredRoutes(app: INestApplication): string[] {
  const express = app.getHttpAdapter().getInstance() as {
    router?: { stack?: unknown[] };
    _router?: { stack?: unknown[] };
  };
  const stack = express.router?.stack ?? express._router?.stack ?? [];
  if (stack.length === 0) throw new Error("the Express router registered nothing; the probe is not measuring anything");
  const routes: string[] = [];
  for (const layer of stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled || method === "_all") continue;
      routes.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return routes;
}

/**
 * Register `controllers` on a real Nest application and return what Express ends
 * up serving. `configure` receives the app before routing so a control can
 * install a DIFFERENT version expression (or none) and watch the paths move.
 *
 * `registerRouter()` is the step of `init()` that maps routes; the other steps
 * of `init()` run module lifecycle hooks, which a controller built by `preview`
 * mode would enter with uninitialised fields. Calling it directly keeps the
 * router honest and the hooks out.
 */
async function routesUnder(
  controllers: readonly Ctor[] | readonly unknown[],
  configure: (app: INestApplication) => void,
): Promise<string[]> {
  @Module({ controllers: controllers as never[] })
  class ProbeModule {}

  const app = await NestFactory.create(ProbeModule, {
    preview: true,
    logger: false,
    abortOnError: false,
    bodyParser: false,
  });
  const withRouter = app as unknown as { registerRouter?: () => Promise<void> };
  if (typeof withRouter.registerRouter !== "function") {
    throw new Error("NestApplication.registerRouter is gone; this probe no longer measures route registration");
  }
  configure(app);
  await withRouter.registerRouter();
  return registeredRoutes(app);
}

describe("WIN-267 T1 — the version is one expression", () => {
  it("declares the prefix, the major and the unversioned roots exactly once each", () => {
    expect(API_GLOBAL_PREFIX).toBe("api");
    expect(API_VERSION).toBe("1");
    expect(API_V1_PREFIX).toBe("/api/v1");
    // The exclude patterns are derived from the segment list, not written twice.
    expect(GLOBAL_PREFIX_EXCLUDE).toEqual(UNVERSIONED_ROOT_SEGMENTS.map((s) => `/${s}{/*rest}`));
  });

  /**
   * THE HOLE THIS CLOSES. Everything else in this file proves that
   * `applyApiSurface` puts the routes where the manifest says they are. None of
   * it proves the PROCESS calls it — delete the one line from `main.ts` and the
   * generator, the census and the route probe all stay green while the running
   * server serves `/agent/agents`. So the composition root is read here, and the
   * two Nest calls that express a version are pinned to the one file that owns
   * them.
   */
  it("the composition root installs the expression, and nothing else expresses a version", () => {
    // Located from the working directory rather than `import.meta`: this file is
    // typechecked under the agent's CommonJS `module` setting, where
    // `import.meta` is a TS1343 error. `existsSync` decides between the two
    // roots a run can start from, and a third would fail the assertion below
    // rather than silently scan nothing.
    const candidates = [resolve("src"), resolve("apps/agent/src")];
    const srcDir = candidates.find((dir) => existsSync(join(dir, "main.ts")));
    expect(srcDir, `agent src not found from ${process.cwd()}`).toBeDefined();
    const main = readFileSync(join(srcDir as string, "main.ts"), "utf8");
    expect(main).toContain('import { applyApiSurface } from "./http/api-surface"');
    expect(main).toMatch(/^\s*applyApiSurface\(app\);$/mu);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
        if (path === join(srcDir as string, "http", "api-surface.ts")) continue;
        const text = readFileSync(path, "utf8");
        if (/\.setGlobalPrefix\(|\.enableVersioning\(/u.test(text)) {
          offenders.push(path.slice((srcDir as string).length + 1));
        }
      }
    };
    walk(srcDir as string);
    expect(offenders, "setGlobalPrefix/enableVersioning may only be called from http/api-surface.ts").toEqual([]);
  });

  it("covers every controller the generated manifest attributes a route to", () => {
    const named = new Set(MANIFEST_OPERATIONS.flatMap((op) => op.implementations.map((i) => i.controller)));
    const probed = new Set(PRODUCTION_CONTROLLERS.map((c) => c.name));
    // Both directions: a controller this file forgot would otherwise take its
    // routes out of the comparison and the identity check would still pass.
    expect([...named].filter((n) => !probed.has(n))).toEqual([]);
    expect([...probed].filter((n) => !named.has(n))).toEqual([]);
    // 28: +1 for ChatStreamController (M4 finish).
    expect(probed.size).toBe(28);
  });
});

describe("WIN-267 T1 — every operation answers on the path it always answered on", () => {
  it("the Nest router reproduces the generated manifest, route for route", async () => {
    for (const controller of PRODUCTION_CONTROLLERS) stripInjectionMetadata(controller);

    const served = await routesUnder(PRODUCTION_CONTROLLERS, applyApiSurface);
    const expected = MANIFEST_OPERATIONS.map((op) => op.id);

    const servedSet = new Set(served);
    const expectedSet = new Set(expected);

    // Named both ways so a failure says WHICH route moved, not just "sets differ".
    expect([...expectedSet].filter((id) => !servedSet.has(id)).sort()).toEqual([]);
    expect([...servedSet].filter((id) => !expectedSet.has(id)).sort()).toEqual([]);
    expect(servedSet.size).toBe(expectedSet.size);
    // 301: +1 for POST /api/v1/agent/agents/:agentId/chat/stream (M4 finish).
    expect(expected.length).toBe(301);
    // No path is registered twice under one method — a duplicate would make the
    // set comparison above pass while the second registration was dead.
    expect(served.length).toBe(servedSet.size);
  }, 120_000);

  it("splits the surface the way the ADR does: 245 versioned, 56 deliberately not", async () => {
    for (const controller of PRODUCTION_CONTROLLERS) stripInjectionMetadata(controller);
    const served = await routesUnder(PRODUCTION_CONTROLLERS, applyApiSurface);

    const versioned = served.filter((r) => r.split(" ")[1].startsWith(`${API_V1_PREFIX}/`));
    const bare = served.filter((r) => !r.split(" ")[1].startsWith(`${API_V1_PREFIX}/`));
    // 245: +1 for the chat-stream POST (M4 finish). The bare count does NOT move —
    // the new route is under /api/v1 like the GET it twins.
    expect(versioned.length).toBe(245);
    expect(bare.length).toBe(56);

    // Every bare route is either the process health probe or sits on a root the
    // ADR pins off the versioned surface. Nothing else may escape the prefix.
    for (const route of bare) {
      const path = route.split(" ")[1];
      const root = path.split("/").filter(Boolean)[0];
      const onDeclaredRoot = (UNVERSIONED_ROOT_SEGMENTS as readonly string[]).includes(root);
      expect(onDeclaredRoot || path === "/api/health", `${route} escaped the version with no declared reason`).toBe(true);
    }
  }, 120_000);
});

describe("WIN-267 T1 — negative controls", () => {
  it("MUTATION: without the version expression, all 245 versioned routes move", async () => {
    for (const controller of PRODUCTION_CONTROLLERS) stripInjectionMetadata(controller);
    // The controllers now declare only their own paths, so a Nest application
    // that forgets `applyApiSurface` serves the whole REST surface unprefixed.
    // This is what makes the identity above a property of the expression rather
    // than of the decorators.
    const served = new Set(await routesUnder(PRODUCTION_CONTROLLERS, () => {}));
    const expected = MANIFEST_OPERATIONS.filter((op) => op.path.startsWith(`${API_V1_PREFIX}/`));
    expect(expected.length).toBe(245);
    for (const op of expected) expect(served.has(op.id)).toBe(false);
    expect(served.has("GET /agent/agents")).toBe(true);
  }, 120_000);

  it("MUTATION: without the exclusion list, the unversioned roots are swallowed by /api", async () => {
    for (const controller of PRODUCTION_CONTROLLERS) stripInjectionMetadata(controller);
    const served = new Set(
      await routesUnder(PRODUCTION_CONTROLLERS, (app) => {
        app.setGlobalPrefix(API_GLOBAL_PREFIX);
        app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
      }),
    );
    // RFC-fixed and scraper-fixed URLs really do move when the exclusions go, so
    // the list is load-bearing rather than decorative.
    expect(served.has("GET /metrics")).toBe(false);
    expect(served.has("GET /api/metrics")).toBe(true);
    expect(served.has("POST /oauth/token")).toBe(false);
    expect(served.has("GET /.well-known/oauth-authorization-server")).toBe(false);
    expect(served.has("GET /mcp")).toBe(false);
    // ...while the versioned surface is unaffected, which is why the exclusion
    // list is the only thing this control changed.
    expect(served.has("GET /api/v1/agent/agents")).toBe(true);
  }, 120_000);

  it("defaultVersion is the floor: a controller that declares no version is v1", async () => {
    @Controller("probe")
    class UndeclaredVersionController {
      @Get("thing")
      thing(): string {
        return "";
      }
    }
    @Controller({ path: "probe-neutral", version: VERSION_NEUTRAL })
    class NeutralController {
      @Get("thing")
      thing(): string {
        return "";
      }
    }
    for (const controller of [UndeclaredVersionController, NeutralController]) {
      stripInjectionMetadata(controller as unknown as Ctor);
    }
    const served = new Set(await routesUnder([UndeclaredVersionController, NeutralController], applyApiSurface));
    expect(served.has("GET /api/v1/probe/thing")).toBe(true);
    // A neutral controller on a root that is NOT excluded still takes the global
    // prefix — versioning and prefixing are independent axes, and /api/health is
    // exactly this case in production.
    expect(served.has("GET /api/probe-neutral/thing")).toBe(true);
  }, 120_000);
});
