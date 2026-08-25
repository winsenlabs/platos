import { describe, expect, it, vi } from "vitest";
import {
  explainCapturedQuery,
  normalizeSql,
  requireCapturedEndpointQueries,
  requireCapturedRelationQuery,
  sha256,
  writeExplainEvidence,
  type CapturedPrismaQuery,
} from "./postgres-integration-evidence";

describe("PostgreSQL endpoint evidence", () => {
  it("selects the one emitted item/count pair for the endpoint relation", () => {
    const items = query('SELECT "public"."Memory"."id" FROM "public"."Memory" ORDER BY 1');
    const count = query(
      'SELECT COUNT(*) FROM (SELECT "public"."Memory"."id" FROM "public"."Memory") AS "sub"'
    );
    expect(
      requireCapturedEndpointQueries(
        [query('SELECT "public"."Environment"."id" FROM "public"."Environment"'), count, items],
        "Memory"
      )
    ).toEqual({ items, count });
    expect(() => requireCapturedEndpointQueries([items, items, count], "Memory")).toThrow(
      "exactly one item query and one count query"
    );
  });

  it("replays the exact emitted SQL and records its normalized hash", async () => {
    const captured = query('  SELECT *\n FROM "public"."Memory" WHERE "id" = $1::uuid; ', [
      "00000000-0000-4000-8000-000000000001",
    ]);
    const plan = [{ Plan: { "Actual Rows": 1, "Shared Hit Blocks": 2 } }];
    const client = { $queryRawUnsafe: vi.fn().mockResolvedValue([{ "QUERY PLAN": plan }]) };

    const evidence = await explainCapturedQuery(client, captured);

    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)   SELECT *\n FROM "public"."Memory" WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid; `
    );
    expect(evidence).toMatchObject({
      source: "captured-prisma-query",
      normalizedSql: normalizeSql(captured.query),
      normalizedSqlSha256: sha256(normalizeSql(captured.query)),
      plan,
    });
    expect(() =>
      writeExplainEvidence({
        name: "unit.explain.json",
        endpoint: "MemoryService.listPage",
        rowLimit: 1,
        statementTimeoutMs: 1_000,
        plans: { items: evidence },
      })
    ).not.toThrow();
  });

  it("selects the indexed candidate query instead of an exact fallback", () => {
    const indexed = query('SELECT * FROM "Memory" ORDER BY "embedding" <=> $1::vector');
    const fallback = query(
      'SELECT * FROM "Memory" ORDER BY ("embedding" <=> $1::vector) + 0 /* exact fallback */'
    );
    expect(requireCapturedRelationQuery([indexed, fallback], "Memory")).toBe(indexed);
  });
});

function query(sql: string, params: unknown[] = []): CapturedPrismaQuery {
  return { query: sql, params: JSON.stringify(params) };
}
