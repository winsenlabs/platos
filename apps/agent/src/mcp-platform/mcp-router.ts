/**
 * Theme K.4 — MCP JSON-RPC router.
 *
 * Handles the small subset of the MCP spec we need for Platform MCP:
 *   - initialize         → handshake
 *   - notifications/ping → keepalive ack
 *   - tools/list         → tool inventory (permission-gated by token)
 *   - tools/call         → invoke a tool (permission-gated by token + gateway)
 *
 * Each handler returns a JSON-RPC response body; the SSE transport
 * wraps it in a `data: <json>\n\n` frame.
 */

import { Logger } from "@nestjs/common";
import type { RequestScope } from "../auth/scope.guard";
import type { VerifiedToken } from "./token.service";
import { PlatosMCPTokenService } from "./token.service";
import type { MCPPermissionGatewayService } from "./permission-gateway.service";
import type {
  ApprovalRecord,
  MonitoringApprovalsService,
} from "../monitoring/approvals.service";
import { compileSchema, type CompiledValidator } from "./schema-validator";

export interface McpToolHandler {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCPF-followup — pre-compiled JSON Schema validator. Populated lazily
   * by `McpRouter.register` so individual tool builders don't have to
   * repeat the boilerplate; calling `register` twice on the same handler
   * recompiles. The router uses this on every `tools/call` to reject
   * malformed args with -32602 INVALID_PARAMS instead of letting them
   * silently coerce inside the handler (e.g. `String(undefined)` →
   * `"undefined"` cascading into a 404).
   */
  validateInput?: CompiledValidator;
  /**
   * K.18 — when true the tool is only visible + callable from an
   * admin-tier MCP token. Scope-tier tokens see 403 on `tools/call` and
   * the tool is hidden from their `tools/list` inventory.
   */
  requiresAdminTier?: boolean;
  /**
   * TL.1 — display category for the Tools tab + TL.2 display modes.
   * Optional on the handler definition: `buildPlatformToolHandlers` stamps
   * every platform handler with `"platos.platform"` post-assembly, so
   * individual builders (entities/trigger/skills/…) don't need to repeat
   * the field. Null/undefined falls back to `"uncategorized"` downstream.
   */
  category?: string;
  /**
   * Secret-bearing mutations must opt out of macro capture. Their arguments
   * cannot be replayed safely without persisting plaintext in Macro.steps.
   */
  macroRecordable?: boolean;
  execute(
    params: Record<string, unknown>,
    scope: RequestScope,
    token: VerifiedToken,
  ): Promise<unknown>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal subset of JSON-RPC error codes from the MCP spec. */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TOOL_BLOCKED: -32000,
  PERMISSION_DENIED: -32001,
  AWAITING_APPROVAL: -32002,
  /**
   * Reserved server-error band code for downstream rate-limit responses.
   * Carries `data.retryAfterSeconds` and `data.scope`. The HTTP transport
   * additionally sets the `Retry-After` response header.
   */
  RATE_LIMITED: -32099,
} as const;

export interface McpRouterContext {
  /** Token-pinned scope for every call. */
  buildScope(token: VerifiedToken, userId?: string): RequestScope;
}

/**
 * Theme K.17 — recording-side hook. When present, the router calls
 * `record(token, tool, params)` after a successful `tools/call` so an
 * in-progress macro recording can capture the step. `macros.*` tools
 * are skipped upstream to avoid self-recursion.
 */
export interface McpMacroRecorder {
  record(token: VerifiedToken, tool: string, params: Record<string, unknown>): void;
}

/**
 * Per-request transport-level metadata threaded through the router so
 * downstream branches (the approval gate in particular) can read
 * extension headers like `X-Platos-Approval-Id`. Optional — the
 * router falls back to no-header behaviour.
 */
export interface McpRequestContext {
  approvalId?: string | null;
  /**
   * Public dashboard origin used when minting the dashboard URL on a
   * pending-approval response. When absent the router falls back to a
   * relative path.
   */
  dashboardOrigin?: string | null;
}

/**
 * Optional approvals controller wired by the Platform MCP controller
 * when `MCP_INTERACTIVE_APPROVALS=true`. The router treats it as
 * present-or-absent — when null the legacy auto-approve path runs.
 */
