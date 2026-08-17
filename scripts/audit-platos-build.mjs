#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures = [];
const checks = [];

function check(description, condition) {
  checks.push(description);
  if (!condition) failures.push(description);
}

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function walk(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return [relativePath];
  return readdirSync(absolutePath).flatMap((entry) => walk(join(relativePath, entry)));
}

const packageJson = JSON.parse(read("package.json"));
const agentPackage = JSON.parse(read("apps/agent/package.json"));
const databasePackage = JSON.parse(read("internal-packages/database/package.json"));
const webappPackage = JSON.parse(read("apps/webapp/package.json"));
const agentDockerfile = read("apps/agent/Dockerfile");
const webappDockerfile = read("apps/webapp/Dockerfile.platos");
const compose = read("docker-compose.platos.yml");
const retiredDatabaseName = ["tenancy", "database"].join("-");

check("root exposes build:platos", Boolean(packageJson.scripts?.["build:platos"]));
check("root exposes build:platos:agent", Boolean(packageJson.scripts?.["build:platos:agent"]));
check("root exposes build:platos:webapp", Boolean(packageJson.scripts?.["build:platos:webapp"]));
check(
  "agent build compiles the promoted clean database dependency",
  /--filter @platos\/database build/.test(packageJson.scripts?.["build:platos:agent"] ?? "")
);
check(
  "database deploy includes compiled, generated, migration, and guard entries",
  ["dist", "generated", "prisma", "scripts"].every((path) => databasePackage.files?.includes(path))
);
check("promoted package owns the canonical name", databasePackage.name === "@platos/database");
check(
  "temporary tenancy workspace package is absent",
  !existsSync(join(root, "internal-packages", retiredDatabaseName, "package.json"))
);
check(
  "agent has exactly one database workspace dependency",
  agentPackage.dependencies?.["@platos/database"] === "workspace:*" &&
    !Object.keys(agentPackage.dependencies ?? {}).some((name) => name.includes(retiredDatabaseName))
);
check(
  "webapp has exactly one database workspace dependency",
  webappPackage.dependencies?.["@platos/database"] === "workspace:*" &&
    !Object.keys(webappPackage.dependencies ?? {}).some((name) => name.includes(retiredDatabaseName))
);
check(
  "ordinary database migration runs the legacy-catalog guard first",
  /db:migrate:check.*prisma migrate deploy/.test(databasePackage.scripts?.["db:migrate:deploy"] ?? "")
);
check("agent exposes strict declaration build", /--declaration/.test(agentPackage.scripts?.["build:strict"] ?? ""));
check("webapp build is guarded by memory policy", /memory-policy\.mjs build/.test(webappPackage.scripts?.build ?? ""));
check("agent image uses explicit Platos build graph", /build:platos:agent/.test(agentDockerfile));
check("webapp image uses explicit Platos build graph", /build:platos:webapp/.test(webappDockerfile));
check(
  "webapp image generates the promoted database package",
  /--filter @platos\/database generate/.test(webappDockerfile)
);
check(
  "compose migrations use the guarded package entrypoint",
  /npm run db:migrate:deploy/.test(compose) && /\.\/internal-packages\/database:\/work/.test(compose)
);
const webappCompose = compose.split(/^  (?=\S)/m).find((service) => service.startsWith("webapp:")) ?? "";
check("webapp service receives the documented runtime heap variable", /WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB/.test(webappCompose));

for (const path of [
  "apps/agent/src/agent-runtime/turn-dispatch.service.ts",
  "apps/agent/src/trigger-bridge/runs-bridge.service.ts",
  "apps/agent/src/agent-runtime/agent.service.ts",
]) {
  const source = read(path);
  check(`${path} has no implicit Trigger Cloud endpoint`, !source.includes("https://api.trigger.dev"));
  check(`${path} has no implicit localhost/webapp Trigger endpoint`, !/http:\/\/(?:localhost|webapp):\d+/.test(source));
}
for (const path of [
  "apps/agent/src/agent-runtime/agent-task.service.ts",
  "apps/agent/src/agent-runtime/platos-tasks.controller.ts",
  "apps/agent/src/mcp-platform/tools/platos_tasks.ts",
  "apps/agent/src/skills/official/skill-handlers.ts",
]) {
  const source = read(path);
  check(`${path} does not gate SDK calls on the secret alone`, !source.includes("!!process.env.TRIGGER_SECRET_KEY"));
  check(`${path} uses the explicit external Trigger gate`, source.includes("configureExternalTriggerSdk"));
}

