/**
 * Regression: the platform sends message types the decoder did not know, and
 * every one of them logged "platools received malformed message".
 *
 * `tools_registered` is the one that bit us — the platform acknowledges every
 * successful `tool_register` batch, so it arrives immediately after connect.
 * Walle logged the warning on every single session while the connection was
 * in fact healthy, which made a working socket look broken.
 */
import { describe, expect, test } from "vitest";
import { decodePlatformMessage } from "../src/transport/protocol";

const decode = (value: unknown) => decodePlatformMessage(JSON.stringify(value));

describe("decodePlatformMessage — platform acknowledgements", () => {
  test("decodes tools_registered, the ack sent on every connect", () => {
    expect(
      decode({
        type: "tools_registered",
        entity_id: "walle-mcp-service",
        environment_id: "478bc711-229c-544b-a346-254ada4bd84e",
        count: 12,
        new_tools: ["search_book", "draft_outreach"],
        pruned: 13,
      }),
    ).toEqual({
      type: "tools_registered",
      entity_id: "walle-mcp-service",
      environment_id: "478bc711-229c-544b-a346-254ada4bd84e",
      count: 12,
      new_tools: ["search_book", "draft_outreach"],
      pruned: 13,
    });
  });

  test("tolerates a tools_registered carrying only its discriminator", () => {
    expect(decode({ type: "tools_registered" })).toEqual({ type: "tools_registered" });
  });

  test("drops non-string entries from new_tools rather than failing the frame", () => {
    const decoded = decode({ type: "tools_registered", new_tools: ["ok", 7, null] });
    expect(decoded).toEqual({ type: "tools_registered", new_tools: ["ok"] });
  });

  test("decodes register_throttled with its retry hint", () => {
    expect(decode({ type: "register_throttled", error: "60/min exceeded", retry_after_ms: 30_000 }))
      .toEqual({ type: "register_throttled", error: "60/min exceeded", retry_after_ms: 30_000 });
  });

  test("decodes tool_health_alert", () => {
    expect(decode({ type: "tool_health_alert", tool: "search_book", status: "degraded" }))
      .toEqual({ type: "tool_health_alert", tool: "search_book", status: "degraded" });
  });

  test("decodes a terminal platform error so the reason is not lost to a bare close", () => {
    expect(decode({ type: "error", error: "Invalid service secret or entity not found" }))
      .toEqual({ type: "error", error: "Invalid service secret or entity not found" });
  });

  test("still rejects frames missing their required fields", () => {
    // Widening the decoder must not turn it into a pass-through.
    expect(decode({ type: "register_throttled" })).toBeNull();
    expect(decode({ type: "tool_health_alert", tool: "x" })).toBeNull();
    expect(decode({ type: "error" })).toBeNull();
    expect(decode({ type: "genuinely_unknown" })).toBeNull();
    expect(decodePlatformMessage("not json")).toBeNull();
  });

  test("existing platform messages are unaffected", () => {
    expect(decode({ type: "heartbeat_ack" })).toEqual({ type: "heartbeat_ack" });
    expect(
      decode({ type: "tool_call", call_id: "c1", tool_name: "search_book", params: {} }),
    ).toEqual({ type: "tool_call", call_id: "c1", tool_name: "search_book", params: {} });
  });
});
