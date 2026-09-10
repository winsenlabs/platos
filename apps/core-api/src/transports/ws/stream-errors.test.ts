// THE STREAM LANE'S SIX REFUSALS, AND THE JOIN THAT KEEPS THEM HONEST.
//
// SPLIT OUT OF `sse.test.ts` FOR A REASON WORTH RECORDING: that file reached 495
// effective lines against ADR M0.3 §6's warn-at-400 / fail-at-500 budget, so it was
// one case away from a hard failure. Splitting on the seam the file already had —
// the MECHANICS above, the VOCABULARY here — is what the budget is for.
//
// THE JOIN IS TO A FILE THIS SUITE DOES NOT CONTROL. `docs/error-taxonomy.json` is
// read off disk and compared in BOTH directions: a code minted by this lane with
// no entry fails `audit:error-taxonomy` E1, and a mint whose CATEGORY drifted from
// its entry fails here. Neither half is an assertion against a value this file
// wrote, which is the property this programme's first lesson is about.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { classifyStreamEnd, encodeStreamCursor, isResumable, unwrap, type StreamCursor } from "@platos/kernel";

import {
  streamCredentialExpired,
  streamCursorExpired,
  streamCursorUnreadable,
  streamFrameTooLarge,
  streamJournalUnavailable,
  streamUnknown,
} from "./stream-errors.js";
import { terminalErrorFrame, TERMINAL_FAULTS } from "./streams.controller.js";

const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, { readonly status: number; readonly category: string }>> };

const STREAM = "env-1/turn-1";

function cursor(seq: number, stream = STREAM): StreamCursor {
  return unwrap(encodeStreamCursor(stream, seq));
}

describe("the terminal frame a client receives", () => {
  it("classifies as `failed` and NOT resumable, so a client stops asking", () => {
    const end = classifyStreamEnd(
      terminalErrorFrame(9, 1, "STREAM_CREDENTIAL_EXPIRED"),
      cursor(8),
    );
    expect(end).toEqual({ kind: "failed", code: "STREAM_CREDENTIAL_EXPIRED" });
    expect(isResumable(end)).toBe(false);
  });

  it("is written for exactly four endings and for no others", () => {
    // The three ABSENT kinds are the rule rather than an omission: `sealed` would
    // be a SECOND terminal frame after the producer's own, which is the duplicate
    // the acceptance forbids, and the other two have nothing to write to.
    expect(Object.keys(TERMINAL_FAULTS).sort()).toEqual([
      "credential-expired",
      "cursor-expired",
      "frame-too-large",
      "journal-unavailable",
    ]);
    for (const kind of ["sealed", "disconnected", "consumer-too-slow"]) {
      expect(TERMINAL_FAULTS[kind as keyof typeof TERMINAL_FAULTS]).toBeUndefined();
    }
  });
});

describe("every code this lane can answer with is in the committed taxonomy", () => {
  const faults = [
    streamCursorUnreadable,
    streamCursorExpired,
    streamUnknown,
    streamJournalUnavailable,
    streamCredentialExpired,
    streamFrameTooLarge,
  ];

  it("carries an entry whose category matches the mint", () => {
    // THE JOIN IS TO A FILE THIS SUITE DOES NOT CONTROL. A code minted here with
    // no entry fails `audit:error-taxonomy` E1; this case is the other half, so a
    // mint whose CATEGORY drifted from its entry fails here too.
    for (const fault of faults) {
      const error = fault();
      const entry = TAXONOMY.codes[error.code];
      expect(entry, `${error.code} has no taxonomy entry`).toBeDefined();
      expect(entry?.category, error.code).toBe(error.category);
    }
  });

  it("mints six DISTINCT codes, so no two refusals are indistinguishable", () => {
    const codes = faults.map((fault) => fault().code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("puts a code on every terminal frame, and it is the same code as the envelope's", () => {
    // ONE MINT SITE, ONE VALUE, BOTH SIDES OF THE FIRST BYTE. A map of `kind` to a
    // code STRING would have been two literals that agree today.
    for (const [kind, fault] of Object.entries(TERMINAL_FAULTS)) {
      const code = fault?.().code;
      expect(code, kind).toBeDefined();
      const frameOut = terminalErrorFrame(1, 1, code!);
      expect(classifyStreamEnd(frameOut, null)).toEqual({ kind: "failed", code });
    }
  });
});
