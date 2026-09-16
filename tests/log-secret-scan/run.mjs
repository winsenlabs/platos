#!/usr/bin/env node
// WIN-259 — THE EMITTED-LOG HALF OF SECRET SCANNING.
//
// The issue's clause is "logs/artifacts are scanned". The ARTIFACT half exists:
// `tests/browser-evidence/verify-artifacts.mjs` rejects bearer tokens and
// secret-bearing keys in browser evidence. The LOG half did not, and Linear
// records it as NOT MET. This is that gate.
//
// WHAT IS REAL HERE, stated plainly rather than left to be inferred:
//
//   REAL  The process. `apps/core-api/dist/main.js` — the SHIPPED entry point,
//         started with an environment the way an orchestrator starts it, not a
//         test harness composing the app in its own process. Its stdout and
//         stderr are the corpus, because those are the bytes a log aggregator
//         receives.
//   REAL  The database, the cache and the relay. PostgreSQL, Redis and an SMTP
//         server, all containers this runner starts and stops.
//   REAL  The flows. A magic-link sign-in driven to completion through a real
//         mailbox; the platform and entity MCP token mints; a provider-key
//         rotation carrying known material in its request body; an environment
//         variable written as a secret; and a REFUSED sign-in carrying planted
//         material, because an error path is where this class of leak lives.
//   REAL  The plants. Every configuration field the schema itself classifies
//         `secret: true` and this run wires gets a unique sentinel, DERIVED from
//         the schema rather than listed here — a new secret setting joins the
//         plant list on the commit that declares it. The runtime-minted secrets
//         (the magic-link token, the session token, both MCP tokens) are read
//         back out of the process's own responses, so they are the values it
//         really produced.
//
// WHAT IS NOT: this gate does not prove the process logs nothing sensitive that
// nobody planted. It proves that the material it planted, in five encodings, is
// absent from everything the process printed. A leak of a value this run never
// introduced is invisible to it, and saying so is the difference between a gate
// and a slogan.
//
// THE NEGATIVE CONTROL IS THE DELIVERABLE, NOT THE FOOTNOTE. A scan that has
// never been shown to find anything is decoration. `leaky-control.mjs` is a
// second child process that writes the SAME planted values through the SAME
// `createProcessLogger` and the SAME stdout, under a field key the kernel's
// redactor does not classify as material. The gate requires every planted value
// to be found there. If that phase finds nothing, the whole run fails: it means
// the capture, the encodings or the scan stopped working, and the clean result
// above would have been silence rather than evidence.
//
// It FAILS when Docker is absent rather than skipping, for the reason every
// container-backed runner in this repository gives: a skipped run and a passing
// one are indistinguishable in a summary.
//
// Run: node tests/log-secret-scan/run.mjs [--keep]

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { groupFields } from "../../apps/core-api/dist/config/schema.js";
import { CORE_API_CONFIG_FIELDS } from "../../apps/core-api/dist/config/schema.js";
import { PLATFORM_SECTIONS } from "../../apps/core-api/dist/config/platform.js";

import {
  allConfigFields,
  observedMessages,
  refusals,
  scan,
  secretConfigFields,
  sentinelFor,
  uncapturedLogSinkSettings,
} from "./scanner.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const RUN = randomBytes(4).toString("hex");
const NONCE = randomBytes(16).toString("hex");
const PREFIX = `m2m4-evidence-registers-logscan-${RUN}`;

