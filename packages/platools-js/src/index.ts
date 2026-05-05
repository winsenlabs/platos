/**
 * Platools — Your AI Arsenal (TypeScript SDK).
 *
 * Turn any backend function into a managed, authenticated,
 * monitored MCP tool with a single `platools.tool()` call:
 *
 *     import { z } from "zod";
 *     import { Platools } from "@platosdev/platools-sdk";
 *
 *     const platools = new Platools();
 *
 *     export const checkBalance = platools.tool(
 *       {
 *         name: "check_balance",
 *         description: "Get an account balance by id",
 *         input: z.object({ accountId: z.string().uuid() }),
 *         output: z.object({ balanceCents: z.number().int() }),
 *         auth: "user",
 *       },
 *       async ({ accountId }) => {
 *         return { balanceCents: await db.getBalance(accountId) };
 *       },
 *     );
 *
 * On startup the SDK generates an MCP-compliant JSON schema from
 * the Zod input / output shapes and (via `platools.connect()`)
 * opens an outbound WebSocket to the Platos platform. See PRD §5.1
 * and §5.2 for the contracts.
 */

export const VERSION = "0.0.0" as const;

export { Platools, type PlatoolsConfig } from "./platools.js";
export { ToolRegistry } from "./core/registry.js";
export { makeLocalContext, makeToolFactory } from "./core/decorator.js";
export {
  SchemaError,
  buildInputSchema,
  buildOutputSchema,
  buildSchemas,
} from "./core/schema.js";
export type {
  AuthLevel,
  JsonSchema,
  ToolContext,
  ToolDef,
  ToolHandler,
  ToolOptions,
  ToolSchema,
} from "./types.js";

// Per-call context — populated by the transport layer from the
// platform's `__platos` envelope and read by tool handlers without
// threading ctx through every function.
//
// CTX.5: `PlatosContext` is the type of the optional second argument
// every tool handler receives. It carries the unpacked `_context`
// envelope built by the agent from `contextMapping.envelopeKeys` —
// handlers that prefer argument-passing over AsyncLocalStorage
// accessors read `ctx?.context["user.id"]` etc.
export {
  buildPlatosContext,
  currentAgentId,
  currentCallId,
  currentContext,
  currentEntityId,
  currentScope,
  currentThreadId,
  currentUserId,
  currentUserToken,
  envelopeToContext,
  runWithContext,
  type PlatosCallContext,
  type PlatosContext,
  type PlatosEnvelope,
} from "./context.js";

// Transport surface — advanced consumers may import these to
// wire their own dispatcher, but the common case is
// `platools.connect()`.
export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  HEARTBEAT_INTERVAL_MS,
  PlatoolsClient,
  backoffDelayMs,
  type ClientLogger,
  type PlatoolsClientOptions,
  type Sleeper,
  type WsFactory,
  type WsLike,
} from "./transport/client.js";
export {
  decodePlatformMessage,
  encodeSdkMessage,
  type HeartbeatAckMessage,
  type HeartbeatMessage,
  type PlatformToSdk,
  type SdkToPlatform,
  type ToolCallMessage,
  type ToolErrorMessage,
  type ToolHealthEntry,
  type ToolHealthStatus,
  type ToolRegisterMessage,
  type ToolResultMessage,
  type ToolSchemaPayload,
  type WelcomeMessage,
} from "./transport/protocol.js";

// Replay guard — HMAC verification + per-entity nonce LRU (PPR-71).
// Consumers implementing their own HTTP handler for the Platos
// fallback path should call `verifyRequest()` before dispatching.
export {
  DEFAULT_MAX_SKEW_SECONDS,
  DEFAULT_NONCE_CACHE_SIZE,
  verifyRequest,
  __resetNonceCacheForTests,
  type VerifyRequestInput,
  type VerifyRequestResult,
} from "./security/replay-guard.js";

// Doctor surface — the CLI is the canonical entry point, but the
// analyzer is re-exported so consumers can wire it into their own
// CI scripts or test harness.
export { analyzeRegistry, analyzeTools, type AnalyzeOptions } from "./doctor/analyzer.js";
export { formatReport, reportToJson } from "./doctor/reporter.js";
export { DoctorReport, type Finding, type Severity } from "./doctor/types.js";
export {
  allCheckNames,
  checkCircularDependencies,
  checkDescriptions,
  checkDestructiveAnnotations,
  checkOrphanTools,
  checkOverlyBroad,
  checkParamSources,
  checkPermissionGaps,
  checkReturnSchema,
} from "./doctor/checks.js";
