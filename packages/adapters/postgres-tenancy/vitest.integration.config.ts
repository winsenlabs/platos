// The real-PostgreSQL suites, and ONLY them.
//
// A second config rather than a flag on the default one, because the default
// config's job is to EXCLUDE these files and a run that has to remember to pass
// `--exclude ''` is a run somebody gets wrong. `pnpm test:postgres-tenancy:integration`
// points here; `pnpm test:v1-packages` uses vitest.config.ts and never starts a
// container.
//
// `fileParallelism` is off because each suite starts its own PostgreSQL
// container, and two at once on a laptop is how a suite becomes flaky for a
// reason that has nothing to do with the code under test.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