export interface McpApprovalGate {
  /**
   * Lookup an approval row by id, returning null when the row is
   * missing or sits outside the calling scope.
   */
  get(scope: RequestScope, approvalId: string): Promise<ApprovalRecord | null>;
  /**
   * Create (or rediscover the still-pending row for) an MCP approval.
   * Idempotent on `(scope, requestHash)`.
   */
  create(input: {
    scope: RequestScope;
    toolName: string;
    args: Record<string, unknown>;
    requestHash: string;
    requestedByUserId?: string | null;
    requestedByMcpTokenId?: string | null;
    timeoutSeconds?: number;
  }): Promise<ApprovalRecord>;
  /**
   * Stamp the row as consumed and cache the executed result so
   * subsequent retries with the same approval id return the cached
   * value without re-executing the tool.
   */
  markConsumed(
    scope: RequestScope,
    approvalId: string,
    resolution: unknown,
  ): Promise<void>;
  /** Compute the deterministic idempotency hash. */
  hash(
    scope: RequestScope,
    toolName: string,
    redactedArgs: Record<string, unknown>,
  ): string;
}

export class McpRouter {
  private readonly logger = new Logger(McpRouter.name);
  private handlers = new Map<string, McpToolHandler>();
  private recorder: McpMacroRecorder | null = null;
  private approvalGate: McpApprovalGate | null = null;
  private approvalTtlSeconds = 3600;

  constructor(
    private readonly context: McpRouterContext,
    private readonly permissionGateway: MCPPermissionGatewayService,
  ) {}

  /**
   * MCP approval-UI — opt-in. When the controller passes a non-null
   * gate, `require_approval` calls open a real approval row instead of
   * being auto-approved. Idempotent — passing null disables the gate.
   */
  setApprovalGate(gate: McpApprovalGate | null, ttlSeconds?: number): void {
    this.approvalGate = gate;
    if (typeof ttlSeconds === "number" && ttlSeconds >= 60) {
      this.approvalTtlSeconds = Math.round(ttlSeconds);
    }
  }

  /**
   * K.17 — attach a macro recorder. Called by the controller's
   * `getRouter()` after `macros.*` tools are registered. Null-safe —
   * the router works identically when the recorder is absent.
   */
  setMacroRecorder(recorder: McpMacroRecorder | null): void {
    this.recorder = recorder;
  }

  register(handler: McpToolHandler): void {
    // MCPF-followup — pre-compile the input-schema validator so the
    // dispatch path doesn't pay the cost on every call. Idempotent
    // (recompiles when the same handler name is re-registered).
    if (!handler.validateInput) {
      handler.validateInput = compileSchema(handler.inputSchema);
    }
    this.handlers.set(handler.name, handler);
  }

  registerAll(handlers: McpToolHandler[]): void {
    for (const h of handlers) this.register(h);
  }

  getRegisteredTools(): McpToolHandler[] {
    return Array.from(this.handlers.values());
  }

