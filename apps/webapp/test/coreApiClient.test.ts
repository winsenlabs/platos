// WIN-257 T8 — THE JOINS THE CORE CLIENT MAKES TO THINGS IT DOES NOT CONTROL.
//
// `app/services/coreApi.server.ts` and `app/utils/coreVocabulary.ts` both RESTATE
// something another package owns: the V1 URL prefix, and four closed
// vocabularies. Restating is the right call in both cases — the webapp may not
// depend on another deployable, and it may no longer depend on the generated
// Prisma client at all — but a copy nobody checks is worse than either option it
// replaced.
//
// So every copy is joined here by READING THE AUTHORITY OFF DISK. Not importing
// it: an import would be the dependency edge the restatement exists to avoid, and
// for `api-surface.ts` it would pull a Nest deployable into the dashboard's test
// run. A file read is a join that costs nothing and still goes red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The client reads its base URL at module load, and `env.server.ts` refuses a
// process with no `PLATOS_INTERNAL_AUTH_TOKEN`. This suite is about the paths,
// not the transport, so the environment is stubbed rather than supplied.
vi.mock("~/env.server", () => ({
  env: { NODE_ENV: "test", PLATOS_CORE_API_URL: "http://core.invalid", PLATOS_AGENT_API_URL: "http://agent.invalid", PLATOS_INTERNAL_AUTH_TOKEN: "x".repeat(32) },
}));

import { CORE_MCP_ROOT, CORE_OPERATIONS, CORE_VERSION_PREFIX } from "../app/services/coreApi.server";
import { MEMORY_ARCHIVE_STATES, MEMORY_KINDS, MEMORY_SOURCES, MEMORY_VISIBILITIES, ORGANIZATION_ROLES } from "../app/utils/coreVocabulary";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function source(path: string): string {
  return readFileSync(`${repositoryRoot}${path}`, "utf8");
}

/** Every `export const NAME = [...] as const;` list in a source file. */
function constLists(text: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  for (const match of text.matchAll(/export const ([A-Z_]+) = \[([^\]]*)\] as const;/gu)) {
    const values = [...(match[2] ?? "").matchAll(/"([^"]+)"/gu)].map((entry) => entry[1] ?? "");
    lists.set(match[1] ?? "", values);
  }
  return lists;
}

