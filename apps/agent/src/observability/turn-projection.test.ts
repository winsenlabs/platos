import { createHash } from "crypto";
import { describe, expect, test } from "vitest";
import { subjectKeyHash } from "../privacy/subject-graph";
import { projectTurn } from "./observability-event";
import {
  buildTurnProjection,
  derivedUuid,
  projectionSubject,
  type TurnProjectionInput,
} from "./turn-projection";

const SALT = "test-salt";
const TURN_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "22222222-2222-4222-8222-222222222222";
const TOOL_CALL_ID = "33333333-3333-4333-8333-333333333333";

const ACCEPTED = new Date("2026-08-20T10:00:00.000Z");
const COMPLETED = new Date("2026-08-20T10:00:03.000Z");

function input(overrides: Partial<TurnProjectionInput> = {}): TurnProjectionInput {
  return {
    scope: {
      organizationId: "org-1",
      projectId: "proj-1",
      environmentId: "env-1",
      userId: "external-user-1",
    },
    thread: { id: "thread-1", agentId: "agent-1", endUserId: "enduser-1" },
    turn: {
      id: TURN_ID,
      agentVersionId: "version-1",
      status: "completed",
      acceptedAt: ACCEPTED,
      completedAt: COMPLETED,
      costCents: 0.5,
    },
    salt: SALT,
    ...overrides,
  };
}

const step = {
  id: STEP_ID,
  sequence: 1,
  model: "anthropic:claude-sonnet",
  status: "completed" as const,
  startedAt: ACCEPTED,
  completedAt: COMPLETED,
  inputTokens: 40_000,
  outputTokens: 500,
  cacheReadInputTokens: 39_795,
  cacheCreationInputTokens: 100,
  reasoningTokens: 20,
  costCents: 0.5,
  modelPriceId: "price-1",
  inputRate: 0.000003,
  outputRate: 0.000015,
  cacheReadRate: 0.0000003,
  cacheWriteRate: 0.00000375,
  pricingSource: "LITELLM",
};

describe("subject derivation", () => {
  test("hashes the acting external user with the same primitive as the erasure receipt", () => {
    // A projection hashed differently from the register is a projection erasure
    // cannot find.
    const subject = projectionSubject(input().scope, "enduser-1", SALT);
    expect(subject.subjectKeyHash).toBe(
      subjectKeyHash("external-user-1", "org-1", SALT, (s) =>
        createHash("sha256").update(s).digest("hex")),
    );
    expect(subject.endUserId).toBe("enduser-1");
  });

  test("scopes the hash to the organization, so one person is two subjects across tenants", () => {
    const a = projectionSubject(input().scope, "enduser-1", SALT);
    const b = projectionSubject(
      { ...input().scope, organizationId: "org-2" },
      "enduser-1",
      SALT,
    );
    expect(a.subjectKeyHash).not.toBe(b.subjectKeyHash);
  });

  test("copies plaintext identity only from a signed userMeta", () => {
    const withMeta = projectionSubject(
      { ...input().scope, sessionContext: { user: { name: "Ada", email: "ada@example.test" } } },
      "enduser-1",
      SALT,
    );
    expect(withMeta.userDisplayName).toBe("Ada");
    expect(withMeta.userEmail).toBe("ada@example.test");

    const withoutMeta = projectionSubject(input().scope, "enduser-1", SALT);
    expect(withoutMeta.userDisplayName).toBeNull();
    expect(withoutMeta.userEmail).toBeNull();
  });

  test("ignores a sessionContext whose user block is not the expected shape", () => {
    for (const sessionContext of [null, "string", { user: "string" }, { user: { name: 42 } }]) {
      const subject = projectionSubject({ ...input().scope, sessionContext }, "e", SALT);
      expect(subject.userDisplayName).toBeNull();
      expect(subject.userEmail).toBeNull();
    }
  });

  test("emits an empty hash rather than hashing an absent user", () => {
    const subject = projectionSubject({ ...input().scope, userId: "" }, "enduser-1", SALT);
    expect(subject.subjectKeyHash).toBe("");
  });
});

