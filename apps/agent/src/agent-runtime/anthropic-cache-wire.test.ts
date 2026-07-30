import { describe, it, expect } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { withAnthropicCacheBreakpoints, type CacheableMessage } from "./anthropic-cache-breakpoints";

/**
 * WIRE-FORMAT verification for Workstream A.
 *
 * The unit tests prove we *choose* the right breakpoint positions. This proves
 * the choice actually reaches Anthropic: that `@ai-sdk/anthropic@4` serialises
 * `providerOptions.anthropic.cacheControl` into a real `cache_control` field on
 * the wire, INCLUDING on `assistant` and `tool` role messages.
 *
 * That last part is the risk worth testing. Our breakpoints land on whatever the
 * newest message happens to be, and in a tool loop that is almost always an
 * assistant (tool_use) or tool (tool_result) message. If the provider only
 * honoured cacheControl on system/user messages, every breakpoint we place mid
 * tool-loop would be silently dropped and the fix would appear to work while
 * changing nothing on the bill.
 *
 * No network and no API key: we inject a `fetch` that captures the request body
 * and returns a minimal valid Anthropic response.
 */

function anthropicResponse() {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function captureRequest(messages: CacheableMessage[]) {
  let body: any;
  const anthropic = createAnthropic({
    apiKey: "test-key-not-used",
    fetch: (async (_url: any, init: any) => {
      body = JSON.parse(String(init.body));
      return anthropicResponse();
    }) as any,
  });
  await generateText({
    model: anthropic("claude-sonnet-4-5"),
    messages: messages as any,
    allowSystemInMessages: true,
  } as any);
  return body;
}

/** Collect every cache_control marker in the serialised request. */
function markers(body: any): Array<{ where: string; role?: string }> {
  const out: Array<{ where: string; role?: string }> = [];
  for (const [i, s] of (Array.isArray(body?.system) ? body.system : []).entries()) {
    if (s?.cache_control) out.push({ where: `system[${i}]` });
  }
  for (const [i, m] of (body?.messages ?? []).entries()) {
    const content = m?.content;
    if (Array.isArray(content)) {
      for (const [j, part] of content.entries()) {
        if (part?.cache_control) out.push({ where: `messages[${i}].content[${j}]`, role: m.role });
      }
    } else if (content?.cache_control) {
      out.push({ where: `messages[${i}].content`, role: m.role });
    }
  }
  return out;
}

describe("anthropic wire format — cacheControl actually reaches the API", () => {
  it("serialises cacheControl on a USER message into cache_control", async () => {
    const msgs = withAnthropicCacheBreakpoints([
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
    ]);
    const body = await captureRequest(msgs);
    const found = markers(body);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.role === "user")).toBe(true);
  });

  it("serialises cacheControl on ASSISTANT and TOOL messages (the tool-loop case)", async () => {
    // A realistic mid-tool-loop array: the newest message is a tool_result.
    const msgs = withAnthropicCacheBreakpoints([
      { role: "system", content: "SYS" },
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "json", value: { ok: true } } },
        ],
      },
    ]);
    const body = await captureRequest(msgs);

    // STRICT: the head here is the tool_result, and it must carry a real
    // cache_control on the wire. Verified actual payload shape:
    //   messages[2] role=user part[0] type=tool_result cache_control={"type":"ephemeral"}
    // (the provider rewrites role:"tool" to role:"user" with a tool_result
    // part, per Anthropic's format — the marker survives that rewrite).
    const toolResultParts = (body.messages ?? []).flatMap((m: any) =>
      (Array.isArray(m.content) ? m.content : [m.content]).filter(
        (p: any) => p?.type === "tool_result",
      ),
    );
    expect(toolResultParts.length).toBe(1);
    expect(toolResultParts[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("serialises the SYSTEM breakpoint too (the pre-existing path still works)", async () => {
    const body = await captureRequest([
      {
        role: "system",
        content: "SYS",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { role: "user", content: "hi" },
    ]);
    const sys = Array.isArray(body.system) ? body.system : [];
    expect(sys.length).toBeGreaterThan(0);
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" });
  });

  /**
   * Audit finding 11 — the non-streaming `run()` path passes the system prompt
   * via `instructions`, which cannot carry providerOptions, so its breakpoints
   * live only on the message array. This asserts that still caches the static
   * prefix: an Anthropic cache entry at position P covers the whole prefix
   * [0..P], so the tool definitions and the system prompt sitting AHEAD of a
   * marked message are inside the cached region.
   */
  it("run()-shaped call: instructions + message breakpoints still mark the wire", async () => {
    let body: any;
    const anthropic = createAnthropic({
      apiKey: "test-key-not-used",
      fetch: (async (_url: any, init: any) => {
        body = JSON.parse(String(init.body));
        return anthropicResponse();
      }) as any,
    });
    const msgs = withAnthropicCacheBreakpoints([
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "t", input: { a: 1 } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "t", output: { type: "json", value: { ok: true } } },
        ],
      },
    ]);
    await generateText({
      model: anthropic("claude-sonnet-4-5"),
      instructions: "SYSTEM PROMPT VIA INSTRUCTIONS",
      messages: msgs as any,
    } as any);

    // The system prompt reached the wire via the top-level `system` field...
    const sysText = JSON.stringify(body.system ?? "");
    expect(sysText).toContain("SYSTEM PROMPT VIA INSTRUCTIONS");
    // ...and at least one message breakpoint is present, which is what pulls
    // that system field into the cached prefix.
    const found = markers(body);
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(4);
  });

  it("never exceeds Anthropic's 4-breakpoint limit on a long tool-heavy turn", async () => {
    const msgs: CacheableMessage[] = [
      { role: "system", content: "SYS", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "user", content: "start" },
    ];
    for (let n = 0; n < 25; n++) {
      msgs.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: "t", input: {} }] });
      msgs.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: "t", output: { type: "json", value: 1 } }],
      });
    }
    const body = await captureRequest(withAnthropicCacheBreakpoints(msgs));
    expect(markers(body).length).toBeLessThanOrEqual(4);
  });
});
