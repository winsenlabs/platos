import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("production auth build boundary", () => {
  test("does not register the token-minting TestModule in the production application graph", () => {
    const appModule = readFileSync(resolve(__dirname, "app.module.ts"), "utf8");
    expect(appModule).not.toContain('from "./test/test.module"');
    expect(appModule).not.toContain("imports.push(TestModule)");
  });

  test("strict builds remove the emitted test controller directory", () => {
    const guard = readFileSync(
      resolve(__dirname, "../scripts/enforce-production-auth-boundary.mjs"),
      "utf8"
    );
    expect(guard).toContain('rm(resolve("dist/test")');
    expect(guard).toContain('appModule.includes("test/test.module")');
  });
});
