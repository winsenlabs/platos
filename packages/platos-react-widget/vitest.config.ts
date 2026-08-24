import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
  },
  resolve: {
    alias: {
      "@platosdev/client": path.resolve(__dirname, "../platos-client/src/index.ts"),
    },
  },
});
