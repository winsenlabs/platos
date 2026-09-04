// `vitest run` in this package runs the suites that need nothing but Node.
//
// The two `*.integration.test.ts` files start a PostgreSQL container, and the CI
// job that runs `pnpm test:v1-packages` has no Docker daemon — the same reason
// `differential-state-conservation` is its own job. They are run by
// `pnpm test:postgres-tenancy:integration`, which points vitest back at them.
//
// The exclusion is by FILENAME rather than by a skip inside the suite, so an
// integration suite can never silently pass by finding no daemon: when it runs,
// it runs, and when Docker is absent it fails.

import { defineConfig } from "vitest/config";

export const INTEGRATION_GLOB = "src/**/*.integration.test.ts";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**", INTEGRATION_GLOB],
  },
});
