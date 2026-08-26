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

const packageJson = JSON.parse(read("package.json"));
const agentPackage = JSON.parse(read("apps/agent/package.json"));
const agentBuildTsconfig = JSON.parse(read("apps/agent/tsconfig.build.json"));
const tenancyDatabasePackage = JSON.parse(read("internal-packages/tenancy-database/package.json"));
const webappPackage = JSON.parse(read("apps/webapp/package.json"));
const agentDockerfile = read("apps/agent/Dockerfile");
const webappDockerfile = read("apps/webapp/Dockerfile.platos");
const agentEntrypoint = read("apps/agent/entrypoint.sh");
const compose = read("docker-compose.platos.yml");

function sourceFiles(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute).flatMap((entry) => sourceFiles(join(path, entry)));
}

check("root exposes build:platos", Boolean(packageJson.scripts?.["build:platos"]));
check("root exposes build:platos:agent", Boolean(packageJson.scripts?.["build:platos:agent"]));
check("root exposes build:platos:webapp", Boolean(packageJson.scripts?.["build:platos:webapp"]));
check(
  "agent build compiles the clean tenancy database dependency",
  /--filter @platos\/tenancy-database build/.test(packageJson.scripts?.["build:platos:agent"] ?? "")
);
check(
  "agent build does not generate the legacy database client",
  !/--filter @platos\/database generate/.test(packageJson.scripts?.["build:platos:agent"] ?? "")
);
check(
  "agent package does not depend on the legacy database graph",
  !agentPackage.dependencies?.["@platos/database"] &&
    !agentPackage.dependencies?.["@prisma/client"] &&
    !agentPackage.dependencies?.["@platos/sdk"]
);
check(
  "agent build audits emitted production dependencies",
  /audit:production-dependencies/.test(packageJson.scripts?.["build:platos:agent"] ?? "") &&
    Boolean(agentPackage.scripts?.["audit:production-dependencies"])
);
check(
  "tenancy database deploy includes compiled and generated runtime entries",
  ["dist", "generated"].every((path) => tenancyDatabasePackage.files?.includes(path))
);
check(
  "agent exposes a production-only strict declaration build",
  /--project tsconfig\.build\.json/.test(agentPackage.scripts?.["build:strict"] ?? "") &&
    ["src/**/*.test.ts", "src/**/*.spec.ts"].every((pattern) => agentBuildTsconfig.exclude?.includes(pattern))
);
check("webapp build is guarded by memory policy", /memory-policy\.mjs build/.test(webappPackage.scripts?.build ?? ""));
check("agent has no legacy pricing package dependency", !agentPackage.dependencies?.["@internal/cost-rates"]);
check(
  "webapp has no legacy pricing package dependency",
  !webappPackage.dependencies?.["@internal/cost-rates"] &&
    !webappPackage.dependencies?.["@internal/llm-model-catalog"]
);
check("agent image uses explicit Platos build graph", /build:platos:agent/.test(agentDockerfile));
check("agent image does not copy the legacy database schema", !agentDockerfile.includes("internal-packages/database/prisma"));
check("agent entrypoint does not generate the legacy database client", !agentEntrypoint.includes("@platos/database"));
check("webapp image uses explicit Platos build graph", /build:platos:webapp/.test(webappDockerfile));
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
  "apps/agent/src/agent-runtime/jobs.controller.ts",
  "apps/agent/src/mcp-platform/tools/jobs.ts",
  "apps/agent/src/skills/official/skill-handlers.ts",
]) {
  const source = read(path);
  check(`${path} does not gate SDK calls on the secret alone`, !source.includes("!!process.env.TRIGGER_SECRET_KEY"));
  check(`${path} uses the explicit external Trigger gate`, source.includes("configureExternalTriggerSdk"));
}

// WIN-132 removes Platos-hosted Trigger execution while deliberately leaving
// the broader run-engine package in place for still-deferred dashboard
// consumers. Keep those two facts distinct so this audit catches either a
// reintroduced Mode-C surface or an accidental package deletion.
check("deferred run-engine package remains present", existsSync(join(root, "internal-packages/run-engine/package.json")));
check("local Trigger worker is absent", !existsSync(join(root, "apps/agent/src/trigger-worker.ts")));
check("local Trigger worker compose service is absent", !/^  worker:/m.test(compose));
check(
  "local Trigger engine routes are absent",
  !existsSync(join(root, "apps/webapp/app/routes/engine.v1.worker-actions.connect.ts"))
);

for (const path of [
  ...sourceFiles("apps/agent/src"),
  ...sourceFiles("apps/webapp/app"),
]) {
  if (!/\.(?:ts|tsx|mts)$/.test(path) || /\.(?:test|spec)\./.test(path)) continue;
  const source = read(path);
  check(`${path} has no legacy pricing package import`, !/@internal\/(?:cost-rates|llm-model-catalog)/.test(source));
  check(`${path} has no Redis model catalogue authority`, !source.includes("cost:model_catalog"));
  check(`${path} has no inherited pricing delegate`, !/\.(?:llmModel|llmPrice|llmPricingTier)\b/.test(source));
  check(`${path} has no agent-local verified prices`, !source.includes("verified-prices"));
}

console.log(`platos-build-audit: ${checks.length} checks`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
for (const description of checks) console.log(`  ok: ${description}`);
