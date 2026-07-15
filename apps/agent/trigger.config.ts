import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev config for the Platos agent tasks.
 *
 * To run these tasks durably, start a trigger dev worker from this directory:
 *   pnpm --filter trigger.dev build && \
 *     node ../../packages/cli-v3/dist/esm/index.js dev
 *
 * Or once the CLI is installed globally:
 *   trigger.dev dev
 *
 * The worker will register the tasks in `src/trigger-tasks/` with the
 * webapp's run engine, and future `tasks.trigger("platos-agent-tool-block", ...)`
 * calls will actually dispatch runs.
 *
 * Without a running dev worker, `spawn_bgo` (alias: `spawn_task`) gracefully
 * falls back to the Redis stub (the meta-tool still returns a sensible
 * response to the LLM).
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || "proj_hovobxjmqdvnduupguwa",
  dirs: ["./src/trigger-tasks"],
  maxDuration: 600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30000,
      randomize: true,
    },
  },
});
