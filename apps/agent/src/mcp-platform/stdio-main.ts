import { inspect } from "node:util";

/**
 * Platform MCP stdio entrypoint for Claude Code/Cursor.
 *
 * Security and framing invariants:
 *   - PLATOS_MCP_STDIO_TOKEN is required; no scope may be supplied on stdin.
 *   - token verification and tenancy ancestry are identical to HTTP+SSE.
 *   - only JSON-RPC protocol frames reach stdout; every log is redirected to
 *     stderr before Nest or any application module is imported.
 */

const protocolWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);

function stderrLog(...args: unknown[]): void {
  stderrWrite(`${args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" ")}\n`);
}

// Protect stdio framing even if a lazily imported service calls console.log or
// writes process.stdout directly. The transport retains the original writer.
process.stdout.write = stderrWrite as typeof process.stdout.write;
console.log = stderrLog;
console.info = stderrLog;
console.debug = stderrLog;
console.warn = stderrLog;

async function writeProtocolLine(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    protocolWrite(line, (error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const rawBearer = process.env["PLATOS_MCP_STDIO_TOKEN"]?.trim();
  delete process.env["PLATOS_MCP_STDIO_TOKEN"];
  if (!rawBearer) {
    throw new Error(
      "PLATOS_MCP_STDIO_TOKEN is required (supply a scoped plt_mcp_ token through the IDE process environment)"
    );
  }

  // Import the Nest module graph in dependency order. Loading the controller
  // concurrently with its circular AgentRuntimeModule dependencies can expose
  // partially initialized decorator metadata under tsx/CommonJS.
  const { NestFactory } = await import("@nestjs/core");
  const { McpStdioAppModule } = await import("./stdio-app.module");
  const { McpPlatformController } = await import("./mcp-platform.controller");
  const { runMcpStdioTransport } = await import("./stdio-transport");
  const { closeStdioOwnedResources, withCleanupDeadline } = await import("./stdio-lifecycle");
  const { PRISMA_TOKEN } = await import("../shared/database.provider");
  const { REDIS_TOKEN } = await import("../shared/redis.provider");

  const app = await NestFactory.createApplicationContext(McpStdioAppModule, {
    logger: false,
    abortOnError: false,
  });

  const abortController = new AbortController();
  let closePromise: Promise<void> | null = null;
  const close = () => {
    closePromise ??= closeStdioOwnedResources({
      abortController,
      app,
      prisma: app.get(PRISMA_TOKEN, { strict: false }),
      redis: app.get(REDIS_TOKEN, { strict: false }),
    });
    return closePromise;
  };
  const shutdown = async (exitCode: number) => {
    const result = await withCleanupDeadline(close(), 5_000);
    if (result === "timed_out") stderrLog("[platos-mcp-stdio] cleanup timed out");
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));

  try {
    const controller = app.get(McpPlatformController, { strict: false });
    const session = await controller.createStdioSession(rawBearer);
    if (!session) throw new Error("invalid or expired Platform MCP token");
    await runMcpStdioTransport({
      input: process.stdin,
      session,
      signal: abortController.signal,
      writeProtocolLine,
    });
  } finally {
    const result = await withCleanupDeadline(close(), 5_000);
    if (result === "timed_out") throw new Error("stdio cleanup timed out");
  }
}

void main().catch((error) => {
  stderrLog("[platos-mcp-stdio]", error instanceof Error ? error.message : error);
  // Bootstrap can fail after a global provider has opened a socket but before
  // Nest returns an application context we can close. Do not let those partial
  // resources keep an IDE-owned stdio subprocess alive indefinitely.
  process.exit(1);
});
