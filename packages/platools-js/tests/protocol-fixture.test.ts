/**
 * THE PLATOOLS WIRE PROTOCOL, DRIVEN AGAINST THE FIXTURE BOTH SDKS READ.
 *
 * WIN-270 (M4.4), cross-language fixtures. `tests/sdk-contract/platools-protocol.json`
 * is read here AND by `packages/platools-py/tests/test_protocol_fixture.py`. Each
 * suite declares the fixture's tool in its own language, runs its own
 * `PlatoolsClient` through registration and dispatch over a fake socket, and
 * compares the frames the client SENDS against the fixture. Nothing asserted below
 * is a value this file writes: the expected frames, the parameter meanings and the
 * error string all come from the fixture, and the frame key sets come from the
 * platform's own protocol header in `apps/agent/src/tool-gateway/tool-sync-ws.service.ts`.
 *
 * The one thing this file does write is the handler, and the fixture's `$comment`
 * states what it must return; the Python suite registers the same one. What that
 * handler's output proves is not its own shape but what reached it: the declared
 * default, the call context, and no envelope in its arguments.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { currentScope } from "../src/context.js";
import { makeToolFactory } from "../src/core/decorator.js";
import { ToolRegistry } from "../src/core/registry.js";
import {
  PlatoolsClient,
  type ClientLogger,
  type WsFactory,
  type WsLike,
} from "../src/transport/client.js";
import { decodePlatformMessage } from "../src/transport/protocol.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

interface FixtureParameter {
  readonly name: string;
  readonly types: readonly string[];
  readonly required: boolean;
  readonly default?: unknown;
}

interface Fixture {
  readonly server: string;
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly auth: "none" | "user" | "admin";
    readonly roles: readonly string[];
    readonly annotations: Readonly<Record<string, unknown>>;
    readonly parameters: readonly FixtureParameter[];
  };
  readonly frames: {
    readonly tool_register: {
      readonly keys: readonly string[];
      readonly toolKeys: readonly string[];
      readonly expected: { readonly type: string; readonly tools: readonly Record<string, unknown>[] };
    };
    readonly tool_call: {
      readonly keys: readonly string[];
      readonly wire: {
        readonly type: string;
        readonly call_id: string;
        readonly tool_name: string;
        readonly params: Readonly<Record<string, unknown>>;
      };
    };
    readonly tool_result: {
      readonly keys: readonly string[];
      readonly expected: Readonly<Record<string, unknown>>;
    };
    readonly tool_error: {
      readonly keys: readonly string[];
      readonly call: Readonly<Record<string, unknown>>;
      readonly expected: Readonly<Record<string, unknown>>;
    };
  };
}

const fixture = JSON.parse(
  readFileSync(`${root}/tests/sdk-contract/platools-protocol.json`, "utf8"),
) as Fixture;

/**
 * The frame key lists the platform documents, parsed out of its protocol header.
 *
 * Each line reads `{ type: "<name>", key, key?, nested: [...] }`. A nested value is
 * reduced to its key, and `?` is kept because it is the platform's statement that
 * the key is optional.
 */
function serverFrameKeys(): Map<string, string[]> {
  const source = readFileSync(`${root}/${fixture.server}`, "utf8");
  const found = new Map<string, string[]>();
  for (const match of source.matchAll(/^\s*\*\s*\{\s*type:\s*"([a-z_]+)",\s*(.*?)\s*\}\s*$/gmu)) {
    const [, type, rest] = match as unknown as [string, string, string];
    const flattened = rest.replace(/\{[^{}]*\}/gu, "").replace(/\[[^\]]*\]/gu, "");
    const keys = flattened
      .split(",")
      .map((key) => key.split(":")[0]!.trim())
      .filter((key) => key.length > 0);
    found.set(type, ["type", ...keys]);
  }
  return found;
}

/** A property's JSON types: `type` as a string or an array, plus every `anyOf` member's. */
function typesOf(property: Record<string, unknown>): string[] {
  const types = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") types.add(value);
    else if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") types.add(entry);
  };
  add(property["type"]);
  if (Array.isArray(property["anyOf"])) {
    for (const member of property["anyOf"] as Record<string, unknown>[]) add(member["type"]);
  }
  return [...types].sort();
}

/** The fixture's reading of an `input_schema`: see its `$comment`. */
function parametersOf(schema: Record<string, unknown>): FixtureParameter[] {
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema["required"] ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    types: typesOf(property),
    required: required.has(name),
    ...(Object.hasOwn(property, "default") && property["default"] !== null
      ? { default: property["default"] }
      : {}),
  }));
}

/** Drop the keys the platform marks optional when they are null, as it treats absent and null alike. */
function withoutOptionalNulls(frame: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const optional = new Set(keys.filter((key) => key.endsWith("?")).map((key) => key.slice(0, -1)));
  return Object.fromEntries(
    Object.entries(frame).filter(([key, value]) => !(optional.has(key) && (value === null || value === undefined))),
  );
}

