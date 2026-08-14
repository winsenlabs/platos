import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("production auth build boundary", () => {
  test("excludes the development token-minting Remix route from production builds", () => {
    const output = execFileSync(
      process.execPath,
      ["-e", "console.log(JSON.stringify(require('./remix.config.js').ignoredRouteFiles))"],
      {
        cwd: resolve(__dirname, ".."),
        env: { ...process.env, PLATOS_PRODUCTION_BUILD: "true" },
        encoding: "utf8",
      }
    );

    expect(JSON.parse(output)).toContain("**/*.agent-connect.mint-token.ts");
  });

  test("keeps the route available to an explicit non-production development build", () => {
    const output = execFileSync(
      process.execPath,
      ["-e", "console.log(JSON.stringify(require('./remix.config.js').ignoredRouteFiles))"],
      {
        cwd: resolve(__dirname, ".."),
        env: { ...process.env, PLATOS_PRODUCTION_BUILD: "false" },
        encoding: "utf8",
      }
    );

    expect(JSON.parse(output)).not.toContain("**/*.agent-connect.mint-token.ts");
  });
});
