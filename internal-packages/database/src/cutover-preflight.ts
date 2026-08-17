import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  legacyModelDispositionLedger,
  legacyEnumDispositionLedger,
  legacyIndexDispositionLedger,
  legacyPhysicalTableDispositionLedger,
  sourceValidationManifest,
} from "./cutover-ledger";
import { mapCutoverId } from "./cutover-id";
import {
  loadExpectedLegacyMigrations,
  validateLegacyMigrationHistory,
  type LegacyMigrationRow,
} from "./cutover-history";
import { cutoverDomainPhases, incompleteCutoverPhaseIds } from "./cutover-phases";
import type {
  CutoverCheck,
  CutoverDatabase,
  CutoverMode,
  CutoverOptions,
  SourceDigest,
} from "./cutover-types";

export const CUTOVER_ADVISORY_LOCK = [1347178323, 123] as const;
export const CUTOVER_EXECUTE_ACCEPTANCE = "WIN123_EXECUTE_V1";
export const CUTOVER_IRREVERSIBLE_EFFECTS_ACCEPTANCE = "WIN123_IRREVERSIBLE_EFFECTS_V1";

export const CUTOVER_REQUIRED_KEY_ENVIRONMENT = [
  "ENCRYPTION_KEY",
  "PLATOS_ENCRYPTION_KEY",
  "PLATOS_CREDENTIAL_ROOT_KEY_VERSION",
  "PLATOS_CREDENTIAL_ROOT_KEYS",
  "PLATOS_MESSAGE_ENCRYPTION_KEY",
  "PLATOS_CUTOVER_EXPORT_KEY",
] as const;

export interface PreflightResult {
  readonly checks: readonly CutoverCheck[];
  readonly sourceDigests: readonly SourceDigest[];
  readonly readyForRequestedMode: boolean;
  readonly legacyHistoryRows: readonly LegacyMigrationRow[];
}

function check(
  id: string,
  status: CutoverCheck["status"],
  summary: string,
  details?: Readonly<Record<string, unknown>>
): CutoverCheck {
  return { id, status, summary, details };
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const wanted = new Set(expected);
  return actual.every((name) => wanted.has(name));
}

