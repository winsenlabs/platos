/**
 * AT MOST ONE TERMINAL FRAME PER STREAM, READ BACK OFF A REAL SOCKET.
 *
 * WHAT WAS WRONG. `StreamingService.streamToSSE`'s failure path wrote an `error`
 * frame AND THEN a `done` frame. `done` is also what a COMPLETED turn ends on,
 * so a client reading to the end of a failed stream saw the same last frame a
 * successful one produces: the failure was unreportable, and a reader that acted
 * on the ending had already been told the wrong thing.
 *
 * WHERE THE RULE COMES FROM. Not from this file.
 * `apps/core-api/src/transports/ws/streams.controller.ts` writes the canonical
 * lane's terminal frame in ONE function so that "at most one terminal frame per
 * stream is a property of one function rather than of every branch", and it names
 * THIS file, by path, twice, as the counter-example it was built not to be. This
 * suite is the legacy lane holding the same rule.
 *
 * WHY OVER A SOCKET RATHER THAN OVER A FAKE `Response`. A recorder that collects
 * `write()` arguments proves what the service CALLED; the acceptance is about
 * what a client RECEIVES. So the subject is mounted on a real `node:http`
 * listener, driven with real `fetch`, and the reply is split on the SSE
 * grammar's own frame separator — the blank line — rather than on anything this
 * file decides. The chunk boundaries are the kernel's, not ours, which is
 * exactly the difference that makes "nothing follows the terminal frame" a claim
 * about the wire.
 *
 * THE NEGATIVE CONTROL IS THE OLD BYTES. The last case feeds the frame counter
 * the exact two-frame tail the service used to emit and requires it to report
 * TWO. Without it a counter that could never see a duplicate would pass every
 * case above while proving nothing.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "../agent-runtime/agent.service";
import { StreamingService } from "./streaming.service";

/** The two event types that END a turn, as `AgentStreamEvent` declares them. */
const TERMINAL_TYPES = new Set(["done", "error"]);

interface Frame {
  readonly id: number | null;
  readonly data: Record<string, unknown>;
}

/**
 * Split an SSE body into frames, per the grammar and not per a convenience.
 *
 * A frame ends at a BLANK LINE; `id:` and `data:` are field names with an
 * optional single leading space in the value. Nothing here knows what a Platos
 * frame contains — that is what the cases assert.
 */
function parseFrames(body: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of body.split("\n\n")) {
    if (block.trim() === "") continue;
    let id: number | null = null;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trimStart());
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    frames.push({ id, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
  }
  return frames;
}

function terminalFrames(frames: Frame[]): Frame[] {
  return frames.filter((frame) => TERMINAL_TYPES.has(String(frame.data.type)));
}

async function* producer(
  events: AgentStreamEvent[],
  throwAtEnd?: Error,
): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) yield event;
  if (throwAtEnd) throw throwAtEnd;
}

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

/**
 * Mount the subject on a real listener and read the whole reply back.
 *
 * `http.ServerResponse` carries every member `streamToSSE` touches —
 * `setHeader`, `flushHeaders`, `write`, `end` — so the express type is a
 * compile-time cast over the same runtime object the framework hands it.
 */
async function driveOverSocket(
  events: AgentStreamEvent[],
  throwAtEnd?: Error,
): Promise<{ frames: Frame[]; body: string; status: number }> {
  const service = new StreamingService();
  const local = createServer((_request, response) => {
    void service.streamToSSE(producer(events, throwAtEnd), response as unknown as Response);
  });
  server = local;
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", () => resolve()));
  const { port } = local.address() as AddressInfo;
  const reply = await fetch(`http://127.0.0.1:${port}/stream`);
  const body = await reply.text();
  return { frames: parseFrames(body), body, status: reply.status };
}

