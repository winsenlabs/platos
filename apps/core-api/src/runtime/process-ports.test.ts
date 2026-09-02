import type { Clock } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { resolveCorrelation, withCorrelation } from "./correlation.js";
import { createProcessLogger, systemClock, ulidGenerator } from "./process-ports.js";

function fixedClock(at: number): Clock & { advance: (ms: number) => void } {
  let millisecond = at;
  return {
    now: () => new Date(millisecond),
    advance: (ms: number) => {
      millisecond += ms;
    },
  };
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("the system clock", () => {
  it("returns a moving Date", () => {
    const clock = systemClock();
    expect(clock.now()).toBeInstanceOf(Date);
    expect(clock.now().getTime()).toBeGreaterThan(0);
  });
});

describe("the identifier generator", () => {
  it("mints RFC 4122 v4 uuids", () => {
    const ids = ulidGenerator();
    expect(ids.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(ids.uuid()).not.toBe(ids.uuid());
  });

  it("mints 26-character Crockford base-32 ulids", () => {
    const value = ulidGenerator().ulid();
    expect(value).toHaveLength(26);
    expect(value).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u);
  });

  it("sorts by creation time across milliseconds", () => {
    const clock = fixedClock(1_700_000_000_000);
    const ids = ulidGenerator(clock);
    const first = ids.ulid();
    clock.advance(1);
    const second = ids.ulid();
    clock.advance(1000);
    const third = ids.ulid();
    expect([third, first, second].sort()).toEqual([first, second, third]);
  });

  it("stays monotonic WITHIN one millisecond, which is the whole point of the format", () => {
    // A frozen clock is the adversarial case: without the counter every id in
    // the same millisecond is independent randomness and "sortable" is a lie
    // exactly when throughput makes ordering matter.
    const ids = ulidGenerator(fixedClock(1_700_000_000_000));
    const batch = Array.from({ length: 500 }, () => ids.ulid());
    expect(batch).toEqual([...batch].sort());
    expect(new Set(batch).size).toBe(batch.length);
  });
});

describe("the process logger", () => {
  it("emits one JSON object per line", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "info", write: sink.write, clock: fixedClock(0) });
    logger.log("info", "process.started", { port: 3030 });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(sink.lines[0] ?? "{}")).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      level: "info",
      message: "process.started",
      port: 3030,
    });
  });

  it("drops levels below the configured floor", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "warn", write: sink.write });
    logger.log("debug", "a");
    logger.log("info", "b");
    logger.log("warn", "c");
    logger.log("error", "d");
    expect(sink.lines.map((line) => JSON.parse(line).message)).toEqual(["c", "d"]);
  });

  it("stamps the ambient correlation id without the caller passing it", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "debug", write: sink.write });
    withCorrelation(resolveCorrelation("trace-xyz"), () => logger.log("info", "inside"));
    logger.log("info", "outside");
    const [inside, outside] = sink.lines.map((line) => JSON.parse(line));
    expect(inside.requestId).toBe("trace-xyz");
    // Outside a request there is no trace to claim membership of.
    expect(outside).not.toHaveProperty("requestId");
  });

  it("carries child fields onto everything, and lets a call add more", () => {
    const sink = capture();
    const base = createProcessLogger({ minimumLevel: "debug", write: sink.write, base: { service: "core-api" } });
    base.child({ component: "shutdown" }).log("warn", "process.stopped", { remaining: 2 });
    expect(JSON.parse(sink.lines[0] ?? "{}")).toMatchObject({
      service: "core-api",
      component: "shutdown",
      remaining: 2,
      message: "process.stopped",
    });
  });

  it("keeps caller data in fields, so a hostile value cannot forge a second line", () => {
    const sink = capture();
    const logger = createProcessLogger({ minimumLevel: "debug", write: sink.write });
    logger.log("info", "edge.request", { path: 'x"}\n{"level":"error","message":"forged"' });
    expect(sink.lines).toHaveLength(1);
    // JSON.stringify escaped the newline, so the forged object is a string value
    // rather than a line of its own.
    expect(sink.lines[0]?.split("\n").filter((part) => part.length > 0)).toHaveLength(1);
    expect(JSON.parse(sink.lines[0] ?? "{}").message).toBe("edge.request");
  });
});
