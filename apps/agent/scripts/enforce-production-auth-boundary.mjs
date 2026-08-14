import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const appModulePath = resolve("dist/app.module.js");
const appModule = await readFile(appModulePath, "utf8");

if (appModule.includes("test/test.module") || appModule.includes("TestModule")) {
  throw new Error("Production AppModule must not register the token-minting TestModule");
}

// TypeScript emits every source file. Remove the unregistered test harness as
// a second structural boundary so production images do not contain token-mint
// controller code that an accidental future dynamic import could activate.
await rm(resolve("dist/test"), { recursive: true, force: true });
