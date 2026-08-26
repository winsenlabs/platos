import { defineConfig } from "@playwright/test";
import { browserVisualProjects } from "./visual-projects";

const baseURL = process.env.WIN235_WEBAPP_URL;
if (!baseURL) throw new Error("WIN235_WEBAPP_URL is required for authenticated browser evidence");

export default defineConfig({
  testDir: __dirname,
  testMatch: "browser-evidence.spec.ts",
  outputDir:
    process.env.WIN234_PLAYWRIGHT_OUTPUT_DIR ?? "artifacts/win234-browser/playwright-output",
  globalSetup: require.resolve("./global-setup"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["line"]],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    screenshot: "off",
    trace: "off",
    video: "off",
    serviceWorkers: "block",
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
  },
  projects: browserVisualProjects(),
});
