import { describe, expect, it } from "vitest";
import { ConversationService } from "./conversation.service";

type Turn = {
  id: string;
  threadId: string;
  sequence: number;
  inputText: string;
  outputText: string;
  status: "SUCCEEDED";
  parentTurnId: null;
};

function makeTurns(count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    threadId: "thread-1",
    sequence: index + 1,
    inputText: `user-${index}`,
    outputText: `assistant-${index}`,
    status: "SUCCEEDED",
    parentTurnId: null,
  }));
}

function stubPrisma(turns: Turn[]) {
  return {
    turn: {
      findUnique: async ({ where }: any) => {
        const turn = turns.find((candidate) => candidate.id === where.id);
        return turn ? { sequence: turn.sequence } : null;
      },
      findFirst: async ({ where }: any) => turns.find((turn) => turn.id === where.id) ?? null,
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = turns.filter((turn) => turn.threadId === where.threadId);
        if (where.sequence?.gt !== undefined) {
          rows = rows.filter((turn) => turn.sequence > where.sequence.gt);
        }
        rows.sort((left, right) => orderBy.sequence === "desc"
          ? right.sequence - left.sequence
          : left.sequence - right.sequence);
        return rows.slice(0, take);
      },
    },
  };
}

function service(turns: Turn[], cursorId: string | null) {
  const instance = new ConversationService(stubPrisma(turns) as any);
  (instance as any).getThread = async () => ({
    id: "thread-1",
    compactedSummary: cursorId ? "summary" : null,
    compactedUpToTurnId: cursorId,
  });
  return instance;
}

const scope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  userId: "user",
} as any;

describe("cursor-anchored clean Turn history", () => {
  it("keeps the legacy sliding limit before the first compaction", async () => {
    const history = await service(makeTurns(25), null).loadHistory("thread-1", scope, 10);
    expect(history.map((message) => message.content)).toEqual([
      "user-20", "assistant-20",
      "user-21", "assistant-21",
      "user-22", "assistant-22",
      "user-23", "assistant-23",
      "user-24", "assistant-24",
    ]);
  });

  it("returns only Turn sides after the durable cursor", async () => {
    const turns = makeTurns(25);
    const history = await service(turns, turns[14]!.id).loadHistory("thread-1", scope, 10);
    expect(history[0]?.content).toBe("user-15");
    expect(history.at(-1)?.content).toBe("assistant-24");
    expect(history.some((message) => message.content === "assistant-14")).toBe(false);
  });

  it("keeps the cached prefix stable until compaction advances", async () => {
    const turns = makeTurns(25);
    const cursor = turns[14]!.id;
    const before = await service(turns, cursor).loadHistory("thread-1", scope, 10);
    const after = await service(makeTurns(26), cursor).loadHistory("thread-1", scope, 10);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("steps the live prefix forward exactly when the cursor advances", async () => {
    const turns = makeTurns(30);
    const before = await service(turns, turns[14]!.id).loadHistory("thread-1", scope, 10);
    const after = await service(turns, turns[24]!.id).loadHistory("thread-1", scope, 10);
    expect(before[0]?.content).toBe("user-15");
    expect(after[0]?.content).toBe("user-25");
  });

  it("falls back to the sliding window when no cursor row can be read", async () => {
    const history = await service(makeTurns(25), "00000000-0000-4000-8000-999999999999")
      .loadHistory("thread-1", scope, 10);
    expect(history).toHaveLength(10);
    expect(history[0]?.content).toBe("user-20");
  });

  it("keeps the newest complete turns when a 300-turn anchored window stalls", async () => {
    const turns = makeTurns(300);
    const history = await service(turns, turns[0]!.id).loadHistory("thread-1", scope, 10);
    expect(history).toHaveLength(50);
    expect(history[0]?.content).toBe("user-275");
    expect(history.at(-1)?.content).toBe("assistant-299");
    expect(history.some((message) => message.content === "assistant-274")).toBe(false);
  });
});
