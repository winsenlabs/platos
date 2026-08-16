import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev config for the Platos agent tasks.
 *
 * Trigger is a separate external application used by Platos. For local
 * development, run its supported CLI from this directory:
 *   npx trigger.dev@latest dev
 *
 * The worker registers the tasks in `src/trigger-tasks/` with external
 * Trigger/Trigger Cloud, and `tasks.trigger("platos-agent-tool-block", ...)`
 * dispatches runs through that external service.
 *
 * Without a running dev worker, `spawn_bgo` (alias: `spawn_task`) gracefully
 * falls back to the Redis stub (the meta-tool still returns a sensible
 * response to the LLM).
 */
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || "proj_hovobxjmqdvnduupguwa",
  dirs: ["./src/trigger-tasks"],
  // Every task is a thin shell — it POSTs to the agent and waits; the real work
  // (turns, DLQ drain, …) runs on the agent, not the task machine. `micro` is the
  // right size. (A task can override if it ever runs work in-worker.)
  machine: "micro",
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
