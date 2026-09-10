import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { All, Controller, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";

import manifest from "../control-plane/operation-manifest.generated.json";
import { API_VERSION, applyApiSurface } from "./api-surface";
import {
  DEPRECATED_ROUTE_PREFIXES,
  DEPRECATION_MINIMUM_WINDOW_DAYS,
  canonicalPathFor,
  deprecationHeadersFor,
  httpDate,
  isUnderPathPrefix,
  matchDeprecatedRoutePrefix,
} from "./deprecation-signal";

/**
 * WIN-267 (M4.1) — "aliases preserve old clients and emit deprecation metadata",
 * read back off a real socket.
 *
 * The clause has two halves and they are proved differently, because they are
 * different kinds of claim.
 *
 *   EMITS DEPRECATION METADATA is a behavioural claim, so it is observed over
 *   HTTP against a real Nest application that installed the surface through the
 *   same `applyApiSurface` `main.ts` calls. The paths requested are not written
 *   here — they are the fifteen `DEPRECATED` operations of the generated
 *   manifest, which `generate-control-plane.mjs` produced by AST-walking the
 *   controllers. So the test cannot pass by agreeing with itself about which
 *   paths are aliases.
 *
 *   PRESERVES OLD CLIENTS is a claim about what did NOT change, so it is
 *   observed as a difference: every alias response is compared to its canonical
 *   twin, and status, body and every header except the three this module is
 *   allowed to add must be identical. A middleware that rewrote a path, swallowed
 *   a body or moved a status fails here.
 *
 * THE FALSIFIABLE HALF, and it is the reason the canonical twin is requested at
 * all: a matcher written as a bare `startsWith` over the alias prefix, or one
 * accidentally anchored on `/api/v1`, would stamp a sunset date on the CANONICAL
 * surface. The canonical assertions are what separate a working matcher from a
 * matcher that says yes to everything, and the near-miss case
 * (`/api/v1/platos/memoryboard`) separates a path-prefix match from a string
 * one.
 */

const DEPRECATED_OPERATIONS = manifest.inventories.restOperations.filter(
  (operation) => operation.classification === "DEPRECATED",
);

/**
 * A probe that answers every versioned path so the middleware's decision — not
 * a controller's presence — is what the observations are about. It is mounted
 * under the real version segment by declaring the real `API_VERSION`, so the
 * paths below are the wire paths and not a private URL space.
 */
@Controller({ path: "", version: API_VERSION })
class VersionedProbeController {
  @All("{*rest}")
  answer(): { probe: string } {
    return { probe: "ok" };
  }
}

@Module({ controllers: [VersionedProbeController] })
class ProbeModule {}

type Observation = {
  status: number;
  body: string;
  headers: Map<string, string>;
};

let app: INestApplication;
let origin: string;

/** Substitute a stable value for every `:param` so the path is requestable. */
function concrete(path: string): string {
  return path.replaceAll(/:[A-Za-z0-9_]+/gu, "win267-probe");
}

async function observe(path: string, method: string): Promise<Observation> {
  const response = await fetch(new URL(path, origin), { method });
  const headers = new Map<string, string>();
  for (const [name, value] of response.headers.entries()) headers.set(name.toLowerCase(), value);
  return { status: response.status, body: await response.text(), headers };
}

beforeAll(async () => {
  app = await NestFactory.create(ProbeModule, { logger: false });
  applyApiSurface(app);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("the compatibility-alias table is the manifest's own alias set", () => {
  it("classifies exactly the operations the generator classified DEPRECATED", () => {
    expect(DEPRECATED_OPERATIONS.length).toBeGreaterThan(0);
    for (const operation of DEPRECATED_OPERATIONS) {
      const prefix = matchDeprecatedRoutePrefix(operation.path);
      expect(prefix, `${operation.id} is DEPRECATED but no alias row covers it`).not.toBeNull();
      expect(prefix?.id).toBe(operation.policyRule);
    }
  });

  it("has no row that covers nothing", () => {
    for (const prefix of DEPRECATED_ROUTE_PREFIXES) {
      const covered = DEPRECATED_OPERATIONS.filter((operation) =>
        isUnderPathPrefix(operation.path, prefix.aliasPrefix),
      );
      expect(covered.length, `${prefix.id} matches no DEPRECATED operation`).toBeGreaterThan(0);
    }
  });

  it("names a successor the manifest independently derived from the controllers", () => {
    for (const operation of DEPRECATED_OPERATIONS) {
      const prefix = matchDeprecatedRoutePrefix(operation.path);
      expect(prefix).not.toBeNull();
      const recomputed = `${operation.method} ${canonicalPathFor(prefix!, operation.path)}`;
      expect(operation.replacement, `${operation.id} successor disagrees`).toBe(recomputed);
    }
  });

  it("published the same window the wire serves", () => {
    for (const operation of DEPRECATED_OPERATIONS) {
      const prefix = matchDeprecatedRoutePrefix(operation.path)!;
      expect(operation.deprecation, `${operation.id} carries no deprecation block`).toBeDefined();
      expect(operation.deprecation!.announcedOn).toBe(prefix.announcedOn);
      expect(operation.deprecation!.sunsetOn).toBe(prefix.sunsetOn);
    }
    const policy = manifest.deprecationPolicy;
    expect(policy.minimumWindowDays).toBe(DEPRECATION_MINIMUM_WINDOW_DAYS);
    expect(policy.wireSignal).toEqual(["Deprecation", "Sunset", "Link"]);
    expect(policy.aliases.map((alias) => alias.id).sort()).toEqual(
      DEPRECATED_ROUTE_PREFIXES.map((prefix) => prefix.id).sort(),
    );
  });

  it("leaves no canonical operation inside an alias prefix", () => {
    for (const operation of manifest.inventories.restOperations) {
      if (operation.classification === "DEPRECATED") continue;
      expect(
        matchDeprecatedRoutePrefix(operation.path),
        `${operation.id} sits under an alias prefix but is not DEPRECATED`,
      ).toBeNull();
    }
  });

  it("keeps every sunset at least the ADR's ninety days from its announcement", () => {
    const day = 24 * 60 * 60 * 1000;
    for (const prefix of DEPRECATED_ROUTE_PREFIXES) {
      const announced = Date.parse(`${prefix.announcedOn}T00:00:00.000Z`);
      const sunset = Date.parse(`${prefix.sunsetOn}T00:00:00.000Z`);
      expect(Number.isNaN(announced)).toBe(false);
      expect(Number.isNaN(sunset)).toBe(false);
      expect(Math.round((sunset - announced) / day)).toBeGreaterThanOrEqual(
        DEPRECATION_MINIMUM_WINDOW_DAYS,
      );
    }
  });
});

describe("an alias response carries the deprecation signal", () => {
  it("stamps Deprecation, Sunset and a successor Link on every DEPRECATED operation", async () => {
    for (const operation of DEPRECATED_OPERATIONS) {
      const aliasPath = concrete(operation.path);
      const observed = await observe(aliasPath, operation.method);
      const prefix = matchDeprecatedRoutePrefix(aliasPath);
      expect(prefix).not.toBeNull();
      expect(observed.headers.get("deprecation"), `${operation.id} Deprecation`).toBe("true");
      expect(observed.headers.get("sunset"), `${operation.id} Sunset`).toBe(
        httpDate(prefix!.sunsetOn),
      );
      expect(observed.headers.get("link"), `${operation.id} Link`).toBe(
        `<${canonicalPathFor(prefix!, aliasPath)}>; rel="successor-version"`,
      );
    }
  });

  it("serves an RFC 8594 HTTP-date rather than the calendar date it is declared as", async () => {
    const observed = await observe(
      concrete(DEPRECATED_OPERATIONS[0]!.path),
      DEPRECATED_OPERATIONS[0]!.method,
    );
    const sunset = observed.headers.get("sunset") ?? "";
    expect(sunset).toMatch(
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u,
    );
    expect(sunset).not.toBe(DEPRECATED_ROUTE_PREFIXES[0]!.sunsetOn);
    expect(Date.parse(sunset)).toBe(
      Date.parse(`${DEPRECATED_ROUTE_PREFIXES[0]!.sunsetOn}T00:00:00.000Z`),
    );
  });

  it("points the Link at the deep path and not merely at the canonical prefix", async () => {
    const deep = DEPRECATED_OPERATIONS.find((operation) =>
      operation.path.includes("/graph/entities/"),
    );
    expect(deep, "the manifest no longer carries a deep alias operation").toBeDefined();
    const aliasPath = concrete(deep!.path);
    const observed = await observe(aliasPath, deep!.method);
    const link = observed.headers.get("link") ?? "";
    expect(link).toContain("/api/v1/memory/graph/entities/");
    expect(link).not.toBe('</api/v1/memory>; rel="successor-version"');
  });
});

describe("a canonical response carries none of it", () => {
  it("leaves every canonical twin of a DEPRECATED operation unstamped", async () => {
    for (const operation of DEPRECATED_OPERATIONS) {
      const prefix = matchDeprecatedRoutePrefix(operation.path)!;
      const canonicalPath = concrete(canonicalPathFor(prefix, operation.path));
      const observed = await observe(canonicalPath, operation.method);
      for (const header of ["deprecation", "sunset", "link"]) {
        expect(
          observed.headers.has(header),
          `${operation.method} ${canonicalPath} carries ${header}`,
        ).toBe(false);
      }
    }
  });

  it("treats the alias prefix as a path and not as a string", async () => {
    const prefix = DEPRECATED_ROUTE_PREFIXES[0]!;
    const nearMiss = `${prefix.aliasPrefix}board`;
    expect(matchDeprecatedRoutePrefix(nearMiss)).toBeNull();
    const observed = await observe(nearMiss, "GET");
    expect(observed.status).toBe(200);
    expect(observed.headers.has("deprecation")).toBe(false);
  });

  it("does not read a query string as part of the path", () => {
    expect(deprecationHeadersFor("/api/v1/memory?after=/api/v1/platos/memory")).toBeNull();
  });
});

describe("an alias preserves the old client", () => {
  it("differs from its canonical twin in exactly the three added headers", async () => {
    const volatile = new Set(["date", "etag", "content-length", "link", "deprecation", "sunset"]);
    for (const operation of DEPRECATED_OPERATIONS) {
      const prefix = matchDeprecatedRoutePrefix(operation.path)!;
      const aliasPath = concrete(operation.path);
      const canonicalPath = concrete(canonicalPathFor(prefix, operation.path));
      const alias = await observe(aliasPath, operation.method);
      const canonical = await observe(canonicalPath, operation.method);

      expect(alias.status, `${operation.id} status moved`).toBe(canonical.status);
      expect(alias.body, `${operation.id} body moved`).toBe(canonical.body);

      const aliasRest = [...alias.headers].filter(([name]) => !volatile.has(name)).sort();
      const canonicalRest = [...canonical.headers].filter(([name]) => !volatile.has(name)).sort();
      expect(aliasRest, `${operation.id} headers moved`).toEqual(canonicalRest);

      const added = [...alias.headers.keys()].filter((name) => !canonical.headers.has(name)).sort();
      expect(added).toEqual(["deprecation", "link", "sunset"]);
    }
  });
});