  /**
   * Dispatch a single JSON-RPC request. Returns the response body.
   *
   * `requestCtx` carries transport-level metadata (e.g. the
   * `X-Platos-Approval-Id` header) that the controller can pass through
   * without it being part of the JSON-RPC envelope. Optional — the
   * router falls back to no-context behaviour.
   */
  async handle(
    req: JsonRpcRequest,
    token: VerifiedToken,
    requestCtx?: McpRequestContext,
  ): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {
                tools: {},
                logging: {},
              },
              serverInfo: {
                name: "platos-platform-mcp",
                version: "0.1.0",
              },
            },
          };
        }
        case "notifications/ping":
        case "ping": {
          return { jsonrpc: "2.0", id, result: {} };
        }
        case "notifications/initialized": {
          return { jsonrpc: "2.0", id, result: {} };
        }
        case "tools/list": {
          // Filter by token permission allowlist so a token only sees
          // tools it can invoke. Prevents accidental cross-scope
          // discovery via a low-permission token.
          //
          // K.18 — also hide admin-tier tools from scope-tier tokens so
          // cross-scope tools don't even appear in the inventory.
          const allowed = this.getRegisteredTools().filter((h) => {
            if (h.requiresAdminTier && token.tier !== "admin") return false;
            return PlatosMCPTokenService.allows(token.permissions, h.name);
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: allowed.map((h) => ({
                name: h.name,
                description: h.description,
                inputSchema: h.inputSchema,
                // TL.1 — expose the handler's category so MCP clients +
                // the Tools tab can group the inventory without a second
                // round-trip. Defaults to `"uncategorized"` for any
                // handler the factory didn't stamp.
                category: h.category ?? "uncategorized",
              })),
            },
          };
        }
        case "tools/call": {
          const params = req.params as
            | { name?: string; arguments?: Record<string, unknown> }
            | undefined;
          const name = params?.name;
          if (!name || typeof name !== "string") {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: RPC_ERRORS.INVALID_PARAMS,
                message: "tools/call: `name` is required",
              },
            };
          }
          if (!PlatosMCPTokenService.allows(token.permissions, name)) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: RPC_ERRORS.PERMISSION_DENIED,
                message: `token does not allow tool '${name}'`,
              },
            };
          }
          const handler = this.handlers.get(name);
          if (!handler) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: RPC_ERRORS.METHOD_NOT_FOUND,
                message: `tool '${name}' not found`,
              },
            };
          }
          // K.18 — admin-tier gate. Scope tokens are rejected at the
          // handler level rather than at the DB; the cross-scope queries
          // in admin.ts walk the full org tree and would otherwise leak
          // data to an LLM call if a scope token's permission allowlist
          // happened to include the admin tool name.
          if (handler.requiresAdminTier && token.tier !== "admin") {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: RPC_ERRORS.PERMISSION_DENIED,
                message: `tool '${name}' requires an admin-tier MCP token`,
              },
            };
          }

          // MCPF-followup — validate the call's `arguments` payload
          // against the tool's declared `inputSchema` BEFORE we do any
          // gateway / permission work that touches the DB. Without this
          // a bad call (e.g. `entities.update({entityId, description})`
          // when `description` isn't a known field with
          // `additionalProperties: false`) would silently drop the
          // unknown key and "succeed" returning an unchanged row. The
          // MCP spec maps schema-validation failures to JSON-RPC
          // INVALID_PARAMS (-32602).
          const argsForValidation = (params?.arguments ?? {}) as Record<string, unknown>;
          if (handler.validateInput) {
            const v = handler.validateInput(argsForValidation);
            if (!v.valid) {
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: RPC_ERRORS.INVALID_PARAMS,
                  message: `invalid arguments for tool '${name}'`,
                  data: { errors: v.errors },
                },
              };
            }
          }

          const scope = this.context.buildScope(token, token.mintedByUserId);

          // Permission gateway — tier 1-4. `block` rejects; `require_approval`
          // is not valid for Platform MCP (no active conversation to pause);
          // we treat it as block-with-hint.
          //
          // K.18 — pass the token's tier so admin tokens auto-escalate
          // every non-block disposition to `require_approval`.
          const perm = await this.permissionGateway.resolve({
            scope,
            agentId: null,
            userId: token.mintedByUserId,
            toolName: name,
            tokenTier: token.tier,
          });
          if (perm.state === "block") {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: RPC_ERRORS.TOOL_BLOCKED,
                message: `tool '${name}' blocked by tier-${perm.tier} policy`,
                data: { tier: perm.tier, reason: perm.reason },
              },
            };
          }
          const args = params?.arguments ?? {};

          // ── MCP approval gate ──────────────────────────────────────
          // When the gate is wired (MCP_INTERACTIVE_APPROVALS=true) and
          // the resolved permission is `require_approval`, we never
          // auto-execute. Three sub-paths:
          //   (1) The client passed `X-Platos-Approval-Id` and the row
          //       is `approved` + `consumedAt` populated → return the
          //       cached result.
          //   (2) The client passed `X-Platos-Approval-Id` and the row
          //       is `approved` + not yet consumed → execute the tool
          //       now, stamp consumedAt + cache resolution.
          //       Wave 2: if the row has `editedArgs`, execute with
          //       the operator-edited version instead of the original.
          //   (3) Otherwise → mint (or rediscover) a pending approval
          //       row, return -32002 AWAITING_APPROVAL with the
          //       approval id + dashboard URL.
          let cachedResult: unknown = undefined;
          // Wave 2 — when the operator edited the args at approve-time
          // we swap them in here. Default is the LLM-proposed args from
          // the original tools/call payload.
          let executionArgs: Record<string, unknown> = (args ?? {}) as Record<
            string,
            unknown
          >;
          let executionArgsSource: "original" | "edited" = "original";
          if (perm.state === "require_approval" && this.approvalGate) {
            const gate = this.approvalGate;
            const inboundApprovalId = (requestCtx?.approvalId ?? "").trim() || null;
            const argsRecord = (args ?? {}) as Record<string, unknown>;
            const redactedArgs = redactArgsForAudit(argsRecord);

            if (inboundApprovalId) {
              const row = await gate.get(scope, inboundApprovalId);
              if (!row) {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: RPC_ERRORS.AWAITING_APPROVAL,
                    message: `approval ${inboundApprovalId} not found in this scope`,
                    data: { approvalId: inboundApprovalId, status: "not_found" },
                  },
                };
              }
              if (row.status === "rejected") {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: RPC_ERRORS.AWAITING_APPROVAL,
                    message: `approval ${inboundApprovalId} was rejected`,
                    data: {
                      approvalId: inboundApprovalId,
                      status: "rejected",
                      reason: row.comment ?? null,
                      respondedBy: row.respondedBy ?? null,
                    },
                  },
                };
              }
              if (row.status === "timed_out" || row.expired) {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: RPC_ERRORS.AWAITING_APPROVAL,
                    message: `approval ${inboundApprovalId} expired before resolution`,
                    data: { approvalId: inboundApprovalId, status: "timed_out" },
                  },
                };
              }
              if (row.status === "pending") {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: RPC_ERRORS.AWAITING_APPROVAL,
                    message: `approval ${inboundApprovalId} still pending`,
                    data: {
                      approvalId: inboundApprovalId,
                      status: "pending",
                      expiresAt: row.deadlineAt,
                      retryHeader: "X-Platos-Approval-Id",
                      retryMeta: { platosApprovalId: inboundApprovalId },
                    },
                  },
                };
              }
              // status === "approved"
              if (row.toolName && row.toolName !== name) {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: RPC_ERRORS.AWAITING_APPROVAL,
                    message: `approval ${inboundApprovalId} was for tool '${row.toolName}', not '${name}'`,
                    data: { approvalId: inboundApprovalId, status: "tool_mismatch" },
                  },
                };
              }
              if (row.consumedAt) {
                // Already executed — return cached result so the call
                // is idempotent under client retries.
                cachedResult = row.resolution ?? null;
              } else if (
                row.editedArgs !== null &&
                row.editedArgs !== undefined &&
                typeof row.editedArgs === "object" &&
                !Array.isArray(row.editedArgs)
              ) {
                // Wave 2 — operator edited the args before approving.
                // Execute the tool with the edited version. The audit
                // trail still carries the original `args` for diff.
                executionArgs = row.editedArgs as Record<string, unknown>;
                executionArgsSource = "edited";
              }
              // else: approved but not yet consumed; fall through to
              // execute the handler with the original args.
            } else {
              // No approval id passed — open (or rediscover) a pending
              // row and return AWAITING_APPROVAL.
              const requestHash = gate.hash(scope, name, redactedArgs);
              const row = await gate.create({
                scope,
                toolName: name,
                args: redactedArgs,
                requestHash,
                requestedByUserId: token.mintedByUserId ?? null,
                requestedByMcpTokenId: token.id ?? null,
                timeoutSeconds: this.approvalTtlSeconds,
              });
              const dashboardUrl = buildApprovalDashboardUrl(
                requestCtx?.dashboardOrigin ?? null,
                scope,
                row.approvalId,
              );
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: RPC_ERRORS.AWAITING_APPROVAL,
                  message: `approval required for tool '${name}'`,
                  data: {
                    approvalId: row.approvalId,
                    status: "pending",
                    expiresAt: row.deadlineAt,
                    dashboardUrl,
                    retryHeader: "X-Platos-Approval-Id",
                    retryMeta: { platosApprovalId: row.approvalId },
                    tier: perm.tier,
                    reason: perm.reason,
                  },
                },
              };
            }
          } else if (perm.state === "require_approval") {
            // Gate not wired (MCP_INTERACTIVE_APPROVALS=false) — keep
            // the legacy pragmatic auto-approve. We log a single line
            // so a future audit pass can replay the history.
            try {
              // eslint-disable-next-line no-console
              console.log(
                `[mcp-router] auto-approving require_approval call ${name} (tier-${perm.tier} reason: ${perm.reason}, token=${token.id ?? "?"})`,
              );
            } catch {
              /* never throw from a log line */
            }
          }

          // Wave 2 — the executionArgs branch above may have swapped
          // the LLM args for operator-edited args. Re-validate the
          // edited payload against the handler's input schema before
          // calling, so a malformed edit produces INVALID_PARAMS rather
          // than blowing up inside the handler.
          if (
            cachedResult === undefined &&
            executionArgsSource === "edited" &&
            handler.validateInput
          ) {
            const v = handler.validateInput(executionArgs);
            if (!v.valid) {
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: RPC_ERRORS.INVALID_PARAMS,
                  message: `operator-edited arguments for tool '${name}' failed validation`,
                  data: { errors: v.errors, source: "edited_args" },
                },
              };
            }
          }
          const result =
            cachedResult !== undefined
              ? cachedResult
              : await handler.execute(executionArgs, scope, token);

          // If we executed under an approval, stamp consumedAt + cache
          // the result so subsequent retries are idempotent.
          if (
            cachedResult === undefined &&
            perm.state === "require_approval" &&
            this.approvalGate &&
            requestCtx?.approvalId
          ) {
            try {
              await this.approvalGate.markConsumed(
                scope,
                requestCtx.approvalId,
                result,
              );
            } catch {
              /* best-effort — never fail a successful tool call */
            }
          }

          // K.17 — record successful calls into any in-progress macro
          // recording for this token. `macros.*` is skipped to avoid
          // self-recursion (a macro that records its own record_stop).
          // Wave 2 — we record the args that actually executed, so a
          // replayed macro reproduces the operator-edited call rather
          // than the LLM-proposed one.
          if (
            this.recorder &&
            !name.startsWith("macros.") &&
            handler.macroRecordable !== false
          ) {
            try {
              this.recorder.record(token, name, executionArgs);
            } catch {
              /* recorder is best-effort; never fail a tool call */
            }
          }

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result),
                },
              ],
            },
          };
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: RPC_ERRORS.METHOD_NOT_FOUND,
              message: `method '${req.method}' not supported`,
            },
          };
      }
    } catch {
      this.logger.error("Platform MCP request failed");
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERRORS.INTERNAL_ERROR,
          message: "internal error",
        },
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Helpers — args redaction + dashboard URL building. Local to the
// router so the approval gate's audit trail never carries plaintext
// secrets (api keys, OAuth client secrets, magic-link tokens, …).
// ─────────────────────────────────────────────────────────────────

