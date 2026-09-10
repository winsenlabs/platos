// THE READ LOOP AND THE CREDENTIAL FENCE, AGAINST A SCRIPTED JOURNAL.
//
// SPLIT OUT OF `sse.test.ts` under ADR M0.3 §6's file-size budget; see that file's
// banner for the seams. What is here is the one function that decides how long a
// reader is served and why it stops.
//
// THE FENCE'S ARITHMETIC IS THE REASON A DOUBLE IS THE RIGHT TOOL. `pumpStream`
// takes its clock as a PARAMETER precisely so the credential's expiry can be
// placed either side of a read without waiting for it, and a case that had to wait
// for a real window to close is a case nobody runs. The same fence is proven a
// SECOND time in `apps/core-api/src/composition/stream-lane.integration.test.ts`,
// with a real session whose window closes while a real socket is open — so it is
// proven once as arithmetic and once as an elapsed second, and neither proof
// stands in for the other.
//
// THE JOURNAL HERE IS SCRIPTED, AND EVERY OUTCOME THE PORT DECLARES IS REACHABLE
// THROUGH IT. That is the point of scripting it rather than driving Redis: the
// port declares `page`, `unknown`, `expired` and `unavailable`, and reaching
// `unavailable` against a real server means breaking the server mid-case. The
// REAL-server behaviour of each outcome is proven in
// `packages/adapters/redis-streams/src/journal.integration.test.ts`; what is
// proven here is what the LOOP does with each answer.

import { describe, expect, it } from "vitest";

import {
  admitFrame,
  encodeStreamCursor,
  STREAM_SCHEMA_VERSION,
  unwrap,
  type StreamCursor,
  type StreamFrame,
  type StreamJournal,
  type StreamReadOutcome,
  type StreamSeal,
} from "@platos/kernel";

import { DEFAULT_SSE_OPTIONS, encodeHeartbeat, type StreamResponse } from "./sse.js";
import { pumpStream, startingSequence, terminalErrorFrame } from "./streams.controller.js";

const STREAM = "env-1/turn-1";

function frame(seq: number, overrides: Partial<StreamFrame> = {}): StreamFrame {
  return {
    sv: STREAM_SCHEMA_VERSION,
    family: "sse.turn",
    t: "assistant.delta",
    seq,
    ts: 1_760_000_000_000 + seq,
    fields: { text: `chunk-${seq}` },
    ...overrides,
  };
}

function cursor(seq: number, stream = STREAM): StreamCursor {
  return unwrap(encodeStreamCursor(stream, seq));
}

/** A response that records what was written and can be told to stop draining. */
function recordingResponse(options: { readonly wedged?: boolean } = {}): StreamResponse & {
  readonly chunks: string[];
} {
  const chunks: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const response = {
    chunks,
    writableEnded: false,
    setHeader() {
      return undefined;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return options.wedged !== true;
    },
    end() {
      (response as { writableEnded: boolean }).writableEnded = true;
      return undefined;
    },
    once(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    off(event: string, listener: () => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((held) => held !== listener));
      return undefined;
    },
  };
  return response as unknown as StreamResponse & { readonly chunks: string[] };
}

/** A journal that answers from a script. Every outcome the port declares is reachable. */
function scriptedJournal(pages: readonly StreamReadOutcome[]): StreamJournal & { reads: number } {
  let index = 0;
  const journal = {
    reads: 0,
    async append() {
      return { kind: "appended" as const, cursor: null, trimmed: 0 };
    },
    async seal(_id: string, terminal: StreamSeal["terminal"], at: number) {
      return { kind: "sealed" as const, seal: { terminal, at } };
    },
    async read(): Promise<StreamReadOutcome> {
      journal.reads += 1;
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return page ?? { kind: "page", frames: [], cursor: null, seal: null };
    },
  };
  return journal as unknown as StreamJournal & { reads: number };
}

function page(frames: readonly StreamFrame[], seal: StreamSeal | null = null): StreamReadOutcome {
  const last = frames[frames.length - 1];
  return {
    kind: "page",
    frames,
    cursor: last === undefined ? null : cursor(last.seq),
    seal,
  };
}

