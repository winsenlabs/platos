/**
 * Platools — Your AI Arsenal (TypeScript SDK).
 *
 * Mirrors `platools/__init__.py::Platools`. Each instance owns its
 * own `ToolRegistry` and exposes a `tool()` factory bound to that
 * registry. Consumers usually construct exactly one instance per
 * backend process.
 *
 * Usage:
 *
 *     import { z } from "zod";
 *     import { Platools } from "@platosdev/platools-sdk";
 *
 *     const platools = new Platools({
 *       url: process.env.PLATOS_URL,
 *       secret: process.env.PLATOS_SECRET,
 *     });
 *
 *     export const processRefund = platools.tool(
 *       {
 *         name: "process_refund",
 *         description: "Process a refund for an order",
 *         input: z.object({ orderId: z.string(), reason: z.string() }),
 *         output: z.object({ refundId: z.string(), amountCents: z.number().int() }),
 *         auth: "user",
 *         roles: ["support", "admin"],
 *       },
 *       async ({ orderId, reason }) => refundService.process(orderId, reason),
 *     );
 *
 *     // Bootstrap:
 *     await platools.connect();
 */

import type { z } from "zod";

import { makeToolFactory } from "./core/decorator.js";
import { ToolRegistry } from "./core/registry.js";
import { PlatoolsClient } from "./transport/client.js";
import type {
  ToolDef,
  ToolHandler,
  ToolOptions,
  ToolSchema,
} from "./types.js";

export interface PlatoolsConfig {
  /** Base URL of the Platos platform — e.g. `https://platform.platos.dev`. */
  readonly url?: string;
  /** SDK secret issued by the platform; used for JWT auth on the WebSocket. */
  readonly secret?: string;
}

export class Platools {
  public readonly url: string | null;
  public readonly secret: string | null;

  private readonly registryInstance: ToolRegistry = new ToolRegistry();
  private readonly toolFactory: ReturnType<typeof makeToolFactory>;

  public constructor(config: PlatoolsConfig = {}) {
    this.url = config.url ?? processEnv("PLATOS_URL");
    this.secret = config.secret ?? processEnv("PLATOS_SECRET");
    this.toolFactory = makeToolFactory(this.registryInstance);
  }

  /**
   * Register a typed tool with this `Platools` instance. Returns the
   * consumer's handler unchanged so the tool remains directly
   * callable in user code (matches the Python decorator semantics).
   */
  public tool<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny>(
    options: ToolOptions<Input, Output>,
    handler: ToolHandler<z.infer<Input>, z.infer<Output>>,
  ): ToolHandler<z.infer<Input>, z.infer<Output>> {
    return this.toolFactory(options, handler);
  }

  /**
   * Public accessor for the underlying `ToolRegistry`. Used by
   * `platools doctor` to walk every decorated tool and by advanced
   * consumers integrating with their own dispatch layer.
   */
  public get registry(): ToolRegistry {
    return this.registryInstance;
  }

  /** Read-only snapshot of the registered tools keyed by name. */
  public get tools(): Record<string, ToolDef> {
    const out: Record<string, ToolDef> = {};
    for (const t of this.registryInstance.all()) out[t.name] = t;
    return out;
  }

  public getTool(name: string): ToolDef | undefined {
    return this.registryInstance.get(name);
  }

  /** Return MCP-compliant tool schemas for every registered tool. */
  public getMcpSchemas(): ToolSchema[] {
    return this.registryInstance.all().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }));
  }

  /**
   * Open an outbound WebSocket to the platform and run forever.
   *
   * Reconnects automatically with exponential backoff on failure;
   * exits cleanly when `stop()` is called or the platform closes
   * the connection. See PRD §5.2.
   */
  public async connect(): Promise<void> {
    if (this.url === null || this.secret === null) {
      throw new Error(
        "Platools.connect() requires url + secret — set PLATOS_URL and PLATOS_SECRET",
      );
    }
    const client = new PlatoolsClient({
      url: this.url,
      secret: this.secret,
      registry: this.registryInstance,
    });
    await client.runForever();
  }
}

function processEnv(name: string): string | null {
  // Guarded access so the SDK can be imported in browser/edge
  // environments that don't expose `process.env`. The connect path
  // still requires explicit credentials in those environments.
  if (typeof process === "undefined") return null;
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
}