const REDACTABLE_KEY_RE =
  /(api[_-]?key|secret|token|password|passphrase|client[_-]?secret|signing[_-]?key|webhook[_-]?secret|authorization)/i;

/**
 * Recursive redactor — replaces values for keys that look secret-bearing
 * with a `<redacted>` sentinel. Stable shape so the audit trail still
 * shows what fields were sent. Caps recursion at 6 levels and 200
 * keys per level so a malicious payload can't bloat the audit row.
 *
 * The internal helper returns `unknown` (any of: redacted-object,
 * redacted-array, scalar, sentinel-string). The exported wrapper
 * coerces the top-level result to `Record<string, unknown>` so call
 * sites can persist + hash the audit row directly.
 */
function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "<truncated>";
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => redactValue(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 200) {
        out["__truncated__"] = true;
        break;
      }
      count += 1;
      if (REDACTABLE_KEY_RE.test(k)) {
        if (typeof v === "string") {
          // Keep first 4 chars for breadcrumbs; redact the rest.
          out[k] = v.length > 4 ? `${v.slice(0, 4)}…<redacted>` : "<redacted>";
        } else {
          out[k] = "<redacted>";
        }
        continue;
      }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 4096) {
    return `${value.slice(0, 4096)}…<truncated>`;
  }
  return value;
}

export function redactArgsForAudit(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out = redactValue(args, 0);
  if (out && typeof out === "object" && !Array.isArray(out)) {
    return out as Record<string, unknown>;
  }
  // Defensive fallback — top-level is always an object for a
  // tools/call args payload, but if a malformed call gets here we
  // still return something serialisable rather than throw.
  return { __nonObjectArgs: out };
}

function buildApprovalDashboardUrl(
  origin: string | null,
  scope: RequestScope,
  approvalId: string,
): string {
  // Path layout matches the Remix route `_app.orgs.$organizationSlug
  // .projects.$projectParam.env.$envParam.approvals.$approvalId`. The
  // controller substitutes resolved slugs when it has them; otherwise
  // the dashboard does its own scope lookup from the ids.
  const path = `/orgs/${scope.organizationId}/projects/${scope.projectId}/env/${scope.environmentId}/approvals/${approvalId}`;
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin.replace(/\/$/, "")}${path}`;
  }
  return path;
}
