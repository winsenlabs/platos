/**
 * `platools.tool()` factory — the TypeScript analogue of the Python
 * `@platools.tool()` decorator.
 *
 * TC39 decorators are still shifting under our feet, so the TS SDK
 * uses a plain factory function (same pattern tRPC, Hono, and Zod
 * itself use). Consumers write:
 *
 *     export const processRefund = platools.tool(
 *       {
 *         name: "process_refund",
 *         description: "Process a refund for an order",
 *         input: z.object({ orderId: z.string(), reason: z.string() }),
 *         output: RefundResult,
 *         auth: "user",
 *         roles: ["support", "admin"],
 *       },
 *       async ({ orderId, reason }, ctx) => refundService.process(orderId, reason),
 *     );
 *
 * The factory:
 *
 *   1. Validates the `ToolOptions` (auth level, timeout, roles).
 *   2. Builds input + output JSON schemas via `zod-to-json-schema`.
 *   3. Registers a `ToolDef` in the owning `Platools` instance's
 *      registry.
 *   4. Returns the handler unchanged — decorated tools remain
 *      directly callable in user code, exactly like the Python SDK.
 *
 * Sync and async handlers are both supported; the transport
 * `await`s the handler's return value unconditionally.
 */

import type { z } from "zod";

import { buildPlatosContext, type PlatosContext } from "../context.js";
import { buildSchemas } from "./schema.js";
import { ToolRegistry } from "./registry.js";
import type {
  AuthLevel,
  ToolDef,
  ToolHandler,
  ToolOptions,
} from "../types.js";

const VALID_AUTH: ReadonlySet<AuthLevel> = new Set<AuthLevel>(["none", "user", "admin"]);

/**
 * Build a `tool()` factory bound to `registry`. Each `Platools`
 * instance has its own registry, so every instance's `.tool()` is a
 * closure over its own registry reference — two `Platools` objects
 * never leak registrations to each other.
 */
export function makeToolFactory(
  registry: ToolRegistry,
): <Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  options: ToolOptions<Input, Output>,
  handler: ToolHandler<z.infer<Input>, z.infer<Output>>,
) => ToolHandler<z.infer<Input>, z.infer<Output>> {
  return function tool<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
    options: ToolOptions<Input, Output>,
    handler: ToolHandler<z.infer<Input>, z.infer<Output>>,
  ): ToolHandler<z.infer<Input>, z.infer<Output>> {
    validateOptions(options);

    const { inputSchema, outputSchema } = buildSchemas(options);

    // Wrap the handler in a common `unknown`-typed shim so the
    // registry stays homogeneous. The original, properly-typed
    // handler is returned to the caller untouched.
    const boxed: ToolHandler<unknown, unknown> = (params, ctx) =>
      handler(params as z.infer<Input>, ctx);

    const toolDef: ToolDef = {
      name: options.name,
      description: (options.description ?? "").trim(),
      handler: boxed,
      inputZodSchema: options.input,
      outputZodSchema: options.output ?? null,
      inputSchema,
      outputSchema,
      auth: options.auth ?? "none",
      roles: Object.freeze([...(options.roles ?? [])]),
      rateLimit: options.rateLimit ?? null,
      timeoutMs: options.timeoutMs ?? null,
      annotations: Object.freeze({ ...(options.annotations ?? {}) }),
    };
    registry.register(toolDef);

    // Return the consumer's handler unchanged — it remains directly
    // callable in user code. This matches the Python decorator's
    // "returns original function" behavior so unit tests can
    // invoke the tool without going through the registry.
    return handler;
  };
}

function validateOptions<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
  options: ToolOptions<Input, Output>,
): void {
  if (!options.name || options.name.trim() === "") {
    throw new Error("platools.tool: `name` is required");
  }
  const auth = options.auth ?? "none";
  if (!VALID_AUTH.has(auth)) {
    throw new Error(
      `platools.tool: auth must be one of ${[...VALID_AUTH].sort().join(", ")}, got ${auth}`,
    );
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw new Error(
      `platools.tool: timeoutMs must be positive, got ${options.timeoutMs}`,
    );
  }
  if (!options.input) {
    throw new Error("platools.tool: `input` (Zod schema) is required");
  }
}

/**
 * Build a no-op `PlatosContext`. Used by tests and by the local test
 * runner which doesn't go through the WebSocket transport.
 *
 * CTX.5: the returned shape now matches the full handler-ctx
 * contract (`callId`, `context`, `entityIds?`, `raw`) so local tests
 * and the platform-dispatched path see an identical type.
 */
export function makeLocalContext(callId = "local"): PlatosContext {
  return buildPlatosContext(callId, {});
}
