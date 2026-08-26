import { createDecipheriv, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

const CONTRACT_VERSION = 1;
const DEFAULT_MAX_PROFILES = 100_000;
const DEFAULT_MAX_RELATIONSHIPS = 1_000_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;
const INDEX_NAMES = ["Memory_profile_cluster_key", "Memory_profile_standalone_key"];

export const PROFILE_INDEX_CONTRACT = new Map([
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

const PROFILE_ROWS_SQL = `
  SELECT "id", "environmentId", "endUserId", "agentId", "clusterId",
         "metadata", "profileKey", "updatedAt"
  FROM "public"."Memory"
  WHERE "kind" = 'profile'
  ORDER BY "updatedAt" DESC, "id" DESC
  LIMIT $1`;

const PROFILE_RELATIONSHIPS_SQL = `
  SELECT relationship."id", relationship."sourceMemoryId"
  FROM "public"."MemoryRelationship" AS relationship
  JOIN "public"."Memory" AS memory ON memory."id" = relationship."sourceMemoryId"
  WHERE memory."kind" = 'profile'
  ORDER BY relationship."id"
  LIMIT $1`;

const PROFILE_CATALOG_SQL = `
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
    AND index_class.relname = ANY($1::text[])
  ORDER BY index_class.relname`;

export async function runMemoryProfileMigration(command, options = {}) {
  if (!["bootstrap-empty", "dry-run", "apply", "verify"].includes(command)) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_INVALID_COMMAND",
      "command must be bootstrap-empty, dry-run, apply, or verify",
      64,
    );
  }
  const config = resolveConfig(options);
  const client = options.client ?? new Client({
    connectionString: config.databaseUrl,
    application_name: `platos-memory-profile-${command}`,
  });
  const ownsClient = !options.client;

  if (ownsClient) await client.connect();
  try {
    if (command === "bootstrap-empty") return await bootstrapEmpty(client, config);
    if (command === "dry-run") return await dryRun(client, config);
    if (command === "apply") return await apply(client, config);
    if (command === "verify") return await verify(client, config);
  } finally {
    if (ownsClient) await client.end();
  }
}

async function bootstrapEmpty(client, config) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await setLocalBounds(client, config);
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('MemoryProfileMigration:v1', 0)) AS locked",
    );
    if (lock.rows[0]?.locked !== true) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_LOCK_BUSY",
        "another Memory profile migration owns the advisory lock",
        75,
      );
    }
    const catalog = await loadCatalog(client);
    const emptyPlan = buildMigrationPlan([], config.env, []);
    if (validProfileIndexes(catalog)) {
      await client.query("COMMIT");
      return report("bootstrap-empty", "already_applied", emptyPlan);
    }
    if (catalog.length !== 0) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_CATALOG_CONFLICT",
        "profile indexes exist but do not match the exact migration contract",
        67,
      );
    }
    const existing = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM "public"."Memory" WHERE "kind" = 'profile'
       ) AS "profilesExist"`,
    );
    if (existing.rows[0]?.profilesExist !== false) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_REVIEW_REQUIRED",
        "profile data exists; stop writers and use reviewed dry-run and digest-bound apply",
        65,
      );
    }
    await createProfileIndexes(client);
    const appliedCatalog = await loadCatalog(client);
    if (!validProfileIndexes(appliedCatalog)) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_CATALOG_INVALID",
        `created profile indexes do not match the exact migration contract: ${catalogDiagnostics(appliedCatalog)}`,
        67,
      );
    }
    await client.query("COMMIT");
    return report("bootstrap-empty", "bootstrapped", emptyPlan);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function dryRun(client, config) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await setLocalBounds(client, config);
    const rows = await loadProfileRows(client, config.maxProfiles);
    const relationships = await loadProfileRelationships(client, config.maxRelationships);
    const plan = buildMigrationPlan(rows, config.env, relationships);
    await client.query("COMMIT");
    return report("dry-run", "ready", plan);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function apply(client, config) {
  if (!/^[0-9a-f]{64}$/.test(config.expectedDigest ?? "")) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DIGEST_REQUIRED",
      "apply requires an exact lowercase SHA-256 digest from dry-run",
      64,
    );
  }

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await setLocalBounds(client, config);
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('MemoryProfileMigration:v1', 0)) AS locked",
    );
    if (lock.rows[0]?.locked !== true) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_LOCK_BUSY",
        "another Memory profile migration owns the advisory lock",
        75,
      );
    }

    const rows = await loadProfileRows(client, config.maxProfiles);
    const relationships = await loadProfileRelationships(client, config.maxRelationships);
    const catalog = await loadCatalog(client);
    const plan = buildMigrationPlan(rows, config.env, relationships);

    if (validProfileIndexes(catalog)) {
      assertApprovedDigest(plan, config.expectedDigest);
      assertAppliedData(plan);
      await client.query("COMMIT");
      return report("apply", "already_applied", plan);
    }
    if (catalog.length !== 0) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_CATALOG_CONFLICT",
        "profile indexes exist but do not match the exact migration contract",
        67,
      );
    }
    assertApprovedDigest(plan, config.expectedDigest);

    if (plan.losers.length > 0) {
      await client.query(
        `WITH mapping AS (
           SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS item("loserId", "winnerId")
         )
         UPDATE "public"."MemoryRelationship" AS relationship
         SET "sourceMemoryId" = mapping."winnerId"
         FROM mapping
         WHERE relationship."sourceMemoryId" = mapping."loserId"`,
        [
          plan.losers.map(({ loserId }) => loserId),
          plan.losers.map(({ winnerId }) => winnerId),
        ],
      );
      await client.query(
        `DELETE FROM "public"."Memory" WHERE "id" = ANY($1::uuid[])`,
        [plan.losers.map(({ loserId }) => loserId)],
      );
    }

    if (plan.updates.length > 0) {
      await client.query(
        `WITH normalized AS (
           SELECT * FROM unnest($1::uuid[], $2::text[]) AS item("id", "profileKey")
         )
         UPDATE "public"."Memory" AS memory
         SET "profileKey" = normalized."profileKey"
         FROM normalized
         WHERE memory."id" = normalized."id"`,
        [
          plan.updates.map(({ id }) => id),
          plan.updates.map(({ profileKey }) => profileKey),
        ],
      );
    }

    await createProfileIndexes(client);

    const appliedRows = await loadProfileRows(client, config.maxProfiles);
    const appliedRelationships = await loadProfileRelationships(client, config.maxRelationships);
    const appliedPlan = buildMigrationPlan(appliedRows, config.env, appliedRelationships);
    assertAppliedData(appliedPlan);
    const appliedCatalog = await loadCatalog(client);
    if (!validProfileIndexes(appliedCatalog)) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_CATALOG_INVALID",
        `created profile indexes do not match the exact migration contract: ${catalogDiagnostics(appliedCatalog)}`,
        67,
      );
    }

    await client.query("COMMIT");
    return report("apply", "applied", plan);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function createProfileIndexes(client) {
  await client.query(
    `CREATE UNIQUE INDEX "Memory_profile_standalone_key"
     ON "public"."Memory"("environmentId", "endUserId", "agentId", "profileKey")
     WHERE "kind" = 'profile' AND "clusterId" IS NULL AND "profileKey" IS NOT NULL`,
  );
  await client.query(
    `CREATE UNIQUE INDEX "Memory_profile_cluster_key"
     ON "public"."Memory"("environmentId", "endUserId", "clusterId", "profileKey")
     WHERE "kind" = 'profile' AND "clusterId" IS NOT NULL AND "profileKey" IS NOT NULL`,
  );
}

function assertApprovedDigest(plan, expectedDigest) {
  if (plan.digest !== expectedDigest) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DIGEST_MISMATCH",
      "database state changed after dry-run; generate and approve a new digest",
      66,
    );
  }
}

async function verify(client, config) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await setLocalBounds(client, config);
    const rows = await loadProfileRows(client, config.maxProfiles);
    const relationships = await loadProfileRelationships(client, config.maxRelationships);
    const plan = buildMigrationPlan(rows, config.env, relationships);
    assertAppliedData(plan);
    const catalog = await loadCatalog(client);
    if (!validProfileIndexes(catalog)) {
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_CONTRACT_INCOMPLETE",
        "profile indexes are missing or do not match the exact migration contract",
        67,
      );
    }
    await client.query("COMMIT");
    return report("verify", "verified", plan);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function setLocalBounds(client, config) {
  await client.query(`SET LOCAL statement_timeout = '${config.statementTimeoutMs}ms'`);
  await client.query(`SET LOCAL lock_timeout = '${config.lockTimeoutMs}ms'`);
}

async function loadProfileRows(client, maxProfiles) {
  const result = await client.query(PROFILE_ROWS_SQL, [maxProfiles + 1]);
  if (result.rows.length > maxProfiles) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_LIMIT_EXCEEDED",
      `profile inventory exceeds the configured ${maxProfiles}-row safety bound`,
      65,
    );
  }
  return result.rows;
}

async function loadProfileRelationships(client, maxRelationships) {
  const result = await client.query(PROFILE_RELATIONSHIPS_SQL, [maxRelationships + 1]);
  if (result.rows.length > maxRelationships) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_RELATIONSHIP_LIMIT_EXCEEDED",
      `profile relationship inventory exceeds the configured ${maxRelationships}-row safety bound`,
      65,
    );
  }
  return result.rows;
}

async function loadCatalog(client) {
  const result = await client.query(PROFILE_CATALOG_SQL, [INDEX_NAMES]);
  return result.rows.map((row) => ({
    ...row,
    keyColumns: Number(row.keyColumns),
    totalColumns: Number(row.totalColumns),
  }));
}

export function buildMigrationPlan(rows, env = process.env, relationships = []) {
  const winners = new Map();
  const candidates = [];
  const keyVersions = new Set();
  let encrypted = 0;
  let withoutIdentity = 0;

  for (const row of rows) {
    let metadata = row.metadata;
    if (isEncryptedEnvelope(metadata)) {
      encrypted += 1;
      keyVersions.add(Number(metadata.v));
      metadata = decryptMetadata(metadata, env);
      if (isEncryptedEnvelope(metadata)) {
        throw migrationError(
          "MEMORY_PROFILE_MIGRATION_DECRYPT_UNAVAILABLE",
          "encrypted profile metadata could not be decrypted",
          65,
        );
      }
    }

    const rawProfileKey = isRecord(metadata) ? metadata.profileKey : undefined;
    if (typeof rawProfileKey !== "string" || rawProfileKey.trim().length === 0) {
      withoutIdentity += 1;
      throw migrationError(
        "MEMORY_PROFILE_MIGRATION_PROFILE_KEY_REQUIRED",
        "a profile row has no usable metadata profile identity",
        65,
      );
    }

    const profileKey = normalizeProfileKey(rawProfileKey);
    const owner = row.clusterId ? ["cluster", row.clusterId] : ["agent", row.agentId];
    const identity = JSON.stringify([
      row.environmentId,
      row.endUserId,
      ...owner,
      profileKey,
    ]);
    const candidate = { row, profileKey, identity };
    candidates.push(candidate);
    if (!winners.has(identity)) winners.set(identity, candidate);
  }

  const losers = [];
  for (const candidate of candidates) {
    const winner = winners.get(candidate.identity);
    if (winner !== candidate) {
      losers.push({ loserId: candidate.row.id, winnerId: winner.row.id });
    }
  }
  losers.sort((left, right) => left.loserId.localeCompare(right.loserId));

  const loserIds = new Set(losers.map(({ loserId }) => loserId));
  const updates = candidates
    .filter((candidate) => !loserIds.has(candidate.row.id))
    .filter((candidate) => candidate.row.profileKey !== candidate.profileKey)
    .map((candidate) => ({ id: candidate.row.id, profileKey: candidate.profileKey }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const summary = {
    version: CONTRACT_VERSION,
    profiles: rows.length,
    validProfiles: candidates.length,
    withoutIdentity,
    encrypted,
    keyVersions: [...keyVersions].sort((left, right) => left - right),
    profileRelationships: relationships.length,
    losers,
    updates,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify({
      ...summary,
      rows: rows.map((row) => ({
        id: row.id,
        environmentId: row.environmentId,
        endUserId: row.endUserId,
        agentId: row.agentId,
        clusterId: row.clusterId,
        storedProfileKey: row.profileKey,
        updatedAt: new Date(row.updatedAt).toISOString(),
        metadataDigest: createHash("sha256")
          .update(JSON.stringify(row.metadata))
          .digest("hex"),
      })),
      relationships: relationships.map((relationship) => ({
        id: relationship.id,
        sourceMemoryId: relationship.sourceMemoryId,
      })),
    }))
    .digest("hex");

  return {
    ...summary,
    digest,
    storedIdentityMismatches: candidates.filter(
      (candidate) => !loserIds.has(candidate.row.id)
        && candidate.row.profileKey !== candidate.profileKey,
    ).length,
  };
}

function assertAppliedData(plan) {
  if (plan.losers.length !== 0 || plan.storedIdentityMismatches !== 0) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DATA_INCOMPLETE",
      "profile identity data is not fully normalized and deduplicated",
      67,
    );
  }
}

export function validProfileIndexes(indexes) {
  if (indexes.length !== PROFILE_INDEX_CONTRACT.size) return false;
  return indexes.every((index) => {
    const expected = PROFILE_INDEX_CONTRACT.get(index.name);
    return Boolean(expected)
      && index.unique === true
      && index.valid === true
      && index.ready === true
      && index.live === true
      && index.nullsNotDistinct === false
      && index.hasExpressions === false
      && index.accessMethod === "btree"
      && Number(index.keyColumns) === 4
      && Number(index.totalColumns) === 4
      && index.profileKeyType === "text"
      && index.profileKeyNullable === true
      && index.profileKeyDefault === null
      && JSON.stringify(index.operatorClasses) === JSON.stringify([
        "pg_catalog.uuid_ops",
        "pg_catalog.uuid_ops",
        "pg_catalog.uuid_ops",
        "pg_catalog.text_ops",
      ])
      && Array.isArray(index.indexCollations)
      && JSON.stringify(index.indexCollations) === JSON.stringify(index.columnCollations)
      && JSON.stringify(index.columns) === JSON.stringify(expected.columns)
      && index.predicate === expected.predicate;
  });
}

function catalogDiagnostics(indexes) {
  return JSON.stringify(indexes.map((index) => ({
    name: index.name,
    unique: index.unique,
    valid: index.valid,
    ready: index.ready,
    live: index.live,
    nullsNotDistinct: index.nullsNotDistinct,
    hasExpressions: index.hasExpressions,
    accessMethod: index.accessMethod,
    keyColumns: Number(index.keyColumns),
    totalColumns: Number(index.totalColumns),
    profileKeyType: index.profileKeyType,
    profileKeyNullable: index.profileKeyNullable,
    profileKeyDefault: index.profileKeyDefault,
    operatorClasses: index.operatorClasses,
    indexCollations: index.indexCollations,
    columnCollations: index.columnCollations,
    columns: index.columns,
    predicate: index.predicate,
  })));
}

function decryptMetadata(envelope, env) {
  const version = Number(envelope.v);
  if (!Number.isSafeInteger(version) || version <= 0 || typeof envelope.ct !== "string") {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_ENVELOPE_INVALID",
      "encrypted profile metadata envelope is malformed",
      65,
    );
  }
  const activeVersion = positiveInteger(env.PLATOS_MESSAGE_ENCRYPTION_KEY_V, 1);
  const primary = env.PLATOS_MESSAGE_ENCRYPTION_KEY;
  const keyHex = version === activeVersion && typeof primary === "string"
    && /^[0-9a-f]{64}$/i.test(primary)
    ? primary
    : env[`PLATOS_MESSAGE_ENCRYPTION_KEY_V${version}`];
  if (typeof keyHex !== "string" || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DECRYPT_UNAVAILABLE",
      `message encryption key version ${version} is unavailable`,
      65,
    );
  }

  try {
    const packed = Buffer.from(envelope.ct, "base64");
    if (packed.length < 33) throw new Error("invalid envelope length");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), packed.subarray(0, 16));
    decipher.setAuthTag(packed.subarray(16, 32));
    const plaintext = Buffer.concat([decipher.update(packed.subarray(32)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DECRYPT_UNAVAILABLE",
      `profile metadata encrypted with key version ${version} could not be decrypted`,
      65,
    );
  }
}

function report(command, status, plan) {
  return {
    event: "memory_profile_migration",
    version: CONTRACT_VERSION,
    command,
    status,
    digest: plan.digest,
    inventory: {
      profiles: plan.profiles,
      encrypted: plan.encrypted,
      keyVersions: plan.keyVersions,
      validProfiles: plan.validProfiles,
      withoutIdentity: plan.withoutIdentity,
      updates: plan.updates.length,
      deduplicated: plan.losers.length,
      relationships: plan.profileRelationships,
    },
    contentRedacted: true,
  };
}

function resolveConfig(options) {
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (!options.client && !databaseUrl) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DATABASE_URL_REQUIRED",
      "DATABASE_URL is required",
      64,
    );
  }
  return {
    databaseUrl,
    env,
    expectedDigest: options.expectedDigest,
    maxProfiles: boundedPositiveInteger(
      options.maxProfiles ?? env.MEMORY_PROFILE_MIGRATION_MAX_PROFILES,
      DEFAULT_MAX_PROFILES,
      1_000_000,
      "MEMORY_PROFILE_MIGRATION_MAX_PROFILES",
    ),
    maxRelationships: boundedPositiveInteger(
      options.maxRelationships ?? env.MEMORY_PROFILE_MIGRATION_MAX_RELATIONSHIPS,
      DEFAULT_MAX_RELATIONSHIPS,
      5_000_000,
      "MEMORY_PROFILE_MIGRATION_MAX_RELATIONSHIPS",
    ),
    statementTimeoutMs: boundedPositiveInteger(
      options.statementTimeoutMs ?? env.MEMORY_PROFILE_MIGRATION_STATEMENT_TIMEOUT_MS,
      DEFAULT_STATEMENT_TIMEOUT_MS,
      600_000,
      "MEMORY_PROFILE_MIGRATION_STATEMENT_TIMEOUT_MS",
    ),
    lockTimeoutMs: boundedPositiveInteger(
      options.lockTimeoutMs ?? env.MEMORY_PROFILE_MIGRATION_LOCK_TIMEOUT_MS,
      30_000,
      120_000,
      "MEMORY_PROFILE_MIGRATION_LOCK_TIMEOUT_MS",
    ),
  };
}

function boundedPositiveInteger(value, fallback, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_INVALID_CONFIGURATION",
      `${name} must be a positive integer no greater than ${maximum}`,
      64,
    );
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProfileKey(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function isEncryptedEnvelope(value) {
  return isRecord(value) && value.__platos_enc === 1;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function rollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the stable migration failure that caused the rollback.
  }
}

export function migrationError(code, message, exitCode) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}

async function main(argv) {
  const [rawCommand, ...args] = argv;
  const command = rawCommand?.replace(/^memory-profile-/, "");
  const expectedDigest = command === "apply" ? parseApplyDigest(args) : undefined;
  if (command !== "apply" && args.length > 0) {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_INVALID_ARGUMENT",
      `${rawCommand} does not accept positional arguments`,
      64,
    );
  }
  const result = await runMemoryProfileMigration(command, { expectedDigest });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseApplyDigest(args) {
  if (args.length !== 2 || args[0] !== "--digest") {
    throw migrationError(
      "MEMORY_PROFILE_MIGRATION_DIGEST_REQUIRED",
      "memory-profile-apply requires --digest <dry-run-sha256>",
      64,
    );
  }
  return args[1];
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === "string"
      ? error.code
      : "MEMORY_PROFILE_MIGRATION_DATABASE_ERROR";
    const message = typeof error?.code === "string"
      ? error.message
      : "memory profile migration database operation failed";
    process.stderr.write(`${JSON.stringify({
      event: "memory_profile_migration",
      status: "failed",
      code,
      message,
      contentRedacted: true,
    })}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 70;
  });
}
