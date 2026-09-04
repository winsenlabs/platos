import { describe, expect, it } from "vitest";

import {
  isNetworkDestination,
  parseDestination,
  toDestinationInput,
  type Destination,
} from "./destination.js";

function parsed(raw: unknown): Destination {
  const result = parseDestination(raw as never);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("parseDestination", () => {
  it("accepts the four legacy kinds", () => {
    expect(parsed({ type: "slack", url: "https://hooks.example/x" })).toEqual({
      kind: "slack",
      url: "https://hooks.example/x",
    });
    expect(parsed({ type: "webhook", url: "https://example.test/hook" })).toEqual({
      kind: "webhook",
      url: "https://example.test/hook",
    });
    expect(parsed({ type: "email", email: "ops@example.test" })).toEqual({
      kind: "email",
      email: "ops@example.test",
    });
    expect(parsed({ type: "pagerduty", integrationKey: "k-1" })).toEqual({
      kind: "pagerduty",
      integrationKey: "k-1",
    });
  });

  it("refuses an unknown type rather than passing it through", () => {
    const denied = parseDestination({ type: "sms", url: "https://example.test" } as never);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_DESTINATION_INVALID");
  });

  it("refuses a missing or empty url on the url-bearing kinds", () => {
    expect(parseDestination({ type: "slack" } as never).ok).toBe(false);
    expect(parseDestination({ type: "slack", url: "" } as never).ok).toBe(false);
    expect(parseDestination({ type: "webhook", url: 7 } as never).ok).toBe(false);
  });

  it("refuses an empty pagerduty integrationKey", () => {
    expect(parseDestination({ type: "pagerduty", integrationKey: "" } as never).ok).toBe(false);
  });

  it("refuses a null or non-object delivery", () => {
    expect(parseDestination(null).ok).toBe(false);
    expect(parseDestination(undefined).ok).toBe(false);
  });

  // The legacy email rule really is only `includes("@")`. Pinned so that
  // tightening it is a deliberate, visible change rather than a tidy-up that
  // silently invalidates rules operators are relying on today.
  it('admits any email CONTAINING "@" — the weak legacy rule, preserved', () => {
    expect(parsed({ type: "email", email: "@" })).toEqual({ kind: "email", email: "@" });
    expect(parsed({ type: "email", email: "not an address@but accepted" }).kind).toBe("email");
  });

  it('refuses an email with no "@"', () => {
    expect(parseDestination({ type: "email", email: "ops.example.test" } as never).ok).toBe(false);
  });
});

describe("isNetworkDestination", () => {
  it("is true for exactly the two kinds this system fetches", () => {
    expect(isNetworkDestination(parsed({ type: "slack", url: "https://a.test" }))).toBe(true);
    expect(isNetworkDestination(parsed({ type: "webhook", url: "https://a.test" }))).toBe(true);
  });

  it("is false for the kinds it does not fetch, so they are not screened", () => {
    expect(isNetworkDestination(parsed({ type: "email", email: "a@b.test" }))).toBe(false);
    expect(isNetworkDestination(parsed({ type: "pagerduty", integrationKey: "k" }))).toBe(false);
  });
});

describe("toDestinationInput", () => {
  it("round-trips every kind back to its column discriminator", () => {
    for (const raw of [
      { type: "slack", url: "https://a.test" },
      { type: "webhook", url: "https://b.test" },
      { type: "email", email: "a@b.test" },
      { type: "pagerduty", integrationKey: "k" },
    ]) {
      expect(toDestinationInput(parsed(raw))).toEqual(raw);
    }
  });
});
