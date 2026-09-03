import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runStdio } from "./main.js";
import {
  EXIT_CONFIGURATION,
  EXIT_OK,
  createStdioSession,
  loadStdioConfiguration,
  renderStdioFailure,
} from "./runtime.js";
import { createToolsRuntime } from "./testing/in-memory-runtime.js";

const projectRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const entryPoint = join(projectRoot, "dist/main.js");
const runtimeModule = join(projectRoot, "dist/testing/in-memory-runtime.js");

function collector(): { io: { write: (line: string) => void; writeError: (t: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { write: (line) => out.push(line), writeError: (text) => err.push(text) }, out, err };
}

describe("stdio configuration", () => {
  it("refuses to start with no host runtime module — the recorded rule (j) consequence", () => {
    const outcome = loadStdioConfiguration({});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.diagnostics[0]?.field).toBe("PLATOS_MCP_STDIO_RUNTIME_MODULE");
    expect(renderStdioFailure(outcome.diagnostics)).toContain("rule (j)");
  });

  it("accepts a specifier and defaults the drain timeout", () => {
    const outcome = loadStdioConfiguration({ PLATOS_MCP_STDIO_RUNTIME_MODULE: "./runtime.js" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ runtimeModule: "./runtime.js", shutdownTimeoutMs: 5000 });
  });

  it("rejects a malformed timeout", () => {
    const outcome = loadStdioConfiguration({
      PLATOS_MCP_STDIO_RUNTIME_MODULE: "./runtime.js",
      PLATOS_MCP_STDIO_SHUTDOWN_TIMEOUT_MS: "soon",
    });
    expect(outcome.ok).toBe(false);
  });

  it("never echoes the specifier, which can carry a path and therefore a token", () => {
    // A module path is routinely a filesystem location, and a filesystem
    // location routinely names a mount, a tenant or a token. This renderer
    // echoes NO value at all — field name and problem only.
    const outcome = loadStdioConfiguration({
      PLATOS_MCP_STDIO_RUNTIME_MODULE: "/srv/secrets/tenant-abc123/runtime.js",
      PLATOS_MCP_STDIO_SHUTDOWN_TIMEOUT_MS: "not-a-number",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const text = renderStdioFailure(outcome.diagnostics);
    expect(text).toContain("PLATOS_MCP_STDIO_SHUTDOWN_TIMEOUT_MS");
    expect(text).not.toContain("tenant-abc123");
    expect(text).not.toContain("not-a-number");
  });
});

describe("the frame loop", () => {
  const session = () => {
    let shutdowns = 0;
    const instance = createStdioSession(createToolsRuntime(), () => {
      shutdowns += 1;
    });
    return { instance, shutdowns: () => shutdowns };
  };

  it("answers a health frame and echoes the caller's id", () => {
    const { instance } = session();
    expect(JSON.parse(instance.handle('{"id":"abc","method":"health"}') ?? "{}")).toEqual({
      id: "abc",
      ok: true,
      status: "alive",
      tools: "tools",
    });
  });

  it("mints an id when the caller omits one", () => {
    const { instance } = session();
    const response = JSON.parse(instance.handle('{"method":"health"}') ?? "{}");
    expect(response.id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("refuses to carry an over-long id into a correlated log", () => {
    const { instance } = session();
    const response = JSON.parse(instance.handle(`{"id":"${"x".repeat(200)}","method":"health"}`) ?? "{}");
    expect(response.id).toHaveLength(36);
  });

  it("reports a malformed frame rather than throwing", () => {
    const { instance } = session();
    expect(JSON.parse(instance.handle("{not json") ?? "{}")).toMatchObject({ ok: false, error: "MALFORMED_FRAME" });
  });

  it("reports an unknown method — tool invocation is M4's, not this issue's", () => {
    const { instance } = session();
    expect(JSON.parse(instance.handle('{"id":"1","method":"tools/call"}') ?? "{}")).toMatchObject({
      ok: false,
      error: "UNKNOWN_METHOD",
    });
  });

  it("ignores blank lines without counting them as work", () => {
    const { instance } = session();
    expect(instance.handle("   ")).toBeNull();
    expect(instance.handled).toBe(0);
  });

  it("starts shutdown exactly once per shutdown frame", () => {
    const { instance, shutdowns } = session();
    instance.handle('{"id":"1","method":"shutdown"}');
    expect(shutdowns()).toBe(1);
  });
});

describe("running the process in-memory", () => {
  it("exits 78 when no runtime module is configured", async () => {
    const sink = collector();
    const code = await runStdio({ env: {}, io: sink.io, input: new PassThrough() });
    expect(code).toBe(EXIT_CONFIGURATION);
    expect(sink.err.join("")).toContain("PLATOS_MCP_STDIO_RUNTIME_MODULE");
    expect(sink.out).toEqual([]);
  });

  it("exits 78 when the host runtime cannot be loaded", async () => {
    const sink = collector();
    const code = await runStdio({
      env: { PLATOS_MCP_STDIO_RUNTIME_MODULE: "./nope.js" },
      io: sink.io,
      input: new PassThrough(),
      loadRuntime: async () => {
        throw new Error("Cannot find module");
      },
    });
    expect(code).toBe(EXIT_CONFIGURATION);
    // Fail closed: no ready frame, so a supervisor cannot mistake it for healthy.
    expect(sink.out).toEqual([]);
  });

  it("announces ready, answers frames, and stops when the input ends", async () => {
    const sink = collector();
    const input = new PassThrough();
    const finished = runStdio({
      env: { PLATOS_MCP_STDIO_RUNTIME_MODULE: "in-memory" },
      io: sink.io,
      input,
      loadRuntime: async () => await Promise.resolve(createToolsRuntime()),
    });
    input.write('{"id":"one","method":"health"}\n');
    input.write('{"id":"two","method":"health"}\n');
    input.end();

    expect(await finished).toBe(EXIT_OK);
    const frames = sink.out.map((line) => JSON.parse(line));
    expect(frames[0]).toEqual({ event: "ready", tools: "tools" });
    expect(frames[1]).toMatchObject({ id: "one", ok: true });
    expect(frames[2]).toMatchObject({ id: "two", ok: true });
    expect(frames.at(-1)).toEqual({ event: "stopped", handled: 2 });
  });

  it("stops accepting frames after a shutdown frame", async () => {
    const sink = collector();
    const input = new PassThrough();
    const finished = runStdio({
      env: { PLATOS_MCP_STDIO_RUNTIME_MODULE: "in-memory" },
      io: sink.io,
      input,
      loadRuntime: async () => await Promise.resolve(createToolsRuntime()),
    });
    input.write('{"id":"1","method":"shutdown"}\n');
    input.write('{"id":"2","method":"health"}\n');
    input.end();

    expect(await finished).toBe(EXIT_OK);
    const ids = sink.out.map((line) => JSON.parse(line)).map((frame) => frame.id);
    expect(ids).toContain("1");
    expect(ids).not.toContain("2");
  });
});

describe("the built binary", () => {
  const run = async (
    env: Record<string, string>,
    stdin: string,
  ): Promise<{ code: number | null; out: string; err: string }> => {
    if (!existsSync(entryPoint)) {
      throw new Error(`${entryPoint} is missing; run \`pnpm build:v1\` before the executable evidence.`);
    }
    const child = spawn(process.execPath, [entryPoint], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.stdin.end(stdin);
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { code, out, err };
  };

  it("refuses to start standalone, which is the finding made executable", async () => {
    const result = await run({}, "");
    expect(result.code).toBe(EXIT_CONFIGURATION);
    expect(result.err).toContain("must be given a tools runtime by its host");
    expect(result.out).toBe("");
  }, 40_000);

  it("starts, answers a health frame and exits 0 when a host runtime is supplied", async () => {
    const result = await run(
      { PLATOS_MCP_STDIO_RUNTIME_MODULE: runtimeModule },
      '{"id":"probe","method":"health"}\n',
    );
    expect(result.code).toBe(EXIT_OK);
    const frames = result.out.trim().split("\n").map((line) => JSON.parse(line));
    expect(frames[0]).toEqual({ event: "ready", tools: "tools" });
    expect(frames[1]).toMatchObject({ id: "probe", ok: true, status: "alive" });
    expect(frames.at(-1)).toEqual({ event: "stopped", handled: 1 });
  }, 40_000);
});