describe("the pump", () => {
  const options = { ...DEFAULT_SSE_OPTIONS, heartbeatMs: 20, drainDeadlineMs: 200 };

  it("writes a page in order and stops on the producer's seal", async () => {
    const response = recordingResponse();
    const journal = scriptedJournal([
      page([frame(1), frame(2)]),
      page([], { terminal: "turn.done", at: 5 }),
    ]);
    const outcome = await pumpStream({
      journal,
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: Date.now() + 10_000,
      hasDisconnected: () => false,
      now: () => Date.now(),
      options,
      pageLimit: 64,
    });
    expect(outcome.kind).toBe("sealed");
    expect(outcome.lastSeq).toBe(2);
    const ids = response.chunks.filter((chunk) => chunk.startsWith("id: "));
    expect(ids.length).toBe(2);
    expect(ids[0]).toContain(cursor(1));
    expect(ids[1]).toContain(cursor(2));
  });

  it("STOPS AT THE CREDENTIAL EXPIRY, and reports the position it reached", async () => {
    const response = recordingResponse();
    const journal = scriptedJournal([page([frame(1)]), page([])]);
    // A clock that steps past the deadline on its third reading, so the fence is
    // reached with a frame already delivered.
    let ticks = 0;
    const outcome = await pumpStream({
      journal,
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: 1_000,
      hasDisconnected: () => false,
      now: () => {
        ticks += 1;
        return ticks < 3 ? 0 : 5_000;
      },
      options,
      pageLimit: 64,
    });
    expect(outcome).toEqual({ kind: "credential-expired", lastSeq: 1 });
  });

  it("stops at the expiry BEFORE reading when the credential is already spent", async () => {
    const journal = scriptedJournal([page([frame(1)])]);
    const outcome = await pumpStream({
      journal,
      streamId: STREAM,
      response: recordingResponse(),
      after: null,
      deadlineMs: 0,
      hasDisconnected: () => false,
      now: () => 1,
      options,
      pageLimit: 64,
    });
    expect(outcome.kind).toBe("credential-expired");
    // THE JOURNAL IS NEVER TOUCHED. A fence that read first would do work for a
    // credential that had already expired.
    expect(journal.reads).toBe(0);
  });

  it("reports a slow consumer without writing anything else to it", async () => {
    const response = recordingResponse({ wedged: true });
    const journal = scriptedJournal([page([frame(1), frame(2)])]);
    const outcome = await pumpStream({
      journal,
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: Date.now() + 10_000,
      hasDisconnected: () => false,
      now: () => Date.now(),
      options,
      pageLimit: 64,
    });
    expect(outcome).toEqual({ kind: "consumer-too-slow", lastSeq: 0 });
    // ONE attempted write and no more. A pump that kept going would hold every
    // later frame in this process's heap for a consumer that is not reading.
    expect(response.chunks.length).toBe(1);
  });

  it("ends the stream on an oversized frame rather than skipping it", async () => {
    const response = recordingResponse();
    const journal = scriptedJournal([page([frame(1), frame(2, { fields: { text: "x".repeat(500) } })])]);
    const outcome = await pumpStream({
      journal,
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: Date.now() + 10_000,
      hasDisconnected: () => false,
      now: () => Date.now(),
      options: { ...options, maxFrameBytes: 128 },
      pageLimit: 64,
    });
    expect(outcome).toEqual({ kind: "frame-too-large", lastSeq: 1 });
    // THE POSITION IS THE FRAME BEFORE IT, so a resuming client is handed the same
    // frame again rather than the one after it. Advancing first is how one bad
    // frame becomes a silent gap.
    expect(response.chunks.filter((chunk) => chunk.startsWith("id: ")).length).toBe(1);
  });

  it("carries the journal's own refusals out rather than turning them into frames", async () => {
    for (const [outcome, kind] of [
      [{ kind: "unavailable", reason: "x" } as StreamReadOutcome, "journal-unavailable"],
      [{ kind: "expired", earliest: null } as StreamReadOutcome, "cursor-expired"],
      [{ kind: "unknown" } as StreamReadOutcome, "sealed"],
    ] as const) {
      const pumped = await pumpStream({
        journal: scriptedJournal([outcome]),
        streamId: STREAM,
        response: recordingResponse(),
        after: null,
        deadlineMs: Date.now() + 10_000,
        hasDisconnected: () => false,
        now: () => Date.now(),
        options,
        pageLimit: 64,
      });
      expect(pumped.kind, JSON.stringify(outcome)).toBe(kind);
    }
  });

  it("stops the moment the client goes, without writing", async () => {
    const response = recordingResponse();
    const outcome = await pumpStream({
      journal: scriptedJournal([page([frame(1)])]),
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: Date.now() + 10_000,
      hasDisconnected: () => true,
      now: () => Date.now(),
      options,
      pageLimit: 64,
    });
    expect(outcome).toEqual({ kind: "disconnected", lastSeq: 0 });
    expect(response.chunks).toEqual([]);
  });

  it("sends a heartbeat on an idle unsealed stream and nothing else", async () => {
    const response = recordingResponse();
    let ticks = 0;
    const outcome = await pumpStream({
      journal: scriptedJournal([page([])]),
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: 500,
      hasDisconnected: () => false,
      // Reading 1 sits before the deadline and past the heartbeat interval, so one
      // beat is written; the next reading crosses the fence and the loop stops.
      now: () => {
        ticks += 1;
        return ticks <= 2 ? 100 : 900;
      },
      options,
      pageLimit: 64,
    });
    expect(outcome.kind).toBe("credential-expired");
    expect(response.chunks).toEqual([encodeHeartbeat()]);
  });

  it("keeps reading while a sealed stream still has a full page to deliver", async () => {
    // A seal with a FULL page means the reader has not caught up. Returning here
    // would drop every frame after the first page of a completed turn.
    const response = recordingResponse();
    const sealed = { terminal: "turn.done" as const, at: 1 };
    const journal = scriptedJournal([
      page([frame(1), frame(2)], sealed),
      page([frame(3)], sealed),
      page([], sealed),
    ]);
    const outcome = await pumpStream({
      journal,
      streamId: STREAM,
      response,
      after: null,
      deadlineMs: Date.now() + 10_000,
      hasDisconnected: () => false,
      now: () => Date.now(),
      options,
      pageLimit: 2,
    });
    expect(outcome).toEqual({ kind: "sealed", lastSeq: 3 });
    expect(response.chunks.filter((chunk) => chunk.startsWith("id: ")).length).toBe(3);
  });

  it("numbers a terminal frame from the RESUMED position, not from zero", () => {
    // The defect this exists to prevent: a reader that resumed at 400 and was
    // fenced before receiving anything would be handed a terminal frame numbered
    // 1, and its own `admitFrame` would call that a DUPLICATE and drop it —
    // leaving it with no explanation for a stream that stopped.
    expect(startingSequence(cursor(400))).toBe(400);
    expect(startingSequence(null)).toBe(0);
    expect(admitFrame(400, terminalErrorFrame(401, 1, "STREAM_CREDENTIAL_EXPIRED"))).toEqual({
      kind: "apply",
    });
    expect(admitFrame(400, terminalErrorFrame(0, 1, "STREAM_CREDENTIAL_EXPIRED"))).toEqual({
      kind: "duplicate",
    });
  });
});
