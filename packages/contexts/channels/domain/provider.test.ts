import { describe, expect, it } from "vitest";

import {
  admitAppDistribution,
  admitAppProvider,
  admitConnectionProvider,
  APP_PROVIDERS,
  CONNECTION_PROVIDERS,
  supportsNativeThreading,
} from "./provider.js";

describe("admitConnectionProvider", () => {
  // Spelled as a literal table so the test-case census can count these rows
  // statically; the guard below proves the literal still covers the real list.
  it.each([["slack"], ["telegram"], ["whatsapp"], ["discord"]])("admits %s", (provider) => {
    const result = admitConnectionProvider(provider);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(provider);
  });

  it("covers every declared connection provider above", () => {
    expect([...CONNECTION_PROVIDERS]).toEqual(["slack", "telegram", "whatsapp", "discord"]);
  });

  it("normalizes case and surrounding whitespace", () => {
    const result = admitConnectionProvider("  SLACK ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("slack");
  });

  it.each([["teams"], [""], ["  "]])("rejects %s", (value) => {
    expect(admitConnectionProvider(value).ok).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(admitConnectionProvider(42).ok).toBe(false);
  });
});

describe("admitAppProvider", () => {
  it("admits slack, the one provider with an installation model", () => {
    expect(admitAppProvider("slack").ok).toBe(true);
  });

  it.each([["telegram"], ["whatsapp"], ["discord"]])(
    "refuses %s, which is a direct connection and has no installation flow",
    (provider) => {
      // The two lists are deliberately different. Collapsing them would let an
      // operator mint an app for a provider whose OAuth flow does not exist,
      // and the failure would surface much later, at install time.
      expect(admitConnectionProvider(provider).ok).toBe(true);
      expect(admitAppProvider(provider).ok).toBe(false);
    },
  );

  it("leaves exactly those three outside the app list", () => {
    // Pins the literal table above to the real difference between the lists,
    // so adding a provider to one list without the other fails here.
    expect(CONNECTION_PROVIDERS.filter((provider) => !APP_PROVIDERS.includes(provider as never))).toEqual([
      "telegram",
      "whatsapp",
      "discord",
    ]);
  });
});

describe("admitAppDistribution", () => {
  it.each([["private"], ["public"]])("admits %s", (value) => {
    expect(admitAppDistribution(value).ok).toBe(true);
  });

  it("normalizes case", () => {
    const result = admitAppDistribution("PUBLIC");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("public");
  });

  it("rejects anything else", () => {
    expect(admitAppDistribution("unlisted").ok).toBe(false);
  });
});

describe("supportsNativeThreading", () => {
  it("is true for slack alone", () => {
    expect(supportsNativeThreading("slack")).toBe(true);
    expect(supportsNativeThreading("telegram")).toBe(false);
    expect(supportsNativeThreading("discord")).toBe(false);
    expect(supportsNativeThreading("whatsapp")).toBe(false);
  });
});
