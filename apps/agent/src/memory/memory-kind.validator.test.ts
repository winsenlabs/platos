import { describe, expect, it } from "vitest";
import { validateMemoryPayload } from "./memory-kind.validator";

describe("canonical memory kind validation", () => {
  it("requires complete relationship metadata", () => {
    expect(validateMemoryPayload({
      kind: "relationship",
      content: "Ada works at Platos",
      metadata: { from: "person:ada", to: "company:platos" },
    })).toMatchObject({ ok: false });
    expect(validateMemoryPayload({
      kind: "relationship",
      content: "Ada works at Platos",
      metadata: { from: "person:ada", to: "company:platos", type: "works_at" },
    })).toMatchObject({ ok: true, kind: "relationship" });
  });

  it("requires profileKey for profile memories", () => {
    expect(validateMemoryPayload({ kind: "profile", content: "Ada", metadata: {} })).toMatchObject({ ok: false });
    expect(validateMemoryPayload({
      kind: "profile",
      content: "Ada",
      metadata: { profileKey: "name" },
    })).toMatchObject({ ok: true, kind: "profile" });
  });

  it("accepts only an ISO timestamp when an event timestamp is provided", () => {
    expect(validateMemoryPayload({
      kind: "event",
      content: "Launch",
      metadata: { at: "2026-08-24T09:30:00Z", location: "London", participants: ["Ada"] },
    })).toMatchObject({ ok: true, kind: "event" });
    expect(validateMemoryPayload({
      kind: "event",
      content: "Launch",
      metadata: { at: "next Tuesday" },
    })).toMatchObject({ ok: false });
  });
});
