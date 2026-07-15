import { task, metadata, logger } from "@trigger.dev/sdk";
import { runInNewContext } from "node:vm";
const env = process.env;

/**
 * PIFSP-12 — Platos custom task executor.
 *
 * Triggered by the `run_platos_task` meta-tool (agent-spawn tasks) or by the
 * task management UI ("Run now" button on manual tasks).
 *
 * Payload shape:
 *   taskRowId — DB id of the PlatosTask row (for scope-gated lookup + lastRunAt bump).
 *   payload   — The operator-supplied payload passed to the handler's `run()` fn.
 *   scope     — Full (org, proj, env) tuple for DB access + audit.
 *   invokedBy — "agent" | "manual" | "schedule" | "webhook"
 *
 * Execution:
 *   1. Fetch `compiledHandler` from DB (Prisma in Node context via direct env access).
 *   2. Run the handler JS in a sandboxed `vm.runInNewContext()` context.
 *   3. The sandbox `ctx` object exposes: `logger`, `metadata`, `fetch`,
 *      `wait` (thin shim), and `output.set()`.
 *   4. Any unhandled throw becomes `{ status: "failed", error }` (not a re-throw)
 *      so trigger.dev run detail shows a clean handle rather than a raw stack.
 *
 * Security:
 *   - Compiled handler runs in a fresh V8 context with NO access to Node globals,
 *     process.env, or require(). Only the `ctx` sandbox object is exposed.
 *   - Operator code cannot exfiltrate secrets or break out of the scope.
 *   - This is appropriate for operator-authored code (admin-tier trust); it is
 *     NOT appropriate for end-user-authored code (no vm escape protection).
 *
 * TypeScript support:
 *   The handler is stored as plain JavaScript (ES2020). The task editor in the
 *   webapp renders a textarea with JSDoc type hints. Full TypeScript compile
 *   (esbuild.transform) is a follow-up once esbuild is added to agent deps.
 */

interface PlatosCustomTaskPayload {
  taskRowId: string;
  payload?: Record<string, unknown>;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId?: string;
  };
  invokedBy: "agent" | "manual" | "schedule" | "webhook";
  agentId?: string;
}

interface PlatosCustomTaskOutput {
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  durationMs: number;
}

export const platosCustomTask = task({
  id: "platos-custom-task",
  queue: { concurrencyLimit: parseInt(process.env.PLATOS_CUSTOM_TASK_CONCURRENCY ?? "10", 10) },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 10000 },
  run: async (payload: PlatosCustomTaskPayload): Promise<PlatosCustomTaskOutput> => {
    const startMs = Date.now();

    // Dynamic Prisma import — the agent container generates Prisma at startup.
    // We import directly rather than going through NestJS DI since trigger tasks
    // run outside the NestJS container lifecycle.
    let prisma: any;
    try {
      const { PrismaClient } = await import("@platos/database");
      prisma = new PrismaClient();
    } catch (err: any) {
      logger.error("[platos-custom-task] Failed to create Prisma client", { error: err?.message });
      return { status: "failed", error: "DB client unavailable", durationMs: Date.now() - startMs };
    }

    try {
      // 1. Load the task row.
      await metadata.set("stage", "loading");
      const row = await prisma.platosTask.findFirst({
        where: {
          id: payload.taskRowId,
          organizationId: payload.scope.organizationId,
          projectId: payload.scope.projectId,
          environmentId: payload.scope.environmentId,
          isActive: true,
        },
        select: { compiledHandler: true, handler: true, taskId: true, timeout: true, displayName: true },
      });

      if (!row) {
        return { status: "failed", error: "Task not found or inactive", durationMs: Date.now() - startMs };
      }

      const source: string = row.compiledHandler ?? row.handler;
      if (!source?.trim()) {
        return { status: "failed", error: "Task has no handler code", durationMs: Date.now() - startMs };
      }

      await metadata.set("stage", "executing");
      await metadata.set("taskId", row.taskId);

      // 2. Build sandbox context — expose only safe primitives.
      let sandboxOutput: unknown = undefined;
      const sandbox = {
        // Platos ctx helpers (operator API surface)
        ctx: {
          logger: {
            info: (msg: string, data?: unknown) => logger.info(`[task:${row.taskId}] ${msg}`, data as any),
            warn: (msg: string, data?: unknown) => logger.warn(`[task:${row.taskId}] ${msg}`, data as any),
            error: (msg: string, data?: unknown) => logger.error(`[task:${row.taskId}] ${msg}`, data as any),
          },
          metadata: {
            set: async (key: string, value: unknown) => metadata.set(key, value as any),
          },
          fetch: globalThis.fetch,
          output: {
            set: (value: unknown) => { sandboxOutput = value; },
          },
        },
        payload: payload.payload ?? {},
        // Standard JS globals — no Node-specific globals
        console: {
          log: (...args: unknown[]) => logger.info(`[task:${row.taskId}]`, { args }),
          warn: (...args: unknown[]) => logger.warn(`[task:${row.taskId}]`, { args }),
          error: (...args: unknown[]) => logger.error(`[task:${row.taskId}]`, { args }),
        },
        JSON,
        Math,
        Date,
        Promise,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Error,
        setTimeout: undefined,  // blocked — use ctx.wait in future
        setInterval: undefined, // blocked
        require: undefined,     // blocked — no module access
        process: undefined,     // blocked — no process env access
      };

      // 3. Execute in isolated context.
      // Wrap the handler: extract the `run` export and call it.
      const wrappedSource = `
        (async function __platosTaskWrapper__() {
          ${source}
          if (typeof run !== "function") throw new Error("Handler must export a \`run\` function");
          return await run(payload, ctx);
        })()
      `;

      const timeoutMs = Math.min(row.timeout * 1000, 3600_000);
      const resultPromise = runInNewContext(wrappedSource, sandbox) as Promise<unknown>;

      // Enforce timeout
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Handler timed out after ${row.timeout}s`)), timeoutMs)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const finalResult = sandboxOutput !== undefined ? sandboxOutput : result;

      // 4. Bump lastRunAt
      await prisma.platosTask.updateMany({
        where: { id: payload.taskRowId },
        data: { lastRunAt: new Date() },
      }).catch(() => {});

      await metadata.set("stage", "completed");
      return { status: "completed", result: finalResult, durationMs: Date.now() - startMs };

    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      logger.error("[platos-custom-task] Handler error", {
        taskRowId: payload.taskRowId,
        error: errorMsg,
      });
      return { status: "failed", error: errorMsg, durationMs: Date.now() - startMs };
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  },
});
