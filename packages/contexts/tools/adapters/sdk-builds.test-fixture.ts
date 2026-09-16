/**
 * WIN-268 (M4.2) — THE TWO MCP SDK SERVER BUILDS THIS PACKAGE'S DISPATCH SUITE
 * RUNS AGAINST, AND THE JOINS THAT KEEP THEM TWO.
 *
 * The adopted client in `mcp-dispatch.ts` is put against the server of the
 * ADOPTED SDK and of the 1.30.x CANDIDATE, aliased as
 * `@modelcontextprotocol/sdk-candidate`, before any version bump. Every case in
 * `dispatch.integration.test.ts` that has an SDK server on the far side runs
 * once per build through `it.each` over an ARRAY LITERAL of the two constants
 * below, which is the one table shape `scripts/arch/test-case-census.mjs` can
 * count statically.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT PART OF THE SUITE. Both live under
 * `packages/contexts/**`, which `scripts/arch/max-file-lines.mjs` budgets at 500
 * effective lines; the suite stood at 487 before the module-identity joins below
 * and went over at 535. The alternative was to shrink the joins, which is the
 * one thing that must not happen to them — they are the answer to a verifier
 * finding that the two-build table could collapse into one build asked twice.
 * Nothing here declares a case, so the test-case census's FILE count for this
 * package does not move: it reads `*.test.ts`, and this is not one.
 *
 * WHAT THE JOINS ARE FOR. `installedSdk` reads the tree — two `node_modules`
 * manifests the suite matches against `pnpm-lock.yaml`. That is worth having and
 * it is NOT enough: repointing the three `sdk-candidate` imports below at
 * `@modelcontextprotocol/sdk` leaves both manifests and the lockfile untouched,
 * and every version assertion stays green while the table quietly asks one build
 * twice. So the suite also requires the three LOADED classes to be different
 * objects, each to be the export a dynamic import of its own specifier yields,
 * and each specifier to resolve inside the pnpm store directory of its own
 * version — which is what `resolvedStoreVersion` and `SERVER_ENTRY_POINTS` are.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer as CandidateMcpServer } from "@modelcontextprotocol/sdk-candidate/server/mcp.js";
import { SSEServerTransport as CandidateSSEServerTransport } from "@modelcontextprotocol/sdk-candidate/server/sse.js";
import { StreamableHTTPServerTransport as CandidateStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk-candidate/server/streamableHttp.js";

export { SSEServerTransport };

export interface SdkServerBuild {
  readonly label: "adopted" | "candidate";
  readonly directory: string;
  readonly McpServer: typeof McpServer;
  readonly StreamableHTTPServerTransport: typeof StreamableHTTPServerTransport;
  readonly SSEServerTransport: typeof SSEServerTransport;
}

/** The three entry points the imports above take from each build. */
export const SERVER_ENTRY_POINTS = ["server/mcp.js", "server/sse.js", "server/streamableHttp.js"] as const;

export const ADOPTED: SdkServerBuild = {
  label: "adopted",
  directory: "@modelcontextprotocol/sdk",
  McpServer,
  StreamableHTTPServerTransport,
  SSEServerTransport,
};

export const CANDIDATE: SdkServerBuild = {
  label: "candidate",
  directory: "@modelcontextprotocol/sdk-candidate",
  McpServer: CandidateMcpServer as unknown as typeof McpServer,
  StreamableHTTPServerTransport: CandidateStreamableHTTPServerTransport as unknown as typeof StreamableHTTPServerTransport,
  SSEServerTransport: CandidateSSEServerTransport as unknown as typeof SSEServerTransport,
};

const requireFromHere = createRequire(import.meta.url);

/**
 * The version whose pnpm store directory a specifier actually resolves into.
 * The alias and the adopted name are two `node_modules` entries, but both are
 * links into `.pnpm/@modelcontextprotocol+sdk@<version>_…`, so the store path is
 * the resolver's own answer to "which build is this specifier".
 */
export function resolvedStoreVersion(specifier: string): string {
  const resolved = requireFromHere.resolve(specifier);
  const match = /@modelcontextprotocol\+sdk@(\d+\.\d+\.\d+)/u.exec(resolved);
  if (!match) {
    throw new Error(`${specifier} did not resolve inside an @modelcontextprotocol/sdk store directory: ${resolved}`);
  }
  return match[1]!;
}

/** `packages/contexts/tools/`, with a trailing separator. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function installedSdk(build: SdkServerBuild): { name: string; version: string } {
  return JSON.parse(readFileSync(`${PACKAGE_ROOT}node_modules/${build.directory}/package.json`, "utf8")) as { name: string; version: string };
}
