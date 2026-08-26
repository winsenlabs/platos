import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";

const PROFILE_CONTRACT_QUERY = `
  SELECT
    index_class.relname AS "name",
    pg_index.indisunique AS "unique",
    pg_index.indisvalid AS "valid",
    pg_index.indisready AS "ready",
    pg_index.indislive AS "live",
    pg_index.indnullsnotdistinct AS "nullsNotDistinct",
    pg_index.indexprs IS NOT NULL AS "hasExpressions",
    access_method.amname AS "accessMethod",
    pg_index.indnkeyatts AS "keyColumns",
    pg_index.indnatts AS "totalColumns",
    column_catalog."dataType" AS "profileKeyType",
    column_catalog."nullable" AS "profileKeyNullable",
    column_catalog."defaultExpression" AS "profileKeyDefault",
    ARRAY(
      SELECT operator_namespace.nspname || '.' || operator_class.opcname
      FROM unnest(pg_index.indclass::oid[]) WITH ORDINALITY AS configured_class(oid, position)
      JOIN pg_opclass operator_class ON operator_class.oid = configured_class.oid
      JOIN pg_namespace operator_namespace ON operator_namespace.oid = operator_class.opcnamespace
      ORDER BY configured_class.position
    ) AS "operatorClasses",
    ARRAY(
      SELECT configured_collation.oid::text
      FROM unnest(pg_index.indcollation::oid[]) WITH ORDINALITY AS configured_collation(oid, position)
      ORDER BY configured_collation.position
    ) AS "indexCollations",
    ARRAY(
      SELECT attribute.attcollation::text
      FROM unnest(pg_index.indkey) WITH ORDINALITY AS key_column(attnum, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = pg_index.indrelid
       AND attribute.attnum = key_column.attnum
      ORDER BY key_column.position
    ) AS "columnCollations",
    ARRAY(
      SELECT attribute.attname::text
      FROM unnest(pg_index.indkey) WITH ORDINALITY AS key_column(attnum, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = pg_index.indrelid
       AND attribute.attnum = key_column.attnum
      ORDER BY key_column.position
    ) AS "columns",
    pg_get_expr(pg_index.indpred, pg_index.indrelid) AS "predicate"
  FROM pg_index
  JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
  JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
  JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
  JOIN pg_am access_method ON access_method.oid = index_class.relam
  CROSS JOIN LATERAL (
    SELECT
      format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
      NOT attribute.attnotnull AS "nullable",
      pg_get_expr(default_value.adbin, default_value.adrelid) AS "defaultExpression"
    FROM pg_attribute attribute
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = table_class.oid
      AND attribute.attname = 'profileKey'
      AND NOT attribute.attisdropped
  ) column_catalog
  WHERE table_namespace.nspname = 'public'
    AND table_class.relname = 'Memory'
    AND index_class.relname IN (
      'Memory_profile_standalone_key',
      'Memory_profile_cluster_key'
    )
  ORDER BY index_class.relname`;

interface ProfileIndexCatalogRow {
  name: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  live: boolean;
  nullsNotDistinct: boolean;
  hasExpressions: boolean;
  accessMethod: string;
  keyColumns: number;
  totalColumns: number;
  profileKeyType: string;
  profileKeyNullable: boolean;
  profileKeyDefault: string | null;
  operatorClasses: string[];
  indexCollations: string[];
  columnCollations: string[];
  columns: string[];
  predicate: string | null;
}

/**
 * Startup is intentionally read-only. Data migration, decryption,
 * deduplication, and DDL belong to the immutable migrations image.
 */
@Injectable()
export class MemoryProfileStartupVerifierService implements OnModuleInit {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient) {}

  async onModuleInit(): Promise<void> {
    await this.verify();
  }

  async verify(): Promise<void> {
    let indexes: ProfileIndexCatalogRow[];
    try {
      indexes = await this.prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5000ms'");
        return tx.$queryRawUnsafe(PROFILE_CONTRACT_QUERY) as Promise<ProfileIndexCatalogRow[]>;
      }, { timeout: 6_000 });
    } catch {
      throw startupError(
        "MEMORY_PROFILE_STARTUP_VERIFICATION_FAILED",
        "Memory profile catalog verification failed; the Agent will not start",
      );
    }

    if (!validProfileIndexes(indexes)) {
      throw startupError(
        "MEMORY_PROFILE_STARTUP_CONTRACT_INCOMPLETE",
        "Memory profile migration is incomplete; run memory-profile-dry-run, memory-profile-apply, and memory-profile-verify before starting the Agent",
      );
    }
  }
}

export function validProfileIndexes(indexes: ProfileIndexCatalogRow[]): boolean {
  const expected = new Map<string, { columns: string[]; predicate: string }>([
    [
      "Memory_profile_cluster_key",
      {
        columns: ["environmentId", "endUserId", "clusterId", "profileKey"],
        predicate: `((kind = 'profile'::text) AND ("clusterId" IS NOT NULL) AND ("profileKey" IS NOT NULL))`,
      },
    ],
    [
      "Memory_profile_standalone_key",
      {
        columns: ["environmentId", "endUserId", "agentId", "profileKey"],
        predicate: `((kind = 'profile'::text) AND ("clusterId" IS NULL) AND ("profileKey" IS NOT NULL))`,
      },
    ],
  ]);
  if (indexes.length !== expected.size) return false;
  return indexes.every((index) => {
    const contract = expected.get(index.name);
    return !!contract
      && index.unique
      && index.valid
      && index.ready
      && index.live
      && !index.nullsNotDistinct
      && !index.hasExpressions
      && index.accessMethod === "btree"
      && index.keyColumns === 4
      && index.totalColumns === 4
      && index.profileKeyType === "text"
      && index.profileKeyNullable
      && index.profileKeyDefault === null
      && JSON.stringify(index.operatorClasses) === JSON.stringify([
        "pg_catalog.uuid_ops",
        "pg_catalog.uuid_ops",
        "pg_catalog.uuid_ops",
        "pg_catalog.text_ops",
      ])
      && Array.isArray(index.indexCollations)
      && JSON.stringify(index.indexCollations) === JSON.stringify(index.columnCollations)
      && JSON.stringify(index.columns) === JSON.stringify(contract.columns)
      && index.predicate === contract.predicate;
  });
}

function startupError(code: string, message: string): Error {
  const error = new Error(message);
  (error as any).code = code;
  return error;
}
