import { describe, it, expect } from "vitest";
import { PromptBuilderService } from "./prompt-builder.service";

/**
 * PROMPT-CACHE (audit finding 5) — `assembleAsync` must not bake a live clock
 * into the system prompt on the turn-time retrieval re-assemble path.
 *
 * Context: the save path already strips the datetime block from the stored
 * `systemPrompt` (PromptBlockEditor does this deliberately, citing the prompt
 * cache), and the streaming turn path injects a fresh timestamp into
 * `dynamicContext.__datetime` — which sits AFTER the last cache breakpoint.
 * But `assembleAsync`, which REPLACES the system prompt for any agent that has
 * a retrieval block, rendered the timestamp back inline. Result for such an
 * agent: the clock appeared twice with two different values, and the cached
 * prefix was invalidated every turn.
 */

type Block = Parameters<PromptBuilderService["assembleAsync"]>[0][number];

const block = (over: Partial<Block>): Block =>
  ({
    id: "b1",
    type: "identity",
    name: "Identity",
    content: "You are Walle.",
    enabled: true,
    editable: true,
    order: 0,
    ...over,
  }) as Block;

const ISO_TIME = /\d{2}:\d{2}:\d{2} UTC/;

describe("assembleAsync — datetime block and the cache prefix", () => {
  const pb = new PromptBuilderService();

  const blocks = [
    block({ id: "id", type: "identity", order: 0 }),
    block({ id: "dt", type: "datetime", name: "Date & time", content: "", order: 1 }),
  ];

  it("renders the live timestamp by default (run() / preview keep today's behaviour)", async () => {
    const out = await pb.assembleAsync(blocks, {}, undefined, undefined);
    expect(out).toMatch(ISO_TIME);
  });

  it("omits it when the caller supplies the clock post-breakpoint", async () => {
    const out = await pb.assembleAsync(blocks, {}, undefined, undefined, {
      omitDateTimeBlock: true,
    });
    expect(out).not.toMatch(ISO_TIME);
    expect(out).not.toMatch(/Current date:/);
    // Every other block still assembles — this is a surgical omission.
    expect(out).toContain("You are Walle.");
  });

  /**
   * THE REGRESSION. Two turns one second apart must produce a byte-identical
   * system prompt, or the whole cached prefix is thrown away every turn.
   */
  it("produces a byte-stable prompt across turns when omitted", async () => {
    const a = await pb.assembleAsync(blocks, {}, undefined, undefined, {
      omitDateTimeBlock: true,
    });
    await new Promise((r) => setTimeout(r, 1100)); // cross a second boundary
    const b = await pb.assembleAsync(blocks, {}, undefined, undefined, {
      omitDateTimeBlock: true,
    });
    expect(a).toBe(b);
  });

  it("WITHOUT the flag the same two turns differ — proves the bug is real", async () => {
    const a = await pb.assembleAsync(blocks, {}, undefined, undefined);
    await new Promise((r) => setTimeout(r, 1100));
    const b = await pb.assembleAsync(blocks, {}, undefined, undefined);
    expect(a).not.toBe(b);
  });

  it("the sync `assemble` preview path is untouched", async () => {
    // assemble() feeds the operator-facing preview and the cache-separation
    // precompute; it must keep rendering the clock.
    expect(pb.assemble(blocks, {})).toMatch(ISO_TIME);
  });
});
