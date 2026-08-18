#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
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
const tenancyDatabasePackage = JSON.parse(read("internal-packages/tenancy-database/package.json"));
const webappPackage = JSON.parse(read("apps/webapp/package.json"));
const agentDockerfile = read("apps/agent/Dockerfile");
const webappDockerfile = read("apps/webapp/Dockerfile.platos");
const compose = read("docker-compose.platos.yml");

check("root exposes build:platos", Boolean(packageJson.scripts?.["build:platos"]));
check("root exposes build:platos:agent", Boolean(packageJson.scripts?.["build:platos:agent"]));
check("root exposes build:platos:webapp", Boolean(packageJson.scripts?.["build:platos:webapp"]));
check(
  "agent build compiles the clean tenancy database dependency",
  /--filter @platos\/tenancy-database build/.test(packageJson.scripts?.["build:platos:agent"] ?? "")
);
check(
  "tenancy database deploy includes compiled and generated runtime entries",
  ["dist", "generated"].every((path) => tenancyDatabasePackage.files?.includes(path))
);
check("agent exposes strict declaration build", /--declaration/.test(agentPackage.scripts?.["build:strict"] ?? ""));
check("webapp build is guarded by memory policy", /memory-policy\.mjs build/.test(webappPackage.scripts?.build ?? ""));
check("agent image uses explicit Platos build graph", /build:platos:agent/.test(agentDockerfile));
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
  "apps/agent/src/agent-runtime/platos-tasks.controller.ts",
  "apps/agent/src/mcp-platform/tools/platos_tasks.ts",
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

console.log(`platos-build-audit: ${checks.length} checks`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
for (const description of checks) console.log(`  ok: ${description}`);
