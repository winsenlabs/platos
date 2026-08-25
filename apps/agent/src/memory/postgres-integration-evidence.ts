import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const EXPLAIN_ARTIFACT_MAX_BYTES = 256 * 1024;

export interface PostgresIntegrationDatabase {
  databaseUrl: string;
  stop(): Promise<void>;
}

export interface CapturedPrismaQuery {
  query: string;
  params: string;
}

export interface CapturedExplainPlan {
  source: "captured-prisma-query";
  normalizedSql: string;
  normalizedSqlSha256: string;
  plan: unknown;
}

interface ExplainQueryClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export async function startPostgresIntegrationDatabase(): Promise<PostgresIntegrationDatabase> {
  const externalUrl = process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  if (externalUrl) {
    if (process.env.PLATOS_POSTGRES_INTEGRATION_EXTERNAL !== "1") {
      throw new Error(
        "PLATOS_POSTGRES_INTEGRATION_EXTERNAL=1 is required to use the external integration database"
      );
    }
    return { databaseUrl: externalUrl, stop: async () => undefined };
  }

  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16"
  ).start();
  return {
    databaseUrl: container.getConnectionUri(),
    stop: () => container.stop().then(() => undefined),
  };
}

export function postgresUrlWithParams(databaseUrl: string, params: Record<string, string>): string {
  const parsed = new URL(databaseUrl);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

export function applicationQueryCount(queries: CapturedPrismaQuery[]): number {
  return queries.filter(({ query }) => {
    const statement = query.trimStart().toUpperCase();
    return !["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION", "SET LOCAL"].some((prefix) =>
      statement.startsWith(prefix)
    );
  }).length;
}

export function requireCapturedEndpointQueries(
  queries: CapturedPrismaQuery[],
  relation: "Memory" | "MemoryEntity"
): { items: CapturedPrismaQuery; count: CapturedPrismaQuery } {
  const escapedRelation = relation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const relationPattern = new RegExp(`(?:FROM|JOIN)\\s+(?:"public"\\.)?"${escapedRelation}"`, "i");
  const relationQueries = queries.filter(
    ({ query }) => /^\s*SELECT\b/i.test(query) && relationPattern.test(query)
  );
  const counts = relationQueries.filter(({ query }) => /\bCOUNT\s*\(\s*\*\s*\)/i.test(query));
  const items = relationQueries.filter(({ query }) => !/\bCOUNT\s*\(\s*\*\s*\)/i.test(query));
  if (counts.length !== 1 || items.length !== 1) {
    throw new Error(
      `${relation} endpoint must emit exactly one item query and one count query; got ${items.length}/${counts.length}`
    );
  }
  return { items: items[0]!, count: counts[0]! };
}

export function requireCapturedRelationQuery(
  queries: CapturedPrismaQuery[],
  relation: "Memory" | "MemoryEntity"
): CapturedPrismaQuery {
  const escapedRelation = relation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const relationPattern = new RegExp(`(?:FROM|JOIN)\\s+(?:"public"\\.)?"${escapedRelation}"`, "i");
  const matches = queries.filter(
    ({ query }) =>
      /^\s*SELECT\b/i.test(query) &&
      relationPattern.test(query) &&
      !/\bCOUNT\s*\(\s*\*\s*\)/i.test(query) &&
      !/\/\*\s*exact fallback\s*\*\//i.test(query)
  );
  if (matches.length !== 1) {
    throw new Error(
      `${relation} endpoint must emit exactly one replayable item query; got ${matches.length}`
    );
  }
  return matches[0]!;
}

export async function explainCapturedQuery(
  client: ExplainQueryClient,
  captured: CapturedPrismaQuery
): Promise<CapturedExplainPlan> {
  const values: unknown = JSON.parse(captured.params);
  if (!Array.isArray(values)) throw new Error("captured Prisma query parameters are not an array");
  const replaySql = inlineCapturedParams(captured.query, values);
  const rows = (await client.$queryRawUnsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${replaySql}`
  )) as Array<{ "QUERY PLAN": unknown }>;
  const normalizedSql = normalizeSql(captured.query);
  return {
    source: "captured-prisma-query",
    normalizedSql,
    normalizedSqlSha256: sha256(normalizedSql),
    plan: rows[0]?.["QUERY PLAN"],
  };
}

function inlineCapturedParams(sql: string, values: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (placeholder, position: string) => {
    const index = Number(position) - 1;
    return index >= 0 && index < values.length ? postgresLiteral(values[index]) : placeholder;
  });
}

function postgresLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("captured Prisma query contains a non-finite number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (Array.isArray(value)) return `ARRAY[${value.map(postgresLiteral).join(", ")}]`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replaceAll("'", "''")}'`;
}

export function normalizeSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function writeQueryCountEvidence(input: {
  name: string;
  endpoint: string;
  queryCount: number;
  maximumQueryCount: number;
  fixtureRows: number;
}): void {
  if (!Number.isInteger(input.queryCount) || input.queryCount <= 0) {
    throw new Error(`${input.endpoint} did not execute a measurable database query`);
  }
  if (input.queryCount > input.maximumQueryCount) {
    throw new Error(
      `${input.endpoint} executed ${input.queryCount} queries; budget is ${input.maximumQueryCount}`
    );
  }
  writeEvidence(input.name, {
    schemaVersion: 1,
    kind: "query-count",
    endpoint: input.endpoint,
    queryCount: input.queryCount,
    maximumQueryCount: input.maximumQueryCount,
    fixtureRows: input.fixtureRows,
  });
}

export function writeExplainEvidence(input: {
  name: string;
  endpoint: string;
  rowLimit: number;
  statementTimeoutMs: number;
  plans: Record<string, CapturedExplainPlan>;
}): void {
  for (const [planName, evidence] of Object.entries(input.plans)) {
    if (evidence.source !== "captured-prisma-query") {
      throw new Error(`${input.endpoint}.${planName} is not tied to captured Prisma SQL`);
    }
    if (evidence.normalizedSql !== normalizeSql(evidence.normalizedSql)) {
      throw new Error(`${input.endpoint}.${planName} SQL is not normalized`);
    }
    if (evidence.normalizedSqlSha256 !== sha256(evidence.normalizedSql)) {
      throw new Error(`${input.endpoint}.${planName} normalized SQL hash is invalid`);
    }
    const serializedPlan = JSON.stringify(evidence.plan);
    if (!serializedPlan.includes("Actual Rows")) {
      throw new Error(`${input.endpoint}.${planName} did not execute EXPLAIN ANALYZE`);
    }
    if (!serializedPlan.includes("Shared Hit Blocks")) {
      throw new Error(`${input.endpoint}.${planName} did not capture EXPLAIN BUFFERS`);
    }
  }
  writeEvidence(
    input.name,
    {
      schemaVersion: 1,
      kind: "postgres-explain",
      endpoint: input.endpoint,
      options: ["ANALYZE", "BUFFERS", "FORMAT JSON"],
      bounded: {
        statementTimeoutMs: input.statementTimeoutMs,
        rowLimit: input.rowLimit,
        maximumArtifactBytes: EXPLAIN_ARTIFACT_MAX_BYTES,
      },
      plans: input.plans,
    },
    EXPLAIN_ARTIFACT_MAX_BYTES
  );
}

export function writePostgresRuntimeEvidence(input: {
  serverVersion: string;
  pgvectorVersion: string;
}): void {
  writeEvidence("postgres-runtime.json", {
    schemaVersion: 1,
    kind: "postgres-runtime",
    serverVersion: input.serverVersion,
    pgvectorVersion: input.pgvectorVersion,
  });
}

function writeEvidence(name: string, value: unknown, maximumBytes = 64 * 1024): void {
  const configuredDirectory = process.env.PLATOS_POSTGRES_EVIDENCE_DIR?.trim();
  if (!configuredDirectory) {
    if (process.env.PLATOS_POSTGRES_EVIDENCE_REQUIRED === "1") {
      throw new Error("PLATOS_POSTGRES_EVIDENCE_DIR is required by the PostgreSQL evidence gate");
    }
    return;
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > maximumBytes) {
    throw new Error(`${name} exceeds the bounded evidence size of ${maximumBytes} bytes`);
  }
  const directory = resolve(configuredDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, name), serialized, "utf8");
}
