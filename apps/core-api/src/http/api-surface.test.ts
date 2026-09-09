// THE MEASUREMENT BEHIND `api-surface.ts`'s DESIGN NOTE.
//
// That file says core-api cannot reach `/api/v1` the way `apps/agent` does —
// `setGlobalPrefix("api")` plus a `v` version prefix — because the exclusion list
// that would keep the terminal 404 at the application root also strips the prefix
// off every business route. A comment claiming that would be an assertion nobody
// can check, and this repository has already found FOUR blocking claims in the
// tree that were never true. So it is measured, against a real Nest application,
// through the public API only.
//
// THE MECHANISM, FOR A READER WHO WANTS TO CHECK IT WITHOUT RUNNING ANYTHING:
// `RoutePathFactory.isExcludedFromGlobalPrefix` calls
// `truncateVersionPrefixFromPath` BEFORE testing the exclusion patterns, so a
// versioned business route is offered to the list as `/probe`, not `/v1/probe`.
// Any pattern wide enough to match the terminal handler's `{*path}` matches
// `/probe` too.

import {
  All,
  Controller,
  Get,
  Module,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  API_GLOBAL_PREFIX,
  API_URI_VERSION_PREFIX,
  API_VERSION,
  API_VERSION_PREFIX,
  API_VERSION_SEGMENT_PREFIX,
  applyApiSurface,
} from "./api-surface.js";

@Controller({ path: "probe", version: API_VERSION })
class ProbeController {
  @Get()
  ping(): { readonly probe: true } {
    return { probe: true };
  }
}

@Controller({ version: VERSION_NEUTRAL })
class TerminalProbeController {
  @All("{*path}")
  any(): { readonly terminal: true } {
    return { terminal: true };
  }
}

@Module({ controllers: [ProbeController, TerminalProbeController] })
class ProbeSurfaceModule {}

type Running = { readonly base: string; close(): Promise<void> };

let running: Running | null = null;

async function start(configure: (app: Awaited<ReturnType<typeof NestFactory.create>>) => void): Promise<Running> {
  const app = await NestFactory.create(ProbeSurfaceModule, { logger: false });
  configure(app);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await app.close();
    },
  };
}

afterEach(async () => {
  await running?.close();
  running = null;
});

async function body(base: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`);
  return (await response.json()) as Record<string, unknown>;
}

describe("WIN-267 R1 — where `/api/v1` comes from in this deployable", () => {
  it("spells the version exactly once, and composes the prefix from its parts", () => {
    // The three constants and the two strings built out of them. Written as an
    // identity rather than as literals so that changing `API_VERSION` moves every
    // derived value and nothing else has to be remembered.
    expect(API_URI_VERSION_PREFIX).toBe(`${API_GLOBAL_PREFIX}/${API_VERSION_SEGMENT_PREFIX}`);
    expect(API_VERSION_PREFIX).toBe(`/${API_URI_VERSION_PREFIX}${API_VERSION}`);
  });

  it("mounts a versioned route under the canonical prefix and leaves the edge at the root", async () => {
    running = await start((app) => {
      applyApiSurface(app);
    });
    expect(await body(running.base, `${API_VERSION_PREFIX}/probe`)).toEqual({ probe: true });
    // A version-neutral controller keeps the application root, which is what
    // `/livez` and the terminal 404 depend on.
    expect(await body(running.base, "/anything-else")).toEqual({ terminal: true });
  });

  it("MEASURES the alternative failing: a catch-all exclusion strips the prefix off business routes", async () => {
    running = await start((app) => {
      // The spelling `apps/agent/src/http/api-surface.ts` uses, with the ONLY
      // exclusion wide enough to keep a `{*path}` terminal handler at the root.
      app.setGlobalPrefix(API_GLOBAL_PREFIX, { exclude: ["/{*path}"] });
      app.enableVersioning({
        type: VersioningType.URI,
        prefix: API_VERSION_SEGMENT_PREFIX,
        defaultVersion: API_VERSION,
      });
    });
    // THE FINDING. The business route did NOT land under `/api`; it landed at
    // `/v1/probe`, so `/api/v1/probe` is answered by the terminal handler. This
    // is the whole reason `applyApiSurface` folds the API root into the version
    // prefix instead.
    expect(
      await body(running.base, `/${API_VERSION_SEGMENT_PREFIX}${API_VERSION}/probe`),
      "the exclusion stripped the global prefix off the versioned route",
    ).toEqual({ probe: true });
    expect(
      await body(running.base, `${API_VERSION_PREFIX}/probe`),
      "so the canonical URL reaches the terminal handler instead of the route",
    ).toEqual({ terminal: true });
  });
});
