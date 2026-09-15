// THE V1 EVENT-STREAM READER, DRIVEN BY THE CROSS-LANGUAGE RESUME FIXTURE.
//
// WIN-272 (M4.6), "clients resume without missing or double-applying state".
// `tests/sdk-contract/v1-stream-resume.json` is read here and by
// `packages/platos-client-py/tests/test_v1_stream.py`. Every assertion joins to
// something this file does not control:
//
//   core-api's SSE encoders     the fixture's wire text must be exactly what
//                               `encodeStreamMeta`, `encodeSseFrame`,
//                               `encodeSseEvent` and `encodeHeartbeat` write;
//   the kernel                  cursors, admissions and stream ends must be what
//                               `encodeStreamCursor`, `admitFrame` and
//                               `classifyStreamEnd` return — the SDK's PORTS of
//                               those rules are run against the kernel's own
//                               functions over the same grid;
//   the generated client        the reader is reached through
//                               `createV1Client(...).environmentStreams.read`, the
//                               method `scripts/sdk/v1-contract.mjs` emits.
//
// WHERE EACH RECONNECT FELL IS PINNED PER CONNECTION: the Last-Event-ID each
// request carried, the frames each connection applied, and how each ended. A
// concatenation-only check is satisfied by one full half and one empty half, and
// this programme has been burned by exactly that.

import { readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sse from "../../../apps/core-api/src/transports/ws/sse.js";
import { isOk } from "../../kernel/src/vo/error.js";
import * as kernel from "../../kernel/src/vo/stream-frame.js";
import {
  EventStreamReader,
  PlatosRefusal,
  PlatosStreamError,
  SseParser,
  V1_OPERATIONS,
  V1HttpTransport,
  WIRE_ERROR_CODES,
  admitFrame,
  classifyStreamEnd,
  createV1Client,
  isResumable,
  type V1FrameAdmission,
  type V1StreamEnd,
  type V1StreamFrame,
  type V1StreamMeta,
} from "../src/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

type Write =
  | { readonly meta: { readonly sv: number; readonly replayFrom: string | null } }
  | { readonly frame: FrameWrite }
  | { readonly event: FrameWrite }
  | { readonly heartbeat: true };
interface FrameWrite {
  readonly t: string;
  readonly seq: number;
  readonly ts: number;
  readonly fields: Record<string, kernel.StreamFrame["fields"][string]>;
}
interface ConnectionExpect {
  readonly lastEventId: string | null;
  readonly meta: V1StreamMeta | null;
  readonly admissions: readonly { readonly seq: number; readonly kind: string; readonly missing?: number }[];
  readonly applied: readonly number[];
  readonly end: V1StreamEnd | null;
}
interface Connection {
  readonly response: { readonly status: number; readonly contentType: string };
  readonly writes: readonly Write[];
  readonly truncatedAfter: string | null;
  readonly wire: string;
  /** The body is `wire`'s UTF-8 cut at this many bytes, inside its last character; null sends all of it. */
  readonly endsAtByte: number | null;
  readonly byteBoundaries: readonly number[];
  readonly expect: ConnectionExpect;
}
interface Scenario {
  readonly name: string;
  readonly open: { readonly lastEventId: string | null; readonly lastSeq: number | null; readonly maxReconnects: number | null };
  readonly connections: readonly Connection[];
  readonly expect: {
    readonly applied: readonly number[];
    readonly text: string;
    readonly lastEventId: string;
    readonly lastSeq: number;
    readonly reconnects: number;
    readonly end: V1StreamEnd;
    /** The `PlatosStreamError` violation the scenario ends with, or null. */
    readonly error: string | null;
  };
}
interface Fixture {
  readonly environmentId: string;
  readonly streamId: string;
  readonly journalStreamId: string;
  readonly cursors: Readonly<Record<string, string>>;
  readonly admissionGrid: readonly { readonly lastApplied: number; readonly seq: number; readonly admission: V1FrameAdmission }[];
  readonly endGrid: readonly {
    readonly lastFrame: ({ readonly t: string } & Record<string, unknown>) | null;
    readonly resumeFrom: string | null;
    readonly end: V1StreamEnd;
    readonly resumable: boolean;
  }[];
  readonly scenarios: readonly Scenario[];
}

const fixture = JSON.parse(
  readFileSync(`${root}/tests/sdk-contract/v1-stream-resume.json`, "utf8"),
) as Fixture;

const FAMILY = "sse.turn" as const;
const kernelFrame = (write: FrameWrite): kernel.StreamFrame => ({
  sv: kernel.STREAM_SCHEMA_VERSION,
  family: FAMILY,
  t: write.t,
  seq: write.seq,
  ts: write.ts,
  fields: write.fields,
});
const cursorOf = (seq: number): string => {
  const encoded = kernel.encodeStreamCursor(fixture.journalStreamId, seq);
  if (!isOk(encoded)) throw new Error(`the kernel refused a cursor for seq ${seq}`);
  return encoded.value;
};

/** The server's own bytes for one write. */
function encode(write: Write): string {
  if ("meta" in write) return sse.encodeStreamMeta(write.meta.sv, write.meta.replayFrom as kernel.StreamCursor | null);
  if ("heartbeat" in write) return sse.encodeHeartbeat();
  const encoded =
    "frame" in write
      ? sse.encodeSseFrame(kernelFrame(write.frame), cursorOf(write.frame.seq) as kernel.StreamCursor, kernel.STREAM_MAX_FRAME_BYTES)
      : sse.encodeSseEvent(kernelFrame(write.event), kernel.STREAM_MAX_FRAME_BYTES);
  if (!encoded.ok) throw new Error("core-api's encoder refused a fixture frame");
  return encoded.bytes;
}

/** A body that hands the reader `wire` split at the fixture's UTF-8 byte offsets, and ended at `endsAtByte`. */
function bodyOf(connection: Connection): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(connection.wire).slice(0, connection.endsAtByte ?? undefined);
  const cuts = [0, ...connection.byteBoundaries, bytes.length];
  const pieces = cuts.slice(1).map((end, index) => bytes.slice(cuts[index], end));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

describe("the fixture is joined to core-api's encoders and to the kernel", () => {
  it("carries exactly the bytes core-api's SSE lane writes", () => {
    let checked = 0;
    for (const scenario of fixture.scenarios) {
      for (const [index, connection] of scenario.connections.entries()) {
        const where = `${scenario.name} connection ${index + 1}`;
        if (connection.response.status !== 200) {
          const envelope = JSON.parse(connection.wire) as { error: { code: string } };
          expect(WIRE_ERROR_CODES, where).toContain(envelope.error.code);
          continue;
        }
        const full = connection.writes.map(encode).join("");
        const expected =
          connection.truncatedAfter === null
            ? full
            : full.slice(0, full.indexOf(connection.truncatedAfter) + connection.truncatedAfter.length);
        expect(connection.truncatedAfter === null || full.includes(connection.truncatedAfter), where).toBe(true);
        expect(connection.wire, where).toBe(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(fixture.scenarios.length);
  });

  it("names cursors the kernel encodes, for the stream key the controller composes", () => {
    const controller = readFileSync(`${root}/apps/core-api/src/transports/ws/streams.controller.ts`, "utf8");
    expect(controller).toMatch(
      /export function journalStreamId\(environmentId: string, streamId: string\): string \{\s*return `\$\{environmentId\}\/\$\{streamId\}`;/u,
    );
    expect(fixture.journalStreamId).toBe(`${fixture.environmentId}/${fixture.streamId}`);
    for (const [seq, cursor] of Object.entries(fixture.cursors)) {
      expect(cursor).toBe(cursorOf(Number(seq)));
      const decoded = kernel.decodeStreamCursor(cursor);
      expect(isOk(decoded) && decoded.value).toEqual({ streamId: fixture.journalStreamId, seq: Number(seq) });
    }
  });

  it("states the kernel's admissions, and the SDK's port agrees with the kernel on every row", () => {
    expect(fixture.admissionGrid.length).toBeGreaterThanOrEqual(25);
    for (const row of fixture.admissionGrid) {
      const frame = kernelFrame({ t: "assistant.delta", seq: row.seq, ts: 0, fields: {} });
      expect(kernel.admitFrame(row.lastApplied, frame), JSON.stringify(row)).toEqual(row.admission);
      expect(admitFrame(row.lastApplied, frame), JSON.stringify(row)).toEqual(row.admission);
    }
    const kinds = new Set(fixture.admissionGrid.map((row) => row.admission.kind));
    expect([...kinds].sort()).toEqual(["apply", "duplicate", "gap"]);
  });

  it("states the kernel's stream ends, and the SDK's port agrees with the kernel on every row", () => {
    for (const row of fixture.endGrid) {
      const where = JSON.stringify(row);
      const { t, ...fields } = row.lastFrame ?? { t: "" };
      const frame = row.lastFrame === null ? null : kernelFrame({ t, seq: 1, ts: 0, fields: fields as FrameWrite["fields"] });
      const kernelEnd = kernel.classifyStreamEnd(frame, row.resumeFrom as kernel.StreamCursor | null);
      expect(kernelEnd, where).toEqual(row.end);
      expect(kernel.isResumable(kernelEnd), where).toBe(row.resumable);
      const portEnd = classifyStreamEnd(row.lastFrame, row.resumeFrom);
      expect(portEnd, where).toEqual(row.end);
      expect(isResumable(portEnd), where).toBe(row.resumable);
    }
    const kinds = new Set(fixture.endGrid.map((row) => row.end.kind));
    expect([...kinds].sort()).toEqual(["completed", "failed", "interrupted", "severed"]);
  });

  it("states, per connection, what the kernel's rules make of the frames each one carries", () => {
    for (const scenario of fixture.scenarios) {
      let lastApplied = scenario.open.lastSeq ?? 0;
      let lastCursor = scenario.open.lastEventId;
      for (const [index, connection] of scenario.connections.entries()) {
        const where = `${scenario.name} connection ${index + 1}`;
        if (connection.response.status !== 200) {
          expect(connection.expect.applied, where).toEqual([]);
          continue;
        }
        // Only frames whose event reached its blank line are dispatched.
        const frames: { write: FrameWrite; id: boolean }[] = [];
        for (const write of connection.writes) {
          if (!("frame" in write) && !("event" in write)) continue;
          const text = encode(write);
          const start = connection.writes.slice(0, connection.writes.indexOf(write)).map(encode).join("").length;
          if (start + text.length > connection.wire.length) break;
          frames.push("frame" in write ? { write: write.frame, id: true } : { write: write.event, id: false });
        }
        const admissions: ConnectionExpect["admissions"][number][] = [];
        const applied: number[] = [];
        let end: V1StreamEnd | null = null;
        let lastReceived: kernel.StreamFrame | null = null;
        for (const { write, id } of frames) {
          const frame = kernelFrame(write);
          lastReceived = frame;
          const admission = kernel.admitFrame(lastApplied, frame);
          admissions.push({ seq: write.seq, ...admission });
          if (admission.kind === "duplicate") continue;
          if (admission.kind === "gap") {
            lastReceived = null;
            end = null;
            break;
          }
          lastApplied = write.seq;
          if (id) lastCursor = cursorOf(write.seq);
          applied.push(write.seq);
          if (kernel.isTerminalFrameType(write.t)) break;
        }
        const gapped = admissions.some((entry) => entry.kind === "gap");
        if (!gapped) end = kernel.classifyStreamEnd(lastReceived, lastCursor as kernel.StreamCursor | null) as V1StreamEnd;
        expect(admissions, where).toEqual(connection.expect.admissions);
        expect(applied, where).toEqual(connection.expect.applied);
        expect(end, where).toEqual(connection.expect.end);
      }
    }
  });
});

/** Run one scenario through the generated client and record what happened on each connection. */
async function drive(scenario: Scenario) {
  const requests: { url: string; headers: Record<string, string>; method: string }[] = [];
  const connections = scenario.connections.map(() => ({
    lastEventId: null as string | null | undefined,
    meta: null as V1StreamMeta | null,
    admissions: [] as { seq: number; kind: string; missing?: number }[],
    applied: [] as number[],
    end: null as V1StreamEnd | null,
  }));
  let stream: ReturnType<ReturnType<typeof createV1Client>["environmentStreams"]["read"]> | null = null;
  const current = () => connections[requests.length - 1]!;
  const client = createV1Client({
    baseUrl: "https://platos.example.com",
    operatorToken: "operator-token",
    sleep: async () => {
      // Between connections: the one that just ended has classified itself.
      current().end = stream?.end ?? null;
      // The reader sleeps before EVERY reconnect, outside its own error handling, so
      // a reader about to open a connection the scenario does not have fails here,
      // at once, instead of reconnecting forever against a fetch it swallows errors from.
      if (requests.length >= scenario.connections.length) {
        throw new Error(`${scenario.name}: the reader is reconnecting past the scenario's last connection`);
      }
    },
    fetch: (async (url: string, init: RequestInit) => {
      const headers = { ...(init.headers as Record<string, string>) };
      requests.push({ url, headers, method: String(init.method) });
      const connection = scenario.connections[requests.length - 1];
      if (connection === undefined) throw new Error(`${scenario.name}: the reader opened an extra connection`);
      current().lastEventId = headers["last-event-id"] ?? null;
      return new Response(connection.response.status === 200 ? bodyOf(connection) : connection.wire, {
        status: connection.response.status,
        headers: { "content-type": connection.response.contentType },
      });
    }) as unknown as typeof globalThis.fetch,
  });
  stream = client.environmentStreams.read(fixture.environmentId, fixture.streamId, {
    ...(scenario.open.lastEventId === null ? {} : { lastEventId: scenario.open.lastEventId }),
    ...(scenario.open.lastSeq === null ? {} : { lastSeq: scenario.open.lastSeq }),
    ...(scenario.open.maxReconnects === null ? {} : { maxReconnects: scenario.open.maxReconnects }),
    onConnect: ({ meta }) => {
      current().meta = meta;
    },
    onAdmission: (frame, admission) => {
      current().admissions.push({ seq: frame.seq, ...admission });
    },
  });
  expect(requests, "nothing may be sent before iteration").toHaveLength(0);
  const frames: V1StreamFrame[] = [];
  let error: string | null = null;
  try {
    for await (const frame of stream) {
      frames.push(frame);
      current().applied.push(frame.seq);
    }
  } catch (thrown) {
    if (!(thrown instanceof PlatosStreamError)) throw thrown;
    error = thrown.violation;
  }
  current().end = stream.end;
  return { requests, connections, frames, stream, error };
}

describe("the TypeScript reader does what each scenario states, connection by connection", () => {
  it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))("%s", async (_name, scenario) => {
    const { requests, connections, frames, stream, error } = await drive(scenario);

    expect(requests).toHaveLength(scenario.connections.length);
    for (const [index, request] of requests.entries()) {
      expect(request.method).toBe("GET");
      const template = V1_OPERATIONS.find((operation) => operation.responseKind === "event-stream")!.template;
      expect(request.url).toBe(
        `https://platos.example.com${template
          .replace(":environmentId", fixture.environmentId)
          .replace(":streamId", fixture.streamId)}`,
      );
      expect(request.headers["accept"]).toBe("text/event-stream");
      expect(request.headers["authorization"]).toBe("Bearer operator-token");
      expect(request.headers["idempotency-key"], `connection ${index + 1}`).toBeUndefined();
    }
    for (const [index, connection] of scenario.connections.entries()) {
      const where = `${scenario.name} connection ${index + 1}`;
      expect(connections[index]!.lastEventId, `${where} Last-Event-ID`).toBe(connection.expect.lastEventId);
      expect(connections[index]!.meta, `${where} meta`).toEqual(connection.expect.meta);
      expect(connections[index]!.admissions, `${where} admissions`).toEqual(connection.expect.admissions);
      expect(connections[index]!.applied, `${where} applied`).toEqual(connection.expect.applied);
      expect(connections[index]!.end, `${where} end`).toEqual(connection.expect.end);
    }
    expect(frames.map((frame) => frame.seq)).toEqual(scenario.expect.applied);
    expect(frames.map((frame) => (typeof frame["text"] === "string" ? frame["text"] : "")).join("")).toBe(scenario.expect.text);
    expect(stream.lastEventId).toBe(scenario.expect.lastEventId);
    expect(stream.lastSeq).toBe(scenario.expect.lastSeq);
    expect(stream.reconnects).toBe(scenario.expect.reconnects);
    expect(stream.end).toEqual(scenario.expect.end);
    expect(error).toBe(scenario.expect.error);
  });

  it("pins a reconnect in the middle of the sequence, not at either edge", () => {
    const [first, second] = fixture.scenarios.find((scenario) => scenario.name === "severed-mid-frame")!.connections;
    expect(first!.expect.applied.length).toBeGreaterThan(0);
    expect(second!.expect.applied.length).toBeGreaterThan(0);
    expect(first!.expect.applied.at(-1)! + 1).toBe(second!.expect.applied[0]);
    // The first connection's wire ends INSIDE a frame, and the frame it tears is the
    // second connection's first.
    expect(first!.wire.endsWith("\n\n")).toBe(false);
    expect(first!.truncatedAfter).toContain(`"seq":${second!.expect.applied[0]}`);
  });

  it("resumes a close-delimited body cut inside a character over a REAL socket, with the runtime's own fetch", async () => {
    // The fake body above models a clean close as the stream closing. This checks
    // that model against a real HTTP/1.1 response with no Content-Length and no
    // chunking, ended by the server closing the socket between two bytes of one
    // character, read by the default `globalThis.fetch`.
    const scenario = fixture.scenarios.find((entry) => entry.name === "severed-inside-a-character")!;
    const seen: (string | null)[] = [];
    let served = 0;
    const server = createServer((socket) => {
      const connection = scenario.connections[served++];
      let request = "";
      socket.on("data", (piece) => {
        request += piece.toString("latin1");
        if (!request.includes("\r\n\r\n")) return;
        const match = /^last-event-id:\s*(.*)$/imu.exec(request.split("\r\n\r\n")[0]!);
        seen.push(match === null ? null : match[1]!.trim());
        if (connection === undefined) return void socket.destroy();
        const body = new TextEncoder().encode(connection.wire).slice(0, connection.endsAtByte ?? undefined);
        socket.write(`HTTP/1.1 200 OK\r\ncontent-type: ${connection.response.contentType}\r\nconnection: close\r\n\r\n`);
        socket.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = createV1Client({ baseUrl: `http://127.0.0.1:${port}`, sleep: async () => {} });
      const stream = client.environmentStreams.read(fixture.environmentId, fixture.streamId, { idleTimeoutMs: 10_000 });
      const frames: V1StreamFrame[] = [];
      for await (const frame of stream) frames.push(frame);
      expect(frames.map((frame) => frame.seq)).toEqual(scenario.expect.applied);
      expect(frames.map((frame) => (typeof frame["text"] === "string" ? frame["text"] : "")).join("")).toBe(scenario.expect.text);
      expect(seen).toEqual(scenario.connections.map((connection) => connection.expect.lastEventId));
      expect(stream.reconnects).toBe(scenario.expect.reconnects);
      expect(stream.end).toEqual(scenario.expect.end);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("pins a clean close INSIDE a character at the connection's end, not at a chunk boundary", () => {
    const cut = fixture.scenarios.flatMap((scenario) => scenario.connections).filter((c) => c.endsAtByte !== null);
    expect(cut.length).toBeGreaterThan(0);
    for (const connection of cut) {
      const bytes = new TextEncoder().encode(connection.wire);
      const last = new TextEncoder().encode([...connection.wire].at(-1)!);
      // Strictly inside the last character: at least one byte of it sent, at least one withheld.
      expect(last.length).toBeGreaterThan(1);
      expect(connection.endsAtByte!).toBeGreaterThan(bytes.length - last.length);
      expect(connection.endsAtByte!).toBeLessThan(bytes.length);
      // The withheld byte is a UTF-8 continuation byte, so no decoder can finish the character.
      expect(bytes[connection.endsAtByte!]! & 0xc0).toBe(0x80);
      for (const boundary of connection.byteBoundaries) expect(boundary).toBeLessThan(connection.endsAtByte!);
    }
    const [first, second] = fixture.scenarios.find((scenario) => scenario.name === "severed-inside-a-character")!.connections;
    expect(first!.endsAtByte).not.toBeNull();
    expect(first!.expect.applied.length).toBeGreaterThan(0);
    expect(first!.expect.end?.kind).toBe("severed");
    expect(first!.expect.applied.at(-1)! + 1).toBe(second!.expect.applied[0]);
    expect(first!.truncatedAfter).toContain(first!.wire.at(-1)!);
  });

  it("pins the budget to reconnects in a row without progress, in both directions", () => {
    const renewed = fixture.scenarios.find((scenario) => scenario.name === "progress-restores-the-budget")!;
    const exhausted = fixture.scenarios.find((scenario) => scenario.name === "a-fruitless-run-exhausts-the-budget")!;
    // More reconnects than the budget, and the stream still finishes: a lifetime budget cannot pass this.
    expect(renewed.expect.reconnects).toBeGreaterThan(renewed.open.maxReconnects!);
    expect(renewed.expect.error).toBeNull();
    expect(renewed.connections.every((connection) => connection.expect.applied.length > 0)).toBe(true);
    // A connection that answers stream_meta but applies nothing is not progress: a
    // budget restored by merely connecting cannot pass this.
    expect(exhausted.expect.error).toBe("STREAM_RECONNECTS_EXHAUSTED");
    expect(exhausted.expect.reconnects).toBeGreaterThan(exhausted.open.maxReconnects!);
    const budget = exhausted.open.maxReconnects!;
    const trailing = exhausted.connections.slice(-budget);
    expect(trailing).toHaveLength(budget);
    expect(trailing.every((connection) => connection.expect.applied.length === 0 && connection.expect.meta !== null)).toBe(true);
    expect(exhausted.connections.at(-(budget + 1))!.expect.applied.length).toBeGreaterThan(0);
    // And a fruitless connection EARLIER in the stream did not spend what progress restored.
    expect(exhausted.connections.slice(0, -(budget + 1)).some((connection) => connection.expect.applied.length === 0)).toBe(true);
  });
});

describe("the reader refuses what the lane never sends", () => {
  const streamOperation = V1_OPERATIONS.find((operation) => operation.responseKind === "event-stream")!;
  const jsonOperation = V1_OPERATIONS.find((operation) => operation.responseKind === "json")!;
  const [firstConnection] = fixture.scenarios[0]!.connections;

  const answering = (...answers: (() => Response)[]) => {
    const calls: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push({ ...(init.headers as Record<string, string>) });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      return answer();
    }) as unknown as typeof globalThis.fetch;
    // A bound on the harness, not on the reader: a reader whose budget never runs out
    // fails here instead of spinning the event loop on microtasks forever.
    const sleep = async () => {
      if (calls.length > 50) throw new Error("the reader kept reconnecting past 50 connections");
    };
    return { calls, client: createV1Client({ baseUrl: "https://platos.example.com", fetch: fetchImpl, sleep }) };
  };
  const eventStream = (text: string, status = 200) => () =>
    new Response(text, { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  const drain = async (stream: AsyncIterable<unknown>) => {
    for await (const _frame of stream) {
      // consumed
    }
  };

  it("routes an event stream through stream(), never through the JSON send()", async () => {
    const transport = new V1HttpTransport({ baseUrl: "https://platos.example.com" });
    await expect(
      transport.send({ operation: streamOperation, path: streamOperation.template, body: undefined, query: undefined }),
    ).rejects.toThrow(/answers with an event stream; read it through stream\(\)/u);
    expect(() =>
      transport.stream({ operation: jsonOperation, path: jsonOperation.template, body: undefined, query: undefined }),
    ).toThrow(/answers with JSON; call it through send\(\)/u);
  });

  it("refuses a body that is not an event stream", async () => {
    const { client } = answering(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(drain(client.environmentStreams.read("e", "s"))).rejects.toMatchObject({ violation: "STREAM_MEDIA_TYPE" });
  });

  it("refuses an sv outside the kernel's band", async () => {
    const { client } = answering(eventStream('event: stream_meta\ndata: {"sv":2,"replayFrom":null}\n\n'));
    await expect(drain(client.environmentStreams.read("e", "s"))).rejects.toMatchObject({ violation: "STREAM_VERSION_UNSUPPORTED" });
  });

  it("refuses a server that resumed from a position this reader did not ask for", async () => {
    const { client } = answering(eventStream(`event: stream_meta\ndata: {"sv":1,"replayFrom":"${fixture.cursors["2"]}"}\n\n`));
    await expect(drain(client.environmentStreams.read("e", "s"))).rejects.toMatchObject({ violation: "STREAM_REPLAY_MISMATCH" });
  });

  it("refuses a frame that arrives before stream_meta", async () => {
    const { client } = answering(eventStream(firstConnection!.wire.slice(firstConnection!.wire.indexOf("id: "))));
    await expect(drain(client.environmentStreams.read("e", "s"))).rejects.toMatchObject({ violation: "STREAM_META_MISSING" });
  });

  it("throws a non-retryable refusal without reconnecting", async () => {
    const { calls, client } = answering(
      () =>
        new Response(
          JSON.stringify({ error: { code: "STREAM_CURSOR_EXPIRED", title: "t", body: "b", errorId: "e", traceRef: "r", version: "1" } }),
          { status: 409 },
        ),
    );
    const error = await drain(client.environmentStreams.read("e", "s")).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlatosRefusal);
    expect((error as PlatosRefusal).code).toBe("STREAM_CURSOR_EXPIRED");
    expect(calls).toHaveLength(1);
  });

  it("stops after its reconnect budget, with every retry carrying the last applied cursor", async () => {
    const severedAfterOne = eventStream(
      `event: stream_meta\ndata: {"sv":1,"replayFrom":null}\n\nid: ${fixture.cursors["1"]}\ndata: {"sv":1,"t":"assistant.delta","seq":1,"ts":1}\n\n`,
    );
    const resumedNothing = eventStream(`event: stream_meta\ndata: {"sv":1,"replayFrom":"${fixture.cursors["1"]}"}\n\n`);
    const { calls, client } = answering(severedAfterOne, resumedNothing);
    const stream = client.environmentStreams.read("e", "s", { maxReconnects: 2 });
    const error = await drain(stream).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PlatosStreamError);
    expect((error as PlatosStreamError).violation).toBe("STREAM_RECONNECTS_EXHAUSTED");
    expect(calls.map((headers) => headers["last-event-id"] ?? null)).toEqual([null, fixture.cursors["1"], fixture.cursors["1"]]);
    expect(stream.reconnects).toBe(2);
  });

  it("refuses a resume position that names a cursor without its sequence", () => {
    const { client } = answering(eventStream(""));
    expect(() => client.environmentStreams.read("e", "s", { lastEventId: fixture.cursors["2"]! })).toThrow(/resume together/u);
    expect(() => new EventStreamReader({} as never, { lastSeq: 2 })).toThrow(/resume together/u);
  });

  it("is read once", async () => {
    const { client } = answering(eventStream(fixture.scenarios.find((s) => s.name === "failed-is-final")!.connections[0]!.wire));
    const stream = client.environmentStreams.read("e", "s");
    await drain(stream);
    await expect(drain(stream)).rejects.toThrow(/read once/u);
  });
});

describe("the reader runs on a browser's fetch", () => {
  const onlyStream = fixture.scenarios.find((scenario) => scenario.name === "failed-is-final")!.connections[0]!;
  const streamAnswer = () =>
    new Response(onlyStream.wire, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
  const jsonAnswer = () => new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } });

  /**
   * A fetch with the WebIDL receiver check a browser's has: `Window.fetch` called
   * with `this` bound to anything but the global object (or nothing) throws
   * "Illegal invocation". Node's fetch does not check, which is why every
   * Node-driven case passed while a browser could not open a single stream.
   */
  const brandChecked = (answer: () => Response, inits: RequestInit[]) =>
    function fetch(this: unknown, _url: string, init: RequestInit) {
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
      }
      const response = answer();
      inits.push(init);
      return Promise.resolve(response);
    } as unknown as typeof globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the DEFAULT fetch as a plain function, on the stream path as on the JSON path", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", brandChecked(() => (inits.length === 0 ? jsonAnswer() : streamAnswer()), inits));
    const client = createV1Client({ baseUrl: "https://platos.example.com", sleep: async () => {} });
    await expect(client.organizations.list()).resolves.toEqual({ data: [], nextCursor: null });
    const stream = client.environmentStreams.read("e", "s", { maxReconnects: 0 });
    const types: string[] = [];
    for await (const frame of stream) types.push(frame.t);
    expect(types.at(-1)).toBe("stream.error");
    expect(stream.reconnects).toBe(0);
    expect(inits).toHaveLength(2);
  });

  it("calls an INJECTED fetch as a plain function too, when the reader is built directly", async () => {
    const inits: RequestInit[] = [];
    const reader = new EventStreamReader(
      {
        url: "https://platos.example.com/stream",
        method: "GET",
        headers: {},
        fetch: brandChecked(streamAnswer, inits),
        sleep: async () => {},
        backoffMs: () => 0,
      },
      { maxReconnects: 0 },
    );
    for await (const _frame of reader) {
      // consumed
    }
    expect(reader.end?.kind).toBe("failed");
    expect(inits).toHaveLength(1);
  });

  it("merges fetchOptions into every stream request, as send() does, under the reader's own method, headers and signal", async () => {
    const inits: RequestInit[] = [];
    const external = new AbortController();
    const client = createV1Client({
      baseUrl: "https://platos.example.com",
      operatorToken: "operator-token",
      fetch: brandChecked(streamAnswer, inits),
      fetchOptions: {
        credentials: "include",
        mode: "cors",
        cache: "no-store",
        method: "POST",
        headers: { "x-dropped": "1" },
        signal: external.signal,
      },
      sleep: async () => {},
    });
    await expect(client.organizations.list().catch(() => "sent")).resolves.toBeDefined();
    inits.length = 0;
    const stream = client.environmentStreams.read("e", "s", { maxReconnects: 0 });
    for await (const _frame of stream) {
      // consumed
    }
    expect(inits).toHaveLength(1);
    const [init] = inits;
    expect(init!.credentials).toBe("include");
    expect(init!.mode).toBe("cors");
    expect(init!.cache).toBe("no-store");
    expect(init!.method).toBe("GET");
    expect(init!.headers).toEqual({ authorization: "Bearer operator-token", accept: "text/event-stream" });
    // The request's signal is the reader's own (idle timeout, iteration stop), wired to the caller's.
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal).not.toBe(external.signal);
  });
});

describe("the event-stream parser follows the WHATWG interpretation", () => {
  const all = (pieces: string[]) => {
    const parser = new SseParser();
    return pieces.flatMap((piece) => parser.push(piece));
  };

  it("ends lines on CRLF, CR and LF, including a CRLF split across pieces", () => {
    expect(all(["data: a\r", "\n\r\ndata: b\rdata: c\n\n"])).toEqual([
      { event: "message", data: "a", id: "" },
      { event: "message", data: "b\nc", id: "" },
    ]);
  });

  it("strips one leading BOM, ignores comments and joins data lines", () => {
    const BOM = String.fromCharCode(0xfeff);
    expect(all([`${BOM}: hello\nevent: x\ndata:one\ndata: two\n\n`])).toEqual([{ event: "x", data: "one\ntwo", id: "" }]);
  });

  it("keeps the id buffer across events, ignores an id holding NULL, and dispatches nothing without data", () => {
    const nul = String.fromCharCode(0);
    expect(all([`id: 7\ndata: a\n\nid: 8${nul}\ndata: b\n\nevent: only\n\ndata: c\n\n`])).toEqual([
      { event: "message", data: "a", id: "7" },
      { event: "message", data: "b", id: "7" },
      { event: "message", data: "c", id: "7" },
    ]);
  });

  it("reads retry only when it is all digits, and discards an event the stream ends inside", () => {
    const parser = new SseParser();
    parser.push("retry: 1500\nretry: soon\ndata: torn");
    expect(parser.retryMs).toBe(1500);
    parser.finish();
    expect(parser.push("\n\n")).toEqual([]);
  });
});