check(
  "local run-engine package is absent",
  !existsSync(join(root, "internal-packages/run-engine/package.json"))
);
check(
  "local schedule-engine package is absent",
  !existsSync(join(root, "internal-packages/schedule-engine/package.json"))
);
check(
  "local Trigger worker is absent",
  !existsSync(join(root, "apps/agent/src/trigger-worker.ts"))
);
check("local worker compose service is absent", !/^  worker:/m.test(compose));
const remixRoutes = walk("apps/webapp/app/routes");
check(
  "local engine routes are absent",
  !remixRoutes.some((path) => /(?:^|\/)engine\.v\d+\./.test(path))
);
check(
  "representative local Trigger routes are absent",
  [
    "apps/webapp/app/routes/api.v1.runs.ts",
    "apps/webapp/app/routes/api.v1.deployments.ts",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/route.tsx",
  ].every((path) => !existsSync(join(root, path)))
);
check(
  "local TaskRun realtime transport is absent",
  [
    "apps/webapp/app/services/realtimeClient.server.ts",
    "apps/webapp/app/services/realtimeClientGlobal.server.ts",
  ].every((path) => !existsSync(join(root, path)))
);
check(
  "local worker region surfaces are absent",
  [
    "apps/webapp/app/presenters/v3/RegionsPresenter.server.ts",
    "apps/webapp/app/v3/services/setDefaultRegion.server.ts",
  ].every((path) => !existsSync(join(root, path)))
);
check(
  "local waitpoint callback helper is absent",
  !existsSync(join(root, "apps/webapp/app/services/httpCallback.server.ts"))
);
check(
  "hosted GitHub deployment integration is absent",
  [
    "apps/webapp/app/routes/_app.github.install/route.tsx",
    "apps/webapp/app/routes/_app.github.callback/route.tsx",
    "apps/webapp/app/services/gitHub.server.ts",
    "apps/webapp/app/services/gitHubSession.server.ts",
    "apps/webapp/app/services/projectSettings.server.ts",
    "apps/webapp/app/services/projectSettingsPresenter.server.ts",
  ].every((path) => !existsSync(join(root, path))) &&
    !/\bGITHUB_APP_ENABLED\b/.test(read("apps/webapp/app/env.server.ts"))
);
check(
  "Platos-native custom task routes remain registered",
  [
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks._index/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.new/route.tsx",
    "apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.platos-tasks.$taskId/route.tsx",
  ].every((path) => existsSync(join(root, path)))
);
check(
  "webapp does not depend on local engine packages",
  !webappPackage.dependencies?.["@internal/run-engine"] &&
    !webappPackage.dependencies?.["@internal/schedule-engine"]
);

const forbiddenModeCSource = [
  "apps/agent/entrypoint.sh",
  "apps/agent/src/shared/env.ts",
  "apps/webapp/app/env.server.ts",
  "docker-compose.platos.yml",
  "docker-compose.deploy.yml",
]
  .filter((path) => existsSync(join(root, path)))
  .map(read)
  .join("\n");
check(
  "Mode-C worker configuration is absent",
  !/\b(?:WORKER_MODE|MANAGED_WORKER_SECRET|TRIGGER_WORKER_TOKEN|TRIGGER_BOOTSTRAP_[A-Z_]+)\b/.test(
    forbiddenModeCSource
  )
);

const cleanSchema = read("internal-packages/database/prisma/schema.prisma");
check(
  "clean schema has no Trigger-owned runtime models",
  !/^model\s+(?:RuntimeEnvironment|TaskRun\w*|BatchTaskRun\w*|Worker\w*|TaskSchedule\w*|TaskQueue|Waitpoint\w*|EnvironmentVariable\w*)\s*\{/m.test(
    cleanSchema
  )
);

console.log(`platos-build-audit: ${checks.length} checks`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
for (const description of checks) console.log(`  ok: ${description}`);
