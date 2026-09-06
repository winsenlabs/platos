// EXECUTABLE process evidence.
//
// WIN-297's acceptance says the process starts and stops cleanly "proven by an
// executable test, not by assertion". Everything below spawns the SHIPPED
// artifact — `node dist/main.js`, the exact command `pnpm --filter
// @platos/core-api start` runs — sends it a real signal, and reads its real
// exit code and real stdout. No import, no harness, no in-process shortcut.
//
// If `dist/` is absent this file FAILS rather than skips. A skipped test is
// indistinguishable from a passing one on a dashboard, and this is the only
// evidence that the packaged entry point runs at all.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const entryPoint = join(projectRoot, "dist/main.js");

const EXIT_OK = 0;
const EXIT_CONFIGURATION = 78;

/** `stdio: ["ignore", "pipe", "pipe"]` — no stdin, both output streams piped. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

interface Spawned {
  readonly child: PipedChild;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const live: PipedChild[] = [];

afterEach(() => {
  for (const child of live.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

function launch(env: Record<string, string>): Spawned {
  if (!existsSync(entryPoint)) {
    throw new Error(
      `${entryPoint} is missing. The executable evidence runs the BUILT artifact; run \`pnpm build:v1\` first.`,
    );
  }
  const child = spawn(process.execPath, [entryPoint], {
    // A bare env, not process.env: an inherited PLATOS_* variable from the
    // developer's shell would silently change what the fail-closed cases prove.
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(child);

  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return { child, stdout: () => out, stderr: () => err, exited };
}

function events(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait for the process to announce it is listening, and report the port. */
async function awaitListening(spawned: Spawned, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const started = events(spawned.stdout()).find((event) => event["message"] === "process.started");
    if (started !== undefined) return started["port"] as number;
    if (spawned.child.exitCode !== null) {
      throw new Error(`process exited before listening: ${spawned.stdout()}${spawned.stderr()}`);
    }
    if (Date.now() > deadline) throw new Error(`process did not listen within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SERVING_ENV = { PLATOS_ENVIRONMENT: "test", PLATOS_CORE_API_PORT: "0" };

describe("the built binary refuses to start on bad configuration", () => {
  it("exits 78 with a diagnostic when a required variable is missing", async () => {
    const spawned = launch({});
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_ENVIRONMENT");
    expect(spawned.stderr()).toContain("no port was bound");
    // Fail CLOSED: nothing was constructed, so no lifecycle event was emitted.
    expect(spawned.stdout()).toBe("");
  });

  it("exits 78 without repeating a rejected secret", async () => {
    const spawned = launch({ ...SERVING_ENV, PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: "too-short-abc" });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_CORE_API_ADMIN_HEALTH_TOKEN");
    expect(spawned.stderr()).toContain("[redacted]");
    expect(`${spawned.stdout()}${spawned.stderr()}`).not.toContain("too-short-abc");
  });

  it("reports every bad variable in one run", async () => {
    const spawned = launch({ PLATOS_ENVIRONMENT: "prod", PLATOS_CORE_API_PORT: "-1" });
    await spawned.exited;
    expect(spawned.stderr()).toContain("PLATOS_ENVIRONMENT");
    expect(spawned.stderr()).toContain("PLATOS_CORE_API_PORT");
    expect(spawned.stderr()).toContain("2 configuration problem(s)");
  });
});

// WIN-260 (M2.5). The four cases above prove the CORE section refuses at the
// process boundary. These prove the same for the five sections added beside it —
// against the built binary, its real exit code and its real stderr, because a
// unit test of `loadPlatformConfiguration` proves the function refuses and says
// nothing about whether the process that calls it does.
//
// Each case removes or breaks exactly one value and shows the process REFUSING
// TO BOOT: exit 78, the variable named, and an empty stdout, which is the only
// evidence that nothing was constructed and no port was bound before it gave up.
describe("the built binary refuses to start on a bad section", () => {
  it("exits 78 when a store anchor names a scheme that is not PostgreSQL", async () => {
    const spawned = launch({
      ...SERVING_ENV,
      PLATOS_STORE_POSTGRES_URL: "mysql://platos:swordfish-password@db.internal:3306/platos",
    });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_STORE_POSTGRES_URL");
    expect(spawned.stderr()).toContain("no port was bound");
    expect(spawned.stdout()).toBe("");
    // A connection string is a secret even when it is the wrong KIND of string.
    expect(`${spawned.stdout()}${spawned.stderr()}`).not.toContain("swordfish-password");
  });

  it("exits 78 when a declared group is missing the value it cannot work without", async () => {
    // The REMOVED-VALUE proof. The endpoint is present and valid; the database
    // name that must accompany it is not, so the process refuses rather than
    // booting and discovering it at the first span write.
    const spawned = launch({ ...SERVING_ENV, PLATOS_STORE_CLICKHOUSE_URL: "https://clickhouse.internal:8123" });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_STORE_CLICKHOUSE_DATABASE");
    expect(spawned.stderr()).toContain("is required once PLATOS_STORE_CLICKHOUSE_URL is set");
    expect(spawned.stdout()).toBe("");
  });

  it("exits 78 when a value is set that nothing would ever read", async () => {
    // The ORPHANED proof, and the one that would otherwise be silent: a bucket
    // with no endpoint validates under every field-at-a-time scheme, boots, and
    // wires no object store at all.
    const spawned = launch({ ...SERVING_ENV, PLATOS_STORE_OBJECT_BUCKET: "platos-media" });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_STORE_OBJECT_BUCKET");
    expect(spawned.stderr()).toContain("PLATOS_STORE_OBJECT_ENDPOINT is not");
    expect(spawned.stdout()).toBe("");
  });

  it("exits 78 on a durable endpoint with no key, without repeating the key", async () => {
    const spawned = launch({
      ...SERVING_ENV,
      PLATOS_DURABLE_RUNTIME_API_URL: "https://durable.internal",
      PLATOS_DURABLE_RUNTIME_SECRET_KEY: "tiny",
    });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_DURABLE_RUNTIME_SECRET_KEY");
    expect(spawned.stderr()).toContain("[redacted]");
    expect(`${spawned.stdout()}${spawned.stderr()}`).not.toContain("tiny");
  });

  it("exits 78 on a credential root that is 64 characters and not hexadecimal", async () => {
    const spawned = launch({
      ...SERVING_ENV,
      PLATOS_SECURITY_ENCRYPTION_KEY: `${"a".repeat(63)}z`,
      PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "1",
    });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_SECURITY_ENCRYPTION_KEY");
    expect(spawned.stderr()).toContain("64 hexadecimal");
    expect(spawned.stdout()).toBe("");
  });

  it("names problems from three different sections in one run", async () => {
    const spawned = launch({
      ...SERVING_ENV,
      PLATOS_STORE_REDIS_TLS: "yes",
      PLATOS_PROVIDERS_DEFAULT_MODEL: "claude-haiku-4-5",
      PLATOS_CHANNELS_EMAIL_SMTP_URL: "https://relay.internal",
      PLATOS_CHANNELS_EMAIL_FROM: "alerts@platos.example",
    });
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(spawned.stderr()).toContain("PLATOS_STORE_REDIS_TLS");
    expect(spawned.stderr()).toContain("PLATOS_PROVIDERS_DEFAULT_MODEL");
    expect(spawned.stderr()).toContain("PLATOS_CHANNELS_EMAIL_SMTP_URL");
  });

  it("STILL BOOTS with every one of those variables absent", async () => {
    // The control that stops all six cases above from being vacuous. If the
    // sections were required rather than anchored, the process would refuse
    // here too and every refusal above would prove nothing about the value.
    const spawned = launch(SERVING_ENV);
    const port = await awaitListening(spawned);
    expect(port).toBeGreaterThan(0);
    spawned.child.kill("SIGTERM");
    expect((await spawned.exited).code).toBe(EXIT_OK);
  }, 40_000);

  it("boots with a fully wired platform, so a valid value is not merely an unrejected one", async () => {
    const spawned = launch({
      ...SERVING_ENV,
      PLATOS_STORE_POSTGRES_URL: "postgresql://platos:password-here@db.internal:5432/platos_control",
      PLATOS_STORE_REDIS_URL: "rediss://cache.internal:6380",
      PLATOS_STORE_CLICKHOUSE_URL: "https://clickhouse.internal:8123",
      PLATOS_STORE_CLICKHOUSE_DATABASE: "spans",
      PLATOS_STORE_OBJECT_ENDPOINT: "https://minio.internal:9000",
      PLATOS_STORE_OBJECT_BUCKET: "platos-media",
      PLATOS_STORE_OBJECT_ACCESS_KEY_ID: "platos-minio-admin",
      PLATOS_STORE_OBJECT_SECRET_ACCESS_KEY: "platos-minio-password",
      PLATOS_PROVIDERS_DEFAULT_MODEL: "anthropic:claude-haiku-4-5-20251001",
      PLATOS_CHANNELS_SLACK_SIGNING_SECRET: "c".repeat(32),
      PLATOS_DURABLE_RUNTIME_API_URL: "https://durable.internal",
      PLATOS_DURABLE_RUNTIME_SECRET_KEY: "d".repeat(24),
      PLATOS_SECURITY_SESSION_SECRET: "s".repeat(32),
      PLATOS_SECURITY_ENCRYPTION_KEY: "b".repeat(64),
      PLATOS_SECURITY_ENCRYPTION_KEY_VERSION: "3",
    });
    const port = await awaitListening(spawned);
    expect(port).toBeGreaterThan(0);
    spawned.child.kill("SIGTERM");
    expect((await spawned.exited).code).toBe(EXIT_OK);
  }, 40_000);
});

describe("the built binary starts, serves and stops", () => {
  it("listens, answers liveness and readiness, then exits 0 on SIGTERM", async () => {
    const spawned = launch(SERVING_ENV);
    const port = await awaitListening(spawned);
    expect(port).toBeGreaterThan(0);

    const live = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "alive", phase: "serving" });

    // Honestly red: no adapter has an implementation at M2.1b.
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(503);

    spawned.child.kill("SIGTERM");
    const { code, signal } = await spawned.exited;
    // A clean exit code, NOT death by signal — the difference between a graceful
    // shutdown and an orchestrator killing a process that ignored the request.
    expect(signal).toBeNull();
    expect(code).toBe(EXIT_OK);

    const messages = events(spawned.stdout()).map((event) => event["message"]);
    expect(messages).toEqual(["process.starting", "process.started", "process.draining", "process.stopped"]);
    expect(events(spawned.stdout()).at(-1)).toMatchObject({
      message: "process.stopped",
      reason: "SIGTERM",
      drained: true,
      remaining: 0,
    });
  }, 40_000);

  it("honours SIGINT the same way", async () => {
    const spawned = launch(SERVING_ENV);
    await awaitListening(spawned);
    spawned.child.kill("SIGINT");
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_OK);
    expect(events(spawned.stdout()).at(-1)).toMatchObject({ reason: "SIGINT", drained: true });
  }, 40_000);

  it("releases the port on exit", async () => {
    const spawned = launch(SERVING_ENV);
    const port = await awaitListening(spawned);
    spawned.child.kill("SIGTERM");
    await spawned.exited;
    await expect(fetch(`http://127.0.0.1:${port}/livez`)).rejects.toThrow();
  }, 40_000);

  it("survives two signals in a row and still exits 0", async () => {
    const spawned = launch(SERVING_ENV);
    await awaitListening(spawned);
    spawned.child.kill("SIGTERM");
    spawned.child.kill("SIGINT");
    const { code } = await spawned.exited;
    expect(code).toBe(EXIT_OK);
    // One shutdown, not two: the second signal joined the first.
    expect(events(spawned.stdout()).filter((event) => event["message"] === "process.draining")).toHaveLength(1);
  }, 40_000);

  it("does NOT start a server when the module is merely imported", async () => {
    // `@platos/core-api`'s package entry point IS main.js. Importing the package
    // — which any embedding host or test does — must not bind a socket.
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(entryPoint)}); process.exit(7);`],
      { env: { PATH: process.env["PATH"] ?? "", ...SERVING_ENV }, stdio: ["ignore", "pipe", "pipe"] },
    );
    live.push(child as PipedChild);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(7);
    expect(out).not.toContain("process.started");
  }, 40_000);
});
