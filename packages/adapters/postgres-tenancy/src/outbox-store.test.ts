// `Event.payload`, the one reader in the outbox's half of this package.
//
// WIN-258 T7. Everything else in `outbox-store.ts` needs a database — the two
// refusal codes are driver failures, and `outbox-constraints.integration.test.ts`
// raises both against a real one. The payload reader is the exception: it is a
// pure function over a column, and its refusal CANNOT be reached through a
// committed row, because `Event_payload_json_root` refuses the write.
// `json-columns.integration.test.ts` makes the database prove that by refusing
// an out-of-band INSERT of `'[]'`.
//
// So the guard is falsified HERE, directly, and the ledger records the pairing
// rather than claiming a kill it did not get from a stored row. A guard that
// nothing can turn red is a guard that is not there; a guard whose only red is a
// direct call is a guard whose reachability has been measured and named.

import { describe, expect, test } from "vitest";

import { PAYLOAD_NOT_AN_OBJECT, OutboxStoreError, readOutboxPayload } from "./outbox-store.js";

/** The code a refusal carried, or the string that says it did not refuse. */
function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof OutboxStoreError ? error.code : `not-an-outbox-refusal:${String(error)}`;
  }
  return "no-refusal";
}

describe("readOutboxPayload", () => {
  test("an envelope passes through unchanged, by identity", () => {
    const envelope = { name: "turn.settled", at: "2026-05-01T09:00:00.000Z" };
    expect(readOutboxPayload("e1", envelope)).toBe(envelope);
  });

  test("REFUSES every root the column's CHECK also refuses", () => {
    for (const value of [null, undefined, [], [{ name: "x" }], "envelope", 7, true]) {
      expect(codeOf(() => readOutboxPayload("e1", value))).toBe(PAYLOAD_NOT_AN_OBJECT);
    }
  });

  test("the refusal names the event, because a drain reads rows nobody is watching", () => {
    // The identifier is the whole of the operator's handle on a stuck row: the
    // drain loops, and a message that said only "bad payload" would leave them
    // reading the table by hand to find which one.
    expect(() => readOutboxPayload("11111111-1111-4111-8111-111111111111", [])).toThrow(
      /event 11111111-1111-4111-8111-111111111111 carries a payload that is not a JSON object/u,
    );
  });
});
