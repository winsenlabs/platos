import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for `@platosdev/client`. TEST-ONLY: nothing here reaches `dist/`.
 *
 * `tests/v1-stream.test.ts` joins the resume fixture to core-api's own SSE
 * encoders, and `apps/core-api/src/transports/ws/sse.ts` imports
 * `@platos/kernel`, whose package entry is its BUILT `dist/index.js`. Without
 * this alias the suite failed to load on a cold checkout ("Failed to resolve
 * entry for package @platos/kernel") and passed only where `build:v1` had run
 * first. The kernel is resolved from its source instead — the same source the
 * suite already imports for `admitFrame` and `encodeStreamCursor`, so the
 * encoders and the rules they are compared with are one module, not a build and
 * a checkout that could differ.
 *
 * Only the bare specifier is aliased; the test include globs stay Vitest's
 * defaults (`tests/` and `src/__tests__/`).
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@platos\/kernel$/u,
        replacement: fileURLToPath(new URL("../kernel/src/index.ts", import.meta.url)),
      },
    ],
  },
});
