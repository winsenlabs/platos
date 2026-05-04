/**
 * Public types for the Platools TypeScript SDK.
 *
 * Mirrors `platools/types.py` — the Python SDK is the source of
 * truth for semantics, and every field here matches the Python
 * dataclass 1:1 so the wire protocol and doctor findings line up
 * exactly between SDKs.
 *
 * Keep this module free of runtime logic so typing can be imported
 * cheaply.
 */

import type { z } from "zod";

import type { PlatosContext } from "./context.js";

/**
 * Auth enforcement level for a tool. `none` means any caller, `user`
 * means authenticated end user, `admin` means platform admin role.
 */
export type AuthLevel = "none" | "user" | "admin";

/**
 * MCP-compliant tool schema.
 *
 * The `name`, `description`, and `inputSchema` fields match the MCP
 * tool spec 1:1 so `getMcpSchemas()` can return `ToolSchema`
 * instances directly. `outputSchema` is captured for future-proofing
 * (the current MCP spec does not expose it).
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema | null;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/**
 * Handler signature for a tool registered with `platools.tool()`.
 *
 * `Input` is inferred from the Zod input schema, `Output` from the
 * Zod output schema. The handler may be sync or async — the
 * transport layer awaits the return value unconditionally.
 *
 * CTX.5: `ctx` is **optional** so existing `(params) => …` handlers
 * keep working. New handlers that want the unpacked `_context`
 * envelope add `ctx?: PlatosContext` and read `ctx?.context["user.id"]`
 * etc. See `context.ts::PlatosContext`.
 */
export type ToolHandler<Input, Output> = (
  params: Input,
  ctx?: PlatosContext,
) => Output | Promise<Output>;

/**
 * Context object passed to every tool handler.
 *
 * CTX.5 aliased this to `PlatosContext` so the "thin handler ctx"
 * and the "unpacked `_context` envelope" are a single public type.
 * Exported under both names to avoid breaking code that imported
 * `ToolContext` directly.
 */
export type ToolContext = PlatosContext;

/**
 * Internal representation of a registered tool.
 *
 * The SDK uses this to dispatch tool calls, enforce auth/roles, and
 * serialize the registry over the WebSocket transport. The `handler`
 * is stored as `unknown`-typed to keep the registry homogeneous;
 * the decorator closes over the real signature at registration time.
 */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly handler: ToolHandler<unknown, unknown>;
  readonly inputZodSchema: z.ZodTypeAny;
  readonly outputZodSchema: z.ZodTypeAny | null;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema | null;
  readonly auth: AuthLevel;
  readonly roles: readonly string[];
  readonly rateLimit: string | null;
  readonly timeoutMs: number | null;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/**
 * A minimal JSON Schema shape. The real spec is much richer, but
 * for the fields the doctor and transport touch we only need
 * `type`, `properties`, `required`, `description`, and a few
 * well-known extension fields like `x-user-providable`. Everything
 * else is kept under an unknown index so consumers can ship
 * additional metadata without the type system fighting them.
 */
export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly default?: unknown;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly [extension: string]: unknown;
}

/**
 * Options accepted by `platools.tool()`.
 *
 * The only required fields are `name` and `input` (Zod) — everything
 * else defaults to Python-SDK-compatible values (`auth: "none"`,
 * empty roles, no rate limit, no timeout, no annotations).
 */
export interface ToolOptions<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny = z.ZodNever> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output?: Output;
  readonly auth?: AuthLevel;
  readonly roles?: readonly string[];
  readonly rateLimit?: string;
  readonly timeoutMs?: number;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
