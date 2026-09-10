// THE PURE HALF OF THIS DIRECTORY: ids, keys and the two codecs.
//
// WHAT IS DELIBERATELY NOT HERE. Not one case below claims anything about
// ordering, retention, resume or fan-out. Those are properties of a SERVER and
// they are proven in `journal.integration.test.ts` and `event-bus.integration.
// test.ts` against a real Redis — a double cannot fail the way a server fails, and
// this programme has already paid for suites that proved a fake behaved like the
// fake it was.
//
// WHAT IS HERE IS EVERYTHING A SERVER CANNOT TELL YOU: whether the id this
// directory writes can be read back as the sequence it came from, whether the two
// keyspaces can collide, and whether an event survives the round trip through
// JSON with its `Date` and its branded ids intact. Each of those is a place a
// silent, total data loss would look exactly like success.

import { describe, expect, it } from "vitest";

import { asIdentifier, environmentScope, organizationScope } from "@platos/kernel";
import type {
  DomainEvent,
  EnvironmentId,
  EventId,
  OrganizationId,
  ProjectId,
  RequestId,
} from "@platos/kernel";

import { entryId, sequenceOf } from "./client.js";
import { busKey, BUS_KEY_PREFIX, decodeEvent, encodeEvent } from "./event-bus.js";
import { STREAM_KEY_PREFIX, streamKey, streamMetaKey } from "./journal.js";

