/**
 * Theme K.17 — MCP macros (record / replay / parameterize).
 *
 * Zapier-lite for Platos. Operators record a sequence of MCP tool
 * calls against their token, save it as a `PlatosMacro`, then replay
 * it with `${var.path}` parameter substitution.
 *
 * Scope model
 * -----------
 *   - Every macro is pinned to `(organizationId, projectId, environmentId)`
 *     at record-stop time from the token's scope; never rewritten on share.
 *   - `macros.list` returns the caller's own macros + every org-shared
 *     macro in the same scope.
 *   - Mutation gates (`update` / `delete` / `share`) enforce owner OR
 *     (scope-match + sharedWithOrg). `delete` is additionally guarded at
 *     tier-1 by the permission gateway.
 *
 * Recording state
 * ---------------
 *   In-memory `Map<tokenId, InProgressRecording>` kept on the
 *   `MacroRecordingState` singleton. If the agent restarts mid-recording
 *   the recording is lost.
 *
 *   TODO(K.17.2) — promote `InProgressRecording` to a Redis-backed store
 *   so restarts don't drop in-flight recordings.
 *
 * Permission gate
 * ---------------
 *   - `macros.record_start` / `macros.record_stop` → auto_allow (tier-4).
 *   - `macros.list` / `macros.get`                 → auto_allow.
 *   - `macros.update` / `macros.delete` / `macros.share`
 *                                                 → tier-1 require_approval
 *     (operator-level; wired in `permission-gateway.service.ts` minimums).
 *   - `macros.replay`                             → auto_allow.
 *     TODO(K.17.1) — require first-run approval after create, then
 *     auto_allow subsequent replays.
 */

import * as crypto from "node:crypto";
import type { McpRouter, McpToolHandler, JsonRpcRequest } from "../mcp-router";
import type { VerifiedToken } from "../token.service";
import type { RequestScope } from "../../auth/scope.guard";
import { resolvePath } from "../../agent-runtime/context-resolver";
import type { ControlDatabaseClient } from "../../shared/database.provider";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function macroScopeWhere(scope: ScopeTuple) {
  return {
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
  } as const;
}

function publicMacro<T extends { sharedWithOrganization: boolean }>(row: T) {
  const { sharedWithOrganization, ...rest } = row;
  return { ...rest, sharedWithOrg: sharedWithOrganization };
}

export interface MacroStep {
  tool: string;
  params: Record<string, unknown>;
}

export interface InProgressRecording {
  recordingId: string;
  tokenId: string;
  scope: ScopeTuple;
  createdBy: string;
  steps: MacroStep[];
  startedAt: Date;
}

/**
 * K.17 — in-memory recording state. Instantiated once on the controller
 * and shared with (a) the `McpRouter` recorder hook and (b) the
 * `macros.record_start` / `macros.record_stop` tool handlers.
 *
 * TODO(K.17.2) — Redis-backed persistence so agent restarts don't drop
 * in-flight recordings.
 */
export class MacroRecordingState {
  private readonly byToken = new Map<string, InProgressRecording>();

  /** Router-side hook: append one step. No-op when no active recording. */
  record(token: VerifiedToken, tool: string, params: Record<string, unknown>): void {
    const active = this.byToken.get(token.id);
    if (!active) return;
    active.steps.push({ tool, params });
  }

  start(token: VerifiedToken): InProgressRecording {
    const existing = this.byToken.get(token.id);
    if (existing) return existing; // re-start is idempotent, returns the live recording
    const recording: InProgressRecording = {
      recordingId: `rec_${crypto.randomBytes(12).toString("base64url")}`,
      tokenId: token.id,
      scope: {
        organizationId: token.scope.organizationId,
        projectId: token.scope.projectId,
        environmentId: token.scope.environmentId,
      },
      createdBy: token.mintedByUserId,
      steps: [],
      startedAt: new Date(),
    };
    this.byToken.set(token.id, recording);
    return recording;
  }

  stop(token: VerifiedToken, recordingId: string): InProgressRecording | null {
    const active = this.byToken.get(token.id);
    if (!active) return null;
    if (active.recordingId !== recordingId) return null;
    this.byToken.delete(token.id);
    return active;
  }

  get(token: VerifiedToken): InProgressRecording | null {
    return this.byToken.get(token.id) ?? null;
  }
}

/**
 * Substitute `${var.path}` occurrences anywhere in a step params object.
 * Walks nested objects + arrays; non-string leaves are returned as-is.
 * Missing variable keys leave the placeholder untouched (fail-open,
 * matches CTX.2 `substitutePromptVars` semantics).
 */
