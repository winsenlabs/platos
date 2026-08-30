import { describe, it, expect } from "vitest";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import {
  withAnthropicCacheBreakpoints,
  type CacheableMessage,
} from "./anthropic-cache-breakpoints";

/**
 * WORKSTREAM A — end-to-end measurement of the caching fix.
 *
 * The brief asks for verification from logged usage numbers rather than
 * assumptions. A real billed turn needs a deploy or a live API key, neither of
 * which is available here, so this measures the next best thing and is explicit
 * about the difference:
 *
 *   - REAL: the message array, the breakpoint placement, `prepareStep`, the
 *     provider's wire serialisation, and the AI SDK's multi-step tool loop. The
 *     request bodies inspected below are the exact bytes that would go to
 *     api.anthropic.com.
 *   - SIMULATED: the token accounting. A fake endpoint implements Anthropic's
 *     documented prefix-cache semantics (entry at position P covers the whole
 *     prefix [0..P]; a breakpoint hits if that exact prefix was seen before;
 *     max 4 breakpoints) and reports usage the way the real API would.
 *
 * So this proves the MECHANISM moves tokens from full-price to cache-read, and
 * by how much, on the real code path. It does not prove a number on an invoice.
 * The operator gate in docs/audits/history/win-252/prompt-caching-progress.md
 * still has to confirm against live usage.
 *
 * Token counts here are `bytes / 4`, applied identically to both arms, so the
 * ratio between arms is meaningful even though the absolute values are not
 * Anthropic's tokenizer.
 */

interface StepUsage {
  step: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  markers: number;
}

/** Deterministic stand-in for a tokenizer. Same function for both arms. */
const countTokens = (s: string) => Math.ceil(s.length / 4);

/** Stable hash of a prefix string. */
function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
    h2 = ((h2 + s.charCodeAt(i)) * 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}:${h2.toString(16)}:${s.length}`;
}

/**
 * Flatten a serialised Anthropic request into ordered content blocks, tracking
 * which ones carry a cache_control marker. Mirrors how the real API walks
 * `tools -> system -> messages`.
 */
function flattenBlocks(body: any): Array<{ text: string; marked: boolean }> {
  const blocks: Array<{ text: string; marked: boolean }> = [];
  /**
   * Serialise a block's CONTENT for hashing, excluding `cache_control` itself.
   *
   * This matters and is easy to get wrong. `cache_control` is metadata saying
   * WHERE to cut the prefix, not part of the content being cached. If it were
   * hashed as content, then moving a breakpoint forward would change the bytes
   * of the block it used to sit on and every hit would miss — which would make
   * Anthropic's own documented pattern (advance the breakpoint as the
   * conversation grows) impossible. Including it here produced exactly that
   * false negative: reads pinned at the system prefix and nothing else ever hit.
   */
  const contentText = (v: unknown, prefix = ""): string => {
    if (typeof v === "string") return prefix + v;
    if (v && typeof v === "object") {
      const { cache_control: _dropped, ...rest } = v as Record<string, unknown>;
      return prefix + JSON.stringify(rest);
    }
    return prefix + JSON.stringify(v);
  };

  if (body?.tools) {
    for (const t of body.tools) {
      blocks.push({ text: contentText(t), marked: Boolean(t?.cache_control) });
    }
  }
  const sys = Array.isArray(body?.system) ? body.system : body?.system ? [body.system] : [];
  for (const s of sys) {
    blocks.push({ text: contentText(s), marked: Boolean(s?.cache_control) });
  }
  for (const m of body?.messages ?? []) {
    const parts = Array.isArray(m.content) ? m.content : [m.content];
    for (const p of parts) {
      blocks.push({
        text: contentText(p, `${m.role}:`),
        marked: Boolean(p?.cache_control),
      });
    }
  }
  return blocks;
}

/**
 * A fake Anthropic endpoint implementing prefix-cache semantics, shared by both
 * arms so the comparison is apples-to-apples.
 */
function makeFakeAnthropic(opts: { toolSteps: number; usageLog: StepUsage[] }) {
  const cacheStore = new Set<string>();
  let step = 0;

  const fetchImpl = async (_url: any, init: any) => {
    step++;
    const body = JSON.parse(String(init.body));
    const blocks = flattenBlocks(body);

    // Cumulative prefix hash + token count at EVERY block boundary. A hit does
    // not require the current request to re-mark the position that was cached
    // last time — the API does a longest-prefix match, and the prefix cached at
    // the previous step's breakpoint is still a byte-identical prefix of this
    // request. Modelling only exactly-marked positions would understate hits.
    let running = "";
    let tokensSoFar = 0;
    const hashAt: string[] = [];
    const tokensAt: number[] = [];
    const markedIdx: number[] = [];
    blocks.forEach((b, i) => {
      running += b.text;
      tokensSoFar += countTokens(b.text);
      hashAt.push(hash(running));
      tokensAt.push(tokensSoFar);
      if (b.marked) markedIdx.push(i);
    });
    const totalTokens = tokensSoFar;

    // Anthropic honours at most 4 breakpoints; the rest are dropped in
    // document order, which is exactly why marker accumulation was fatal.
    const honoured = markedIdx.slice(0, 4);

    // For each honoured breakpoint, look back up to the documented ~20-block
    // window for the longest cached prefix. Largest hit across breakpoints wins.
    const LOOKBACK = 20;
    let cacheRead = 0;
    for (const mi of honoured) {
      for (let j = mi; j >= Math.max(0, mi - LOOKBACK); j--) {
        if (cacheStore.has(hashAt[j])) {
          if (tokensAt[j] > cacheRead) cacheRead = tokensAt[j];
          break; // longest match for THIS breakpoint
        }
      }
    }

    // Newly marked prefixes are written; the billed write is the increment
    // beyond what was read, matching `cache_creation_input_tokens`.
    let deepestNew = 0;
    for (const mi of honoured) {
      if (!cacheStore.has(hashAt[mi])) {
        cacheStore.add(hashAt[mi]);
        if (tokensAt[mi] > deepestNew) deepestNew = tokensAt[mi];
      }
    }
    const cacheWrite = Math.max(0, deepestNew - cacheRead);
    const fullPrice = Math.max(0, totalTokens - cacheRead - cacheWrite);

    opts.usageLog.push({
      step,
      input: fullPrice,
      cacheRead,
      cacheWrite,
      markers: markedIdx.length,
    });

    const isToolStep = step <= opts.toolSteps;
    return new Response(
      JSON.stringify({
        id: `msg_${step}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: isToolStep
          ? [{ type: "tool_use", id: `toolu_${step}`, name: "probe", input: { q: `q${step}` } }]
          : [{ type: "text", text: "done" }],
        stop_reason: isToolStep ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: fullPrice,
          output_tokens: 20,
          cache_creation_input_tokens: cacheWrite,
          cache_read_input_tokens: cacheRead,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  return createAnthropic({ apiKey: "test-key-not-used", fetch: fetchImpl as any });
}

