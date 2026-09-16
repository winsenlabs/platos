import { describe, expect, it } from "vitest";

import { parseTrustedProxy, trustedProxyMatcher } from "./trusted-proxy.js";

function matcher(value: string) {
  const range = parseTrustedProxy(value);
  if ("problem" in range) throw new Error(range.problem);
  return trustedProxyMatcher(range);
}

describe("which TCP peer is the trusted proxy", () => {
  it("matches exactly the configured address and nothing beside it", () => {
    const isProxy = matcher("172.18.0.1");
    expect(isProxy("172.18.0.1")).toBe(true);
    expect(isProxy("172.18.0.2")).toBe(false);
    expect(isProxy("127.0.0.1")).toBe(false);
  });

  it("matches a range by its prefix", () => {
    const isProxy = matcher("172.18.0.0/16");
    expect(isProxy("172.18.255.254")).toBe(true);
    expect(isProxy("172.19.0.1")).toBe(false);
  });

  it("compares an IPv4-mapped peer as the IPv4 address it is", () => {
    expect(matcher("172.18.0.1")("::ffff:172.18.0.1")).toBe(true);
    expect(matcher("172.18.0.1")("::ffff:172.18.0.9")).toBe(false);
  });

  it("never matches across families, and never matches an absent peer", () => {
    expect(matcher("fd00::/8")("172.18.0.1")).toBe(false);
    expect(matcher("172.18.0.1")(undefined)).toBe(false);
    expect(matcher("172.18.0.1")("")).toBe(false);
  });
});