function substitutePlaceholders(value: unknown, params: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}/g, (match, key: string) => {
      const resolved = resolvePath(params, key);
      if (resolved === undefined) return match;
      return typeof resolved === "string" ? resolved : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholders(v, params));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePlaceholders(v, params);
    }
    return out;
  }
  return value;
}

function isOwnerOrSharedInScope(
  row: {
    environmentId: string;
    createdBy: string;
    sharedWithOrganization: boolean;
  },
  scope: ScopeTuple,
  userId: string | null,
): "owner" | "shared" | null {
  if (
    row.environmentId !== scope.environmentId
  ) {
    return null;
  }
  if (userId && row.createdBy === userId) return "owner";
  if (row.sharedWithOrganization) return "shared";
  return null;
}

export function buildMacroToolHandlers(deps: {
  state: MacroRecordingState;
  prisma: ControlDatabaseClient;
  /**
   * Back-reference so `macros.replay` can re-dispatch each step through
   * the same JSON-RPC router (same permission gate + audit + scope
   * enforcement as a direct `tools/call`).
   */
  getRouter: () => McpRouter;
}): McpToolHandler[] {
  const { state, prisma, getRouter } = deps;

  return [
    {
      name: "macros.record_start",
      description:
        "Begin capturing subsequent tool calls on this token into an in-progress recording. Returns { recordingId }. Call macros.record_stop to finalize + persist.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
        additionalProperties: true,
      },
      async execute(_params, _scope, token) {
        const rec = state.start(token);
        return {
          recordingId: rec.recordingId,
          stepCount: rec.steps.length,
          startedAt: rec.startedAt.toISOString(),
        };
      },
    },
    {
      name: "macros.record_stop",
      description:
        "Finalize an in-progress recording, persist to PlatosMacro, and return it. Requires a prior macros.record_start.",
      inputSchema: {
        type: "object",
        required: ["recordingId", "name"],
        properties: {
          recordingId: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string" },
          paramSchema: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const recordingId = String(params["recordingId"] ?? "");
        const name = String(params["name"] ?? "").trim();
        if (!name) throw new Error("`name` is required");
        const description = (params["description"] as string | undefined) ?? null;
        const paramSchema = (params["paramSchema"] as Record<string, unknown> | undefined) ?? null;

        const finalized = state.stop(token, recordingId);
        if (!finalized) {
          throw new Error(`no active recording with id '${recordingId}' for this token`);
        }
        const macro = await prisma.macro.create({
          data: {
            environmentId: scope.environmentId,
            name,
            description,
            steps: finalized.steps as any,
            paramSchema: paramSchema as any,
            createdBy: finalized.createdBy,
          },
        });
        return { macro: publicMacro(macro) };
      },
    },
    {
      name: "macros.list",
      description:
        "List macros visible to the caller in the current scope (own macros + org-shared).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const limit = (params["limit"] as number) ?? 100;
        const userId = token.mintedByUserId;
        const macros = await prisma.macro.findMany({
          where: {
            ...macroScopeWhere(tuple(scope)),
            OR: [{ createdBy: userId }, { sharedWithOrganization: true }],
          },
          orderBy: [{ updatedAt: "desc" }],
          take: limit,
        });
        return { macros: macros.map(publicMacro) };
      },
    },
    {
      name: "macros.get",
      description: "Fetch a single macro by id including its recorded steps.",
      inputSchema: {
        type: "object",
        required: ["macroId"],
        properties: { macroId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const macroId = String(params["macroId"]);
        const row = await prisma.macro.findFirst({
          where: { id: macroId, ...macroScopeWhere(tuple(scope)) },
        });
        if (!row) throw new Error(`macro ${macroId} not found`);
        if (!isOwnerOrSharedInScope(row, tuple(scope), token.mintedByUserId)) {
          throw new Error(`macro ${macroId} not found in scope`);
        }
        return { macro: publicMacro(row) };
      },
    },
    {
      name: "macros.update",
      description:
        "Rename / re-describe / toggle shared / replace paramSchema on a macro. Owner-only. Tier-1 require_approval.",
      inputSchema: {
        type: "object",
        required: ["macroId"],
        properties: {
          macroId: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"] },
          sharedWithOrg: { type: "boolean" },
          paramSchema: { type: ["object", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const macroId = String(params["macroId"]);
        const row = await prisma.macro.findFirst({
          where: { id: macroId, ...macroScopeWhere(tuple(scope)) },
        });
        if (!row) throw new Error(`macro ${macroId} not found`);
        // Scope-match + owner gate (shared readers cannot mutate).
        if (
          row.createdBy !== token.mintedByUserId
        ) {
          throw new Error(`macro ${macroId} not editable by this token`);
        }
        const data: Record<string, unknown> = {};
        if (typeof params["name"] === "string") data["name"] = params["name"];
        if ("description" in params) data["description"] = params["description"] ?? null;
        if (typeof params["sharedWithOrg"] === "boolean") {
          data["sharedWithOrganization"] = params["sharedWithOrg"];
        }
        if ("paramSchema" in params) data["paramSchema"] = params["paramSchema"] ?? null;
        const updated = await prisma.macro.update({ where: { id: macroId }, data });
        return { macro: publicMacro(updated) };
      },
    },
    {
      name: "macros.delete",
      description:
        "Delete a macro. Scope + owner double-gated. Tier-1 require_approval.",
      inputSchema: {
        type: "object",
        required: ["macroId"],
        properties: { macroId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const macroId = String(params["macroId"]);
        const row = await prisma.macro.findFirst({
          where: { id: macroId, ...macroScopeWhere(tuple(scope)) },
        });
        if (!row) return { ok: false, macroId };
        if (
          row.createdBy !== token.mintedByUserId
        ) {
          throw new Error(`macro ${macroId} not deletable by this token`);
        }
        await prisma.macro.delete({ where: { id: macroId } });
        return { ok: true, macroId };
      },
    },
    {
      name: "macros.share",
      description:
        "Publish or un-publish a macro to every operator in the same scope. Owner-only. Tier-1 require_approval.",
      inputSchema: {
        type: "object",
        required: ["macroId", "sharedWithOrg"],
        properties: {
          macroId: { type: "string" },
          sharedWithOrg: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const macroId = String(params["macroId"]);
        const sharedWithOrg = Boolean(params["sharedWithOrg"]);
        const row = await prisma.macro.findFirst({
          where: { id: macroId, ...macroScopeWhere(tuple(scope)) },
        });
        if (!row) throw new Error(`macro ${macroId} not found`);
        if (
          row.createdBy !== token.mintedByUserId
        ) {
          throw new Error(`macro ${macroId} not editable by this token`);
        }
        const updated = await prisma.macro.update({
          where: { id: macroId },
          data: { sharedWithOrganization: sharedWithOrg },
        });
        return { macro: publicMacro(updated) };
      },
    },
    {
      name: "macros.replay",
      description:
        "Replay a macro. Each recorded step re-runs through the MCP router as if individually invoked (same permission gate + audit + scope). `${var.path}` placeholders in step params are substituted from `params`.",
      inputSchema: {
        type: "object",
        required: ["macroId"],
        properties: {
          macroId: { type: "string" },
          params: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope, token) {
        const macroId = String(params["macroId"]);
        const replayParams = (params["params"] as Record<string, unknown> | undefined) ?? {};
        const row = await prisma.macro.findFirst({
          where: { id: macroId, ...macroScopeWhere(tuple(scope)) },
        });
        if (!row) throw new Error(`macro ${macroId} not found`);
        if (!isOwnerOrSharedInScope(row, tuple(scope), token.mintedByUserId)) {
          throw new Error(`macro ${macroId} not found in scope`);
        }
        const steps = Array.isArray(row.steps) ? (row.steps as unknown as MacroStep[]) : [];
        const router = getRouter();

        const results: Array<{
          stepIndex: number;
          tool: string;
          ok: boolean;
          result?: unknown;
          error?: { code: number; message: string; data?: unknown };
        }> = [];

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (!step || typeof step.tool !== "string") continue;
          const resolvedParams = (substitutePlaceholders(step.params ?? {}, replayParams) ??
            {}) as Record<string, unknown>;
          const rpc: JsonRpcRequest = {
            jsonrpc: "2.0",
            id: `replay_${macroId}_${i}`,
            method: "tools/call",
            params: { name: step.tool, arguments: resolvedParams },
          };
          const response = await router.handle(rpc, token);
          if (response.error) {
            results.push({
              stepIndex: i,
              tool: step.tool,
              ok: false,
              error: response.error,
            });
          } else {
            results.push({
              stepIndex: i,
              tool: step.tool,
              ok: true,
              result: response.result,
            });
          }
        }
        return { macroId, stepCount: steps.length, results };
      },
    },
  ];
}
