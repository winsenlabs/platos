import { defineConfig } from "@trigger.dev/sdk";
import { generatedWorkerExternalsMustResolve } from "./scripts/trigger-worker-externals";

/**
 * Deployment-only config for Platos registrations in an external Trigger
 * application (Trigger Cloud or a separately self-hosted Trigger service).
 *
 * The Trigger CLI loads this file from apps/agent. Normal agent startup and
 * unit tests do not import it. For local external-Trigger development:
 *   npx trigger.dev@latest dev
 *
 * Registration classification is documented in
 * `src/trigger-tasks/registration-manifest.ts`. Source discovery remains the
 * Trigger CLI's responsibility; this config does not route runtime dispatch.
 */
function requireTriggerProjectRef(): string {
  const projectRef = process.env.TRIGGER_PROJECT_REF?.trim();
  if (!projectRef) {
    throw new Error(
      "TRIGGER_PROJECT_REF is required to load the external Trigger deployment config; set it to the target proj_... reference."
    );
  }
  return projectRef;
}

export default defineConfig({
  project: requireTriggerProjectRef(),
  dirs: ["./src/trigger-tasks"],
  // Most Platos tasks are thin shells that call back into the agent, where
  // tenant state and credentials remain authoritative. A declaration can
  // override this default if it performs work in the external Trigger worker.
  machine: "micro",
  maxDuration: 600,
  build: {
    extensions: [generatedWorkerExternalsMustResolve()],
  },
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
