import { defineConfig } from "vitest/config";

/**
 * Vitest config for `@platools/sdk`.
 *
 * - `include` targets the repo's `tests/` directory, which is kept
 *   out of the shipped `dist/` by `tsconfig.json`.
 * - `environment: "node"` because the SDK is a Node backend library
 *   (the WebSocket transport uses `ws`, which is Node-only).
 * - Coverage is intentionally left to a separate CI job so the
 *   default `vitest run` stays fast.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
  },
});
