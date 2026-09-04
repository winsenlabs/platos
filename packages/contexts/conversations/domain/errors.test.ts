// The catalogue's own invariants.
//
// ITS KNOWN LIMIT, STATED IN THE MODULE AND RESTATED HERE: this suite checks
// CONSTRUCTORS for uniqueness, not GUARDS. Two guards calling one constructor
// are invisible to it, and `mutations.json` is the control on that. What it does
// enforce is that no two constructors mint the same code, which is the property
// every mutation in that ledger depends on.

import { describe, expect, it } from "vitest";

import * as errors from "./errors.js";
import { CONVERSATIONS_ERROR_CODES } from "./errors.js";

const CONSTRUCTORS = Object.entries(errors).filter(
  (entry): entry is [string, (...args: never[]) => errors.ConversationsErrorCode extends never ? never : ReturnType<typeof errors.turnsDisabled>] =>
    typeof entry[1] === "function",
);

/**
 * Arguments for the constructors a generic probe cannot supply.
 *
 * One entry, and it is here rather than in a `try`/`catch` because a swallowed
 * exception would make this whole suite pass against a constructor that throws.
 * `postmanHandleExpired` renders a `Date`; every other constructor is total over
 * strings and numbers.
 */
const SPECIAL_ARGUMENTS: Readonly<Record<string, readonly unknown[]>> = {
  postmanHandleExpired: ["handle-1", new Date("2026-01-01T00:00:00.000Z")],
};

function invoke(name: string, build: (...args: never[]) => unknown): unknown {
  const supplied = SPECIAL_ARGUMENTS[name];
  const args = supplied ?? (["a", "b", 1, 2] as readonly unknown[]).slice(0, build.length);
  return (build as (...rest: unknown[]) => unknown)(...args);
}

describe("CONVERSATIONS_ERROR_CODES", () => {
  it("has no duplicate entry", () => {
    expect(new Set(CONVERSATIONS_ERROR_CODES).size).toBe(CONVERSATIONS_ERROR_CODES.length);
  });

  it("spells every code SCREAMING_SNAKE and prefixes every one with the context", () => {
    for (const code of CONVERSATIONS_ERROR_CODES) {
      expect(code).toMatch(/^CONVERSATIONS(?:_[A-Z0-9]+)+$/u);
    }
  });
});

describe("the constructors", () => {
  it("mint a code that is on the published list, every one of them", () => {
    for (const [name, build] of CONSTRUCTORS) {
      const produced = invoke(name, build) as { code?: string };
      expect(typeof produced.code).toBe("string");
      expect(CONVERSATIONS_ERROR_CODES).toContain(produced.code);
    }
  });

  it("mint DISTINCT codes: no two constructors answer with the same one", () => {
    const minted = new Map<string, string>();
    for (const [name, build] of CONSTRUCTORS) {
      const produced = invoke(name, build) as { code: string };
      const previous = minted.get(produced.code);
      expect(
        previous,
        `${name} and ${previous ?? ""} both mint ${produced.code}`,
      ).toBeUndefined();
      minted.set(produced.code, name);
    }
    expect(minted.size).toBe(CONSTRUCTORS.length);
  });

  it("covers every published code with a constructor", () => {
    const minted = new Set(
      CONSTRUCTORS.map(([name, build]) => (invoke(name, build) as { code: string }).code),
    );
    for (const code of CONVERSATIONS_ERROR_CODES) expect(minted).toContain(code);
  });
});

describe("the categories that carry a retry contract", () => {
  it("sets `retryAfterSeconds` on the two unavailable infrastructure refusals", () => {
    expect(errors.repositoryUnavailable("down").retryAfterSeconds).toBe(1);
    expect(errors.queueUnavailable("down").retryAfterSeconds).toBe(1);
  });

  it("leaves it null on refusals a retry cannot fix", () => {
    expect(errors.turnsDisabled().retryAfterSeconds).toBeNull();
    expect(errors.threadArchived("t").retryAfterSeconds).toBeNull();
    expect(errors.subAgentCycle("a").retryAfterSeconds).toBeNull();
  });
});

describe("the pairs that must never share a code", () => {
  it("keeps the two fork ceilings apart", () => {
    expect(errors.forkCeilingExceeded(11, 10).code).not.toBe(errors.forkDepthExceeded(6, 5).code);
  });

  it("keeps the two attachment size ceilings apart", () => {
    expect(errors.attachmentTooLarge(1, 0).code).not.toBe(errors.attachmentTurnTooLarge(1, 0).code);
  });

  it("keeps the two halves of the money path apart", () => {
    expect(errors.stepUsageInvalid("inputTokens", -1).code).not.toBe(
      errors.stepRateMissing("inputRate", 5).code,
    );
  });

  it("keeps a postman replay apart from a fingerprint collision", () => {
    expect(errors.postmanRequestReplayed("t", "r").code).not.toBe(
      errors.postmanFingerprintMismatch("r").code,
    );
  });

  it("keeps `not_found` concealment apart from an operator's `forbidden`", () => {
    expect(errors.threadNotFound("t").category).toBe("not_found");
    expect(errors.threadForbidden("t", "u").category).toBe("forbidden");
    expect(errors.threadNotFound("t").code).not.toBe(errors.threadForbidden("t", "u").code);
  });
});

describe("what a refusal may carry", () => {
  it("never puts an identifier in the MESSAGE of a concealed not-found", () => {
    // A message that named the thread would undo the concealment the code buys.
    expect(errors.threadNotFound("thread-42").message).toBe("no such thread");
    expect(errors.turnNotFound("turn-42").message).toBe("no such turn");
    expect(errors.stepNotFound("step-42").message).toBe("no such step");
  });
});
