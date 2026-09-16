/**
 * WIN-268 (M4.2) — ONE AGENT NODE, AS ITS OWN OPERATING-SYSTEM PROCESS.
 *
 * `mcp-sse-multi-node.integration.test.ts` starts this file TWICE, so the
 * legacy-SSE session and the POST that answers it are served by two processes
 * that share nothing but a PostgreSQL schema and a Redis — which is the whole
 * claim of a Redis-routed transport, and the one thing an in-process test cannot
 * make: two Nest applications in one process share a module cache, an event
 * loop and every in-memory map, so a transport that secretly routed through
 * process memory (the docs server's does) would pass there and fail on any
 * install with more than one agent replica.
 *
 * The node reports on stdout, one JSON record per line behind `NODE_LINE_PREFIX`:
 * `ready` once it listens, and one `publish` record for EVERY Redis PUBLISH it
 * sends, in send order, with the JSON-RPC id it carried and, where the frame is a
 * JSON-RPC error, that error's code. That log is how the suite pins WHICH node
 * dispatched each request — the split point — instead of inferring it from a
 * stream that would look the same either way, and it is the ONLY witness left in
 * the cancellation case, whose whole point is that the stream those frames would
 * have arrived on is gone.
 *
 * The frame BODY is deliberately not reported: a completed macro replay carries
 * thousands of step results, and one stdout line per publish is not the place
 * for it. The id and the error code are what the suite joins on.
 *
 * Environment: `MCP_NODE_LABEL`, `MCP_NODE_DATABASE_URL` (a private schema the
 * parent already migrated and seeded), `MCP_NODE_REDIS_URL`.
 */

import { NODE_LINE_PREFIX, attachPrivateSchema, startMcpServers } from "./mcp-conformance.test-fixture";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const node = required("MCP_NODE_LABEL");
  const prisma = attachPrivateSchema(required("MCP_NODE_DATABASE_URL"));
  const emit = (record: Record<string, unknown>) => {
    process.stdout.write(`${NODE_LINE_PREFIX}${JSON.stringify({ node, ...record })}\n`);
  };
  const servers = await startMcpServers({
    prisma,
    redisUrl: required("MCP_NODE_REDIS_URL"),
    onPublish: (channel, message) => {
      let id: unknown = null;
      let errorCode: unknown = null;
      try {
        const parsed = JSON.parse(message) as { id?: unknown; error?: { code?: unknown } };
        id = parsed.id ?? null;
        errorCode = parsed.error?.code ?? null;
      } catch {
        // a session-control message such as "cancel", not a JSON-RPC frame
      }
      emit({ event: "publish", channel, id, errorCode });
    },
  });
  emit({ event: "ready", baseUrl: servers.baseUrl, pid: process.pid });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await servers.close();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

// Run by `vite-node`, the same transform Vitest applies to the in-process
// suite — so the two processes and the suite compile these controllers alike.
// Nothing imports this file; it is an entry point only.
main().catch((error: unknown) => {
  process.stderr.write(`${NODE_LINE_PREFIX}fatal ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
