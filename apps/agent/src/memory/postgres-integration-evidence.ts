import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const EXPLAIN_ARTIFACT_MAX_BYTES = 256 * 1024;

export interface PostgresIntegrationDatabase {
  databaseUrl: string;
  stop(): Promise<void>;
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

export function applicationQueryCount(queries: string[]): number {
  return queries.filter((query) => {
    const statement = query.trimStart().toUpperCase();
    return !["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION", "SET LOCAL"].some((prefix) =>
      statement.startsWith(prefix)
    );
  }).length;
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
  plans: Record<string, unknown>;
}): void {
  const serializedPlans = JSON.stringify(input.plans);
  if (!serializedPlans.includes("Actual Rows") || !serializedPlans.includes("Shared Hit Blocks")) {
    throw new Error(`${input.endpoint} evidence is not EXPLAIN ANALYZE with BUFFERS JSON`);
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
