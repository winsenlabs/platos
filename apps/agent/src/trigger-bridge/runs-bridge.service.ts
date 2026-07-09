import { Injectable, Logger } from "@nestjs/common";
import { ConnectionsGateway } from "../connections/connections.gateway";
import type { RequestScope } from "../auth/scope.guard";

// Trigger.dev SDK — same lazy-require pattern as `agent.service.ts` so the
// agent process boots even when the SDK isn't configured (local dev without
// TRIGGER_SECRET_KEY).
let triggerSdk: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  triggerSdk = require("@trigger.dev/sdk");
  // TODO(env.ts) consider migration — this runs at module-import time,
  // before main.ts's validateAgentEnv() surfaces structured errors. Direct
  // process.env keeps boot quiet when SDK isn't configured (local dev).
  if (process.env.TRIGGER_SECRET_KEY && triggerSdk?.configure) {
    triggerSdk.configure({
      accessToken: process.env.TRIGGER_SECRET_KEY,
      baseURL: process.env.TRIGGER_API_URL || "http://localhost:3030",
    });
  }
} catch {
  triggerSdk = null;
}

/**
 * Terminal trigger.dev run states. Once a run hits one of these the
 * subscribe iterator returns and we tear the subscription down.
 */
const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "CRASHED",
  "TIMED_OUT",
  "SYSTEM_FAILURE",
]);

/**
 * Bridges trigger.dev run realtime events to the thread's Socket.IO room.
 *
 * PPR-26 — full implementation. Opens a `runs.subscribeToRun(runId)`
 * async iterator from `@trigger.dev/sdk`, and for each update emits a
 * `run_update` agent event into the scope's + thread's Socket.IO rooms
 * via ConnectionsGateway. Tears the subscription down automatically on
 * terminal statuses.
 *
 * Usage from AgentService (spawn_bgo meta-tool; deprecated alias spawn_task):
 *   const unsubscribe = runsBridge.subscribe(runId, scope, threadId);
 *   // events flow: agent_event { type: "run_update", runId, status, metadata, output? }
 *   // call unsubscribe() early to cancel.
 */
@Injectable()
export class RunsBridgeService {
  private readonly logger = new Logger(RunsBridgeService.name);
  /**
   * Per-runId cancellation flag. Setting `.cancelled = true` stops the
   * background `for-await` loop on the next iteration without needing an
   * AbortSignal — the SDK's async iterators surface `return()` via
   * `break` out of the loop.
   */
  private readonly active = new Map<
    string,
    { cancelled: boolean; iter?: AsyncIterable<unknown> & { return?: () => Promise<unknown> } }
  >();

  constructor(private readonly connections: ConnectionsGateway) {}

  /**
   * Subscribe to a trigger.dev run's realtime stream. Returns an
   * unsubscribe function. Safe to call from inside a meta-tool exec —
   * the inner loop runs in the background.
   */
  subscribe(runId: string, scope: RequestScope, threadId: string): () => void {
    if (!triggerSdk?.runs?.subscribeToRun) {
      this.logger.warn(`runs.subscribeToRun unavailable — trigger.dev SDK not configured. runId=${runId}`);
      return () => undefined;
    }
    if (this.active.has(runId)) {
      this.logger.debug(`already subscribed to run, skipping. runId=${runId}`);
      return this.cancelFn(runId);
    }
    const handle: { cancelled: boolean; iter?: AsyncIterable<unknown> & { return?: () => Promise<unknown> } } = {
      cancelled: false,
    };
    this.active.set(runId, handle);

    // Kick off the subscription loop in the background. We don't await it
    // — the caller gets an unsubscribe handle and the loop runs until
    // terminal status or cancellation.
    void this.runLoop(runId, scope, threadId, handle).catch((err) => {
      this.logger.error(`subscribe loop crashed for runId=${runId}: ${err?.message || err}`);
    });

    return this.cancelFn(runId);
  }

  private cancelFn(runId: string): () => void {
    return () => {
      const handle = this.active.get(runId);
      if (!handle) return;
      handle.cancelled = true;
      // Best-effort close of the async iterator so the SDK can release its
      // underlying SSE connection immediately.
      void handle.iter?.return?.().catch(() => undefined);
      this.active.delete(runId);
    };
  }

  private async runLoop(
    runId: string,
    scope: RequestScope,
    threadId: string,
    handle: { cancelled: boolean; iter?: AsyncIterable<unknown> & { return?: () => Promise<unknown> } },
  ): Promise<void> {
    try {
      const iter: AsyncIterable<any> = triggerSdk.runs.subscribeToRun(runId);
      handle.iter = iter as any;
      for await (const snap of iter) {
        if (handle.cancelled) break;
        const status = String(snap?.status ?? "UNKNOWN");
        // Emit to both the scope room (ConnectionsGateway pattern for
        // approval events) and the thread room (for clients joined via
        // `join_thread`). Socket.IO dedupes via socket id.
        const event = {
          type: "run_update" as const,
          runId,
          status,
          metadata: (snap?.metadata ?? null) as Record<string, unknown> | null,
          ...(snap?.output !== undefined ? { output: snap.output } : {}),
          ...(snap?.error ? { error: snap.error } : {}),
          threadId,
        };
        const scopeRoom = `scope:${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
        const threadRoom = `thread:${threadId}`;
        try {
          this.connections.server?.to(scopeRoom).emit("agent_event", event);
          this.connections.server?.to(threadRoom).emit("agent_event", event);
        } catch (err: any) {
          this.logger.warn(`emit failed for runId=${runId}: ${err?.message}`);
        }
        if (TERMINAL_RUN_STATUSES.has(status)) break;
      }
    } finally {
      this.active.delete(runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    const handle = this.active.get(runId);
    if (handle) {
      handle.cancelled = true;
      void handle.iter?.return?.().catch(() => undefined);
      this.active.delete(runId);
    }
    if (triggerSdk?.runs?.cancel) {
      try {
        await triggerSdk.runs.cancel(runId);
      } catch (err: any) {
        this.logger.warn(`runs.cancel failed for runId=${runId}: ${err?.message}`);
      }
    }
  }

  getActiveCount(): number {
    return this.active.size;
  }
}