describe("the entry id is the producer's sequence", () => {
  it("round-trips every sequence a frame can carry", () => {
    for (const seq of [1, 2, 9, 10, 99, 1_000, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(sequenceOf(entryId(seq)), `seq ${seq}`).toBe(seq);
    }
  });

  it("orders lexically the way Redis orders ids", () => {
    // Redis compares stream ids NUMERICALLY on both halves, so `10-0` is after
    // `9-0`. This case exists because a reader who assumed string ordering would
    // conclude the opposite, and the whole design rests on the server's order
    // being the producer's order.
    const ids = [1, 2, 9, 10, 11, 100].map(entryId);
    const parsed = ids.map(sequenceOf);
    expect(parsed).toEqual([1, 2, 9, 10, 11, 100]);
    expect([...parsed].sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(parsed);
  });

  it("refuses an id whose shape this directory never writes", () => {
    // A server-assigned `<ms>-<n>` with a non-zero counter, an operator's
    // hand-written entry, another product's key. Each returns null so the reader
    // can skip it rather than placing it before every real frame.
    for (const foreign of ["5-1", "abc-0", "5", "-0", "0-0", "5-", "1.5-0", "1760000000000-3"]) {
      expect(sequenceOf(foreign), foreign).toBeNull();
    }
  });

  it("CANNOT tell a server-assigned `<ms>-0` from a producer sequence, and says so", () => {
    // THE LIMIT OF THIS PARSER, RECORDED RATHER THAN IMPLIED. A server-assigned
    // id whose counter is 0 — the first entry in its millisecond, which is the
    // common case — has exactly the shape this directory writes, so the parser
    // reads it as a sequence of 1.76e12.
    //
    // IT IS SURVIVABLE, AND THE REASON IS WHY THIS IS A CASE AND NOT A DEFECT.
    // Only `append` writes into a journal keyspace and only it chooses ids; the
    // bus writes server-assigned ids under a DIFFERENT PREFIX. So this can only
    // happen if something outside this directory writes into a journal stream —
    // and when it does, the frame lands at a sequence roughly a trillion above the
    // real ones, which the client's own `admitFrame` reports as a GAP. The failure
    // mode is loud rather than a silent reorder, which is the property that
    // matters.
    expect(sequenceOf("1760000000000-0")).toBe(1_760_000_000_000);
  });
});

describe("the two keyspaces cannot collide", () => {
  it("gives the journal and the bus disjoint prefixes", () => {
    expect(STREAM_KEY_PREFIX.startsWith(BUS_KEY_PREFIX)).toBe(false);
    expect(BUS_KEY_PREFIX.startsWith(STREAM_KEY_PREFIX)).toBe(false);
  });

  it("keeps a stream's frames and its metadata apart", () => {
    expect(streamKey("t1")).not.toBe(streamMetaKey("t1"));
    expect(streamMetaKey("t1").startsWith(streamKey("t1"))).toBe(true);
  });

  it("cannot let one stream id reach another stream's metadata", () => {
    // The collision a `:meta` suffix invites: a stream literally named `t1:meta`.
    // It is recorded rather than defended against, because the ids this journal is
    // handed are minted by an `IdGenerator` and the case that would matter is a
    // caller passing user input as a stream id — which the transport refuses.
    expect(streamKey("t1:meta")).toBe(streamMetaKey("t1"));
  });

  it("namespaces a bus stream by event name", () => {
    expect(busKey("channels.outbound.requested")).toBe(
      `${BUS_KEY_PREFIX}:channels.outbound.requested`,
    );
  });
});

describe("an event survives the round trip", () => {
  const event: DomainEvent = {
    eventId: asIdentifier<EventId>("01J8Z0000000000000000000AA"),
    name: "channels.outbound.requested",
    schemaVersion: 3,
    occurredAt: new Date("2026-05-01T09:00:00.123Z"),
    scope: environmentScope(
      asIdentifier<OrganizationId>("aaaaaaaa-0001-4000-8000-000000000001"),
      asIdentifier<ProjectId>("aaaaaaaa-0002-4000-8000-000000000002"),
      asIdentifier<EnvironmentId>("aaaaaaaa-0003-4000-8000-000000000003"),
    ),
    requestId: asIdentifier<RequestId>("req_1"),
    payload: { channelThreadKey: "slack:C1:1.2", text: "hello", retries: 0, ok: true, extra: null },
  };

  it("keeps the instant to the millisecond", () => {
    const decoded = decodeEvent(encodeEvent(event));
    expect(decoded).not.toBeNull();
    // A SECOND-RESOLUTION FORMAT WOULD PASS EVERY OTHER CASE HERE. `occurredAt` is
    // what a drain orders and logs by, and losing the milliseconds would reorder
    // two events published in the same second with no error anywhere.
    expect(decoded?.occurredAt.toISOString()).toBe("2026-05-01T09:00:00.123Z");
    expect(decoded?.occurredAt.getTime()).toBe(event.occurredAt.getTime());
  });

  it("keeps every other field, including a nested payload and its nulls", () => {
    const decoded = decodeEvent(encodeEvent(event));
    expect(decoded?.eventId).toBe(event.eventId);
    expect(decoded?.name).toBe(event.name);
    expect(decoded?.schemaVersion).toBe(event.schemaVersion);
    expect(decoded?.scope).toEqual(event.scope);
    expect(decoded?.requestId).toBe(event.requestId);
    expect(decoded?.payload).toEqual(event.payload);
  });

  it("keeps a scope that is not environment-level at its own level", () => {
    // `TenantScope` is a discriminated union and the level is what a consumer
    // branches on. A codec that widened every scope to environment-level would
    // hand a subscriber three ids where the producer had one.
    const organization = {
      ...event,
      scope: organizationScope(asIdentifier<OrganizationId>("aaaaaaaa-0001-4000-8000-000000000001")),
    };
    const decoded = decodeEvent(encodeEvent(organization));
    expect(decoded?.scope).toEqual(organization.scope);
    expect(decoded?.scope.level).toBe("organization");
  });

  it("keeps a null request id null rather than turning it into a string", () => {
    const decoded = decodeEvent(encodeEvent({ ...event, requestId: null }));
    expect(decoded?.requestId).toBeNull();
  });

  it("refuses an entry it cannot read rather than returning a half event", () => {
    for (const bad of [
      "not json",
      "[]",
      "null",
      '"a string"',
      JSON.stringify({ name: "x" }),
      JSON.stringify({ eventId: "e", name: "x" }),
      JSON.stringify({ eventId: "e", name: "x", schemaVersion: 1 }),
      JSON.stringify({ eventId: "e", name: "x", schemaVersion: 1, occurredAt: "nonsense" }),
      JSON.stringify({ eventId: "e", name: "x", schemaVersion: 1, occurredAt: "2026-01-01T00:00:00.000Z" }),
    ]) {
      expect(decodeEvent(bad), bad).toBeNull();
    }
  });
});
