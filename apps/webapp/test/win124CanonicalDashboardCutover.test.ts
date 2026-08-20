import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const canonicalDashboardFiles = [
  "app/presenters/v3/EnvironmentVariablesPresenter.server.ts",
  "app/presenters/v3/AlertChannelListPresenter.server.ts",
  "app/presenters/v3/ApiAlertChannelPresenter.server.ts",
  "app/services/platosEnvironmentVariables.server.ts",
  "app/v3/services/alerts/createAlertChannel.server.ts",
  "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route.tsx",
  "app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route.tsx",
  "app/routes/api.v1.projects.$projectRef.alertChannels.ts",
  "app/routes/api.v1.projects.$projectRef.envvars.$slug.ts",
  "app/routes/api.v1.projects.$projectRef.envvars.$slug.$name.ts",
  "app/routes/api.v1.projects.$projectRef.envvars.$slug.import.ts",
  "app/routes/api.v1.projects.$projectRef.envvars.ts",
  "app/models/vercelIntegration.server.ts",
  "app/v3/services/worker/workerGroupTokenService.server.ts",
  "app/v3/services/alerts/performTaskRunAlerts.server.ts",
  "app/v3/services/alerts/performDeploymentAlerts.server.ts",
  "app/v3/services/alerts/errorAlertEvaluator.server.ts",
  "app/v3/services/alerts/deliverErrorGroupAlert.server.ts",
  "app/v3/services/alerts/deliverCanonicalAlert.server.ts",
  "app/presenters/v3/ErrorAlertChannelPresenter.server.ts",
  "app/presenters/v3/LimitsPresenter.server.ts",
  "app/v3/alertsWorker.server.ts",
  "app/v3/commonWorker.server.ts",
  "app/services/worker.server.ts",
];

describe("WIN-124 canonical dashboard cutover", () => {
  it("keeps dashboard variable/channel persistence off legacy value, secret, and channel models", () => {
    for (const file of canonicalDashboardFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/@platos\/database[^\n]*(EnvironmentVariableValue|ProjectAlertChannel)/);
      expect(source, file).not.toMatch(/prisma\.(environmentVariableValue|secretReference|projectAlertChannel)/);
      expect(source, file).not.toMatch(/projectAlertChannel\.|valueReference|environmentTypes/);
      expect(source, file).not.toContain("EnvironmentVariablesRepository");
      expect(source, file).not.toContain("resolveVariablesForEnvironment");
    }
  });

  it("uses canonical authorization and stores for dashboard environment-variable routes", () => {
    for (const file of canonicalDashboardFiles.filter((path) => path.includes("environment-variables/route"))) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).toContain("requireCanonicalEnvironmentAuthorization");
      expect(source, file).not.toContain("EnvironmentVariablesRepository");
    }
  });

  it("removes the active legacy environment-variable and alert delivery repositories", () => {
    expect(
      existsSync(
        resolve(
          process.cwd(),
          "app/v3/environmentVariables/environmentVariablesRepository.server.ts"
        )
      )
    ).toBe(false);
    expect(
      existsSync(resolve(process.cwd(), "app/v3/services/alerts/deliverAlert.server.ts"))
    ).toBe(false);
  });

  it("requires explicit Environment targeting for project-scoped alert creation", () => {
    const schema = readFileSync(
      resolve(process.cwd(), "app/presenters/v3/ApiAlertChannelPresenter.server.ts"),
      "utf8"
    );
    const service = readFileSync(
      resolve(process.cwd(), "app/v3/services/alerts/createAlertChannel.server.ts"),
      "utf8"
    );
    expect(schema).toContain("environmentId: z.string().optional()");
    expect(service).toContain('"Environment target is required"');
    expect(service).toContain("id: environmentId");
    expect(service).not.toContain('orderBy: [{ slug: "asc" }]');
  });

  it("pins non-budget alert selection and delivery to the event Environment", () => {
    for (const file of [
      "app/v3/services/alerts/performTaskRunAlerts.server.ts",
      "app/v3/services/alerts/performDeploymentAlerts.server.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).toContain("environmentId,");
      expect(source, file).toContain("deletedAt: null");
      expect(source, file).toContain("enabled: true");
      expect(source, file).not.toContain("environmentTypes");
    }

    const evaluator = readFileSync(
      resolve(process.cwd(), "app/v3/services/alerts/errorAlertEvaluator.server.ts"),
      "utf8"
    );
    const delivery = readFileSync(
      resolve(process.cwd(), "app/v3/services/alerts/deliverErrorGroupAlert.server.ts"),
      "utf8"
    );
    expect(evaluator).toContain('alertTypes: { has: "ERROR_GROUP" }');
    expect(evaluator).toContain("channel.environment.id === env.id");
    expect(delivery).toContain("environmentId: canonicalEnvironmentId");
    expect(delivery).toContain('alertTypes: { has: "ERROR_GROUP" }');
  });

  it("validates canonical webhook destinations at creation and every dispatch", () => {
    const creation = readFileSync(
      resolve(process.cwd(), "app/v3/services/alerts/createAlertChannel.server.ts"),
      "utf8"
    );
    expect(creation).toContain("validatePublicUrl(options.channel.url)");
    expect(creation).toContain('"Webhook URL is not public"');

    for (const file of [
      "app/v3/services/alerts/deliverCanonicalAlert.server.ts",
      "app/v3/services/alerts/deliverErrorGroupAlert.server.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).toContain("fetchWithValidatedRedirects(");
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
