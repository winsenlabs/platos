#!/usr/bin/env node
// SERVE THE EXACT CORE-API CANDIDATE, AND READ BACK WHAT IT SAYS.
//
// build-images.yml builds, verifies and loads the core-api candidate, and until
// this script nothing ever started it. An independent verifier showed what that
// let through: an image whose listener was bound to loopback, or whose CMD named
// a file that does not exist, passed every static gate, and the first of them
// even reported healthy to its own loopback healthcheck. The only test that can
// tell a serving image from one that cannot serve is to serve it.
//
// So this starts the loaded candidate, unmodified, the way compose runs it:
//   * PostgreSQL and Redis from the SAME digests docker-compose.platos.yml pins,
//     on a private network, reached by service name;
//   * the migrations candidate's two PostgreSQL jobs, with the commands the
//     compose file gives them, run to completion first;
//   * core-api with the environment names its compose service passes and fresh
//     throwaway secrets, and NO PLATOS_CORE_API_HOST: the image's own ENV must
//     make it reachable;
// and then asserts, through the PUBLISHED PORT on the host:
//   * /livez answers 200 (a loopback-bound listener cannot);
//   * the public /readyz body carries no binding inventory;
//   * the bearer /readyz detail names exactly the bindings of the ADR adapter
//     table (scripts/arch/gen-v1-skeleton.mjs), every unsatisfied one belongs to
//     an adapter the process itself reports as unimplemented, and the contexts a
//     fully configured install composes are composed;
//   * the operator session route, taken from the generated operation manifest,
//     refuses a random bearer with 401: the request reached the store-backed
//     authentication path and was answered, rather than failing on a store;
//   * compose's own healthcheck command passes inside the container;
//   * the process runs as a non-root account, ships LICENSE and NOTICE byte-equal
//     to this checkout, prints none of its secrets, and drains to exit 0 on stop.
//
// Inputs: WIN235_CORE_API_RUNTIME_IMAGE and WIN235_MIGRATIONS_RUNTIME_IMAGE (what
// prepare-candidate-images.sh exports after verifying and loading the archives).
// Optional: CORE_API_SMOKE_PREFIX names every container and the network;
// CORE_API_SMOKE_ARTIFACT_DIR receives the non-secret evidence.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adapterBindings } from "../../scripts/arch/gen-v1-skeleton.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const COMPOSE_FILE = "docker-compose.platos.yml";
export const OPERATION_MANIFEST = "apps/agent/src/control-plane/operation-manifest.generated.json";
export const IDENTITY_SESSION_SOURCE = "apps/core-api/src/transports/rest/identity-session.controller.ts";

/**
 * The contexts a fully configured install composes, measured at the head that
 * introduced this smoke (readback 55 of 60, five contexts). A SUBSET check: a
 * context that starts composing later passes, one that stops composing fails.
 */
export const CONTEXTS_COMPOSED_WHEN_FULLY_CONFIGURED = Object.freeze([
  "identityAccess",
  "tenancy",
  "secrets",
  "providers",
  "tools",
]);

// ─── Pure readers over committed files ───

/** One top-level service's block of a compose file, as text. Throws when absent. */
export function composeServiceBlock(composeText, service) {
  const lines = composeText.split("\n");
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) throw new Error(`${COMPOSE_FILE} has no service named ${service}`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

/** A service's digest-pinned image. Throws unless the reference is `name@sha256:<64 hex>`. */
export function composeServiceImage(composeText, service) {
  const image = /^ {4}image: (\S+)$/m.exec(composeServiceBlock(composeText, service))?.[1];
  if (!image || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(`${COMPOSE_FILE} service ${service} has no digest-pinned image`);
  }
  return image;
}

/** A service's single-word exec-form command, e.g. `command: ["postgres"]`. */
export function composeServiceCommand(composeText, service) {
  const command = /^ {4}command: \["([^"\s]+)"\]$/m.exec(composeServiceBlock(composeText, service))?.[1];
  if (!command) throw new Error(`${COMPOSE_FILE} service ${service} has no single-word command`);
  return command;
}

