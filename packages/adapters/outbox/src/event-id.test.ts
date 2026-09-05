// The ordered identifier, and the four ways it could stop being ordered.
//
// Every case here is about ORDER, not about uniqueness. A UUIDv4 would be unique
// too and would be useless for this: `Event.createdAt` is `TIMESTAMP(3)`, so the
// rows of one millisecond tie on the only ordering column the frozen row has,
// and the identifier is what breaks the tie. If it breaks it randomly, a drain
// reads two events of one transaction in the wrong order and nothing in a suite
// of ten events notices.

import { describe, expect, test } from "vitest";

import { COUNTER_LIMIT, createEventIdMinter } from "./event-id.js";

/** A fixed tail, so a case is about the ordered PREFIX and nothing else. */
const fixedTail = (length: number): Uint8Array => new Uint8Array(length).fill(0xab);

const AT = new Date("2026-05-01T09:00:00.000Z");

describe("the minted identifier is a well-formed UUIDv7", () => {
  test("it is 8-4-4-4-12 lower-case hexadecimal", () => {
    const { eventId } = createEventIdMinter(fixedTail).mint(AT);
    expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  test("the version nibble is 7 and the variant bits are 10", () => {
    const { eventId } = createEventIdMinter(fixedTail).mint(AT);
    expect(eventId[14]).toBe("7");
    // 0xab & 0x3f | 0x80 = 0xeb, so the variant nibble is 'e' — one of 8/9/a/b/
    // c/d/e/f is not enough: RFC 9562 says the top two bits are exactly 10.
    const variant = Number.parseInt(eventId.slice(19, 21), 16);
    expect(variant & 0xc0).toBe(0x80);
  });

  test("the first 48 bits are the Unix millisecond, big-endian", () => {
    const { eventId } = createEventIdMinter(fixedTail).mint(AT);
    const stamp = Number.parseInt(eventId.slice(0, 8) + eventId.slice(9, 13), 16);
    expect(stamp).toBe(AT.getTime());
  });

  test("the instant it reports back is the instant it used", () => {
    const minted = createEventIdMinter(fixedTail).mint(AT);
    expect(minted.at.getTime()).toBe(AT.getTime());
  });
});

describe("order is preserved", () => {
  test("two events in ONE millisecond sort in the order they were minted", () => {
    const minter = createEventIdMinter(fixedTail);
    const first = minter.mint(AT).eventId;
    const second = minter.mint(AT).eventId;
    expect(first).not.toBe(second);
    expect(first < second).toBe(true);
  });

  test("four thousand events in one millisecond stay sorted", () => {
    const minter = createEventIdMinter(fixedTail);
    const minted: string[] = [];
    for (let index = 0; index < 4000; index += 1) minted.push(minter.mint(AT).eventId);
    expect([...minted].sort()).toEqual(minted);
    expect(new Set(minted).size).toBe(4000);
  });

  test("a later millisecond sorts after an earlier one", () => {
    const minter = createEventIdMinter(fixedTail);
    const first = minter.mint(AT).eventId;
    const later = minter.mint(new Date(AT.getTime() + 1)).eventId;
    expect(first < later).toBe(true);
  });

  test("a clock that steps BACKWARDS is clamped, and both halves stay ordered", () => {
    const minter = createEventIdMinter(fixedTail);
    const first = minter.mint(new Date(AT.getTime() + 5));
    const second = minter.mint(AT);
    // The identifier stays ordered AND the instant handed back does too, which
    // is the half that matters: the drain orders by `createdAt` FIRST, so an
    // identifier that was ordered under a timestamp that was not would be
    // thrown away by the very ordering it exists to support.
    expect(first.eventId < second.eventId).toBe(true);
    expect(second.at.getTime()).toBe(first.at.getTime());
  });
});

describe("the counter refuses rather than wrapping", () => {
  test("more than 4096 events in one millisecond is refused, not reordered", () => {
    const minter = createEventIdMinter(fixedTail);
    // COUNTER_LIMIT mints use counters 0 .. COUNTER_LIMIT-1, which is every
    // value the twelve bits hold; the next one would have to wrap to zero and
    // would mint an identifier SMALLER than the one before it.
    for (let index = 0; index < COUNTER_LIMIT; index += 1) minter.mint(AT);
    expect(() => minter.mint(AT)).toThrow(/one millisecond/u);
  });

  test("an unreal instant is refused", () => {
    expect(() => createEventIdMinter(fixedTail).mint(new Date(Number.NaN))).toThrow(RangeError);
  });
});