const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const REDIS_IMAGE = "redis:7-alpine";
const MAILPIT_IMAGE = "axllent/mailpit:v1.21";

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function assertDockerIsAvailable() {
  try {
    docker(["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(
      "this gate needs a Docker daemon and there is none. It fails rather than skipping: a skipped run and a " +
        `passing run are indistinguishable in a summary. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function sleep(ms) {
  await new Promise((done) => {
    setTimeout(done, ms);
  });
}

function mappedPort(container, port) {
  return docker(["port", container, `${String(port)}/tcp`]).trim().split("\n")[0]?.split(":").pop() ?? "";
}

async function waitFor(label, probe, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await probe()) return;
    } catch {
      // not yet
    }
    await sleep(500);
  }
  throw new Error(`${label} never became ready`);
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

async function startInfrastructure() {
  const password = randomBytes(12).toString("hex");
  const containers = {
    postgres: `${PREFIX}-pg`,
    redis: `${PREFIX}-redis`,
    mailpit: `${PREFIX}-mail`,
  };
  docker([
    "run", "--detach", "--rm", "--name", containers.postgres,
    "--env", "POSTGRES_USER=logscan",
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--env", "POSTGRES_DB=m2m4_evidence_registers_logscan",
    "--publish", "0:5432", POSTGRES_IMAGE,
  ]);
  docker(["run", "--detach", "--rm", "--name", containers.redis, "--publish", "0:6379", REDIS_IMAGE]);
  docker(["run", "--detach", "--rm", "--name", containers.mailpit, "--publish", "0:1025", "--publish", "0:8025", MAILPIT_IMAGE]);

  await waitFor("postgres", () => {
    docker(["exec", containers.postgres, "pg_isready", "-h", "127.0.0.1", "-U", "logscan"], { stdio: "pipe" });
    return true;
  });
  await waitFor("redis", () => {
    const answer = docker(["exec", containers.redis, "redis-cli", "ping"], { stdio: ["ignore", "pipe", "pipe"] });
    return answer.trim() === "PONG";
  });
  const mailApiPort = mappedPort(containers.mailpit, 8025);
  await waitFor("mailpit", async () => (await fetch(`http://127.0.0.1:${mailApiPort}/api/v1/info`)).ok);

  return {
    containers,
    databaseUrl: `postgresql://logscan:${password}@127.0.0.1:${mappedPort(containers.postgres, 5432)}/m2m4_evidence_registers_logscan`,
    redisUrl: `redis://127.0.0.1:${mappedPort(containers.redis, 6379)}`,
    smtpUrl: `smtp://127.0.0.1:${mappedPort(containers.mailpit, 1025)}`,
    mailApi: `http://127.0.0.1:${mailApiPort}`,
  };
}

function stopInfrastructure(containers) {
  for (const name of Object.values(containers ?? {})) {
    try {
      docker(["stop", name], { stdio: "pipe" });
    } catch {
      // --rm containers may already be gone; a failed stop must never mask a real failure.
    }
  }
}

function migrate(databaseUrl) {
  const databasePackage = resolve(repositoryRoot, "internal-packages/tenancy-database");
  execFileSync(
    resolve(repositoryRoot, "node_modules/.bin/prisma"),
    ["migrate", "deploy", "--schema", resolve(databasePackage, "prisma/schema.prisma")],
    { cwd: databasePackage, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
}

// ---------------------------------------------------------------------------
// The configuration, and the plants the schema itself demands
// ---------------------------------------------------------------------------

/**
 * The environment the serving process is started with.
 *
 * Every group whose anchor appears here is WIRED, and every secret-classified
 * field of a wired group carries a sentinel. Which groups are wired is a
 * property of this object; which fields are secret is a property of the schema.
 * The two are joined below rather than reconciled by hand.
 */
export function buildEnvironment(infrastructure, loginUrl) {
  const secrets = new Map();
  for (const field of secretConfigFields(PLATFORM_SECTIONS, CORE_API_CONFIG_FIELDS, groupFields)) {
    const sentinel = sentinelFor(field, NONCE);
    if (!sentinel.ok) continue;
    secrets.set(field.name, sentinel.value);
  }
  return {
    PATH: process.env["PATH"] ?? "",
    PLATOS_ENVIRONMENT: "test",
    PLATOS_LOG_LEVEL: "debug",
    PLATOS_CORE_API_HOST: "127.0.0.1",
    // The store urls are real servers, so their sentinels are discarded: a
    // planted PostgreSQL url would simply refuse to connect. They are still
    // planted material — the REDIS url is `secret: true` in the schema and its
    // value carries a host and port this run owns — so both are registered as
    // plants below with their real values.
    PLATOS_STORE_POSTGRES_URL: infrastructure.databaseUrl,
    PLATOS_STORE_REDIS_URL: infrastructure.redisUrl,
    PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
    PLATOS_SECURITY_ENCRYPTION_KEY: secrets.get("PLATOS_SECURITY_ENCRYPTION_KEY") ?? "",
    PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
    PLATOS_SECURITY_SESSION_SECRET: secrets.get("PLATOS_SECURITY_SESSION_SECRET") ?? "",
    PLATOS_CHANNELS_EMAIL_SMTP_URL: infrastructure.smtpUrl,
    PLATOS_CHANNELS_EMAIL_FROM: "login@platos.win259.test",
    PLATOS_CHANNELS_EMAIL_LOGIN_URL: loginUrl,
    // Mailpit speaks no TLS unless handed a certificate this process could not
    // trust, so the suite that proves delivery opts out — the same trade the
    // identity/tenancy REST suite records beside the same relay.
    PLATOS_CHANNELS_EMAIL_REQUIRE_TLS: "false",
    // Two anchors with no required companions, so wiring them costs nothing and
    // puts two more schema-classified secrets into the process.
    PLATOS_CHANNELS_SLACK_SIGNING_SECRET: secrets.get("PLATOS_CHANNELS_SLACK_SIGNING_SECRET") ?? "",
    PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY: secrets.get("PLATOS_CHANNELS_WEBHOOK_SIGNING_KEY") ?? "",
  };
}

/**
 * The secret-classified fields this run wired, and the ones it did not.
 *
 * DERIVED from the same two sources, so the gate publishes its own plant
 * coverage instead of implying it planted everything. An unwired field is a
 * stated gap with the group that would have to be configured, not a silence.
 */
export function plantCoverage(environment) {
  const fields = secretConfigFields(PLATFORM_SECTIONS, CORE_API_CONFIG_FIELDS, groupFields);
  const planted = [];
  const unwired = [];
  for (const field of fields) {
    const value = environment[field.name];
    if (typeof value === "string" && value !== "") planted.push({ name: field.name, value });
    else unwired.push(field.name);
  }
  return { planted, unwired, total: fields.length };
}

// ---------------------------------------------------------------------------
// The serving process, and its corpus
// ---------------------------------------------------------------------------

function startServer(environment, port) {
  const child = spawn(process.execPath, [resolve(repositoryRoot, "apps/core-api/dist/main.js")], {
    cwd: resolve(repositoryRoot, "apps/core-api"),
    env: { ...environment, PLATOS_CORE_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => chunks.push(text));
  child.stderr.on("data", (text) => chunks.push(text));
  // THE EXIT PROMISE IS CREATED AT SPAWN, not at stop. Registering the listener
  // later loses the event for a process that has already died — a core-api that
  // refused its configuration exits 78 in under a second — and the await that
  // followed would then never settle. Node exits 0 with an empty event loop, so
  // that shape turns a real startup failure into a silent green run. It did
  // exactly that here before this was written down.
  const exited = new Promise((done) => {
    child.on("exit", (code, signal) => done({ code, signal }));
  });
  return { child, exited, stopped: false, corpus: () => chunks.join("") };
}

async function stopServer(server) {
  if (server.stopped) return server.exited;
  server.stopped = true;
  server.child.kill("SIGTERM");
  const killer = setTimeout(() => server.child.kill("SIGKILL"), 20_000);
  const outcome = await server.exited;
  clearTimeout(killer);
  return outcome;
}

function freePort() {
  // 40000-49999, chosen per run. A collision shows up as a failed readiness
  // probe rather than as a silent pass, because the drive below asserts every
  // response it needs.
  return 40_000 + Math.floor(Math.random() * 10_000);
}

// ---------------------------------------------------------------------------
// The drive
// ---------------------------------------------------------------------------

async function request(base, method, path, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  if (options.key !== undefined) headers["idempotency-key"] = options.key;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: response.status, headers: response.headers, body, text };
}

async function magicLinkToken(mailApi, address) {
  const listed = await (await fetch(`${mailApi}/api/v1/messages?limit=200`)).json();
  const message = (listed.messages ?? []).find((entry) =>
    (entry.To ?? []).some((recipient) => String(recipient.Address ?? "").toLowerCase() === address.toLowerCase()),
  );
  if (message === undefined) return null;
  const full = await (await fetch(`${mailApi}/api/v1/message/${message.ID}`)).json();
  const match = /https?:\/\/\S*token=[^\s"'<>]+/u.exec(String(full.Text ?? ""));
  if (match === null) return null;
  return new URL(match[0]).searchParams.get("token");
}

/**
 * Drives the flows and returns the values the process actually handled.
 *
 * `reached` is set from the process's own answer. A value the process refused at
 * the door is still `reached` — it was received, parsed and acted on, and an
 * error path is where this class of leak lives — but a request that never got a
 * response leaves its plant unreached, and `refusals` then declines to believe
 * the run.
 */
async function drive(base, mailApi, seeded, materials) {
  const planted = [];
  const record = (id, value, origin, reached) => planted.push({ id, value, origin, reached });

  const start = await request(base, "POST", "/api/v1/bff/magic-link", { body: { email: seeded.operatorEmail } });
  if (start.status !== 202) throw new Error(`magic-link start answered ${String(start.status)}: ${start.text}`);
  let token = null;
  await waitFor("magic-link email", async () => {
    token = await magicLinkToken(mailApi, seeded.operatorEmail);
    return token !== null;
  }, 60);
  if (token === null) throw new Error("no magic-link token arrived");
  record("magic-link-token", token, "POST /api/v1/bff/magic-link, delivered by SMTP", true);

  const completed = await request(base, "POST", "/api/v1/bff/magic-link/complete", { body: { token } });
  if (completed.status !== 200) throw new Error(`magic-link completion answered ${String(completed.status)}: ${completed.text}`);
  const setCookie = completed.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const sessionToken = decodeURIComponent(cookie.split("=").slice(1).join("="));
  if (sessionToken.length < 16) throw new Error("no session token was minted");
  record("session-token", sessionToken, "POST /api/v1/bff/magic-link/complete Set-Cookie", true);

  // A REFUSED sign-in carrying planted material. Error paths are where a
  // transport is most tempted to echo what it was given.
  const refused = await request(base, "POST", "/api/v1/bff/magic-link/complete", {
    body: { token: materials.refusedToken },
  });
  record("refused-magic-link-token", materials.refusedToken, `POST .../complete refused with ${String(refused.status)}`, refused.status >= 400);

  const platformMint = await request(base, "POST", "/mcp/platform/tokens", {
    cookie,
    key: `logscan-platform-${RUN}`,
    body: { environmentId: seeded.environment, name: "log scan platform token", permissions: ["agents.list"], tier: "scope" },
  });
  if (platformMint.status >= 300) throw new Error(`platform mint answered ${String(platformMint.status)}: ${platformMint.text}`);
  const platformToken = String((platformMint.body.data ?? {}).token ?? "");
  if (platformToken.length < 16) throw new Error(`platform mint returned no token: ${platformMint.text}`);
  record("platform-mcp-token", platformToken, "POST /mcp/platform/tokens", true);

  const entityMint = await request(base, "POST", `/mcp/entity/${seeded.entity}/tokens`, {
    cookie,
    key: `logscan-entity-${RUN}`,
    body: { environmentId: seeded.environment, label: "log scan entity token", scopes: ["mcp:tools"], mcpUserId: null, ttlSeconds: null },
  });
  if (entityMint.status >= 300) throw new Error(`entity mint answered ${String(entityMint.status)}: ${entityMint.text}`);
  const entityToken = String((entityMint.body.data ?? {}).token ?? "");
  if (entityToken.length < 16) throw new Error(`entity mint returned no token: ${entityMint.text}`);
  record("entity-mcp-token", entityToken, `POST /mcp/entity/${seeded.entity}/tokens`, true);

  const rotated = await request(base, "POST", `/api/v1/agent/providers/keys/${seeded.providerKeyId}/rotate-secret`, {
    cookie,
    key: `logscan-rotate-${RUN}`,
    body: { environmentId: seeded.environment, plaintext: materials.rotationSecret },
  });
  if (rotated.status >= 300) throw new Error(`rotation answered ${String(rotated.status)}: ${rotated.text}`);
  record("provider-key-rotation-plaintext", materials.rotationSecret, "POST .../rotate-secret request body", true);
  record("provider-key-original-plaintext", materials.originalSecret, "registered before the run, replaced by the rotation", true);

  const variable = await request(base, "PUT", `/api/v1/environments/${seeded.environment}/variables/LOG_SCAN_SECRET`, {
    cookie,
    body: { value: materials.variableSecret, secret: true },
  });
  if (variable.status >= 300) throw new Error(`variable write answered ${String(variable.status)}: ${variable.text}`);
  record("environment-variable-secret", materials.variableSecret, "PUT /api/v1/environments/:id/variables/:key", true);

  const listed = await request(base, "GET", `/api/v1/environments/${seeded.environment}/variables`, { cookie });
  if (listed.status >= 300) throw new Error(`variable list answered ${String(listed.status)}: ${listed.text}`);

  // THE FAILURE PATHS, DRIVEN ON PURPOSE. `DomainExceptionFilter` writes the
  // error's `details` into `http.request_failed`, and `details` is the kernel's
  // "structured, already-redacted context for logs, never returned to a client".
  // That is the richest leak channel this deployable has, and a run that never
  // reached it would have scanned six lifecycle lines and called it clean.
  const rejectedKey = await request(base, "PUT", `/api/v1/environments/${seeded.environment}/variables/not-a-valid-key`, {
    cookie,
    body: { value: materials.rejectedVariableSecret, secret: true },
  });
  record(
    "rejected-environment-variable-secret",
    materials.rejectedVariableSecret,
    `PUT .../variables/not-a-valid-key refused with ${String(rejectedKey.status)}`,
    rejectedKey.status >= 400,
  );

  // A planted value in a QUERY STRING, on a route that refuses it. A refusal
  // that names what it was asked for is the shape that puts a caller's own
  // input into a log line.
  const bySlugs = await request(
    base,
    "GET",
    `/api/v1/environments/by-slugs?organizationSlug=${encodeURIComponent(materials.querySecret)}` +
      "&projectSlug=nothing&environmentSlug=nothing",
    { cookie },
  );
  record("query-string-secret", materials.querySecret, `GET /environments/by-slugs refused with ${String(bySlugs.status)}`, bySlugs.status >= 400);

  // A REPLAY of the platform mint under the key it was minted with. The stored
  // response carries the token, and `http.idempotency_replayed` is written on
  // the way back out.
  const replayed = await request(base, "POST", "/mcp/platform/tokens", {
    cookie,
    key: `logscan-platform-${RUN}`,
    body: { environmentId: seeded.environment, name: "log scan platform token", permissions: ["agents.list"], tier: "scope" },
  });
  if (replayed.status >= 300) throw new Error(`platform mint replay answered ${String(replayed.status)}: ${replayed.text}`);

  // And an idempotency CONFLICT: the same key with a different body, which
  // `http.idempotency_refused` reports.
  await request(base, "POST", "/mcp/platform/tokens", {
    cookie,
    key: `logscan-platform-${RUN}`,
    body: { environmentId: seeded.environment, name: materials.conflictingName, permissions: ["agents.list"], tier: "scope" },
  });
  record("idempotency-conflict-name", materials.conflictingName, "POST /mcp/platform/tokens under a replayed key with a different body", true);

  const signedOut = await request(base, "DELETE", "/api/v1/bff/session", { cookie });
  if (signedOut.status >= 300) throw new Error(`sign-out answered ${String(signedOut.status)}: ${signedOut.text}`);

  return planted;
}

// ---------------------------------------------------------------------------
// The negative control
// ---------------------------------------------------------------------------

async function runLeakyControl(planted) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./leaky-control.mjs", import.meta.url))], {
    env: { PATH: process.env["PATH"] ?? "", PLATOS_LOG_SCAN_PLANTED: JSON.stringify(planted.map((entry) => ({ id: entry.id, value: entry.value }))) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => chunks.push(text));
  child.stderr.on("data", (text) => chunks.push(text));
  const code = await new Promise((done) => child.on("exit", done));
  if (code !== 0) throw new Error(`the negative control exited ${String(code)}`);
  return chunks.join("");
}

// ---------------------------------------------------------------------------

export async function runGate(options = {}) {
  assertDockerIsAvailable();
  const workspace = mkdtempSync(join(tmpdir(), `${PREFIX}-`));
  let infrastructure = null;
  let server = null;
  const results = [];
  try {
    infrastructure = await startInfrastructure();
    migrate(infrastructure.databaseUrl);

    const materials = {
      originalSecret: `plant-${NONCE}-provider-key-original`,
      rotationSecret: `plant-${NONCE}-provider-key-rotation`,
      variableSecret: `plant-${NONCE}-environment-variable`,
      refusedToken: `plant-${NONCE}-refused-magic-link`,
      rejectedVariableSecret: `plant-${NONCE}-rejected-variable`,
      querySecret: `plant-${NONCE}-query-string`,
      conflictingName: `plant-${NONCE}-idempotency-conflict`,
    };
    const port = freePort();
    const environment = buildEnvironment(infrastructure, `http://127.0.0.1:${String(port)}/magic`);
    const coverage = plantCoverage(environment);

    const seedFile = join(workspace, "seed.json");
    execFileSync(process.execPath, [fileURLToPath(new URL("./seed.mjs", import.meta.url)), seedFile], {
      cwd: repositoryRoot,
      env: { ...environment, PLATOS_LOG_SCAN_ORIGINAL_KEY_SECRET: materials.originalSecret },
      stdio: "pipe",
    });
    const seeded = JSON.parse(readFileSync(seedFile, "utf8"));

    server = startServer(environment, port);
    const base = `http://127.0.0.1:${String(port)}`;
    try {
      await waitFor("core-api", async () => (await fetch(`${base}/livez`)).ok, 120);
    } catch (error) {
      // The process's own bytes are the diagnostic. A readiness timeout with no
      // sight of what the process said is the hardest failure in this file to
      // chase, and the corpus is right here.
      const outcome = await stopServer(server);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; the process exited ` +
          `${JSON.stringify(outcome)} and printed:\n${server.corpus().slice(-4000)}`,
      );
    }

    const driven = await drive(base, infrastructure.mailApi, seeded, materials);
    await stopServer(server);
    const corpus = server.corpus();

    const planted = [
      ...driven,
      ...coverage.planted.map((entry) => ({
        id: `config:${entry.name}`,
        value: entry.value,
        origin: `configuration field classified secret: true by the schema`,
        reached: true,
      })),
    ];

    const sinkSettings = uncapturedLogSinkSettings(
      allConfigFields(PLATFORM_SECTIONS, CORE_API_CONFIG_FIELDS, groupFields),
    );
    const refused = refusals({ corpus, planted, sinkSettings });
    const messages = observedMessages(corpus);
    results.push({
      phase: "capture",
      passed: refused.length === 0,
      detail:
        refused.length === 0
          ? `${String(corpus.split("\n").length)} captured line(s) carrying ${String(messages.length)} distinct ` +
            `message(s) [${messages.join(", ")}]; ${String(planted.length)} planted value(s), ` +
            `${String(coverage.planted.length)} of ${String(coverage.total)} schema-classified secret settings wired ` +
            `(unwired: ${coverage.unwired.join(", ") || "none"})`
          : refused.join(" | "),
    });
    if (refused.length > 0) return { ok: false, results };

    const findings = scan(corpus, planted);
    results.push({
      phase: "clean",
      passed: findings.length === 0,
      detail:
        findings.length === 0
          ? "no planted value appears in anything the serving process printed, in any of the five encodings"
          : findings.map((entry) => `${entry.id} as ${entry.encoding} on line ${String(entry.line)}: ${entry.excerpt}`).join(" | "),
    });

    // THE NEGATIVE CONTROL. Same values, same logger, same stdout, one
    // non-material field key. Every plant must be found, or the clean phase
    // above was silence rather than evidence.
    const leaked = await runLeakyControl(planted);
    const caught = scan(leaked, planted);
    const caughtIds = new Set(caught.map((entry) => entry.id));
    const missed = planted.filter((entry) => !caughtIds.has(entry.id)).map((entry) => entry.id);
    results.push({
      phase: "negative-control",
      passed: missed.length === 0 && caught.length > 0,
      detail:
        missed.length === 0
          ? `every one of the ${String(planted.length)} planted values was found when the same logger wrote them ` +
            "through the same stdout under a key the redactor does not classify as material"
          : `the gate FAILED TO CATCH a deliberate leak of: ${missed.join(", ")}`,
    });

    return { ok: results.every((entry) => entry.passed), results, corpusLines: corpus.split("\n").length };
  } finally {
    if (server !== null) await stopServer(server);
    if (!options.keep) {
      stopInfrastructure(infrastructure?.containers);
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

async function main(argv) {
  const outcome = await runGate({ keep: argv.includes("--keep") });
  for (const entry of outcome.results) {
    process.stdout.write(`[log-secret-scan] ${entry.passed ? "PASS" : "FAIL"} ${entry.phase}: ${entry.detail}\n`);
  }
  process.stdout.write(`[log-secret-scan] ${outcome.ok ? "green" : "RED"}\n`);
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[log-secret-scan] ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}
