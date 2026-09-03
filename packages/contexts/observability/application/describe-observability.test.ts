import { beforeEach, describe, expect, it } from "vitest";

import { sinkHealth, TURN_FINALIZED_EVENT } from "../domain/index.js";
import { describeObservability } from "./describe-observability.js";
import { errorClass, probeSink } from "./probe-sink.js";
import {
  buildObservabilityTestContext,
  testEnvelope,
  testFinalizedPayload,
  type ObservabilityTestContext,
} from "./testing/index.js";

describe("describeObservability", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("reports the sink and the depth together", async () => {
    context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload()));
    const described = await describeObservability(context.dependencies);
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.sink.status).toBe("ready");
    expect(described.value.depth).toEqual({ pending: 1, failed: 0 });
    expect(described.value.depthErrorCode).toBeNull();
  });

  it("keeps the two halves independent: a ready sink with an unreadable queue", async () => {
    context.outbox.depthFails = true;
    const described = await describeObservability(context.dependencies);
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.sink.status).toBe("ready");
    expect(described.value.depth).toBeNull();
    expect(described.value.depthErrorCode).toBe("OBSERVABILITY_QUEUE_UNAVAILABLE");
  });

  it("reports an unreadable queue as ABSENT, never as zero", async () => {
    context.outbox.depthFails = true;
    const described = await describeObservability(context.dependencies);
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.depth).not.toEqual({ pending: 0, failed: 0 });
    expect(described.value.depth).toBeNull();
  });

  it("reports a broken sink alongside a readable queue", async () => {
    context.sink.health = sinkHealth("schema_missing", "no turns_v1", ["turns_v1"]);
    const described = await describeObservability(context.dependencies);
    if (!described.ok) throw new Error(described.error.code);
    expect(described.value.sink.status).toBe("schema_missing");
    expect(described.value.sink.missingTables).toEqual(["turns_v1"]);
    expect(described.value.depth).toEqual({ pending: 0, failed: 0 });
  });

  it("reuses a health it was handed rather than probing twice", async () => {
    const described = await describeObservability(context.dependencies, {
      health: sinkHealth("ready", "already probed"),
    });
    if (!described.ok) throw new Error(described.error.code);
    expect(context.sink.callsTo("probe")).toHaveLength(0);
    expect(described.value.sink.detail).toBe("already probed");
  });

  it("probes when it is not handed one — there is no report-without-checking option", async () => {
    await describeObservability(context.dependencies);
    expect(context.sink.callsTo("probe")).toHaveLength(1);
  });
});

describe("probeSink", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("passes a well-behaved adapter's report through", async () => {
    context.sink.health = sinkHealth("misconfigured", "endpoint is not a url");
    expect((await probeSink(context.dependencies)).status).toBe("misconfigured");
  });

  it("turns a THROWN probe into unreachable, never into disabled", async () => {
    context.sink.probeThrows = true;
    const health = await probeSink(context.dependencies);
    expect(health.status).toBe("unreachable");
    expect(health.configured).toBe(true);
    expect(health.detail).toContain("TypeError");
  });
});

describe("errorClass", () => {
  it("reports the class, never the message, which quotes payloads", () => {
    expect(errorClass(new TypeError("ada@example.test failed"))).toBe("TypeError");
    expect(errorClass(new Error("secret"))).toBe("Error");
  });

  it("names the type of a thrown non-error", () => {
    expect(errorClass("boom")).toBe("string");
    expect(errorClass(undefined)).toBe("undefined");
  });
});
