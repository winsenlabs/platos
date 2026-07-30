import { describe, it, expect } from "vitest";
import {
  relocateVolatilePromptVars,
  VOLATILE_VAR_POINTER,
  VOLATILE_PROMPT_VAR_PATHS,
} from "./volatile-prompt-vars";
import { substitutePromptVars } from "./context-resolver";

describe("relocateVolatilePromptVars", () => {
  it("replaces {{user.current_time}} with the pointer and reports it", () => {
    const r = relocateVolatilePromptVars("You are Walle. Now: {{user.current_time}}.");
    expect(r.prompt).toBe(`You are Walle. Now: ${VOLATILE_VAR_POINTER}.`);
    expect(r.relocated).toEqual(["user.current_time"]);
  });

  it("tolerates whitespace inside the braces, like substitutePromptVars does", () => {
    const r = relocateVolatilePromptVars("t={{  user.current_time  }}");
    expect(r.prompt).toBe(`t=${VOLATILE_VAR_POINTER}`);
    expect(r.relocated).toEqual(["user.current_time"]);
  });

  it("replaces EVERY occurrence, not just the first", () => {
    const r = relocateVolatilePromptVars("{{user.current_time}} .. {{user.current_time}}");
    expect(r.prompt.split(VOLATILE_VAR_POINTER)).toHaveLength(3);
    expect(r.relocated).toEqual(["user.current_time"]); // reported once
  });

  it("leaves non-volatile placeholders completely alone", () => {
    const src = "Hi {{user.name}} <{{user.email}}> id={{user.id}} x={{custom.plan}}";
    const r = relocateVolatilePromptVars(src);
    expect(r.prompt).toBe(src);
    expect(r.relocated).toEqual([]);
  });

  it("does not relocate a fixed timestamp that merely looks like a clock", () => {
    // contract.signed_at is stable across turns, so it is NOT cache poison and
    // must keep resolving to its real value.
    const src = "Signed at {{contract.signed_at}}.";
    expect(relocateVolatilePromptVars(src).prompt).toBe(src);
  });

  it("respects an operator promptVars allow-list that excludes the volatile key", () => {
    // If the allow-list omits user.current_time, substitution would have left
    // the placeholder verbatim anyway — relocating would CHANGE behaviour.
    const src = "Now: {{user.current_time}}";
    const r = relocateVolatilePromptVars(src, { promptVars: ["user.name"] });
    expect(r.prompt).toBe(src);
    expect(r.relocated).toEqual([]);
  });

  it("relocates when the allow-list explicitly includes the volatile key", () => {
    const r = relocateVolatilePromptVars("Now: {{user.current_time}}", {
      promptVars: ["user.name", "user.current_time"],
    });
    expect(r.relocated).toEqual(["user.current_time"]);
  });

  it("is a no-op on empty / null / undefined input", () => {
    expect(relocateVolatilePromptVars("").relocated).toEqual([]);
    expect(relocateVolatilePromptVars(null).prompt).toBe("");
    expect(relocateVolatilePromptVars(undefined).prompt).toBe("");
  });

  it("is idempotent — the pointer contains no placeholder to re-match", () => {
    const once = relocateVolatilePromptVars("Now: {{user.current_time}}").prompt;
    const twice = relocateVolatilePromptVars(once);
    expect(twice.prompt).toBe(once);
    expect(twice.relocated).toEqual([]);
  });
});

describe("integration with substitutePromptVars (the real substitution path)", () => {
  /**
   * THE REGRESSION THIS EXISTS FOR.
   *
   * Two turns 40ms apart produced two different system prompts, so the cached
   * prefix — tools AND system AND all message history — was invalidated on
   * every single turn. Relocation must make the two prompts byte-identical.
   */
  it("makes the system prompt byte-identical across turns", () => {
    const authored = "You are Walle.\nCurrent time: {{user.current_time}}\nUser: {{user.name}}";
    const turn = (iso: string) => {
      const ctx = { user: { name: "Tejas", current_time: iso } };
      const relocated = relocateVolatilePromptVars(authored);
      return substitutePromptVars(relocated.prompt, ctx, undefined);
    };
    const t1 = turn("2026-07-30T09:14:22.031Z");
    const t2 = turn("2026-07-30T09:14:22.071Z"); // 40ms later
    const t3 = turn("2026-07-30T11:02:57.884Z"); // ~2h later

    expect(t1).toBe(t2);
    expect(t1).toBe(t3);
    // The volatile value must be gone entirely...
    expect(t1).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // ...while every non-volatile var still resolves.
    expect(t1).toContain("User: Tejas");
    expect(t1).toContain(VOLATILE_VAR_POINTER);
  });

  it("WITHOUT relocation the same two turns differ — proves the bug is real", () => {
    const authored = "Current time: {{user.current_time}}";
    const raw = (iso: string) =>
      substitutePromptVars(authored, { user: { current_time: iso } }, undefined);
    expect(raw("2026-07-30T09:14:22.031Z")).not.toBe(raw("2026-07-30T09:14:22.071Z"));
  });

  it("no volatile path resolves to a raw timestamp after relocation", () => {
    // Guards against adding a path to VOLATILE_PROMPT_VAR_PATHS without the
    // regex handling it (e.g. a path containing regex metacharacters).
    for (const path of VOLATILE_PROMPT_VAR_PATHS) {
      const r = relocateVolatilePromptVars(`x {{${path}}} y`);
      expect(r.relocated).toContain(path);
      expect(r.prompt).not.toContain("{{");
    }
  });
});