describe("the core-api client's restated constants", () => {
  it("composes the SAME version prefix apps/core-api mounts its surface at", () => {
    // `applyApiSurface` sets `{ prefix: API_URI_VERSION_PREFIX, defaultVersion:
    // API_VERSION }`, so `API_VERSION_PREFIX` is the literal path every versioned
    // controller answers under. If either half moves — a v2, or a different
    // global prefix — every operation in the table below starts 404ing, and this
    // case is what says so before a deployment does.
    const text = source("apps/core-api/src/http/api-surface.ts");
    const globalPrefix = /export const API_GLOBAL_PREFIX = "([^"]+)"/u.exec(text)?.[1];
    const segment = /export const API_VERSION_SEGMENT_PREFIX = "([^"]+)"/u.exec(text)?.[1];
    const major = /export const API_VERSION = "([^"]+)"/u.exec(text)?.[1];
    expect([globalPrefix, segment, major].every((value) => typeof value === "string")).toBe(true);
    expect(CORE_VERSION_PREFIX).toBe(`/${globalPrefix}/${segment}${major}`);
  });

  it("uses the SAME version-neutral MCP root apps/core-api mounts the MCP surface at", () => {
    const text = source("apps/core-api/src/transports/mcp/mcp-surface.ts");
    const root = /export const MCP_ROOT_SEGMENT = "([^"]+)"/u.exec(text)?.[1];
    expect(CORE_MCP_ROOT).toBe(`/${root}`);
    // AND IT CARRIES NO VERSION. `mcp-surface.ts` mounts every MCP controller
    // `VERSION_NEUTRAL` and states that the API version must not appear on the
    // protocol axis; a client that prefixed these paths would 404 on both
    // deployables.
    expect(CORE_MCP_ROOT.includes(CORE_VERSION_PREFIX)).toBe(false);
  });

  it("every operation's path starts at one of those two roots and nowhere else", () => {
    for (const [name, operation] of Object.entries(CORE_OPERATIONS)) {
      const path = operation.path({
        organizationId: "o",
        membershipId: "m",
        environmentId: "e",
        entityId: "x",
        key: "K",
      });
      expect(
        path.startsWith(`${CORE_VERSION_PREFIX}/`) || path.startsWith(`${CORE_MCP_ROOT}/`),
        `${name} dispatches to ${path}, which is under neither V1 root`,
      ).toBe(true);
    }
  });

  it("the two mints that return a one-time secret require an Idempotency-Key", () => {
    // JOINED TO THE POLICY THAT ENFORCES IT. `http/idempotency-policy.ts` lists
    // the operations core-api refuses outright without the header; a client that
    // dispatched one of them without a key would get a 400 an operator would read
    // as "the token screen is broken".
    const policy = source("apps/core-api/src/http/idempotency-policy.ts");
    const required = new Set(
      [...policy.matchAll(/template:\s*"([^"]+)",\s*\n\s*class:\s*"required"/gu)].map((match) => match[1] ?? ""),
    );
    expect(required.size).toBeGreaterThan(0);
    const dispatched = Object.entries(CORE_OPERATIONS).filter(([, operation]) => operation.idempotency === "required");
    expect(dispatched.map(([name]) => name).sort()).toEqual(["mcp.entityTokens.mint", "mcp.platformTokens.mint"]);
    expect(required.has("/mcp/platform/tokens")).toBe(true);
    expect(required.has("/mcp/entity/:entityId/tokens")).toBe(true);
  });

  it("a path parameter is required rather than silently interpolated as undefined", () => {
    expect(() => CORE_OPERATIONS["organizations.members.list"].path({})).toThrow(/organizationId/u);
    expect(() => CORE_OPERATIONS["environments.variables.set"].path({ environmentId: "e" })).toThrow(/key/u);
  });

  it("path parameters are percent-encoded, so a slug cannot open a new path segment", () => {
    const path = CORE_OPERATIONS["environments.variables.set"].path({ environmentId: "e", key: "A/../B" });
    expect(path.endsWith("/A%2F..%2FB")).toBe(true);
  });
});

describe("the restated vocabularies", () => {
  it("ORGANIZATION_ROLES is exactly the tenancy domain's list", () => {
    const text = source("packages/contexts/tenancy/domain/roles.ts");
    const roles = [...(/export const ORGANIZATION_ROLES[^=]*=[^[]*\[([^\]]*)\]/u.exec(text)?.[1] ?? "").matchAll(
      /OrganizationRole\.([A-Z_]+)/gu,
    )].map((match) => match[1] ?? "");
    expect(roles.length).toBeGreaterThan(0);
    expect([...ORGANIZATION_ROLES]).toEqual(roles);
  });

  it("the four memory lists are exactly the memory contract's", () => {
    const lists = constLists(source("internal-packages/tenancy-database/src/memory-contract.ts"));
    expect([...MEMORY_KINDS]).toEqual(lists.get("MEMORY_KINDS"));
    expect([...MEMORY_VISIBILITIES]).toEqual(lists.get("MEMORY_VISIBILITIES"));
    expect([...MEMORY_SOURCES]).toEqual(lists.get("MEMORY_SOURCES"));
    expect([...MEMORY_ARCHIVE_STATES]).toEqual(lists.get("MEMORY_ARCHIVE_STATES"));
  });

  it("MUTATION: the join really compares — a changed list would not match", () => {
    // Without this the two cases above could be reading an empty capture on both
    // sides and comparing nothing.
    const lists = constLists(source("internal-packages/tenancy-database/src/memory-contract.ts"));
    expect(lists.get("MEMORY_KINDS")?.length ?? 0).toBeGreaterThan(1);
    expect([...MEMORY_KINDS, "invented"]).not.toEqual(lists.get("MEMORY_KINDS"));
  });
});
