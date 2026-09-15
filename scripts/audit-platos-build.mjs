#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

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
const coreApiDockerfile = read("apps/core-api/Dockerfile");
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
check("root exposes build:platos:core-api", Boolean(packageJson.scripts?.["build:platos:core-api"]));
check(
  "build:platos includes the core-api graph",
  /(?:^|&&\s*)pnpm run build:platos:core-api(?:\s*&&|$)/.test(packageJson.scripts?.["build:platos"] ?? "")
);
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
check("core-api image uses explicit Platos build graph", /^RUN pnpm run build:platos:core-api$/m.test(coreApiDockerfile));
// The image-production milestone asks for non-root images. Read the LAST `USER`
// in the LAST stage: an earlier stage's account, or a `USER` that a later one
// resets, is not what the container runs as.
const coreApiRuntimeStage = coreApiDockerfile.slice(
  [...coreApiDockerfile.matchAll(/^FROM\s/gm)].at(-1)?.index ?? coreApiDockerfile.length
);
const coreApiRuntimeUser = [...coreApiRuntimeStage.matchAll(/^USER\s+(\S+)\s*$/gm)].at(-1)?.[1] ?? "";
check(
  "core-api image runs its final stage as a non-root account",
  coreApiRuntimeUser !== "" && !/^(?:root|0)(?::|$)/.test(coreApiRuntimeUser)
);

// ─── Deployability invariants the core-api image and its compose service state ───
// Each of these was previously a sentence in a comment that no gate read, and an
// independent verifier mutated every one of them with every check still green.
// They join to things this file does not write: the config schema's port
// default, the health controller's routes, the build-images candidate matrix,
// and a route table pinned from origin/v1.

/** Dockerfile instructions with continuation lines joined and comments dropped. */
function dockerInstructions(text) {
  const instructions = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*#/.test(line) || (current === "" && line.trim() === "")) continue;
    const continued = /\\\s*$/.test(line);
    current += `${current === "" ? "" : " "}${line.replace(/\\\s*$/, "").trim()}`;
    if (!continued) {
      instructions.push(current);
      current = "";
    }
  }
  if (current !== "") instructions.push(current);
  return instructions.map((instruction) => {
    const match = /^(\S+)\s*(.*)$/.exec(instruction);
    return { keyword: match[1].toUpperCase(), args: match[2], text: instruction };
  });
}

/** Variable names an ENV or ARG instruction declares. */
function declaredBuildVariables({ keyword, args }) {
  if (keyword === "ARG") return [args.split("=")[0].trim()];
  if (keyword !== "ENV") return [];
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(args)) return [args.split(/\s+/)[0]];
  return [...args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1]);
}

// A name shaped like a credential. A value baked under such a name is in a layer
// for anyone who pulls the image; credentials arrive at run time or through a
// secret mount, never through ENV or ARG.
const CREDENTIAL_SHAPED_NAME = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ENCRYPTION_KEY|SIGNING_KEY|ROOT_KEY/i;

const buildImagesWorkflow = parseYaml(read(".github/workflows/build-images.yml"));
const candidateDockerfiles = (buildImagesWorkflow.jobs?.["build-candidates"]?.strategy?.matrix?.include ?? [])
  .map((row) => row.dockerfile)
  .filter((path) => typeof path === "string");
check(
  "the build-images candidate matrix builds the core-api Dockerfile",
  candidateDockerfiles.includes("apps/core-api/Dockerfile")
);
for (const dockerfile of candidateDockerfiles) {
  const instructions = dockerInstructions(read(dockerfile));
  const stages = new Set();
  const unpinned = [];
  for (const { keyword, args } of instructions) {
    if (keyword !== "FROM") continue;
    const match = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args);
    const image = match?.[1] ?? args;
    if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image) && !stages.has(image.toLowerCase())) unpinned.push(image);
    if (match?.[2]) stages.add(match[2].toLowerCase());
  }
  check(`${dockerfile}: every FROM is digest-pinned or names an earlier stage`, unpinned.length === 0);
  const credentialNames = instructions.flatMap(declaredBuildVariables).filter((name) => CREDENTIAL_SHAPED_NAME.test(name));
  check(`${dockerfile}: no ENV or ARG declares a credential-shaped name`, credentialNames.length === 0);
}

