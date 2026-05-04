/**
 * Platos trigger.dev task worker entrypoint.
 *
 * Runs as a dedicated worker process (WORKER_MODE=true in entrypoint.sh) that
 * connects to the webapp run engine, registers this instance as a dequeue
 * worker, and polls for task runs.
 *
 * Architecture note:
 *   The Platos docker-compose layout has the webapp bootstrap a "bootstrap"
 *   worker group (TRIGGER_BOOTSTRAP_ENABLED=1). Task runs triggered via
 *   `triggerSdk.tasks.trigger(...)` are queued by the run engine and picked up
 *   by a registered worker.
 *
 *   This file allows the agent image to run in either API-server mode (the
 *   default, `node dist/main.js`) or worker mode (`WORKER_MODE=true`), enabling
 *   horizontal scaling by running multiple worker replicas in docker-compose.
 *
 * Environment variables:
 *   TRIGGER_API_URL            — webapp base URL (default: http://webapp:3030)
 *   TRIGGER_WORKER_TOKEN       — per-worker-group auth token issued by webapp.
 *                                 If not set, reads from TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH.
 *   PLATOS_WORKER_CONCURRENCY  — max concurrent runs to dequeue (default: 50)
 *   TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH — path to bootstrap token file
 *                                          (default: /tmp/bootstrap-worker-token.txt)
 *
 * How to provision TRIGGER_WORKER_TOKEN:
 *   The webapp writes the bootstrap worker group token to
 *   TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH on first boot. Mount a shared volume
 *   so the worker service can read the same file, OR set TRIGGER_WORKER_TOKEN
 *   explicitly in the docker-compose environment block.
 */

import { readFile } from "node:fs/promises";
import * as os from "node:os";

const TRIGGER_API_URL = (process.env.TRIGGER_API_URL ?? "http://webapp:3030").replace(/\/$/, "");
const TOKEN_PATH =
  process.env.TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH ?? "/tmp/bootstrap-worker-token.txt";
const CONCURRENCY = parseInt(process.env.PLATOS_WORKER_CONCURRENCY ?? "50", 10);
const INSTANCE_NAME = `platos-worker-${process.pid}`;

async function resolveWorkerToken(): Promise<string> {
  const fromEnv = process.env.TRIGGER_WORKER_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  try {
    const token = (await readFile(TOKEN_PATH, "utf-8")).trim();
    if (token) {
      console.log(`[platos-worker] Loaded worker token from ${TOKEN_PATH}`);
      return token;
    }
  } catch {
    // File not present yet — fall through to error.
  }

  throw new Error(
    `TRIGGER_WORKER_TOKEN is not set. Ensure the webapp has written the bootstrap token ` +
      `to ${TOKEN_PATH} (TRIGGER_BOOTSTRAP_WORKER_TOKEN_PATH) or set TRIGGER_WORKER_TOKEN explicitly.`,
  );
}

function makeHeaders(workerToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${workerToken}`,
    // x-trigger-worker-instance-name is the header checked by WorkerGroupTokenService.authenticate()
    "x-trigger-worker-instance-name": INSTANCE_NAME,
    // MANAGED_WORKER_SECRET is validated by WorkerGroupTokenService to prevent token replay from
    // outside the docker network.
    "x-trigger-worker-managed-secret": process.env.MANAGED_WORKER_SECRET ?? "",
  };
}

async function connect(workerToken: string): Promise<void> {
  const res = await fetch(`${TRIGGER_API_URL}/engine/v1/worker-actions/connect`, {
    method: "POST",
    headers: makeHeaders(workerToken),
    body: JSON.stringify({
      metadata: {
        instanceName: INSTANCE_NAME,
        concurrency: CONCURRENCY,
        pid: process.pid,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Worker connect failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { workerGroup?: { name: string } };
  console.log(`[platos-worker] Connected (workerGroup=${data?.workerGroup?.name ?? "unknown"})`);
}

async function dequeue(workerToken: string): Promise<unknown[]> {
  const res = await fetch(`${TRIGGER_API_URL}/engine/v1/worker-actions/dequeue`, {
    method: "POST",
    headers: makeHeaders(workerToken),
    body: JSON.stringify({ maxRunCount: CONCURRENCY }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dequeue failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const runs = (await res.json()) as unknown[];
  return Array.isArray(runs) ? runs : [];
}

function snapshotResources(): { cpu: { used: number; available: number }; memory: { used: number; available: number } } {
  // Average load over last 1 min, divided by core count, gives 0..1 utilization (>1 means overloaded).
  const loadAvg = os.loadavg()[0] ?? 0;
  const cores = os.cpus().length || 1;
  const cpuUsedFrac = Math.min(loadAvg / cores, 1);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    cpu: { used: cpuUsedFrac, available: 1 - cpuUsedFrac },
    memory: { used: totalMem - freeMem, available: freeMem },
  };
}

async function heartbeat(workerToken: string): Promise<void> {
  const { cpu, memory } = snapshotResources();
  const res = await fetch(`${TRIGGER_API_URL}/engine/v1/worker-actions/heartbeat`, {
    method: "POST",
    headers: makeHeaders(workerToken),
    body: JSON.stringify({ cpu, memory, tasks: [] }),
  });

  if (!res.ok) {
    throw new Error(`Heartbeat failed (${res.status})`);
  }
}

async function main() {
  console.log(`[platos-worker] Starting (concurrency=${CONCURRENCY}, api=${TRIGGER_API_URL})`);

  const workerToken = await resolveWorkerToken();

  await connect(workerToken);

  let stopped = false;
  let idleStreak = 0;

  const poll = async (): Promise<void> => {
    if (stopped) return;

    try {
      const runs = await dequeue(workerToken);
      if (runs.length > 0) {
        idleStreak = 0;
        console.log(`[platos-worker] Dequeued ${runs.length} run(s)`);
      } else {
        idleStreak = Math.min(idleStreak + 1, 4);
      }
    } catch (err: any) {
      console.warn("[platos-worker] Dequeue error:", err?.message);
    }

    if (!stopped) {
      // Back off to 2s when idle, poll at 500ms when active.
      const nextMs = idleStreak >= 2 ? 2000 : 500;
      setTimeout(() => void poll(), nextMs);
    }
  };

  const heartbeatTimer = setInterval(async () => {
    try {
      await heartbeat(workerToken);
    } catch (err: any) {
      console.warn("[platos-worker] Heartbeat error:", err?.message);
    }
  }, 30_000);

  const shutdown = () => {
    console.log("[platos-worker] Shutting down");
    stopped = true;
    clearInterval(heartbeatTimer);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  void poll();
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[platos-worker] Fatal error:", msg);
  process.exit(1);
});