describe("derived usage event ids", () => {
  test("are stable for the same Step, so a replay cannot mint a second charge", () => {
    expect(derivedUuid("platos.usage.inference", STEP_ID))
      .toBe(derivedUuid("platos.usage.inference", STEP_ID));
  });

  test("differ per Step and per namespace", () => {
    expect(derivedUuid("platos.usage.inference", STEP_ID))
      .not.toBe(derivedUuid("platos.usage.inference", TURN_ID));
    expect(derivedUuid("platos.usage.inference", STEP_ID))
      .not.toBe(derivedUuid("platos.usage.embedding", STEP_ID));
  });

  test("are well-formed UUIDs ClickHouse will parse", () => {
    expect(derivedUuid("ns", STEP_ID)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("turn projection", () => {
  test("rolls Step token lanes up to the Turn without adding cache back to input", () => {
    const projection = buildTurnProjection(input({ steps: [step, { ...step, id: TURN_ID, sequence: 2 }] }));
    expect(projection.turn.tokens).toEqual({
      inputTokens: 80_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 79_590,
      cacheWriteInputTokens: 200,
      reasoningTokens: 40,
    });
    const row = projectTurn(projection).turns_v1[0];
    expect(row.total_input_tokens).toBe(80_000);
    expect(row.cache_read_input_tokens).toBe(79_590);
  });

  test("counts Steps and Tool Calls but leaves the billable unit to status alone", () => {
    const projection = buildTurnProjection(input({
      steps: [step, { ...step, id: TURN_ID, sequence: 2 }],
      toolCalls: [{
        id: TOOL_CALL_ID,
        stepId: STEP_ID,
        sequence: 1,
        toolName: "remember",
        status: "completed",
        startedAt: ACCEPTED,
        completedAt: COMPLETED,
      }],
    }));
    expect(projection.turn.stepCount).toBe(2);
    expect(projection.turn.toolCallCount).toBe(1);
    expect(projection.turn.status).toBe("completed");
    expect(Object.keys(projectTurn(projection).turns_v1[0])).not.toContain("billable_unit");
  });

  test("freezes each Step's four rates rather than referencing a catalogue", () => {
    const rows = projectTurn(buildTurnProjection(input({ steps: [step] })));
    expect(rows.steps_v1[0]).toMatchObject({
      pricing_version: "price-1",
      pricing_source: "LITELLM",
      fresh_input_usd_per_million: "3.000000000000",
      output_usd_per_million: "15.000000000000",
      cache_read_usd_per_million: "0.300000000000",
      cache_write_usd_per_million: "3.750000000000",
    });
  });

  test("derives the provider from a namespaced model key and leaves it blank otherwise", () => {
    const namespaced = buildTurnProjection(input({ steps: [step] }));
    expect(namespaced.steps![0].provider).toBe("anthropic");

    const bare = buildTurnProjection(input({ steps: [{ ...step, model: "gpt-5" }] }));
    expect(bare.steps![0].provider).toBe("");

    const explicit = buildTurnProjection(input({ steps: [{ ...step, provider: "bedrock" }] }));
    expect(explicit.steps![0].provider).toBe("bedrock");
  });

  test("emits one inference usage event per Step, carrying the same lanes and rates", () => {
    const projection = buildTurnProjection(input({ steps: [step] }));
    expect(projection.usage).toHaveLength(1);
    expect(projection.usage![0]).toMatchObject({
      usageKind: "inference",
      stepId: STEP_ID,
      turnId: TURN_ID,
      unitType: "tokens",
      costCents: 0.5,
    });
    expect(projection.usage![0].usageEventId)
      .toBe(derivedUuid("platos.usage.inference", STEP_ID));
  });

  test("projects a failed Turn with its cost intact and its status not completed", () => {
    // A failed Turn that performed chargeable work records usage and cost, and
    // is not a billable unit. Both halves matter.
    const projection = buildTurnProjection(input({
      turn: { ...input().turn, status: "failed", errorClass: "ProviderTimeoutError" },
      steps: [{ ...step, status: "failed" }],
    }));
    const rows = projectTurn(projection);
    expect(rows.turns_v1[0].status).toBe("failed");
    expect(rows.turns_v1[0].error_class).toBe("ProviderTimeoutError");
    expect(rows.turns_v1[0].calculated_cost_usd).toBe("0.005000000000");
  });

  test("stamps the same subject on every level, so erasure reaches all four tables", () => {
    const rows = projectTurn(buildTurnProjection(input({
      scope: { ...input().scope, sessionContext: { user: { name: "Ada" } } },
      steps: [step],
      toolCalls: [{
        id: TOOL_CALL_ID,
        stepId: STEP_ID,
        sequence: 1,
        toolName: "remember",
        status: "completed",
        startedAt: ACCEPTED,
        completedAt: COMPLETED,
      }],
    })));
    const hash = rows.turns_v1[0].subject_key_hash;
    expect(hash).not.toBe("");
    for (const table of ["turns_v1", "steps_v1", "tool_calls_v1", "usage_events_v1"] as const) {
      expect(rows[table][0].subject_key_hash, table).toBe(hash);
      expect(rows[table][0].end_user_id, table).toBe("enduser-1");
    }
  });

  test("records the durable-runtime id as a cross-reference and nothing more", () => {
    const projection = buildTurnProjection(input({
      turn: { ...input().turn, runtimeProvider: "trigger", runtimeRunId: "run_abc" },
    }));
    const row = projectTurn(projection).turns_v1[0];
    expect(row.runtime_provider).toBe("trigger");
    expect(row.runtime_run_id).toBe("run_abc");
    // The vendor's id is recorded; its vocabulary does not define anything.
    expect(Object.keys(row).filter((key) => key.includes("task") || key.includes("attempt")))
      .toEqual([]);
  });

  test("produces a Turn row even when the Turn had no Steps", () => {
    const rows = projectTurn(buildTurnProjection(input()));
    expect(rows.turns_v1).toHaveLength(1);
    expect(rows.steps_v1).toHaveLength(0);
    expect(rows.usage_events_v1).toHaveLength(0);
    expect(rows.turns_v1[0].step_count).toBe(0);
  });
});
