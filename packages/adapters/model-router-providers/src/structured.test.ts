import type { Prompt } from "@platos/context-providers/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { err, ok, type TokenUsage } from "@platos/context-providers/application/ports/index.js";

import { compileOutputSchema, runObjectPasses, validatingSchema, type PassOutcome } from "./structured.js";

/** What two rejected passes cost, so the failure can carry it. */
const SPENT: TokenUsage = {
  inputTokens: 240_000,
  outputTokens: 900,
  cacheReadInputTokens: 180_000,
  cacheWriteInputTokens: 12_000,
};

const spent = () => SPENT;

const PERSON = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name", "age"],
  additionalProperties: false,
};

function promptOf(...texts: readonly string[]): Prompt {
  return {
    messages: texts.map((text) => ({
      role: "user" as const,
      content: [{ kind: "text" as const, text }],
      cacheBreakpoint: false,
    })),
  };
}

describe("compiling a schema", () => {
  it("accepts a value the schema admits", () => {
    const compiled = compileOutputSchema(PERSON);

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("unreachable");
    expect(compiled.value.check({ name: "ada", age: 36 })).toEqual({
      ok: true,
      value: { name: "ada", age: 36 },
    });
  });

  it("names every violation with its path", () => {
    const compiled = compileOutputSchema(PERSON);
    if (!compiled.ok) throw new Error("unreachable");

    const outcome = compiled.value.check({ name: 1, age: "old" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.errors).toContain("/name: must be string");
    expect(outcome.errors).toContain("/age: must be integer");
  });

  it("names a root-level violation as `<root>`", () => {
    const compiled = compileOutputSchema(PERSON);
    if (!compiled.ok) throw new Error("unreachable");

    const outcome = compiled.value.check("not an object");

    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.errors[0]).toContain("<root>");
  });

  it("refuses a document that is not a JSON Schema, under its OWN code", () => {
    // Not `PROVIDERS_STRUCTURED_OUTPUT_INVALID`. That code means the MODEL
    // produced the wrong thing and a retry might fix it; this one means the
    // request was never answerable and no retry ever will.
    const compiled = compileOutputSchema({ type: "not-a-type" });

    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("unreachable");
    expect(compiled.error.code).toBe("PROVIDERS_OUTPUT_SCHEMA_INVALID");
  });

  it("reports a schema it cannot compile as null on the non-fatal path", () => {
    expect(validatingSchema({ type: "not-a-type" })).toBeNull();
    expect(validatingSchema(PERSON)).not.toBeNull();
  });

  it("keeps its registrations request-local, so one caller cannot poison another", () => {
    // A shared instance registers caller-supplied `$id` values GLOBALLY, and a
    // second compile of the same ordinary id then fails for somebody else.
    const first = compileOutputSchema({ $id: "https://tenant/schema.json", type: "object" });
    const second = compileOutputSchema({ $id: "https://tenant/schema.json", type: "object" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

describe("the pass loop", () => {
  const compiled = compileOutputSchema(PERSON);
  if (!compiled.ok) throw new Error("fixture schema does not compile");
  const validator = compiled.value;

  it("stops after one pass when the model got it right", async () => {
    let passes = 0;
    const outcome = await runObjectPasses(
      promptOf("who?"),
      validator,
      2,
      (given) => given,
      async () => {
        passes += 1;
        return ok({ object: { name: "ada", age: 36 }, rawText: '{"name":"ada","age":36}' });
      },
      spent,
    );

    expect(passes).toBe(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.value.corrections).toBe(0);
    expect(outcome.value.object).toEqual({ name: "ada", age: 36 });
  });

  it("appends ONE correction carrying the errors and the prior output", async () => {
    const seen: Prompt[] = [];
    await runObjectPasses(
      promptOf("who?"),
      validator,
      2,
      (given) => given,
      async (prompt, passNumber) => {
        seen.push(prompt);
        return passNumber === 1
          ? ok({ object: { name: 1, age: "old" }, rawText: '{"name":1,"age":"old"}' })
          : ok({ object: { name: "ada", age: 36 }, rawText: "{}" });
      },
      spent,
    );

    expect(seen).toHaveLength(2);
    expect(seen[1]?.messages).toHaveLength(2);
    const correction = seen[1]?.messages[1];
    expect(correction?.role).toBe("user");
    const text = correction?.content[0]?.kind === "text" ? correction.content[0].text : "";
    expect(text).toContain("1. /name: must be string");
    expect(text).toContain('<prior>\n{"name":1,"age":"old"}\n</prior>');
  });

  it("re-places the cache breakpoints on the prompt the correction extended", async () => {
    // Without the rewrite the head marker stays on the message BEFORE the
    // correction, and the correction pass re-pays full price for the history.
    let rewrites = 0;
    await runObjectPasses(
      promptOf("who?"),
      validator,
      2,
      (given) => {
        rewrites += 1;
        return given;
      },
      async (_prompt, passNumber) =>
        passNumber === 1
          ? ok({ object: { wrong: true }, rawText: "{}" })
          : ok({ object: { name: "ada", age: 36 }, rawText: "{}" }),
      spent,
    );

    expect(rewrites).toBe(1);
  });

  it("runs exactly the budget and no more", async () => {
    let passes = 0;
    const outcome = await runObjectPasses(
      promptOf("who?"),
      validator,
      3,
      (given) => given,
      async () => {
        passes += 1;
        return ok({ object: { wrong: true }, rawText: "{}" });
      },
      spent,
    );

    expect(passes).toBe(3);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_STRUCTURED_OUTPUT_INVALID");
    expect(outcome.error.details.passes).toBe(3);
    // The failure carries what the three rejected passes cost. Without this a
    // failed structured turn is billed at nothing on this entry point and at its
    // real price on the streaming one.
    expect(outcome.error.details.inputTokens).toBe(240_000);
    expect(outcome.error.details.cacheReadInputTokens).toBe(180_000);
    expect(outcome.error.details.cacheWriteInputTokens).toBe(12_000);
    expect(outcome.error.details.outputTokens).toBe(900);
  });

  it("runs exactly ONE pass when the budget is one, and fails closed", async () => {
    // A legitimate setting for a caller that would rather fail than pay for a
    // second pass.
    let passes = 0;
    const outcome = await runObjectPasses(
      promptOf("who?"),
      validator,
      1,
      (given) => given,
      async () => {
        passes += 1;
        return ok({ object: { wrong: true }, rawText: "{}" });
      },
      spent,
    );

    expect(passes).toBe(1);
    expect(outcome.ok).toBe(false);
  });

  it("corrects a pass that produced nothing parseable at all", async () => {
    const seen: Prompt[] = [];
    const outcome = await runObjectPasses(
      promptOf("who?"),
      validator,
      2,
      (given) => given,
      async (prompt, passNumber) => {
        seen.push(prompt);
        return passNumber === 1
          ? ok({ object: undefined, rawText: "I am afraid I cannot" } satisfies PassOutcome)
          : ok({ object: { name: "ada", age: 36 }, rawText: "{}" });
      },
      spent,
    );

    expect(outcome.ok).toBe(true);
    const correction = seen[1]?.messages[1];
    const text = correction?.content[0]?.kind === "text" ? correction.content[0].text : "";
    expect(text).toContain("no output the schema could be applied to");
    expect(text).toContain("I am afraid I cannot");
  });

  it("ends the loop at once on a failure another pass cannot fix", async () => {
    let passes = 0;
    const outcome = await runObjectPasses(
      promptOf("who?"),
      validator,
      3,
      (given) => given,
      async () => {
        passes += 1;
        return err({
          code: "PROVIDERS_GENERATION_ABORTED",
          category: "precondition_failed",
          message: "gone",
          details: {},
          fields: [],
          retryAfterSeconds: null,
        });
      },
      spent,
    );

    expect(passes).toBe(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("PROVIDERS_GENERATION_ABORTED");
  });

  it("quotes the LAST text the model produced, not an empty later one", async () => {
    const seen: Prompt[] = [];
    await runObjectPasses(
      promptOf("who?"),
      validator,
      3,
      (given) => given,
      async (prompt, passNumber) => {
        seen.push(prompt);
        if (passNumber === 1) return ok({ object: { bad: 1 }, rawText: "FIRST TRY TEXT" });
        return ok({ object: { bad: 2 }, rawText: "" });
      },
      spent,
    );

    const third = seen[2]?.messages[seen[2].messages.length - 1];
    const text = third?.content[0]?.kind === "text" ? third.content[0].text : "";
    expect(text).toContain("FIRST TRY TEXT");
  });
});