const required = (keys: readonly string[]) => keys.filter((key) => !key.endsWith("?")).sort();
const allowed = (keys: readonly string[]) => keys.map((key) => key.replace(/\?$/u, "")).sort();

class FakeSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) listener(1000, Buffer.from(""));
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const silent: ClientLogger = { warn() {}, info() {}, error() {} };

/** The fixture's tool, declared the TypeScript way. */
function registryWithFixtureTool(): ToolRegistry {
  const registry = new ToolRegistry();
  const tool = makeToolFactory(registry);
  tool(
    {
      name: fixture.tool.name,
      description: fixture.tool.description,
      input: z.object({
        order_id: z.string(),
        quantity: z.number().int(),
        gift: z.boolean().default(false),
        note: z.string().nullable().optional(),
      }),
      auth: fixture.tool.auth,
      roles: fixture.tool.roles,
      annotations: fixture.tool.annotations,
    },
    async ({ order_id, quantity, gift }) => {
      const scope = currentScope();
      return {
        received: { order_id, quantity, gift },
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      };
    },
  );
  return registry;
}

async function openSession(): Promise<{ socket: FakeSocket; finish: () => Promise<void> }> {
  let socket: FakeSocket | null = null;
  const wsFactory: WsFactory = () => {
    socket = new FakeSocket();
    return socket as unknown as WsLike;
  };
  const client = new PlatoolsClient({
    url: "https://platos.example.com",
    secret: "service-secret",
    registry: registryWithFixtureTool(),
    wsFactory,
    logger: silent,
  });
  const session = client.runSession();
  const opened = socket as unknown as FakeSocket;
  opened.emit("open");
  return {
    socket: opened,
    finish: async () => {
      opened.close();
      await session;
    },
  };
}

async function deliver(socket: FakeSocket, frame: unknown): Promise<Record<string, unknown>> {
  const before = socket.sent.length;
  socket.emit("message", JSON.stringify(frame));
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent.length, "the client sent no reply frame").toBe(before + 1);
  return JSON.parse(socket.sent[socket.sent.length - 1]!) as Record<string, unknown>;
}

describe("platools-js speaks the protocol the shared fixture states", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("states exactly the frame keys the platform documents", () => {
    const server = serverFrameKeys();
    for (const name of ["tool_register", "tool_call", "tool_result", "tool_error"] as const) {
      expect(server.get(name), `${fixture.server} no longer documents ${name}`).toBeDefined();
      expect([...fixture.frames[name].keys].sort(), name).toEqual([...server.get(name)!].sort());
    }
  });

  it("registers the tool as the fixture's tool_register frame", async () => {
    const { socket, finish } = await openSession();
    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    const spec = fixture.frames.tool_register;

    expect(Object.keys(frame).sort()).toEqual([...spec.keys].sort());
    expect(frame["type"]).toBe(spec.expected.type);
    const tools = frame["tools"] as Record<string, unknown>[];
    expect(tools).toHaveLength(spec.expected.tools.length);
    const [sent] = tools;
    const [expected] = spec.expected.tools;
    expect(Object.keys(sent!).sort()).toEqual([...spec.toolKeys].sort());
    for (const [key, value] of Object.entries(expected!)) {
      expect(sent![key], `tools[0].${key}`).toEqual(value);
    }
    expect(sent!["input_schema"]).toMatchObject({ type: "object" });
    expect(parametersOf(sent!["input_schema"] as Record<string, unknown>)).toEqual(fixture.tool.parameters);
    await finish();
  });

  it("decodes the platform's tool_call frame without losing a field", () => {
    const { wire } = fixture.frames.tool_call;
    expect(Object.keys(wire).sort()).toEqual([...fixture.frames.tool_call.keys].sort());
    expect(decodePlatformMessage(JSON.stringify(wire))).toEqual(wire);
  });

  it("answers the tool_call with the fixture's tool_result frame", async () => {
    const { socket, finish } = await openSession();
    const frame = await deliver(socket, fixture.frames.tool_call.wire);
    const spec = fixture.frames.tool_result;

    expect(Object.keys(frame).sort()).toEqual(allowed(spec.keys));
    const { latency_ms: latency, ...rest } = frame;
    expect(Number.isInteger(latency) && (latency as number) >= 0, `latency_ms ${String(latency)}`).toBe(true);
    expect(rest).toEqual(spec.expected);
    await finish();
  });

  it("answers an unknown tool with the fixture's tool_error frame", async () => {
    const { socket, finish } = await openSession();
    const spec = fixture.frames.tool_error;
    const frame = await deliver(socket, spec.call);

    for (const key of required(spec.keys)) expect(Object.hasOwn(frame, key), key).toBe(true);
    for (const key of Object.keys(frame)) expect(allowed(spec.keys)).toContain(key);
    expect(withoutOptionalNulls(frame, spec.keys)).toEqual(spec.expected);
    await finish();
  });
});
