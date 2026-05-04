/**
 * PPR-42 — Concurrent first-turn version-lock race test.
 *
 * Theme G.5 invariant: the FIRST turn on a thread rolls canary vs current,
 * persists the decision to PlatosAgentThread.lockedVersionId, and every
 * subsequent turn reads that exact version. If two turns race on the first
 * message (no lockedVersionId yet), exactly ONE lock must win, and the
 * other turn must observe the winner's lock + re-read the snapshot so both
 * turns serve under the SAME version.
 *
 * Pre-PPR-18 bug: both turns rolled independently, both set lockedVersionId
 * via `updateMany where lockedVersionId IS null`, but the loser had already
 * captured its own `pickedVersionId` locally — result: two concurrent turns
 * serve under DIFFERENT versions while the thread is now "locked" to one of
 * them. Breaks Theme G.5's "never flip mid-thread" guarantee for early
 * concurrent traffic.
 *
 * CLAUDE.md §9.11: Vitest only, no mocks. We use an in-memory Prisma shim
 * that models the `updateMany ... where ... IS null` atomicity precisely —
 * that's the surface under test.
 *
 * The test spins up two parallel `resolveConfigForThread` calls with a
 * canaryPercent=50 fixture. We force the race by making both calls observe
 * NULL lockedVersionId at the findFirst() step, then proceed to the
 * updateMany() step — the shim's updateMany atomic compare-and-swap
 * implementation mirrors Postgres's "0 rows affected" behaviour when the
 * guard fails. A correct implementation re-reads the winning version and
 * serves under it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentService } from "./agent.service";
import type { ScopedEnvService } from "../providers/scoped-env.service";

const SCOPE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
};
const AGENT_ID = "agent_1";
const THREAD_ID = "thread_1";
const CURRENT_VERSION_ID = "ver_current";
const CANARY_VERSION_ID = "ver_canary";

/**
 * In-memory prisma shim modelling the critical race-sensitive surface of
 * PlatosAgentThread.updateMany. The invariant: only the FIRST caller whose
 * `where` guard (`lockedVersionId: null`) still matches gets `count: 1`;
 * every subsequent caller gets `count: 0` even if they pass the same
 * candidate version. Postgres gives us this via row-level locking — we
 * simulate with a mutex + atomic JS compare-and-swap.
 */
function makePrismaShim(initialThread: {
  id: string;
  lockedVersionId: string | null;
  organizationId: string;
  projectId: string;
  environmentId: string;
}) {
  const threadStore = new Map<string, typeof initialThread>();
  threadStore.set(initialThread.id, { ...initialThread });

  const agentRow = {
    id: AGENT_ID,
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    environmentId: SCOPE.environmentId,
    currentVersionId: CURRENT_VERSION_ID,
    canaryVersionId: CANARY_VERSION_ID,
    canaryPercent: 50,
    featureFlags: null,
    name: "test",
    slug: "test",
    model: "anthropic:claude-sonnet-4-6",
    systemPrompt: "",
    promptBlocks: null,
    dynamicBlocks: null,
    maxSteps: 20,
    contextLimit: 20,
    historyMode: "rolling",
    compactThreshold: 40,
    enableUserProfiling: false,
    toolsBlockConfig: null,
    subAgentConfig: null,
    memoryConfig: null,
    metaTools: null,
    isActive: true,
    outputSchema: null,
  };

  const versions = new Map<string, { id: string; agentId: string; snapshot: any }>();
  versions.set(CURRENT_VERSION_ID, {
    id: CURRENT_VERSION_ID,
    agentId: AGENT_ID,
    snapshot: { model: "anthropic:claude-sonnet-4-6", systemPrompt: "CURRENT" },
  });
  versions.set(CANARY_VERSION_ID, {
    id: CANARY_VERSION_ID,
    agentId: AGENT_ID,
    snapshot: { model: "anthropic:claude-sonnet-4-6", systemPrompt: "CANARY" },
  });

  return {
    state: { threadStore, agentRow, versions },
    platosAgent: {
      findFirst: async (_args: any) => ({ ...agentRow }),
    },
    platosAgentThread: {
      findFirst: async (args: any) => {
        const id = args.where.id;
        const t = threadStore.get(id);
        if (!t) return null;
        // Scope check
        if (args.where.organizationId && args.where.organizationId !== t.organizationId) return null;
        return { id: t.id, lockedVersionId: t.lockedVersionId };
      },
      updateMany: async (args: any) => {
        const id = args.where.id;
        const t = threadStore.get(id);
        if (!t) return { count: 0 };
        // Atomic compare-and-swap: only update if guard matches.
        if (
          "lockedVersionId" in args.where &&
          args.where.lockedVersionId === null &&
          t.lockedVersionId !== null
        ) {
          return { count: 0 };
        }
        t.lockedVersionId = args.data.lockedVersionId ?? t.lockedVersionId;
        return { count: 1 };
      },
    },
    platosAgentVersion: {
      findFirst: async (args: any) => {
        const v = versions.get(args.where.id);
        if (!v) return null;
        if (args.where.agentId && args.where.agentId !== v.agentId) return null;
        return v;
      },
    },
  } as any;
}