export async function runCutoverPreflight(
  database: CutoverDatabase,
  options: CutoverOptions,
  packageRoot = resolve(__dirname, ".."),
  advisoryLockAlreadyHeld = false
): Promise<PreflightResult> {
  const checks: CutoverCheck[] = [];

  const lockResult = advisoryLockAlreadyHeld
    ? { rows: [{ acquired: true }], rowCount: 1 }
    : await database.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        CUTOVER_ADVISORY_LOCK
      );
  const lockAcquired = lockResult.rows[0]?.acquired === true;
  checks.push(
    check(
      "advisory-lock",
      lockAcquired ? "PASS" : "BLOCK",
      lockAcquired ? "well-known cutover advisory lock is available" : "cutover advisory lock is held"
    )
  );

  try {
    const sessions = await database.query<{
      pid: number;
      application_name: string;
      state: string | null;
    }>(`SELECT pid, application_name, state
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND backend_type = 'client backend'
           AND pid <> pg_backend_pid()
           AND application_name NOT LIKE 'platos-cutover%'
         ORDER BY pid`);
    checks.push(
      check(
        "writer-quiescence",
        sessions.rows.length === 0 ? "PASS" : "BLOCK",
        sessions.rows.length === 0
          ? "no non-cutover client sessions are connected"
          : "non-cutover client sessions remain connected",
        sessions.rows.length === 0
          ? undefined
          : {
              sessionCount: sessions.rows.length,
              sessions: sessions.rows.map((row) => ({
                pid: row.pid,
                applicationName: row.application_name || "unset",
                state: row.state,
              })),
            }
      )
    );

    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`
    );
    const actualTables = tables.rows.map((row) => row.table_name);
    const expectedTables = legacyPhysicalTableDispositionLedger.map((entry) => entry.name);
    const tablesRecognized = sameMembers(actualTables, expectedTables);
    checks.push(
      check(
        "legacy-table-fingerprint",
        tablesRecognized ? "PASS" : "BLOCK",
        tablesRecognized ? "legacy physical table inventory matches" : "legacy table inventory is unknown or partial",
        {
          actualCount: actualTables.length,
          expectedCount: expectedTables.length,
          missing: expectedTables.filter((name) => !actualTables.includes(name)),
          unknown: actualTables.filter((name) => !expectedTables.includes(name)),
        }
      )
    );

    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
    );
    const actualIndexes = indexes.rows.map((row) => row.indexname);
    const expectedIndexes = legacyIndexDispositionLedger.map((entry) => entry.name);
    const indexesRecognized = sameMembers(actualIndexes, expectedIndexes);
    checks.push(
      check(
        "legacy-index-fingerprint",
        indexesRecognized ? "PASS" : "BLOCK",
        indexesRecognized ? "legacy physical index inventory matches" : "legacy index inventory is unknown or partial",
        { actualCount: actualIndexes.length, expectedCount: expectedIndexes.length }
      )
    );

    const enums = await database.query<{ typname: string }>(
      `SELECT type_info.typname
         FROM pg_type type_info
         JOIN pg_namespace namespace ON namespace.oid = type_info.typnamespace
        WHERE namespace.nspname = 'public' AND type_info.typtype = 'e'
        ORDER BY type_info.typname`
    );
    const actualEnums = enums.rows.map((row) => row.typname);
    const expectedEnums = legacyEnumDispositionLedger.map((entry) => entry.name);
    const enumsRecognized = sameMembers(actualEnums, expectedEnums);
    checks.push(
      check(
        "legacy-enum-fingerprint",
        enumsRecognized ? "PASS" : "BLOCK",
        enumsRecognized ? "legacy enum inventory matches" : "legacy enum inventory is unknown or partial",
        { actualCount: actualEnums.length, expectedCount: expectedEnums.length }
      )
    );

    let historyRows: LegacyMigrationRow[] = [];
    if (actualTables.includes("_prisma_migrations")) {
      const history = await database.query<LegacyMigrationRow>(
        `SELECT *
           FROM public."_prisma_migrations"
          ORDER BY migration_name`
      );
      historyRows = history.rows;
    }
    const expectedHistory = loadExpectedLegacyMigrations(packageRoot);
    const historyValidation = validateLegacyMigrationHistory(historyRows, expectedHistory);
    checks.push(
      check(
        "legacy-migration-history",
        historyValidation.recognized ? "PASS" : "BLOCK",
        historyValidation.recognized
          ? "legacy migration history and checksums are recognized"
          : "legacy migration history is failed, unknown, partial, or modified",
        {
          appliedCount: historyValidation.appliedCount,
          expectedCount: historyValidation.expectedCount,
          historyDigest: historyValidation.historyDigest,
          blockers: historyValidation.blockers,
        }
      )
    );

    const sourceDigests = tablesRecognized ? await readSourceDigests(database) : [];
    checks.push(
      check(
        "source-counts-digests",
        sourceDigests.length === sourceValidationManifest.length ? "PASS" : "BLOCK",
        sourceDigests.length === sourceValidationManifest.length
          ? "all retained source identities have count and digest evidence"
          : "source count and digest evidence is incomplete",
        { sourceCount: sourceDigests.length }
      )
    );

    if (tablesRecognized) {
      checks.push(...(await runSourceDataChecks(database)));
      checks.push(await validateTargetUuidCandidates(database));
    }
    else checks.push(check("source-data-validation", "BLOCK", "source data checks require a recognized schema"));

    const requiredKeys = options.requiredKeyEnvironment ?? {};
    const missingKeys = CUTOVER_REQUIRED_KEY_ENVIRONMENT.filter((name) => requiredKeys[name] !== true);
    checks.push(
      check(
        "key-presence",
        missingKeys.length === 0 ? "PASS" : "BLOCK",
        missingKeys.length === 0 ? "required key domains are present" : "required key domains are missing",
        { missingEnvironmentVariables: missingKeys }
      )
    );

    const mutationAttestationChecks = validateMutationAttestations(options.mode, options.attestations);
    checks.push(...mutationAttestationChecks);
    checks.push(
      check(
        "sealed-export-contract",
        options.mode === "DRY_RUN" || Boolean(options.exportKeyReference) ? "PASS" : "BLOCK",
        options.mode === "DRY_RUN" || options.exportKeyReference
          ? "sealed export key reference and environment-key contract is configured"
          : "sealed export key reference is required for mutation rehearsal"
      )
    );

    checks.push(
      check(
        "domain-phase-implementation",
        "INCOMPLETE",
        "remaining domain phases are fail-closed stubs",
        {
          incompletePhaseIds: incompleteCutoverPhaseIds,
          phases: cutoverDomainPhases.map((phase) => ({
            id: phase.id,
            implementation: phase.implementation,
            sourceModelCount: phase.sourceModels.length,
          })),
        }
      )
    );

    const hardBlock = checks.some((entry) => entry.status === "BLOCK");
    const incompleteBlocksMode = options.mode === "FULL_EXECUTE";
    return {
      checks,
      sourceDigests,
      readyForRequestedMode: !hardBlock && !incompleteBlocksMode,
      legacyHistoryRows: historyRows,
    };
  } finally {
    if (lockAcquired && !advisoryLockAlreadyHeld) {
      await database.query("SELECT pg_advisory_unlock($1, $2)", CUTOVER_ADVISORY_LOCK);
    }
  }
}

function validateMutationAttestations(
  mode: CutoverMode,
  attestations: CutoverOptions["attestations"]
): CutoverCheck[] {
  if (mode === "DRY_RUN") {
    return [check("mutation-attestations", "PASS", "dry-run performs no durable mutation")];
  }
  const missing: string[] = [];
  if (attestations.executeAcceptance !== CUTOVER_EXECUTE_ACCEPTANCE) missing.push("executeAcceptance");
  if (!attestations.backupAttestationRef) missing.push("backupAttestationRef");
  if (!attestations.backupRestoreTestRef) missing.push("backupRestoreTestRef");
  if (attestations.irreversibleEffectsAcceptance !== CUTOVER_IRREVERSIBLE_EFFECTS_ACCEPTANCE) {
    missing.push("irreversibleEffectsAcceptance");
  }
  if (!attestations.writerFenceAttestationRef) missing.push("writerFenceAttestationRef");
  if (!attestations.capacityAttestationRef) missing.push("capacityAttestationRef");
  return [
    check(
      "mutation-attestations",
      missing.length === 0 ? "PASS" : "BLOCK",
      missing.length === 0
        ? "backup, restore-test, capacity, writer-fence, execute, and irreversible-effects attestations are present"
        : "mutation attestations are missing or do not match the accepted version",
      { missing }
    ),
  ];
}

async function readSourceDigests(database: CutoverDatabase): Promise<SourceDigest[]> {
  const digests: SourceDigest[] = [];
  for (const source of sourceValidationManifest) {
    const result = await database.query<{ row_count: string; identity_digest: string }>(
      `SELECT count(*)::text AS row_count,
              md5(coalesce(string_agg(md5(source."${source.identityField}"::text), '' ORDER BY source."${source.identityField}"::text), '')) AS identity_digest
         FROM public."${source.physicalTable}" source`
    );
    const row = result.rows[0]!;
    digests.push({
      sourceModel: source.sourceModel,
      rowCount: row.row_count,
      identityDigest: row.identity_digest,
    });
  }
  return digests;
}

async function runSourceDataChecks(database: CutoverDatabase): Promise<CutoverCheck[]> {
  const descriptors = [
    {
      id: "token-hash-collisions-and-shape",
      sql: `WITH bearer_hashes(family, token_hash) AS (
              SELECT 'access-key', "keyHash" FROM public."PlatosAccessKey"
              UNION ALL SELECT 'mcp-token', "tokenHash" FROM public."PlatosMCPToken"
              UNION ALL SELECT 'pat', "tokenHash" FROM public."PlatosPAT"
              UNION ALL SELECT 'oauth-access', "tokenHash" FROM public."PlatosOAuthAccessToken"
              UNION ALL SELECT 'oauth-refresh', "tokenHash" FROM public."PlatosOAuthRefreshToken"
              UNION ALL SELECT 'entity-bearer', "tokenHash" FROM public."PlatosMcpBearerToken"
            )
            SELECT token_hash, count(*)::text AS count FROM bearer_hashes
             GROUP BY token_hash
            HAVING count(*) > 1 OR token_hash !~ '^[0-9a-fA-F]{64}$' LIMIT 20`,
    },
    {
      id: "normalized-email-collisions",
      sql: `SELECT lower(btrim(email)) AS value, count(*)::text AS count FROM public."User"
             GROUP BY lower(btrim(email)) HAVING count(*) > 1 OR lower(btrim(email)) = '' LIMIT 20`,
    },
    {
      id: "organization-slug-collisions",
      sql: `SELECT lower(btrim(slug)) AS value, count(*)::text AS count FROM public."Organization"
             GROUP BY lower(btrim(slug)) HAVING count(*) > 1 OR lower(btrim(slug)) = '' LIMIT 20`,
    },
    {
      id: "project-slug-collisions",
      sql: `SELECT "organizationId" AS owner, lower(btrim(slug)) AS value, count(*)::text AS count
              FROM public."Project" GROUP BY "organizationId", lower(btrim(slug))
            HAVING count(*) > 1 OR lower(btrim(slug)) = '' LIMIT 20`,
    },
    {
      id: "malformed-auth-subjects",
      sql: `SELECT id FROM public."User"
             WHERE ("authenticationMethod" IN ('GITHUB', 'GOOGLE') AND
                    ("authIdentifier" IS NULL OR "authIdentifier" !~ '^(github|google):[^:[:space:]]+$'))
                OR ("authenticationMethod" = 'GITHUB' AND "authIdentifier" !~ '^github:')
                OR ("authenticationMethod" = 'GOOGLE' AND "authIdentifier" !~ '^google:')
             LIMIT 20`,
    },
    {
      id: "invalid-dashboard-preferences",
      sql: `SELECT id FROM public."User"
             WHERE "dashboardPreferences" IS NOT NULL
               AND jsonb_typeof("dashboardPreferences") <> 'object' LIMIT 20`,
    },
    {
      id: "missing-organization-owner-candidates",
      sql: `SELECT organization.id FROM public."Organization" organization
             WHERE NOT EXISTS (SELECT 1 FROM public."OrgMember" member
                                WHERE member."organizationId" = organization.id) LIMIT 20`,
    },
    {
      id: "tenancy-orphans-and-ancestry",
      sql: `SELECT environment.id
              FROM public."RuntimeEnvironment" environment
              LEFT JOIN public."Organization" organization ON organization.id = environment."organizationId"
              LEFT JOIN public."Project" project ON project.id = environment."projectId"
             WHERE organization.id IS NULL OR project.id IS NULL
                OR project."organizationId" <> environment."organizationId"
                OR (environment."parentEnvironmentId" IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM public."RuntimeEnvironment" parent
                     WHERE parent.id = environment."parentEnvironmentId"
                       AND parent."projectId" = environment."projectId"
                       AND parent."organizationId" = environment."organizationId"))
             LIMIT 20`,
    },
    {
      id: "environment-target-slug-collisions",
      sql: `WITH ranked AS (
              SELECT "projectId", id,
                     CASE WHEN count(*) OVER (PARTITION BY "projectId", lower(btrim(slug))) = 1
                          THEN lower(btrim(slug))
                          ELSE lower(btrim(slug)) || '--' || row_number() OVER (
                            PARTITION BY "projectId", lower(btrim(slug)) ORDER BY id)
                     END AS target_slug
                FROM public."RuntimeEnvironment")
            SELECT "projectId", target_slug, count(*)::text AS count FROM ranked
             GROUP BY "projectId", target_slug HAVING count(*) > 1 OR target_slug = '' LIMIT 20`,
    },
  ] as const;

  const results: CutoverCheck[] = [];
  for (const descriptor of descriptors) {
    const result = await database.query(descriptor.sql);
    results.push(
      check(
        descriptor.id,
        result.rows.length === 0 ? "PASS" : "BLOCK",
        result.rows.length === 0 ? `${descriptor.id} validation passed` : `${descriptor.id} validation failed`,
        result.rows.length === 0
          ? undefined
          : {
              violationCountAtLeast: result.rows.length,
              sampleDigest: createHash("sha256").update(JSON.stringify(result.rows)).digest("hex"),
            }
      )
    );
  }
  return results;
}

async function validateTargetUuidCandidates(database: CutoverDatabase): Promise<CutoverCheck> {
  const validationByModel = new Map(
    sourceValidationManifest.map((entry) => [entry.sourceModel, entry] as const)
  );
  const seen = new Set<string>();
  let candidateCount = 0;
  let collisionCount = 0;
  for (const entry of legacyModelDispositionLedger.filter((candidate) => candidate.disposition === "BACKFILL")) {
    const validation = validationByModel.get(entry.sourceModel)!;
    const identities = await database.query<{ source_id: string }>(
      `SELECT "${validation.identityField}"::text AS source_id
         FROM public."${entry.physicalTable}" ORDER BY "${validation.identityField}"::text`
    );
    for (const row of identities.rows) {
      entry.targets.forEach((target, index) => {
        const suffix = index === 0
          ? undefined
          : target.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        const candidateId = mapCutoverId({ sourceModel: entry.sourceModel, sourceId: row.source_id, suffix });
        const key = `${target}:${candidateId}`;
        if (seen.has(key)) collisionCount += 1;
        seen.add(key);
        candidateCount += 1;
      });
    }
  }
  const projectAccess = await database.query<{ member_id: string; project_id: string }>(
    `SELECT member.id::text AS member_id, project.id::text AS project_id
       FROM public."OrgMember" member
       JOIN public."Project" project ON project."organizationId" = member."organizationId"
      ORDER BY member.id, project.id`
  );
  for (const row of projectAccess.rows) {
    const candidateId = mapCutoverId({
      sourceModel: "OrgMember",
      sourceId: row.member_id,
      suffix: `project-membership-${row.project_id}`,
    });
    const key = `ProjectMembership:${candidateId}`;
    if (seen.has(key)) collisionCount += 1;
    seen.add(key);
    candidateCount += 1;
  }
  return check(
    "target-uuid-collisions",
    collisionCount === 0 ? "PASS" : "BLOCK",
    collisionCount === 0 ? "deterministic target UUID candidates are collision-free" : "target UUID collisions detected",
    { candidateCount, collisionCount }
  );
}
