import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webappRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appRoot = join(webappRoot, "app");

const deletedDestinationBuilders = [
  "selectPlanPath",
  "organizationBillingPath",
  "organizationVercelIntegrationPath",
  "organizationSlackIntegrationPath",
  "githubAppInstallPath",
  "vercelAppInstallPath",
  "vercelCallbackPath",
  "vercelResourcePath",
  "v3TasksStreamingPath",
  "v3TestPath",
  "v3TestTaskPath",
  "v3CustomDashboardPath",
  "v3BuiltInDashboardPath",
  "v3RunsPath",
  "v3CreateBulkActionPath",
  "v3RunPath",
  "v3RunRedirectPath",
  "v3RunPathFromFriendlyId",
  "v3RunDownloadLogsPath",
  "v3RunSpanPath",
  "v3RunStreamingPath",
  "v3RunIdempotencyKeyResetPath",
  "v3BatchRunsPath",
  "v3DeploymentsPath",
  "v3DeploymentPath",
  "v3DeploymentVersionPath",
  "branchesPath",
  "concurrencyPath",
  "limitsPath",
  "regionsPath",
  "v3BillingPath",
  "v3BillingAlertsPath",
  "v3PrivateConnectionsPath",
  "v3NewPrivateConnectionPath",
  "v3StripePortalPath",
  "v3UsagePath",
] as const;

const deletedDestinationLiterals = [
  ["select plan", /["'`]\/orgs\/[^"'`]+\/select-plan(?:[?"'`/]|$)/],
  ["organization billing", /["'`]\/orgs\/[^"'`]+\/(?:billing|settings\/billing)(?:[?"'`/]|$)/],
  ["billing alerts", /["'`]\/orgs\/[^"'`]+\/settings\/billing-alerts(?:[?"'`/]|$)/],
  ["organization usage", /["'`]\/orgs\/[^"'`]+\/(?:usage|settings\/usage)(?:[?"'`/]|$)/],
  ["private connections", /["'`]\/orgs\/[^"'`]+\/settings\/private-connections(?:[?"'`/]|$)/],
  [
    "organization Trigger integration",
    /["'`]\/orgs\/[^"'`]+\/settings\/integrations\/(?:slack|vercel)(?:[?"'`/]|$)/,
  ],
  ["GitHub install callback", /["'`]\/github\/(?:install|callback)(?:[?"'`/]|$)/],
  [
    "Vercel integration flow",
    /["'`]\/vercel\/(?:install|callback|connect|configure|onboarding)(?:[?"'`/]|$)/,
  ],
  ["top-level run detail", /["'`]\/runs(?:[/?"'`]|$)/],
  ["legacy project run detail", /["'`]\/projects\/v3\/[^"'`]+\/runs(?:[/?"'`]|$)/],
  [
    "Trigger dashboard",
    /["'`]\/orgs\/[^"'`]+\/projects\/[^"'`]+\/env\/[^"'`]+\/dashboards(?:[/?"'`]|$)/,
  ],
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function sourceMatches(pattern: RegExp | string, ignoredPaths: string[] = []) {
  return sourceFiles(appRoot).flatMap((path) => {
    const sourcePath = relative(webappRoot, path);
    if (ignoredPaths.includes(sourcePath)) return [];

    const source = readFileSync(path, "utf8");
    const matches = typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
    return matches ? [sourcePath] : [];
  });
}

describe("deleted Trigger dashboard destinations", () => {
  it.each(deletedDestinationBuilders)("has no surviving %s builder or caller", (builder) => {
    expect(sourceMatches(builder), `${builder} still appears in active source`).toEqual([]);
  });

  it.each(deletedDestinationLiterals)("has no generated %s URL", (label, pattern) => {
    expect(
      sourceMatches(pattern, ["app/services/realtime/s2realtimeStreams.server.ts"]),
      `${label} destination still appears in active source`
    ).toEqual([]);
  });

  it("keeps retained MCP management directly discoverable", () => {
    const sideMenu = readFileSync(join(appRoot, "components/navigation/SideMenu.tsx"), "utf8");
    const integrationsLayout = readFileSync(
      join(
        appRoot,
        "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations/route.tsx"
      ),
      "utf8"
    );

    expect(sideMenu).toContain('name="Integrations"');
    expect(sideMenu).toContain("to={v3ProjectSettingsIntegrationsMcpPath(");
    expect(integrationsLayout).toContain("return redirect(`${mcpPath}${url.search}`)");
  });
});
