import { createHash } from "node:crypto";
import type { CutoverDatabase } from "./cutover-types";

export interface CatalogEntry {
  readonly kind: string;
  readonly name: string;
  readonly definition: string;
}

export interface CatalogSnapshot {
  readonly entries: readonly CatalogEntry[];
  readonly digest: string;
}

const APPLICATION_CATALOG_SQL = `
WITH extension_objects AS (
  SELECT dependency.classid, dependency.objid, dependency.objsubid
    FROM pg_depend dependency
    JOIN pg_extension extension ON extension.oid = dependency.refobjid
   WHERE dependency.deptype = 'e'
), catalog_entries AS (
  SELECT 'column'::text AS kind,
         table_info.table_name || '.' || table_info.ordinal_position::text AS name,
         concat_ws('|', table_info.column_name, table_info.data_type, table_info.udt_schema,
                   table_info.udt_name, table_info.is_nullable, coalesce(table_info.column_default, '')) AS definition
    FROM information_schema.columns table_info
   WHERE table_info.table_schema = 'public'
     AND table_info.table_name <> '_prisma_migrations'
  UNION ALL
  SELECT 'constraint', class.relname || '.' || constraint_info.conname,
         pg_get_constraintdef(constraint_info.oid, true)
    FROM pg_constraint constraint_info
    JOIN pg_class class ON class.oid = constraint_info.conrelid
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
   WHERE namespace.nspname = 'public'
     AND class.relname <> '_prisma_migrations'
  UNION ALL
  SELECT 'index', class.relname, pg_get_indexdef(class.oid)
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    LEFT JOIN extension_objects extension_object
      ON extension_object.classid = 'pg_class'::regclass AND extension_object.objid = class.oid
   WHERE namespace.nspname = 'public'
     AND class.relkind = 'i'
     AND class.relname NOT LIKE '_prisma_migrations%'
     AND extension_object.objid IS NULL
  UNION ALL
  SELECT 'type', type_info.typname,
         coalesce((SELECT string_agg(enum_info.enumlabel, ',' ORDER BY enum_info.enumsortorder)
                     FROM pg_enum enum_info WHERE enum_info.enumtypid = type_info.oid), type_info.typtype::text)
    FROM pg_type type_info
    JOIN pg_namespace namespace ON namespace.oid = type_info.typnamespace
    LEFT JOIN extension_objects extension_object
      ON extension_object.classid = 'pg_type'::regclass AND extension_object.objid = type_info.oid
   WHERE namespace.nspname = 'public'
     AND type_info.typtype IN ('e', 'd')
     AND extension_object.objid IS NULL
  UNION ALL
  SELECT 'function', procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')',
         pg_get_functiondef(procedure.oid)
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    LEFT JOIN extension_objects extension_object
      ON extension_object.classid = 'pg_proc'::regclass AND extension_object.objid = procedure.oid
   WHERE namespace.nspname = 'public'
     AND extension_object.objid IS NULL
  UNION ALL
  SELECT 'trigger', class.relname || '.' || trigger.tgname, pg_get_triggerdef(trigger.oid, true)
    FROM pg_trigger trigger
    JOIN pg_class class ON class.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
   WHERE namespace.nspname = 'public'
     AND class.relname <> '_prisma_migrations'
     AND NOT trigger.tgisinternal
)
SELECT kind, name, definition
  FROM catalog_entries
 ORDER BY kind, name, definition`;

export async function readApplicationCatalog(database: CutoverDatabase): Promise<CatalogSnapshot> {
  const result = await database.query<{ kind: string; name: string; definition: string }>(
    APPLICATION_CATALOG_SQL
  );
  const entries = result.rows.map((row) => ({
    kind: row.kind,
    name: row.name,
    definition: normalizeCatalogDefinition(row.definition),
  }));
  return {
    entries,
    digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

function normalizeCatalogDefinition(value: string): string {
  return value
    .replaceAll(/\s+/g, " ")
    .replaceAll(/public\./g, "public.")
    .trim();
}

export interface CatalogComparison {
  readonly equal: boolean;
  readonly actualDigest: string;
  readonly expectedDigest: string;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export function compareApplicationCatalogs(
  actual: CatalogSnapshot,
  expected: CatalogSnapshot
): CatalogComparison {
  const key = (entry: CatalogEntry) => `${entry.kind}:${entry.name}:${entry.definition}`;
  const actualSet = new Set(actual.entries.map(key));
  const expectedSet = new Set(expected.entries.map(key));
  return {
    equal: actual.digest === expected.digest,
    actualDigest: actual.digest,
    expectedDigest: expected.digest,
    missing: [...expectedSet].filter((entry) => !actualSet.has(entry)).sort(),
    unexpected: [...actualSet].filter((entry) => !expectedSet.has(entry)).sort(),
  };
}
