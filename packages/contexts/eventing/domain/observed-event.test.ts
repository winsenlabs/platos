import {
  asIdentifier,
  environmentScope,
  organizationScope,
  projectScope,
  type DomainEvent,
  type EventId,
  type JsonValue,
} from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { observedEventFrom, SUBJECT_PAYLOAD_KEY } from "./observed-event.js";

function envelope(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: asIdentifier<EventId>("evt-1"),
    name: "run.completed",
    schemaVersion: 1,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    requestId: null,
    payload: {},
    ...overrides,
  };
}

describe("observedEventFrom", () => {
  it("narrows an environment-scoped envelope", () => {
    const observed = observedEventFrom(envelope());
    expect(observed).not.toBeNull();
    expect(observed?.name).toBe("run.completed");
    expect(observed?.scope.environmentId).toBe("env-1");
  });

  // A rule is environment-scoped and has no wider form, so a wider event can
  // match nothing. Narrowing once at the boundary is what stops every downstream
  // predicate having to re-ask.
  it("returns null for an organization- or project-scoped envelope", () => {
    expect(observedEventFrom(envelope({ scope: organizationScope(asIdentifier("org-1")) }))).toBeNull();
    expect(
      observedEventFrom(envelope({ scope: projectScope(asIdentifier("org-1"), asIdentifier("proj-1")) })),
    ).toBeNull();
  });

  it("reads the subject off the reserved payload key", () => {
    const observed = observedEventFrom(envelope({ payload: { [SUBJECT_PAYLOAD_KEY]: "run-7" } }));
    expect(observed?.subjectId).toBe("run-7");
  });

  it("has a null subject when the key is absent, empty or not a string", () => {
    expect(observedEventFrom(envelope({ payload: {} }))?.subjectId).toBeNull();
    expect(observedEventFrom(envelope({ payload: { [SUBJECT_PAYLOAD_KEY]: "" } }))?.subjectId).toBeNull();
    expect(observedEventFrom(envelope({ payload: { [SUBJECT_PAYLOAD_KEY]: 7 } }))?.subjectId).toBeNull();
  });

  it("has a null subject when the payload is not an object at all", () => {
    for (const payload of ["a string", 7, true, null, [1, 2]] as JsonValue[]) {
      expect(observedEventFrom(envelope({ payload }))?.subjectId).toBeNull();
    }
  });

  it("copies the instant rather than aliasing the envelope's Date", () => {
    const source = envelope();
    const observed = observedEventFrom(source);
    source.occurredAt.setFullYear(1999);
    expect(observed?.occurredAt.getUTCFullYear()).toBe(2026);
  });
});