/** The variable names a service's environment block passes. */
export function composeServiceEnvironmentNames(composeText, service) {
  const block = composeServiceBlock(composeText, service);
  const environment = /^ {4}environment:\n((?: {6}.*\n?| *#.*\n?|\s*\n)+)/m.exec(`${block}\n`)?.[1] ?? "";
  return [...environment.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]);
}

/** A `${NAME:-default}` default a service's environment gives one variable. */
export function composeEnvironmentDefault(composeText, service, variable) {
  const line = new RegExp(`^ {6}${variable}: "\\$\\{[A-Z0-9_]+:-([^}]*)\\}"$`, "m").exec(
    composeServiceBlock(composeText, service)
  );
  if (!line) throw new Error(`${COMPOSE_FILE} service ${service} gives ${variable} no default`);
  return line[1];
}

/** The `node -e` program of a service's CMD healthcheck. */
export function composeHealthcheckProgram(composeText, service) {
  const block = composeServiceBlock(composeText, service);
  const program = /^ {10}"-e",\n {10}"(.*)",$/m.exec(block)?.[1];
  if (!program) throw new Error(`${COMPOSE_FILE} service ${service} has no node -e healthcheck`);
  return program;
}

/** The wire path of the operator session read, from the generated manifest. */
export function identitySessionPath(manifest) {
  const matches = (manifest?.inventories?.restOperations ?? []).filter(
    (operation) =>
      operation.method === "GET" &&
      (operation.implementations ?? []).some(
        (implementation) => implementation.source === IDENTITY_SESSION_SOURCE && implementation.handler === "session"
      )
  );
  if (matches.length !== 1 || typeof matches[0].path !== "string" || !matches[0].path.startsWith("/")) {
    throw new Error(`${OPERATION_MANIFEST} must name exactly one GET operation served by ${IDENTITY_SESSION_SOURCE}#session`);
  }
  return matches[0].path;
}

/**
 * Every refusal the detailed readiness body earns, as distinct messages; an empty
 * list is a pass. `bindings` is the ADR table as `{ adapter, port }` rows.
 */
export function readinessViolations(body, bindings, requiredContexts = CONTEXTS_COMPOSED_WHEN_FULLY_CONFIGURED) {
  const violations = [];
  const detail = body?.detail;
  if (body?.phase !== "serving") violations.push(`phase is ${JSON.stringify(body?.phase)}, not "serving"`);
  if (detail === null || typeof detail !== "object") return [...violations, "the bearer body carries no detail"];
  const declared = bindings.map(({ adapter, port }) => `${adapter}:${port}`);
  const satisfied = Array.isArray(detail.satisfiedBindings) ? detail.satisfiedBindings : [];
  const unsatisfied = Array.isArray(detail.unsatisfiedBindings) ? detail.unsatisfiedBindings : [];
  if (detail.declaredBindings !== declared.length) {
    violations.push(`declaredBindings is ${detail.declaredBindings}; the ADR adapter table declares ${declared.length}`);
  }
  const reported = [...satisfied, ...unsatisfied];
  if (new Set(reported).size !== reported.length) violations.push("a binding is reported more than once");
  const missing = declared.filter((binding) => !reported.includes(binding));
  const extra = reported.filter((binding) => !declared.includes(binding));
  if (missing.length > 0 || extra.length > 0) {
    violations.push(`reported bindings differ from the ADR adapter table (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"})`);
  }
  const unwired = Array.isArray(detail.unwiredAdapters) ? detail.unwiredAdapters : [];
  const notImplementation = unwired.filter((row) => row?.cause !== "implementation").map((row) => row?.adapter);
  if (notImplementation.length > 0) {
    violations.push(`adapters unwired for a reason configuration could fix: ${notImplementation.join(", ")}`);
  }
  const unimplemented = new Set(unwired.filter((row) => row?.cause === "implementation").map((row) => row.adapter));
  const unexplained = unsatisfied.filter((binding) => !unimplemented.has(binding.split(":")[0]));
  if (unexplained.length > 0) {
    violations.push(`unsatisfied bindings on adapters the process does not report unimplemented: ${unexplained.join(", ")}`);
  }
  const wronglySatisfied = satisfied.filter((binding) => unimplemented.has(binding.split(":")[0]));
  if (wronglySatisfied.length > 0) {
    violations.push(`satisfied bindings on adapters reported unimplemented: ${wronglySatisfied.join(", ")}`);
  }
  const contexts = Array.isArray(detail.composedContexts) ? detail.composedContexts : [];
  const absent = requiredContexts.filter((context) => !contexts.includes(context));
  if (absent.length > 0) violations.push(`contexts not composed: ${absent.join(", ")}`);
  return violations;
}

/** The environment core-api is started with. Every name is one its compose service passes. */
export function coreApiEnvironment({ postgresUrl, redisUrl, defaultModel, secrets }) {
  return {
    PLATOS_ENVIRONMENT: "production",
    PLATOS_STORE_POSTGRES_URL: postgresUrl,
    PLATOS_STORE_REDIS_URL: redisUrl,
    PLATOS_PROVIDERS_DEFAULT_MODEL: defaultModel,
    PLATOS_SECURITY_SESSION_SECRET: secrets.sessionSecret,
    // Blank, exactly as compose passes the three cookie settings and the trusted
    // proxy when .env leaves them unset: the defaults (a Secure __Host- cookie set
    // only over TLS, no proxy believed) are what the candidate is smoked with.
    PLATOS_SECURITY_SESSION_COOKIE_SECURE: "",
    PLATOS_SECURITY_SESSION_COOKIE_NAME: "",
    PLATOS_SECURITY_SESSION_SAME_SITE: "",
    PLATOS_SECURITY_ENCRYPTION_KEY: secrets.encryptionKey,
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
    PLATOS_CORE_API_TRUSTED_PROXY: "",
    PLATOS_CHANNELS_SLACK_SIGNING_SECRET: secrets.slackSigningSecret,
    // EVERY CHANNEL GROUP IS DECLARED, and not because the smoke exercises them.
    // `readinessViolations` refuses an adapter unwired for a reason CONFIGURATION
    // could fix, so a group left undeclared here fails the smoke the moment its
    // directory stops being a generated interface. `channel-discord` arrived with a
    // constructor; `notifier-email` gained one with the magic-link delivery port.
    PLATOS_CHANNELS_DISCORD_PUBLIC_KEY: secrets.discordPublicKey,
    PLATOS_CHANNELS_EMAIL_SMTP_URL: secrets.emailSmtpUrl,
    PLATOS_CHANNELS_EMAIL_FROM: secrets.emailFrom,
    PLATOS_CHANNELS_EMAIL_LOGIN_URL: secrets.emailLoginUrl,
    PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: secrets.adminHealthToken,
  };
}

// ─── The run ───

function docker(args, { allowFailure = false, input } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result;
}

function envArguments(environment) {
  return Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description, tries, probe) {
  for (let round = 1; round <= tries; round += 1) {
    if (await probe()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function httpGet(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

function sha256File(relativePath) {
  return createHash("sha256").update(readFileSync(path.join(repositoryRoot, relativePath))).digest("hex");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: the loaded, verified candidate reference`);
  return value;
}

async function main() {
  const coreApiImage = requireEnv("WIN235_CORE_API_RUNTIME_IMAGE");
  const migrationsImage = requireEnv("WIN235_MIGRATIONS_RUNTIME_IMAGE");
  const prefix = process.env.CORE_API_SMOKE_PREFIX || `platos-core-api-smoke-${process.pid}`;
  const artifactDirectory = process.env.CORE_API_SMOKE_ARTIFACT_DIR || null;
  if (artifactDirectory) mkdirSync(artifactDirectory, { recursive: true });
  const record = (name, contents) => {
    if (artifactDirectory) writeFileSync(path.join(artifactDirectory, name), contents);
  };

  const compose = readFileSync(path.join(repositoryRoot, COMPOSE_FILE), "utf8");
  const postgresImage = composeServiceImage(compose, "postgres");
  const redisImage = composeServiceImage(compose, "redis");
  const migrateCommand = composeServiceCommand(compose, "migrations-init");
  const memoryProfileCommand = composeServiceCommand(compose, "memory-profile-migrate");
  const defaultModel = composeEnvironmentDefault(compose, "core-api", "PLATOS_PROVIDERS_DEFAULT_MODEL");
  const healthcheckProgram = composeHealthcheckProgram(compose, "core-api");
  const sessionPath = identitySessionPath(JSON.parse(readFileSync(path.join(repositoryRoot, OPERATION_MANIFEST), "utf8")));
  const bindings = adapterBindings();

  const exposed = Object.keys(
    JSON.parse(docker(["image", "inspect", "--format", "{{json .Config.ExposedPorts}}", coreApiImage]).stdout.trim()) ?? {}
  );
  if (exposed.length !== 1 || !/^\d+\/tcp$/.test(exposed[0])) {
    throw new Error(`the core-api candidate must expose exactly one TCP port; it exposes ${JSON.stringify(exposed)}`);
  }
  const containerPort = exposed[0].split("/")[0];

  const secrets = {
    postgresPassword: randomBytes(24).toString("hex"),
    sessionSecret: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("hex"),
    slackSigningSecret: randomBytes(32).toString("hex"),
    // 64 hex digits, which is the grammar the config field states. Constructing the
    // Discord adapter never touches it — the key travels per delivery — so a random
    // one is as good as a real point here, and a real one would be a credential in
    // the source of a smoke that needs none.
    discordPublicKey: randomBytes(32).toString("hex"),
    // The relay is never dialled: constructing `notifier-email` opens no socket, and
    // this smoke sends nothing. The address is unroutable on purpose.
    emailSmtpUrl: "smtp://127.0.0.1:1",
    emailFrom: "smoke@platos.invalid",
    emailLoginUrl: "https://smoke.platos.invalid/magic",
    adminHealthToken: randomBytes(32).toString("hex"),
    messageEncryptionKey: randomBytes(32).toString("hex"),
  };
  const network = `${prefix}-net`;
  const names = { postgres: `${prefix}-postgres`, redis: `${prefix}-redis`, coreApi: `${prefix}-core-api` };
  const databaseUrl = `postgresql://postgres:${secrets.postgresPassword}@${names.postgres}:5432/platos_control`;
  const environment = coreApiEnvironment({
    postgresUrl: databaseUrl,
    redisUrl: `redis://${names.redis}:6379`,
    defaultModel,
    secrets,
  });

  const cleanup = () => {
    docker(["rm", "--force", "--volumes", names.coreApi, names.redis, names.postgres], { allowFailure: true });
    docker(["network", "rm", network], { allowFailure: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanup();
      process.exit(1);
    });
  }

  try {
    docker(["network", "create", network]);
    docker(["run", "--detach", "--name", names.postgres, "--network", network, "--tmpfs", "/var/lib/postgresql/data",
      "--env", "POSTGRES_USER=postgres", "--env", `POSTGRES_PASSWORD=${secrets.postgresPassword}`,
      "--env", "POSTGRES_DB=platos_control", postgresImage, "-c", "wal_level=logical"]);
    docker(["run", "--detach", "--name", names.redis, "--network", network, redisImage]);
    await waitFor("PostgreSQL", 90, () =>
      docker(["exec", names.postgres, "pg_isready", "-U", "postgres", "-d", "platos_control"], { allowFailure: true }).status === 0 &&
      docker(["exec", names.postgres, "psql", "-U", "postgres", "-d", "platos_control", "-c", "SELECT 1"], { allowFailure: true }).status === 0
    );
    await waitFor("Redis", 60, () => docker(["exec", names.redis, "redis-cli", "ping"], { allowFailure: true }).stdout.trim() === "PONG");

    const migrationUrl = `${databaseUrl}?schema=public&sslmode=disable`;
    for (const [command, extra] of [
      [migrateCommand, {}],
      [memoryProfileCommand, { PLATOS_MESSAGE_ENCRYPTION_KEY: secrets.messageEncryptionKey, PLATOS_MESSAGE_ENCRYPTION_KEY_V: "1" }],
    ]) {
      const run = docker(["run", "--rm", "--network", network,
        ...envArguments({ DATABASE_URL: migrationUrl, DIRECT_URL: migrationUrl, ...extra }), migrationsImage, command],
      { allowFailure: true });
      record(`migrations-${command}.log`, `${run.stdout}${run.stderr}`);
      if (run.status !== 0) throw new Error(`migrations candidate \`${command}\` exited ${run.status}:\n${run.stdout}${run.stderr}`);
      console.log(`migrations candidate \`${command}\`: exit 0`);
    }

    docker(["run", "--detach", "--name", names.coreApi, "--network", network,
      "--publish", `127.0.0.1::${containerPort}`, ...envArguments(environment), coreApiImage]);
    const hostPort = /:(\d+)\s*$/m.exec(docker(["port", names.coreApi, `${containerPort}/tcp`]).stdout)?.[1];
    if (!hostPort) throw new Error("core-api published no host port");
    const base = `http://127.0.0.1:${hostPort}`;

    let livez = null;
    await waitFor("core-api /livez through the published port", 90, async () => {
      const state = docker(["inspect", "--format", "{{.State.Running}}", names.coreApi]).stdout.trim();
      if (state !== "true") throw new Error("the core-api container stopped before it served");
      try {
        livez = await httpGet(`${base}/livez`);
        return livez.status === 200;
      } catch {
        return false;
      }
    });
    if (livez.json?.status !== "alive") throw new Error(`/livez answered ${livez.text}`);
    console.log(`GET /livez through 127.0.0.1:${hostPort} -> ${livez.status} ${livez.text}`);

    const publicReadiness = await httpGet(`${base}/readyz`);
    console.log(`GET /readyz (no bearer) -> ${publicReadiness.status} ${publicReadiness.text}`);
    if (![200, 503].includes(publicReadiness.status) || publicReadiness.json === null || "detail" in publicReadiness.json) {
      throw new Error("the public readiness body must be a status and a phase, and nothing else");
    }

    const readiness = await httpGet(`${base}/readyz`, { authorization: `Bearer ${secrets.adminHealthToken}` });
    record("readyz.json", `${readiness.text}\n`);
    const violations = readinessViolations(readiness.json, bindings);
    const detail = readiness.json?.detail ?? {};
    console.log(
      `GET /readyz (bearer) -> ${readiness.status}; read back ${detail.satisfiedBindings?.length} of ${detail.declaredBindings} satisfied, ` +
        `contexts ${JSON.stringify(detail.composedContexts)}`
    );
    if (violations.length > 0) throw new Error(`readiness readback refused:\n  ${violations.join("\n  ")}`);
    if (readiness.status !== (detail.unsatisfiedBindings?.length === 0 ? 200 : 503)) {
      throw new Error(`readiness status ${readiness.status} does not match its own unsatisfied count`);
    }

    const session = await httpGet(`${base}${sessionPath}`, { authorization: `Bearer ${randomBytes(32).toString("hex")}` });
    console.log(`GET ${sessionPath} (random bearer) -> ${session.status}`);
    if (session.status !== 401) throw new Error(`the operator session route answered ${session.status} to a random bearer: ${session.text}`);

    const healthcheck = docker(["exec", names.coreApi, "node", "-e", healthcheckProgram], { allowFailure: true });
    console.log(`compose healthcheck program inside the container -> exit ${healthcheck.status}`);
    if (healthcheck.status !== 0) throw new Error("the compose healthcheck fails against the serving candidate");

    const uid = docker(["exec", names.coreApi, "id", "-u"]).stdout.trim();
    console.log(`container uid -> ${uid}`);
    if (!/^\d+$/.test(uid) || uid === "0") throw new Error(`the candidate runs as uid ${uid}`);

    const legal = docker(["exec", names.coreApi, "sha256sum", "LICENSE", "NOTICE"]).stdout;
    for (const file of ["LICENSE", "NOTICE"]) {
      const shipped = new RegExp(`^([0-9a-f]{64})\\s+${file}$`, "m").exec(legal)?.[1];
      if (shipped !== sha256File(file)) throw new Error(`${file} in the image does not equal this checkout's ${file}`);
    }
    console.log("LICENSE and NOTICE in the image equal this checkout's");

    const stop = docker(["stop", "--time", "30", names.coreApi], { allowFailure: true });
    const exitCode = docker(["inspect", "--format", "{{.State.ExitCode}}", names.coreApi]).stdout.trim();
    const logs = docker(["logs", names.coreApi], { allowFailure: true });
    const output = `${logs.stdout}${logs.stderr}`;
    const leaked = Object.entries(secrets).filter(([, value]) => output.includes(value)).map(([name]) => name);
    record("core-api.log", leaked.length === 0 ? output : "withheld: the log contained a secret value\n");
    console.log(`docker stop -> exit ${stop.status}; container exit code ${exitCode}; secrets in the log: ${leaked.length}`);
    if (leaked.length > 0) throw new Error(`the core-api log printed secret values: ${leaked.join(", ")}`);
    if (exitCode !== "0") throw new Error(`core-api exited ${exitCode} on stop, not a drained 0`);

    record(
      "summary.json",
      `${JSON.stringify(
        {
          coreApiImage,
          migrationsImage,
          livez: livez.status,
          readyz: readiness.status,
          satisfied: detail.satisfiedBindings.length,
          declared: detail.declaredBindings,
          composedContexts: detail.composedContexts,
          identitySession: session.status,
          uid,
          stopExitCode: exitCode,
        },
        null,
        2
      )}\n`
    );
    console.log("core-api candidate smoke: PASSED");
  } catch (error) {
    const logs = docker(["logs", names.coreApi], { allowFailure: true });
    const output = `${logs.stdout}${logs.stderr}`;
    const safe = Object.values(secrets).some((value) => output.includes(value)) ? "withheld: the log contained a secret value" : output;
    console.error(`core-api container log:\n${safe}`);
    throw error;
  } finally {
    cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`core-api candidate smoke: FAILED\n${error.message}`);
    process.exit(1);
  });
}