const coreApiInstructions = dockerInstructions(coreApiDockerfile);
const coreApiDeployIndex = coreApiInstructions.findIndex(
  ({ text }) => text === "RUN pnpm --filter @platos/core-api deploy --prod --legacy /deploy"
);
const coreApiClosureIndex = coreApiInstructions.findIndex(
  ({ text }) =>
    text ===
    "RUN node scripts/deploy-bundle-closure.mjs prune --bundle /deploy && node scripts/deploy-bundle-closure.mjs check --bundle /deploy --importer apps/core-api"
);
const coreApiRuntimeFromIndex = coreApiInstructions.findLastIndex(({ keyword }) => keyword === "FROM");
check(
  "core-api image deploys production dependencies only, then prunes and proves the bundle against the lockfile before the runtime stage",
  coreApiDeployIndex >= 0 && coreApiClosureIndex > coreApiDeployIndex && coreApiRuntimeFromIndex > coreApiClosureIndex
);

const coreApiSchema = read("apps/core-api/src/config/schema.ts");
const coreApiPortDefault = /name:\s*"PLATOS_CORE_API_PORT",[\s\S]*?defaultValue:\s*"(\d+)"/.exec(coreApiSchema)?.[1] ?? null;
check(
  "core-api image exposes the config module's default port",
  coreApiPortDefault !== null &&
    coreApiInstructions.filter(({ keyword }) => keyword === "EXPOSE").map(({ args }) => args).join(" ") === coreApiPortDefault
);

const composeDocument = parseYaml(compose, { merge: true });
const coreApiService = composeDocument.services?.["core-api"] ?? {};
check("core-api compose service is opt-in behind exactly the core-api profile", JSON.stringify(coreApiService.profiles) === '["core-api"]');
const coreApiPorts = (coreApiService.ports ?? []).map(String);
const coreApiLoopback =
  coreApiPortDefault === null ? null : new RegExp(`^127\\.0\\.0\\.1:(\\d+):${coreApiPortDefault}$`).exec(coreApiPorts[0] ?? "");
