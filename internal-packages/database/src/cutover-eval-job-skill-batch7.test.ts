import { describe, expect, test } from "vitest";
import {
  backfillBatch7AgentEvals,
  backfillBatch7Jobs,
  backfillBatch7Macros,
  backfillBatch7MessageRatings,
  backfillRetainedEvalJobSkillBatch7,
  normalizeBatch7CostCents,
  normalizeBatch7JobStatus,
  normalizeBatch7Rating,
  retainedEvalJobSkillBatch7MappingTargets,
  retainedEvalJobSkillBatch7SourceModels,
  validateRetainedEvalJobSkillBatch7,
  validateRetainedEvalJobSkillBatch7Source,
} from "./cutover-eval-job-skill-batch7";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

describe("retained evaluation/job/skill cutover Batch 7", () => {
  test("pins isolated sources and deterministic split suffixes", () => {
    expect(retainedEvalJobSkillBatch7SourceModels).toEqual([
      "PlatosMessageRating",
      "PlatosEvalCriterion",
      "PlatosAgentEval",
      "PlatosGoldenSet",
      "PlatosTask",
      "PlatosSkill",
      "PlatosAgentSkill",
      "PlatosMacro",
    ]);
    expect(retainedEvalJobSkillBatch7MappingTargets).toContainEqual({
      sourceModel: "PlatosSkill",
      targetModel: "ProjectSkill",
      stableSuffix: "project-skill",
    });
    expect(retainedEvalJobSkillBatch7MappingTargets).toContainEqual({
      sourceModel: "PlatosSkill",
      targetModel: "EnvironmentSkill",
      stableSuffix: "environment-skill",
    });
    expect(retainedEvalJobSkillBatch7MappingTargets).toContainEqual({
      sourceModel: "PlatosMacro",
      targetModel: "Macro",
      stableSuffix: "",
    });
  });

  test("normalizes rating, status, and decimal cost fail-closed", () => {
    expect(normalizeBatch7Rating(-1)).toBe(1);
    expect(normalizeBatch7Rating(1)).toBe(5);
    expect(normalizeBatch7JobStatus(true)).toBe("ACTIVE");
    expect(normalizeBatch7JobStatus(false)).toBe("CANCELLED");
    expect(normalizeBatch7CostCents(0.125)).toBe("0.125000");
    expect(normalizeBatch7CostCents(null)).toBeNull();
    expect(() => normalizeBatch7Rating(0)).toThrow("not representable");
    expect(() => normalizeBatch7JobStatus("active")).toThrow("not representable");
    expect(() => normalizeBatch7CostCents(-1)).toThrow("not representable");
    expect(() => normalizeBatch7CostCents(0.1234567)).toThrow("precision");
  });

  test("pages message ratings in bounded chunks and writes normalized values", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosMessageRating" source')) {
          const rows =
            values?.[0] === ""
              ? [
                  {
                    source_id: "rating-a",
                    target_id: "00000000-0000-5000-8000-000000000001",
                    environment_id: "00000000-0000-5000-8000-000000000002",
                    turn_id: "00000000-0000-5000-8000-000000000003",
                    agent_id: "00000000-0000-5000-8000-000000000004",
                    agent_version_id: "00000000-0000-5000-8000-000000000005",
                    end_user_id: "00000000-0000-5000-8000-000000000006",
                    rating: 1,
                    comment: "fixture",
                    created_at: new Date(0),
                    updated_at: new Date(0),
                  },
                ]
              : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    await expect(backfillBatch7MessageRatings(database, 1)).resolves.toBe(1);
    expect(
      queries.filter((query) => query.sql.includes("ORDER BY source.id LIMIT $2"))
    ).toHaveLength(2);
    const insert = queries.find((query) =>
      query.sql.includes('INSERT INTO public."MessageRating"')
    );
    expect(insert?.values).toContain(5);
    expect(insert?.sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bON CONFLICT\b/);
  });

  test("rejects malformed eval JSON and mapped job arrays before insertion", async () => {
    const evalDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        if (sql.includes('FROM cutover_legacy."PlatosAgentEval" source') && values?.[0] === "") {
          return {
            rows: [
              {
                source_id: "eval-a",
                target_id: "id",
                environment_id: "env",
                agent_id: "agent",
                agent_version_id: null,
                thread_id: "thread",
                turn_id: null,
                criterion_id: "criterion",
                criterion_snapshot: ["wrong-root"],
                judge_model: "judge",
                judge_prompt_used: "prompt",
                raw_response: null,
                score: 80,
                rationale: null,
                passed: true,
                cost_cents: 0,
                latency_ms: 1,
                created_at: new Date(0),
              },
            ] as unknown as Row[],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(backfillBatch7AgentEvals(evalDatabase, 1)).rejects.toMatchObject({
      code: "BATCH7_JSON_INVALID",
    });

    const jobDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        if (sql.includes('FROM cutover_legacy."PlatosTask" source') && values?.[0] === "") {
          return {
            rows: [
              {
                source_id: "job-a",
                target_id: "id",
                environment_id: "env",
                display_name: "Job",
                description: null,
                trigger_type: "manual",
                schedule_cron: null,
                schedule_timezone: null,
                allowed_agent_ids: ["agent", "agent"],
                payload_schema: {},
                handler: "return true",
                max_retries: 0,
                is_active: true,
                created_by: "user",
                created_at: new Date(0),
                updated_at: new Date(0),
              },
            ] as unknown as Row[],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(backfillBatch7Jobs(jobDatabase, 1)).rejects.toMatchObject({
      code: "BATCH7_ARRAY_INVALID",
    });
  });

  test("writes macros insert-only with strict array and object JSON roots", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosMacro" source')) {
          const rows = values?.[0] === ""
            ? [{
                source_id: "macro-a",
                target_id: "00000000-0000-5000-8000-000000000001",
                environment_id: "00000000-0000-5000-8000-000000000002",
                name: "Fixture macro",
                description: null,
                steps: [{ tool: "fixture", params: {} }],
                param_schema: { type: "object" },
                shared_with_organization: true,
                created_by: "user-a",
                created_at: new Date(0),
                updated_at: new Date(0),
              }]
            : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    await expect(backfillBatch7Macros(database, 1)).resolves.toBe(1);
    const insert = queries.find((query) => query.sql.includes('INSERT INTO public."Macro"'));
    expect(insert?.sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bON CONFLICT\b/);
    expect(JSON.parse(String(insert?.values?.[4]))).toEqual([{ tool: "fixture", params: {} }]);
    expect(JSON.parse(String(insert?.values?.[5]))).toEqual({ type: "object" });
  });

  test("fails closed on missing mappings, cross-scope associations, and duplicate slugs", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return {
          rows: [
            { issue: "missing-or-duplicate-id-map" },
            { issue: "skill-association" },
            { issue: "duplicate-skill-slug" },
          ] as unknown as Row[],
          rowCount: 3,
        };
      },
    };
    await expect(validateRetainedEvalJobSkillBatch7Source(database)).rejects.toMatchObject({
      code: "BATCH7_SOURCE_OR_MAPPING_INVALID",
    });
  });

  test("keeps conservation, ancestry, and semantic gates separate", async () => {
    let call = 0;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return call === 2
          ? { rows: [{ issue: "skill-chain" }] as unknown as Row[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    await expect(validateRetainedEvalJobSkillBatch7(database)).rejects.toMatchObject({
      code: "BATCH7_ANCESTRY_FAILED",
    });
    expect(call).toBe(2);
  });

  test("returns count-only split evidence and makes no execution or completion claim", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return { rows: [], rowCount: 0 };
      },
    };
    const evidence = await backfillRetainedEvalJobSkillBatch7(database, 2);
    expect(evidence.splitCounts).toEqual({
      skillSources: 0,
      skillTargets: 0,
      projectSkillTargets: 0,
      environmentSkillTargets: 0,
      totalSplitTargets: 0,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/complete|execute|enabled|manifest|config/i);
  });
});
