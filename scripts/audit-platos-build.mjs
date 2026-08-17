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

// WIN-132 owns the destructive mode-C extraction. These assertions prevent a
// "green" WIN-120 build from silently pretending the deferred closure is gone.
check("deferred run-engine package remains present", existsSync(join(root, "internal-packages/run-engine/package.json")));
check("deferred trigger worker remains present", existsSync(join(root, "apps/agent/src/trigger-worker.ts")));
check("deferred worker compose service remains present", /^  worker:/m.test(compose));
check("deferred engine routes remain present", existsSync(join(root, "apps/webapp/app/routes/engine.v1.worker-actions.connect.ts")));

console.log(`platos-build-audit: ${checks.length} checks`);
if (failures.length) {
  for (const failure of failures) console.error(`  FAIL: ${failure}`);
  process.exit(1);
}
for (const description of checks) console.log(`  ok: ${description}`);
