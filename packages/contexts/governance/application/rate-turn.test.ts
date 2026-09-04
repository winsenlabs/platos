import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { TurnId } from "../domain/index.js";
import { rateTurn, readTurnRating, withdrawRating } from "./rate-turn.js";
import {
  AGENT_ID,
  AGENT_VERSION_ID,
  END_USER_ID,
  OTHER_END_USER_ID,
  THREAD_ID,
  TURN_ID,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const AS_END_USER = { kind: "end-user", endUserId: END_USER_ID } as const;
const AS_OTHER_END_USER = { kind: "end-user", endUserId: OTHER_END_USER_ID } as const;
const AS_OPERATOR = { kind: "operator" } as const;

let context: GovernanceTestContext;

beforeEach(() => {
  context = buildGovernanceTestContext();
});

function cast(overrides: Record<string, unknown> = {}) {
  return rateTurn(context.dependencies, {
    authorization: context.authorization,
    actor: AS_END_USER,
    turnId: TURN_ID,
    rating: 1,
    ...overrides,
  });
}

describe("gate 1 — the actor", () => {
  it("REFUSES an operator principal and WRITES NOTHING", async () => {
    const written = await cast({ actor: AS_OPERATOR });
    expect(written.ok).toBe(false);
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_RATING_ACTOR_FORBIDDEN");
    expect(context.ratings.size()).toBe(0);
  });

  it("refuses the operator WITHOUT reading the turn, so ids cannot be probed", async () => {
    await cast({ actor: AS_OPERATOR, turnId: asIdentifier<TurnId>("turn-does-not-exist") });
    // A rating-target read would have been the only way to distinguish a real
    // turn id from a made-up one.
    expect(context.ratings.size()).toBe(0);
  });

  it("REFUSES an operator on the WITHDRAW path too", async () => {
    const withdrawn = await withdrawRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_OPERATOR,
      turnId: TURN_ID,
    });
    expect(!withdrawn.ok && withdrawn.error.code).toBe("GOVERNANCE_RATING_ACTOR_FORBIDDEN");
  });

  it("REFUSES an operator on the READ path too", async () => {
    const read = await readTurnRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_OPERATOR,
      turnId: TURN_ID,
    });
    expect(!read.ok && read.error.code).toBe("GOVERNANCE_RATING_ACTOR_FORBIDDEN");
  });
});

describe("gate 2 — the environment", () => {
  it("REFUSES an unminted grant and writes nothing", async () => {
    const written = await cast({ authorization: { pretend: true } });
    expect(written.ok).toBe(false);
    expect(context.ratings.size()).toBe(0);
  });

  it("cannot reach a turn in another environment with a grant for that other one", async () => {
    const written = await cast({ authorization: context.grantFor(otherEnvironmentScope()) });
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_RATING_TARGET_NOT_FOUND");
    expect(context.ratings.size()).toBe(0);
  });
});

describe("gate 3 — the turn's owner", () => {
  it("REFUSES a turn that does not exist", async () => {
    const written = await cast({ turnId: asIdentifier<TurnId>("turn-nope") });
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_RATING_TARGET_NOT_FOUND");
    expect(context.ratings.size()).toBe(0);
  });

  it("REFUSES a turn that belongs to a DIFFERENT end user, and writes nothing", async () => {
    const written = await cast({ actor: AS_OTHER_END_USER });
    expect(written.ok).toBe(false);
    expect(context.ratings.size()).toBe(0);
  });

  it("answers the SAME code for both, so a caller cannot tell them apart", async () => {
    // Distinguishing them is exactly the probe that lets an authenticated end
    // user enumerate other people's turns. Both branches are exercised above by
    // asserting that no row was written, so the shared code hides no untested
    // path.
    const missing = await cast({ turnId: asIdentifier<TurnId>("turn-nope") });
    const somebodyElses = await cast({ actor: AS_OTHER_END_USER });
    expect(!missing.ok && missing.error.code).toBe("GOVERNANCE_RATING_TARGET_NOT_FOUND");
    expect(!somebodyElses.ok && somebodyElses.error.code).toBe("GOVERNANCE_RATING_TARGET_NOT_FOUND");
  });

  it("REFUSES when the target reader is down, rather than writing unattributed", async () => {
    context.ratingTargets.failNext("reader down");
    const written = await cast();
    expect(written.ok).toBe(false);
    expect(context.ratings.size()).toBe(0);
  });
});