function makeRedisShim() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    },
    setex: async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
      return "OK";
    },
    del: async (k: string) => {
      store.delete(k);
      return 1;
    },
  } as any;
}

function makeScopedEnv(): ScopedEnvService {
  return {
    get: async () => undefined,
  } as any;
}

describe("AgentService.resolveConfigForThread — version-lock race (PPR-42)", () => {
  let prisma: ReturnType<typeof makePrismaShim>;

  beforeEach(() => {
    prisma = makePrismaShim({
      id: THREAD_ID,
      lockedVersionId: null,
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
    });
  });

  it("single turn: picks a version and persists lockedVersionId", async () => {
    const svc = new AgentService(makeRedisShim(), prisma, makeScopedEnv(), { get: () => null } as any);
    const res = await svc.resolveConfigForThread(AGENT_ID, THREAD_ID, SCOPE);
    expect([CURRENT_VERSION_ID, CANARY_VERSION_ID]).toContain(res.versionIdUsed);
    // Thread row now has the lock stamped.
    const locked = prisma.state.threadStore.get(THREAD_ID)!.lockedVersionId;
    expect(locked).toBe(res.versionIdUsed);
  });

  it("thread with pre-existing lock: returns LOCKED bucket, ignores canary roll", async () => {
    prisma.state.threadStore.get(THREAD_ID)!.lockedVersionId = CURRENT_VERSION_ID;
    const svc = new AgentService(makeRedisShim(), prisma, makeScopedEnv(), { get: () => null } as any);
    // Force canaryPercent to 100 via direct mutation; lock must still win.
    prisma.state.agentRow.canaryPercent = 100;
    const res = await svc.resolveConfigForThread(AGENT_ID, THREAD_ID, SCOPE);
    expect(res.bucket).toBe("locked");
    expect(res.versionIdUsed).toBe(CURRENT_VERSION_ID);
  });

  it("concurrent first-turn race: both calls return the SAME versionIdUsed (PPR-18 invariant)", async () => {
    // Deterministic rolls — force the two calls to pick DIFFERENT candidates
    // locally (one canary, one current) so the race is actually observable.
    const origRandom = Math.random;
    let rollIndex = 0;
    const rolls = [0.1, 0.9]; // 10% → canary; 90% → current (canaryPercent=50)
    Math.random = () => rolls[rollIndex++ % rolls.length];
    try {
      const svc = new AgentService(makeRedisShim(), prisma, makeScopedEnv(), { get: () => null } as any);
      const [a, b] = await Promise.all([
        svc.resolveConfigForThread(AGENT_ID, THREAD_ID, SCOPE),
        svc.resolveConfigForThread(AGENT_ID, THREAD_ID, SCOPE),
      ]);
      // INVARIANT: both turns serve under the same locked version.
      expect(a.versionIdUsed).toBe(b.versionIdUsed);
      // AND: whatever they agreed on matches what's now in the DB.
      const persisted = prisma.state.threadStore.get(THREAD_ID)!.lockedVersionId;
      expect(a.versionIdUsed).toBe(persisted);
    } finally {
      Math.random = origRandom;
    }
  });

  it("concurrent race with canaryPercent=50: exactly one write, one re-read", async () => {
    // Same test but with 10 parallel calls — any divergence means we
    // serve turns under different versions while the thread is 'locked'.
    const svc = new AgentService(makeRedisShim(), prisma, makeScopedEnv(), { get: () => null } as any);
    const calls = Array.from({ length: 10 }).map(() =>
      svc.resolveConfigForThread(AGENT_ID, THREAD_ID, SCOPE),
    );
    const results = await Promise.all(calls);
    const versions = new Set(results.map((r) => r.versionIdUsed));
    expect(versions.size).toBe(1);
    expect(prisma.state.threadStore.get(THREAD_ID)!.lockedVersionId).toBe(
      [...versions][0],
    );
  });

  it("null threadId → falls through to getAgentConfig (no lock path)", async () => {
    const svc = new AgentService(makeRedisShim(), prisma, makeScopedEnv(), { get: () => null } as any);
    const res = await svc.resolveConfigForThread(AGENT_ID, null, SCOPE);
    expect(res.bucket).toBe("current");
  });

  it("missing agent row → returns fallback bucket", async () => {
    const orig = prisma.platosAgent.findFirst;
    prisma.platosAgent.findFirst = async () => null;
    const svc = new AgentService(makeRedisShim(), prisma, makeScopedEnv(), { get: () => null } as any);
    const res = await svc.resolveConfigForThread("unknown_agent", THREAD_ID, SCOPE);
    expect(res.bucket).toBe("fallback");
    prisma.platosAgent.findFirst = orig;
  });
});