check(
  "core-api publishes exactly one port, bound to host loopback, onto the config default port",
  coreApiPorts.length === 1 && coreApiLoopback !== null
);
const coreApiHostPort = coreApiLoopback?.[1] ?? null;
const healthController = read("apps/core-api/src/http/health.controller.ts");
const coreApiHealthcheck = [coreApiService.healthcheck?.test ?? []].flat().map(String).join(" ");
check(
  "core-api healthcheck probes liveness on the container port and never readiness",
  /@Get\("livez"\)/.test(healthController) &&
    coreApiPortDefault !== null &&
    coreApiHealthcheck.includes(`http://127.0.0.1:${coreApiPortDefault}/livez`) &&
    !coreApiHealthcheck.includes("readyz")
);
check(
  "core-api passes PLATOS_ENVIRONMENT through blank when unset: the process refuses it, the parse does not",
  coreApiService.environment?.PLATOS_ENVIRONMENT === "${PLATOS_ENVIRONMENT:-}"
);
check(
  "core-api, an opt-in profile service, makes no variable mandatory at parse time",
  !/\$\{[A-Za-z_][A-Za-z0-9_]*:?\?/.test(JSON.stringify(coreApiService))
);
check(
  "agent publishes its port on host loopback only",
  JSON.stringify((composeDocument.services?.agent?.ports ?? []).map(String)) === '["127.0.0.1:3100:3100"]'
);

/** Every reverse_proxy in a Caddyfile, with the host and handle block it sits in. */
function caddyRoutes(text) {
  const routes = [];
  const stack = [];
  for (const line of text.split("\n").map((raw) => raw.replace(/#.*$/, "").trim()).filter(Boolean)) {
    if (line === "}") {
      stack.pop();
      continue;
    }
    const opens = line.endsWith("{");
    const body = opens ? line.slice(0, -1).trim() : line;
    const [word, ...rest] = body.split(/\s+/);
    const top = stack.at(-1);
    if (top === undefined) {
      stack.push({ kind: "host", host: body });
      continue;
    }
    if (top.kind === "proxy") {
      top.route.options.push(body);
      if (opens) stack.push({ kind: "other" });
      continue;
    }
    const host = stack.find((frame) => frame.kind === "host")?.host ?? null;
    const handle = [...stack].reverse().find((frame) => frame.kind === "handle");
    if (word === "reverse_proxy") {
      const route = {
        host,
        directive: handle?.directive ?? null,
        matcher: handle?.matcher ?? null,
        upstream: rest.join(" "),
        options: [],
      };
      routes.push(route);
      if (opens) stack.push({ kind: "proxy", route });
    } else if (opens) {
      stack.push(word === "handle" || word === "handle_path" ? { kind: "handle", directive: word, matcher: rest.join(" ") || null } : { kind: "other" });
    }
  }
  return routes;
}

// The edge as origin/v1 (7fd2e4fb) routes it: eight reverse_proxy routes on the two
// host blocks that existed there, fingerprinted as the parsed table below rather
// than as bytes, so a comment can change and a retarget cannot. Pointing any of
// them at core-api IS the cutover, and that is a decision this file must not let
// through as an edit.
const V1_EDGE_HOSTS = Object.freeze(["test.platos.dev", "agent.test.platos.dev"]);
const V1_EDGE_ROUTE_COUNT = 8;
const V1_EDGE_ROUTES_SHA256 = "4e9b0c5fe5be7f0ffff4f1b1f4960a5060023e669d01796395e62d3fc4c0797f";
const CORE_API_EDGE_HOST = "core.test.platos.dev";
const edgeRoutes = caddyRoutes(read("deploy/Caddyfile"));
const v1EdgeRoutes = edgeRoutes.filter((route) => V1_EDGE_HOSTS.includes(route.host));
const v1EdgeFingerprint = createHash("sha256")
  .update(JSON.stringify(v1EdgeRoutes.map(({ host, directive, matcher, upstream, options }) => [host, directive, matcher, upstream, options])))
  .digest("hex");
check(
  `no existing edge route changes target (${V1_EDGE_ROUTE_COUNT} routes on ${V1_EDGE_HOSTS.join(", ")}, pinned from origin/v1)`,
  v1EdgeRoutes.length === V1_EDGE_ROUTE_COUNT && v1EdgeFingerprint === V1_EDGE_ROUTES_SHA256
);
if (v1EdgeFingerprint !== V1_EDGE_ROUTES_SHA256) {
  for (const route of v1EdgeRoutes) console.error(`  edge route now: ${JSON.stringify(route)}`);
}
check(
  "the edge has exactly the v1 host blocks plus core-api's own",
  JSON.stringify([...new Set(edgeRoutes.map((route) => route.host))].sort()) ===
    JSON.stringify([...V1_EDGE_HOSTS, CORE_API_EDGE_HOST].sort())
);
const coreApiEdgeRoutes = edgeRoutes.filter((route) => route.host === CORE_API_EDGE_HOST);
check(
  "core-api's edge host has one unmatched route to core-api's loopback host port",
  coreApiHostPort !== null &&
    coreApiEdgeRoutes.length === 1 &&
    coreApiEdgeRoutes[0].matcher === null &&
    coreApiEdgeRoutes[0].upstream === `localhost:${coreApiHostPort}`
);
check(
  "core-api's edge host strips Set-Cookie while core-api does not trust the proxy for the Secure-cookie decision",
  JSON.stringify(coreApiEdgeRoutes[0]?.options ?? []) === JSON.stringify(["header_down -Set-Cookie"]) &&
    /return request\.secure === true;/.test(read("apps/core-api/src/transports/rest/operator.ts"))
);
check(
  "no other edge route reaches core-api's host port",
  coreApiHostPort !== null &&
    edgeRoutes.filter((route) => route.host !== CORE_API_EDGE_HOST).every((route) => !route.upstream.endsWith(`:${coreApiHostPort}`))
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
