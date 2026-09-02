// The stdio process: configuration, lifecycle, drain, correlation.
//
// ---------------------------------------------------------------------------
// FINDING (WIN-297, reported not absorbed): this binary CANNOT compose itself.
//
// ADR M0.3 §5.1 rule (j) `adapters-only-from-core` names exactly one importer of
// `packages/adapters/*`: `apps/core-api`. `apps/mcp-stdio` is not it, and its
// generated project references name a single project — `packages/contexts/tools`
// — which publishes types only. So there is no construction this binary is
// permitted to perform: it can name a `ToolsContract` and it can never build one.
//
// Predicted at START rather than discovered here, and resolved WITHOUT widening
// rule (j), because the rule is right: an stdio binary that reached into the
// adapter tree would be a second composition root, and "the one place adapters
// are bound" would stop being true the moment it existed.
//
// The resolution is a HOST-SUPPLIED RUNTIME. `PLATOS_MCP_STDIO_RUNTIME_MODULE`
// names a module the host install provides; this process imports it and asks it
// for a `ToolsContract`. Unset, or unloadable, or not exporting the expected
// factory — the process refuses to start, non-zero, with a redacted diagnostic.
// It never degrades into a binary that answers requests with nothing behind it.
//
// The seam is honestly declared rather than smuggled: a specifier resolved at
// run time is invisible to every static boundary checker in this repository, so
// `composition-root.mjs` asserts that this file is the ONLY place in the V1
// layout performing a dynamic import, and that it is accompanied by this note.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

import type { ToolsContract } from "@platos/context-tools";

export const EXIT_OK = 0;
export const EXIT_FAULT = 1;
export const EXIT_CONFIGURATION = 78;

/** What a host runtime module must export. */
export type ToolsRuntimeFactory = () => Promise<ToolsContract> | ToolsContract;

export interface StdioConfiguration {
  readonly runtimeModule: string;
  readonly shutdownTimeoutMs: number;
}

export interface StdioDiagnostic {
  readonly field: string;
  readonly problem: string;
}

export type StdioConfigOutcome =
  | { readonly ok: true; readonly value: StdioConfiguration }
  | { readonly ok: false; readonly diagnostics: readonly StdioDiagnostic[] };

export function loadStdioConfiguration(env: Readonly<Record<string, string | undefined>>): StdioConfigOutcome {
  const diagnostics: StdioDiagnostic[] = [];
  const runtimeModule = env["PLATOS_MCP_STDIO_RUNTIME_MODULE"]?.trim() ?? "";
  if (runtimeModule === "") {
    diagnostics.push({
      field: "PLATOS_MCP_STDIO_RUNTIME_MODULE",
      problem:
        "is required — this binary holds no adapter (ADR M0.3 §5.1 rule (j)) and must be given a tools runtime by its host",
    });
  }

  const rawTimeout = env["PLATOS_MCP_STDIO_SHUTDOWN_TIMEOUT_MS"]?.trim() ?? "5000";
  let shutdownTimeoutMs = 5000;
  if (!/^\d+$/u.test(rawTimeout) || Number(rawTimeout) < 1 || Number(rawTimeout) > 600000) {
    diagnostics.push({
      field: "PLATOS_MCP_STDIO_SHUTDOWN_TIMEOUT_MS",
      problem: "must be a base-10 integer between 1 and 600000",
    });
  } else shutdownTimeoutMs = Number(rawTimeout);

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: Object.freeze({ runtimeModule, shutdownTimeoutMs }) };
}

export function renderStdioFailure(diagnostics: readonly StdioDiagnostic[]): string {
  return [
    "mcp-stdio refused to start: configuration is invalid.",
    "",
    // Values are never echoed here at all. A module specifier can carry a path,
    // and a path can carry a token; the field name and the problem are enough.
    ...diagnostics.map((entry) => `  ${entry.field} ${entry.problem}`),
    "",
    `${diagnostics.length} configuration problem(s). No runtime was loaded and no frame was read.`,
    "",
  ].join("\n");
}

/** One line in, one line out. The transport itself is M4's; this is the frame. */
export interface StdioFrame {
  readonly id: string;
  readonly method: string;
}

export interface StdioIo {
  readonly write: (line: string) => void;
  readonly writeError: (text: string) => void;
}

export interface StdioSession {
  /** Handle one inbound line. Returns the response line, or null to ignore it. */
  handle(line: string): string | null;
  readonly handled: number;
}

/**
 * The frame loop.
 *
 * It answers exactly two methods, both of which are PROCESS concerns and neither
 * of which is an MCP business call: `health` (is this binary alive and does it
 * hold a runtime) and `shutdown` (stop accepting). Tool invocation is M4's, and
 * shipping a half-implemented one here would be the surface WIN-297 is scoped
 * out of.
 *
 * Every response carries the inbound `id` so a host can correlate, and mints one
 * when the caller omits it — the stdio equivalent of the HTTP correlation edge.
 */
export function createStdioSession(tools: ToolsContract, onShutdown: () => void): StdioSession {
  let handled = 0;
  return {
    get handled() {
      return handled;
    },
    handle(line: string): string | null {
      const trimmed = line.trim();
      if (trimmed === "") return null;
      handled += 1;

      let frame: Partial<StdioFrame>;
      try {
        frame = JSON.parse(trimmed) as Partial<StdioFrame>;
      } catch {
        return JSON.stringify({ id: randomUUID(), ok: false, error: "MALFORMED_FRAME" });
      }

      const id = typeof frame.id === "string" && frame.id.length > 0 && frame.id.length <= 128
        ? frame.id
        : randomUUID();

      if (frame.method === "health") {
        return JSON.stringify({ id, ok: true, status: "alive", tools: tools.name });
      }
      if (frame.method === "shutdown") {
        onShutdown();
        return JSON.stringify({ id, ok: true, status: "draining" });
      }
      return JSON.stringify({ id, ok: false, error: "UNKNOWN_METHOD" });
    },
  };
}

/**
 * Load the host-supplied runtime.
 *
 * Every failure mode is the same outcome — refuse to start — because a stdio
 * binary that accepted frames with no runtime behind it would answer every one
 * of them with an error while looking healthy to its supervisor.
 */
export async function loadToolsRuntime(specifier: string): Promise<ToolsContract> {
  const loaded: unknown = await import(specifier);
  const factory = (loaded as { readonly createToolsRuntime?: unknown }).createToolsRuntime;
  if (typeof factory !== "function") {
    throw new Error("runtime module does not export a createToolsRuntime() function");
  }
  const tools = await (factory as ToolsRuntimeFactory)();
  if (typeof tools !== "object" || tools === null || (tools as ToolsContract).name !== "tools") {
    throw new Error("runtime module's createToolsRuntime() did not return a tools contract");
  }
  return tools;
}