/** A tool whose result is bulky, so history growth actually costs something. */
const probeTool = tool({
  description: "Returns a chunk of context.",
  inputSchema: z.object({ q: z.string() }),
  execute: async ({ q }) => ({
    q,
    // ~2.5k tokens of result per call — the shape of a real tool payload.
    payload: `RESULT for ${q}. `.repeat(500),
  }),
});

/** Big system prompt so the prefix is well over the 1024-token minimum. */
const SYSTEM = "You are Walle, an operations agent. ".repeat(200);

const STEPS = 12; // matches the evidence trace's ~12 sequential LLM steps

async function runArm(mode: "before" | "after"): Promise<StepUsage[]> {
  const usageLog: StepUsage[] = [];
  const anthropic = makeFakeAnthropic({ toolSteps: STEPS - 1, usageLog });

  const initial: CacheableMessage[] = [
    {
      role: "system",
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    { role: "user", content: "Do the twelve-step thing." },
  ];

  await generateText({
    model: anthropic("claude-sonnet-4-5"),
    messages: (mode === "after"
      ? withAnthropicCacheBreakpoints(initial)
      : initial) as any,
    tools: { probe: probeTool },
    stopWhen: isStepCount(STEPS),
    allowSystemInMessages: true,
    // BEFORE = the pre-fix behaviour: one breakpoint on the system message,
    // placed once, never moved. AFTER = the fix: breakpoints re-placed on the
    // grown array at every step.
    ...(mode === "after"
      ? {
          prepareStep: ({ messages }: any) => ({
            messages: withAnthropicCacheBreakpoints(
              messages as unknown as CacheableMessage[],
            ) as any,
          }),
        }
      : {}),
  } as any);

  return usageLog;
}

/**
 * Anthropic's published input multipliers: a cache read costs 0.1x base, a
 * 5-minute cache write costs 1.25x base. Cost is the metric that matters — a
 * raw cache-read PERCENTAGE flatters the fix, because the non-read remainder
 * shifts from full price (1.0x) to writes, which are more expensive per token
 * (1.25x), not less. Comparing on cost keeps that honest.
 */
const PRICE_FULL = 1.0;
const PRICE_READ = 0.1;
const PRICE_WRITE = 1.25;

function totals(log: StepUsage[]) {
  const sum = (k: keyof StepUsage) => log.reduce((n, r) => n + (r[k] as number), 0);
  const fullPrice = sum("input");
  const cacheRead = sum("cacheRead");
  const cacheWrite = sum("cacheWrite");
  return {
    fullPrice,
    cacheRead,
    cacheWrite,
    // Base-token-equivalents, i.e. what the turn actually bills.
    cost: fullPrice * PRICE_FULL + cacheRead * PRICE_READ + cacheWrite * PRICE_WRITE,
    maxMarkers: Math.max(...log.map((r) => r.markers)),
    steps: log.length,
  };
}

describe("WORKSTREAM A — simulated end-to-end cache measurement", () => {
  it("moves the bulk of a 12-step turn from full price to cache reads", async () => {
    const before = await runArm("before");
    const after = await runArm("after");
    const b = totals(before);
    const a = totals(after);

    const pct = (r: StepUsage) => {
      const t = r.input + r.cacheRead + r.cacheWrite;
      return t === 0 ? 0 : Math.round((r.cacheRead / t) * 100);
    };

    const table = [
      "",
      "  step |        BEFORE (system bp only)        |            AFTER (rolling bps)",
      "       |  full-price   read   write  read%     |  full-price   read   write  read%",
      "  -----+---------------------------------------+----------------------------------",
      ...before.map((r, i) => {
        const s = after[i];
        const f = (n: number, w: number) => String(n).padStart(w);
        return `  ${f(r.step, 4)} | ${f(r.input, 10)} ${f(r.cacheRead, 6)} ${f(r.cacheWrite, 7)} ${f(pct(r), 5)}%     | ${f(s?.input ?? 0, 10)} ${f(s?.cacheRead ?? 0, 6)} ${f(s?.cacheWrite ?? 0, 7)} ${f(s ? pct(s) : 0, 5)}%`;
      }),
      "  -----+---------------------------------------+----------------------------------",
      `  full-price tokens : ${b.fullPrice}  ->  ${a.fullPrice}`,
      `  cache-read tokens : ${b.cacheRead}  ->  ${a.cacheRead}`,
      `  cache-write tokens: ${b.cacheWrite}  ->  ${a.cacheWrite}`,
      `  BILLED (base-token-equivalents, 1.0/0.1x read/1.25x write):`,
      `        ${b.cost.toFixed(0)}  ->  ${a.cost.toFixed(0)}   (${(b.cost / Math.max(1, a.cost)).toFixed(2)}x cheaper)`,
      `  peak markers/req  : ${b.maxMarkers}  ->  ${a.maxMarkers}   (Anthropic limit 4)`,
      "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(table);

    // Both arms must have actually run the full loop, or the comparison is void.
    expect(b.steps).toBe(STEPS);
    expect(a.steps).toBe(STEPS);

    // The fix must never exceed Anthropic's hard limit of 4 breakpoints.
    expect(a.maxMarkers).toBeLessThanOrEqual(4);

    // THE CORE CLAIM: no step re-pays full price for history it already sent.
    // This is what was broken — one static breakpoint meant every step past the
    // first paid 1.0x for the whole grown array.
    for (const r of after) {
      expect(r.input).toBe(0);
    }
    expect(b.fullPrice).toBeGreaterThan(100_000); // the bug, quantified
    expect(a.fullPrice).toBe(0);

    // The brief's read-share gate, applied where it can physically hold. The
    // early steps of a turn cannot reach 90%: a prefix must be WRITTEN before it
    // can be read, so step 1 is all write by definition and the share climbs as
    // the cached prefix comes to dominate the request. Steady state is the half
    // of the turn where the tail cost actually lives.
    const steadyState = after.slice(Math.ceil(after.length / 2));
    for (const r of steadyState) {
      expect(pct(r)).toBeGreaterThanOrEqual(85);
    }
    expect(pct(after[after.length - 1])).toBeGreaterThanOrEqual(90);

    // And the whole-turn BILL must fall by at least 3x — the low end of the
    // range the brief asked for. Cost, not token share, because the non-read
    // remainder moves to writes at 1.25x.
    expect(b.cost / Math.max(1, a.cost)).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("BEFORE arm confirms the bug: later steps re-pay full price", async () => {
    // Guards the comparison itself. If the "before" arm ever started caching,
    // the measurement above would be meaningless and this fails loudly.
    const before = await runArm("before");
    const last = before[before.length - 1];
    const t = last.input + last.cacheRead + last.cacheWrite;
    expect(last.input / t).toBeGreaterThan(0.5);
  }, 30_000);
});
