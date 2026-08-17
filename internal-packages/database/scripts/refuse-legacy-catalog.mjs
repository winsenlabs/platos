#!/usr/bin/env node

import pg from "pg";
import { pathToFileURL } from "node:url";

const { Client } = pg;

export const LEGACY_TABLE_MARKERS = Object.freeze([
  "BackgroundWorker",
  "RuntimeEnvironment",
  "TaskRun",
]);

export const LEGACY_MIGRATION_MARKERS = Object.freeze([
  "20221206131204_init",
  "20260814010000_win122_credential_model",
]);

export function legacyCatalogEvidence({ tableNames = [], migrationNames = [] }) {
  const tables = LEGACY_TABLE_MARKERS.filter((name) => tableNames.includes(name));
  const migrations = LEGACY_MIGRATION_MARKERS.filter((name) => migrationNames.includes(name));
  return { tables, migrations, isLegacy: tables.length > 0 || migrations.length > 0 };
}

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function inspectCatalog(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const schema = parsed.searchParams.get("schema") || "public";
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    application_name: "platos-clean-migration-guard",
  });

  await client.connect();
  try {
    await client.query("SET statement_timeout = '5s'");
    const tablesResult = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = ANY($2::text[])`,
      [schema, [...LEGACY_TABLE_MARKERS, "_prisma_migrations"]]
    );
    const tableNames = tablesResult.rows.map(({ table_name }) => table_name);
    let migrationNames = [];

    if (tableNames.includes("_prisma_migrations")) {
      const migrationsResult = await client.query(
        `SELECT migration_name
           FROM ${quotedIdentifier(schema)}."_prisma_migrations"
          WHERE migration_name = ANY($1::text[])
          LIMIT $2`,
        [LEGACY_MIGRATION_MARKERS, LEGACY_MIGRATION_MARKERS.length]
      );
      migrationNames = migrationsResult.rows.map(({ migration_name }) => migration_name);
    }

    return legacyCatalogEvidence({ tableNames, migrationNames });
  } finally {
    await client.end();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the clean migration catalog check");
  }

  const evidence = await inspectCatalog(databaseUrl);
  if (!evidence.isLegacy) {
    console.log("database-migration-guard: catalog is empty or clean; migrate deploy may proceed");
    return;
  }

  const details = [
    evidence.tables.length ? `legacy tables: ${evidence.tables.join(", ")}` : undefined,
    evidence.migrations.length ? `legacy migrations: ${evidence.migrations.join(", ")}` : undefined,
  ].filter(Boolean);
  throw new Error(
    `refusing clean migrate against an inherited catalog (${details.join("; ")}). ` +
      "Use the future, operator-gated db:cutover workflow; ordinary db:migrate never performs cutover."
  );
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`database-migration-guard: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