describe("the legacy SSE lane's terminal frame, over a real socket", () => {
  it("a COMPLETED turn ends on exactly one terminal frame, and it is the producer's `done`", async () => {
    const { frames, status } = await driveOverSocket([
      { type: "token", text: "Hel" },
      { type: "token", text: "lo" },
      { type: "done" },
    ]);
    expect(status).toBe(200);
    // The control for every case below: the lane really does relay frames, so a
    // count of one terminal frame is not a count of one frame.
    expect(frames.map((frame) => frame.data.type)).toEqual(["token", "token", "done"]);
    expect(terminalFrames(frames)).toHaveLength(1);
    expect(frames.at(-1)!.data.type).toBe("done");
  });

  it("a FAILED turn ends on exactly one terminal frame, it is `error`, and NOTHING follows it", async () => {
    // This is the case that used to emit two: an `error` frame and then a `done`.
    const { frames } = await driveOverSocket(
      [{ type: "token", text: "partial" }],
      new Error("upstream exploded"),
    );
    expect(frames.map((frame) => frame.data.type)).toEqual(["token", "error"]);
    expect(terminalFrames(frames)).toHaveLength(1);
    // A `done` ANYWHERE in a failed stream is the defect, not only a `done` last:
    // a client that scans for a success marker finds it either way.
    expect(frames.some((frame) => frame.data.type === "done")).toBe(false);
    expect(frames.at(-1)!.data).toMatchObject({ type: "error", message: "upstream exploded" });
  });

  it("a throw AFTER the producer's own terminal frame adds NOTHING — the `sealed` case", async () => {
    // The generator terminated the turn and then failed on the way out. The
    // client already has its ending; a second frame would contradict an ending it
    // has acted on. The canonical lane's `sealed` outcome writes nothing for
    // exactly this reason.
    const { frames } = await driveOverSocket(
      [{ type: "token", text: "all of it" }, { type: "done" }],
      new Error("cleanup failed after the turn completed"),
    );
    expect(frames.map((frame) => frame.data.type)).toEqual(["token", "done"]);
    expect(terminalFrames(frames)).toHaveLength(1);
  });

  it("the producer's OWN `error` frame is not followed by a transport-minted second one", async () => {
    // The turn failed inside the runtime, which reported it as a frame, and then
    // the generator threw as well. One failure, one terminal frame — and it is
    // the producer's, carrying the producer's message.
    const { frames } = await driveOverSocket(
      [{ type: "error", message: "budget cap reached", code: "budget_cap" }],
      new Error("and then the generator threw"),
    );
    expect(terminalFrames(frames)).toHaveLength(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toMatchObject({ type: "error", message: "budget cap reached" });
    expect(frames[0]!.data.message).not.toBe("and then the generator threw");
  });

  it("frame ids are gapless and strictly increasing across a failure", async () => {
    // The `error` frame is numbered `lastSeq + 1`. A repeated id is what makes a
    // correct client DROP the terminal frame as a duplicate, which turns a
    // reported failure back into a silent truncation.
    const { frames } = await driveOverSocket(
      [{ type: "token", text: "a" }, { type: "token", text: "b" }],
      new Error("late failure"),
    );
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3]);
    expect(frames.map((frame) => frame.data._seq)).toEqual([1, 2, 3]);
  });

  it("THE NEGATIVE CONTROL: the counter reports TWO for the bytes this lane used to send", () => {
    // Byte-for-byte what the old failure path put on the wire. If the counter
    // could not see this, every case above would pass on a lane that still
    // emitted both frames.
    const old =
      `id: 2\ndata: ${JSON.stringify({ type: "error", message: "boom", _seq: 2 })}\n\n` +
      `id: 3\ndata: ${JSON.stringify({ type: "done", _seq: 3 })}\n\n`;
    const frames = parseFrames(old);
    expect(frames).toHaveLength(2);
    expect(terminalFrames(frames)).toHaveLength(2);
    expect(frames.map((frame) => frame.data.type)).toEqual(["error", "done"]);
  });
});