describe("the rating value and comment", () => {
  it("REFUSES a value that is not exactly 1 or -1, and writes nothing", async () => {
    for (const rating of [0, 2, -3, 1.5, Number.NaN]) {
      const written = await cast({ rating });
      expect(!written.ok && written.error.code).toBe("GOVERNANCE_RATING_VALUE_INVALID");
    }
    expect(context.ratings.size()).toBe(0);
  });

  it("REFUSES an over-long comment against the policy it was given", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ ratings: { maxCommentLength: 5 } }) });
    const written = await cast({ comment: "abcdef" });
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_RATING_COMMENT_TOO_LONG");
    expect(context.ratings.size()).toBe(0);
  });

  it("admits a comment at exactly that ceiling", async () => {
    context = buildGovernanceTestContext({ policy: withPolicy({ ratings: { maxCommentLength: 5 } }) });
    const written = await cast({ comment: "abcde" });
    expect(written.ok && written.value.comment).toBe("abcde");
  });

  it("stores a whitespace-only comment as null", async () => {
    const written = await cast({ comment: "   " });
    expect(written.ok && written.value.comment).toBeNull();
  });
});

describe("what a successful vote writes", () => {
  it("attributes the vote to the turn's agent and the LIVE version", async () => {
    const written = await cast();
    expect(written.ok && written.value.agentId).toBe(AGENT_ID);
    expect(written.ok && written.value.agentVersionId).toBe(AGENT_VERSION_ID);
    expect(written.ok && written.value.turnId).toBe(TURN_ID);
    expect(written.ok && written.value.endUserId).toBe(END_USER_ID);
  });

  it("starts the revision at 1", async () => {
    const written = await cast();
    expect(written.ok && written.value.revision).toBe(1);
  });

  it("FLIPS in place rather than adding a second row, and bumps the revision", async () => {
    await cast({ rating: 1 });
    const flipped = await cast({ rating: -1 });
    expect(context.ratings.size()).toBe(1);
    expect(flipped.ok && flipped.value.rating).toBe(-1);
    expect(flipped.ok && flipped.value.revision).toBe(2);
  });

  it("keeps two DIFFERENT end users' votes on one turn as two rows", async () => {
    context.ratingTargets.seed(context.scope, {
      turnId: asIdentifier<TurnId>("turn-2"),
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      endUserId: OTHER_END_USER_ID,
    });
    await cast();
    await cast({ actor: AS_OTHER_END_USER, turnId: asIdentifier<TurnId>("turn-2") });
    expect(context.ratings.size()).toBe(2);
  });

  it("writes inside ONE transaction that commits", async () => {
    await cast();
    expect(context.unitOfWork.opened).toBe(1);
    expect(context.unitOfWork.lastOutcome).toBe("committed");
  });

  it("still writes when `agents` cannot say which version was live", async () => {
    // The label is worth less than the vote.
    context.agents.failEverything();
    const written = await cast();
    expect(written.ok).toBe(true);
    expect(written.ok && written.value.agentVersionId).toBeNull();
    expect(context.ratings.size()).toBe(1);
  });

  it("reports a store failure rather than answering as though it wrote", async () => {
    context.ratings.failNext("store down");
    const written = await cast();
    expect(written.ok).toBe(false);
    expect(context.ratings.size()).toBe(0);
  });
});

describe("withdrawRating", () => {
  it("removes this end user's vote and answers true", async () => {
    await cast();
    const withdrawn = await withdrawRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_END_USER,
      turnId: TURN_ID,
    });
    expect(withdrawn).toEqual({ ok: true, value: true });
    expect(context.ratings.size()).toBe(0);
  });

  it("is idempotent: withdrawing nothing answers FALSE, not an error", async () => {
    const withdrawn = await withdrawRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_END_USER,
      turnId: TURN_ID,
    });
    expect(withdrawn).toEqual({ ok: true, value: false });
  });

  it("cannot withdraw somebody ELSE's vote", async () => {
    await cast();
    const withdrawn = await withdrawRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_OTHER_END_USER,
      turnId: TURN_ID,
    });
    expect(withdrawn.ok).toBe(false);
    expect(context.ratings.size()).toBe(1);
  });
});

describe("readTurnRating", () => {
  it("answers this end user's own vote and the turn's anonymous aggregate", async () => {
    await cast({ rating: 1 });
    const read = await readTurnRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_END_USER,
      turnId: TURN_ID,
    });
    expect(read.ok && read.value.own?.rating).toBe(1);
    expect(read.ok && read.value.aggregate).toEqual({ ups: 1, downs: 0, discarded: 0 });
  });

  it("answers a null own-vote when this end user has not voted", async () => {
    const read = await readTurnRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_END_USER,
      turnId: TURN_ID,
    });
    expect(read.ok && read.value.own).toBeNull();
    expect(read.ok && read.value.aggregate.ups).toBe(0);
  });

  it("counts everybody's votes in the aggregate WITHOUT naming anybody", async () => {
    context.ratingTargets.seed(context.scope, {
      turnId: TURN_ID,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      endUserId: OTHER_END_USER_ID,
    });
    await cast({ rating: 1 });
    const read = await readTurnRating(context.dependencies, {
      authorization: context.authorization,
      actor: AS_END_USER,
      turnId: TURN_ID,
    });
    expect(read.ok && Object.keys(read.value.aggregate).sort()).toEqual(["discarded", "downs", "ups"]);
  });
});
