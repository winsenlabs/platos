import { describe, it, expect } from "vitest";
import { ConversationService } from "./conversation.service";

/**
 * CURSOR-ANCHORED HISTORY.
 *
 * The window was a pure slide (`orderBy desc, take: limit`), which broke two
 * things at once:
 *
 *  1. Compaction was ADDITIVE. Messages between the compaction cursor and the
 *     start of the sliding window appeared in the summary AND again in the
 *     loaded history, so compacting a thread INCREASED its token cost.
 *  2. It defeated cross-turn prompt caching. Anthropic matches an exact prefix,
 *     so the moment the oldest message slid off, messages[0] changed and the
 *     entire cached prefix died — every turn, on every thread past contextLimit.
 *
 * The anchor (`compactedUpToMessageId`) was already being WRITTEN by the
 * compaction path and read by nothing. Honouring it makes the window stepped:
 * fixed between compactions, moving once per cycle.
 */

type Msg = { id: string; role: "user" | "assistant"; content: string; createdAt: Date; encKeyVersion: null };

function makeMessages(n: number): Msg[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg-${i}`,
    createdAt: new Date(2026, 0, 1, 0, i),
    encKeyVersion: null,
  }));
}

/** Prisma stub that honours the where/orderBy/take the loader actually uses. */
function stubPrisma(messages: Msg[], cursorId: string | null) {
  return {
    platosAgentThread: {
      findFirst: async () => ({ compactedUpToMessageId: cursorId }),
    },
    platosAgentMessage: {
      findFirst: async ({ where }: any) => messages.find((m) => m.id === where.id) ?? null,
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = [...messages];
        const gt = where?.createdAt?.gt as Date | undefined;
        if (gt) rows = rows.filter((m) => m.createdAt > gt);
        rows.sort((a, b) =>
          orderBy?.createdAt === "desc"
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return rows.slice(0, take);
      },
    },
  };
}

function svc(messages: Msg[], cursorId: string | null) {
  const s = new ConversationService(stubPrisma(messages, cursorId) as any);
  // getThread does scope/ownership work irrelevant to windowing.
  (s as any).getThread = async () => ({ id: "t1", compactedSummary: null });
  return s;
}

const scope = {
  organizationId: "o", projectId: "p", environmentId: "e", userId: "u",
} as any;

describe("no cursor — behaviour is unchanged", () => {
  it("still returns the last N in chronological order", async () => {
    const msgs = makeMessages(50);
    const out = await svc(msgs, null).loadHistory("t1", scope, 10);
    expect(out).toHaveLength(10);
    expect(out[0].content).toBe("msg-40");
    expect(out[9].content).toBe("msg-49");
  });

  it("returns everything when the thread is shorter than the limit", async () => {
    const out = await svc(makeMessages(4), null).loadHistory("t1", scope, 30);
    expect(out.map((m) => m.content)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"]);
  });
});

describe("with a cursor — the window is anchored, not sliding", () => {
  it("returns only messages AFTER the cursor", async () => {
    const msgs = makeMessages(50);
    const out = await svc(msgs, "m29").loadHistory("t1", scope, 10);
    // Everything up to and including m29 is represented by the summary.
    expect(out[0].content).toBe("msg-30");
    expect(out.at(-1)!.content).toBe("msg-49");
    expect(out).toHaveLength(20);
  });

  it("does NOT re-include messages the summary already covers", async () => {
    // The additive-compaction bug: msg-0..29 are in the summary, so seeing any
    // of them here means we are paying for them twice.
    const out = await svc(makeMessages(50), "m29").loadHistory("t1", scope, 10);
    for (let i = 0; i <= 29; i++) {
      expect(out.some((m) => m.content === `msg-${i}`)).toBe(false);
    }
  });

  /**
   * THE CACHE REGRESSION. Turn N and turn N+1 must share a byte-identical
   * prefix; only the tail may grow.
   */
  it("keeps the prefix stable as the thread grows", async () => {
    const turnN = await svc(makeMessages(50), "m29").loadHistory("t1", scope, 10);
    const turnN1 = await svc(makeMessages(51), "m29").loadHistory("t1", scope, 10);

    expect(turnN1).toHaveLength(turnN.length + 1);
    // Every message of the earlier turn appears, unchanged, at the same index.
    expect(turnN1.slice(0, turnN.length)).toEqual(turnN);
  });

  it("WITHOUT the anchor the same two turns shift — proves the bug was real", async () => {
    const turnN = await svc(makeMessages(50), null).loadHistory("t1", scope, 10);
    const turnN1 = await svc(makeMessages(51), null).loadHistory("t1", scope, 10);
    // Same length, but every element moved: messages[0] changed, so the whole
    // cached prefix is invalidated.
    expect(turnN1).toHaveLength(turnN.length);
    expect(turnN1[0]).not.toEqual(turnN[0]);
  });

  it("steps forward exactly once when the cursor advances", async () => {
    const msgs = makeMessages(60);
    const before = await svc(msgs, "m29").loadHistory("t1", scope, 10);
    const after = await svc(msgs, "m49").loadHistory("t1", scope, 10);
    expect(before[0].content).toBe("msg-30");
    expect(after[0].content).toBe("msg-50");
    expect(after.length).toBeLessThan(before.length);
  });
});

describe("safety", () => {
  it("falls back to the sliding window when the cursor points at a deleted message", async () => {
    // A dangling cursor must not wipe the history.
    const out = await svc(makeMessages(50), "does-not-exist").loadHistory("t1", scope, 10);
    expect(out).toHaveLength(10);
    expect(out.at(-1)!.content).toBe("msg-49");
  });

  it("caps an anchored window so stalled compaction cannot blow the context", async () => {
    // 500 messages after the cursor, limit 10 → cap is max(40, 50) = 50.
    const out = await svc(makeMessages(500), "m0").loadHistory("t1", scope, 10);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out[0].content).toBe("msg-1"); // oldest-after-cursor, still a stable prefix
  });
});
