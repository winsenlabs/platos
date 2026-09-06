import { describe, expect, it } from "vitest";

import {
  adoptRequestId,
  correlationSource,
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

describe("the kernel CorrelationSource seam (WIN-260)", () => {
  // This is the process-edge END of the propagation the adapters carry. The
  // OTHER end is proved in
  // `packages/adapters/postgres-tenancy/src/correlation.integration.test.ts`,
  // which asks a real PostgreSQL for the value it received. The two are separate
  // suites because rule (j) forbids this app from naming an adapter outside its
  // one composition module, and the kernel port is the seam they share.

  it("reports the SAME identifier the ambient context carries", () => {
    withCorrelation(resolveCorrelation("req-edge-1"), () => {
      expect(correlationSource.current()?.requestId).toBe("req-edge-1");
      expect(correlationSource.current()?.requestId).toBe(currentCorrelation()?.requestId);
    });
  });

  it("reports NULL outside a request rather than inventing one", () => {
    // A fabricated correlation is worse than an absent one: an adapter that
    // received one would stamp a request identifier onto work no request caused,
    // and it would be indistinguishable from a real one.
    expect(correlationSource.current()).toBeNull();
  });

  it("carries only the id that SURVIVED validation, never the hostile header", () => {
    // The edge replaces an unusable inbound value rather than rejecting the
    // request, so what reaches an adapter is always safe in a statement, a
    // header, a log field and a span attribute. This is the assertion that lets
    // `transaction.ts` bind it into SQL without escaping it a second time.
    const hostile = 'ok\r\n{"level":"info","message":"authorized"}';
    withCorrelation(resolveCorrelation(hostile), () => {
      const carried = correlationSource.current()?.requestId ?? "";
      expect(carried).not.toBe(hostile);
      expect(carried).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/u);
    });
  });

  it("keeps concurrent requests apart at the port, not just at the storage", async () => {
    const run = async (id: string): Promise<string | undefined> =>
      await withCorrelation(resolveCorrelation(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return correlationSource.current()?.requestId;
      });
    expect(await Promise.all([run("port-a"), run("port-b")])).toEqual(["port-a", "port-b"]);
  });
});
