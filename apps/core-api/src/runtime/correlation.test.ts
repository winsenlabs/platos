import { describe, expect, it } from "vitest";

import {
  adoptRequestId,
  currentCorrelation,
  mintRequestId,
  resolveCorrelation,
  withCorrelation,
} from "./correlation.js";

describe("adopting an upstream correlation identifier", () => {
  it("adopts a well-formed identifier so a trace survives the hop", () => {
    expect(adoptRequestId("01JAV8Z9K7QX2C4NB6RTYE0MDS")).toBe("01JAV8Z9K7QX2C4NB6RTYE0MDS");
    expect(adoptRequestId("req-7f3a.b2:9")).toBe("req-7f3a.b2:9");
  });

  it("refuses a value carrying CRLF — the log-forging vector", () => {
    // Adopted verbatim, this would let a caller append a fabricated line to every
    // structured log the request touches, indistinguishable from a real one.
    expect(adoptRequestId("ok\r\n{\"level\":\"info\",\"message\":\"authorized\"}")).toBeNull();
    expect(adoptRequestId("ok\nmore")).toBeNull();
  });

  it("refuses whitespace, quotes, and other header-splitting characters", () => {
    for (const hostile of ["has space", 'has"quote', "has;semi", "has,comma", "<script>"]) {
      expect(adoptRequestId(hostile), hostile).toBeNull();
    }
  });

  it("refuses an over-long value rather than carrying it into every span", () => {
    expect(adoptRequestId("a".repeat(128))).toHaveLength(128);
    expect(adoptRequestId("a".repeat(129))).toBeNull();
  });

  it("refuses an empty value", () => {
    expect(adoptRequestId("")).toBeNull();
  });

  it("refuses a repeated header, because two upstream opinions are no opinion", () => {
    expect(adoptRequestId(["one", "two"])).toBeNull();
    expect(adoptRequestId(undefined)).toBeNull();
    expect(adoptRequestId(42)).toBeNull();
  });
});

describe("resolving correlation at the edge", () => {
  it("mints an identifier when none arrives, and says it did", () => {
    const resolved = resolveCorrelation(undefined);
    expect(resolved.inherited).toBe(false);
    expect(resolved.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("replaces a hostile identifier rather than failing the request", () => {
    // A bad correlation header is a reason to stop trusting that string, not a
    // reason to reject an otherwise valid request.
    const resolved = resolveCorrelation("bad value\r\ninjected");
    expect(resolved.inherited).toBe(false);
    expect(resolved.requestId).not.toContain("injected");
  });

  it("mints distinct identifiers", () => {
    expect(mintRequestId()).not.toBe(mintRequestId());
  });
});

describe("ambient propagation", () => {
  it("is null outside a request, so a log line cannot claim a trace it has no part in", () => {
    expect(currentCorrelation()).toBeNull();
  });

  it("survives an await, which is the only reason async-local storage is here", async () => {
    const context = resolveCorrelation("trace-abc");
    const seen = await withCorrelation(context, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return currentCorrelation()?.requestId;
    });
    expect(seen).toBe("trace-abc");
    expect(currentCorrelation()).toBeNull();
  });

  it("keeps concurrent requests apart", async () => {
    const run = async (id: string): Promise<string | undefined> =>
      await withCorrelation(resolveCorrelation(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return currentCorrelation()?.requestId;
      });
    expect(await Promise.all([run("first"), run("second")])).toEqual(["first", "second"]);
  });
});
