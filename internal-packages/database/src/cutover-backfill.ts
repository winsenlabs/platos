import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mapCutoverId } from "./cutover-id";
import {
  legacyEnumDispositionLedger,
  legacyPhysicalTableDispositionLedger,
  legacyModelDispositionLedger,
  sourceValidationManifest,
} from "./cutover-ledger";
import type { CutoverDatabase } from "./cutover-types";

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
export const CUTOVER_CHUNK_SIZE = 500;

export function deterministicChunks<T>(rows: readonly T[], size = CUTOVER_CHUNK_SIZE): readonly (readonly T[])[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new TypeError("cutover chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) chunks.push(rows.slice(offset, offset + size));
  return chunks;
}

function stableSuffixForTarget(target: string): string {
  return target
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(/[^A-Za-z0-9-]/g, "-")
    .toLowerCase();
}

export async function moveLegacyCatalogToTemporarySchema(database: CutoverDatabase): Promise<void> {
  await database.query('CREATE SCHEMA "cutover_legacy"');
  for (const entry of legacyEnumDispositionLedger) {
    await database.query(
      `ALTER TYPE public.${quoteIdentifier(entry.name)} SET SCHEMA cutover_legacy`
    );
  }
  for (const entry of legacyPhysicalTableDispositionLedger) {
    await database.query(
      `ALTER TABLE public.${quoteIdentifier(entry.name)} SET SCHEMA cutover_legacy`
    );
  }
}

export async function createCleanCatalog(database: CutoverDatabase, packageRoot: string): Promise<void> {
  const migrationDirectories = [
    "00000000000000_initial",
    "20260817000000_add_upload_reservations",
    "20260817010000_add_token_lifecycle_audit",
    "20260817020000_add_attachment_byte_reconciliation",
  ] as const;
  for (const migration of migrationDirectories) {
    const sql = readFileSync(resolve(packageRoot, "prisma/migrations", migration, "migration.sql"), "utf8");
    await database.query(sql);
  }
}

export async function createCutoverJournal(database: CutoverDatabase, runId: string): Promise<void> {
  await database.query(`CREATE TABLE cutover_legacy.cutover_journal (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id uuid NOT NULL,
    phase text NOT NULL,
    status text NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK')),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  await database.query(`CREATE TABLE cutover_legacy.cutover_id_map (
    mapping_version integer NOT NULL,
    source_model text NOT NULL,
    source_id text NOT NULL,
    target_model text NOT NULL,
    stable_suffix text NOT NULL DEFAULT '',
    target_id uuid NOT NULL,
    PRIMARY KEY (mapping_version, source_model, source_id, target_model, stable_suffix),
    UNIQUE (mapping_version, target_model, target_id)
  )`);
  await appendCutoverJournal(database, runId, "transaction", "STARTED", {});
}

export async function appendCutoverJournal(
  database: CutoverDatabase,
  runId: string,
  phase: string,
  status: "STARTED" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK",
  evidence: Readonly<Record<string, unknown>>
): Promise<void> {
  await database.query(
    `INSERT INTO cutover_legacy.cutover_journal (run_id, phase, status, evidence)
     VALUES ($1::uuid, $2, $3, $4::jsonb)`,
    [runId, phase, status, JSON.stringify(evidence)]
  );
}

interface IdMappingRow {
  readonly sourceModel: string;
  readonly sourceId: string;
  readonly targetModel: string;
  readonly stableSuffix: string;
  readonly targetId: string;
}

export async function materializeCutoverIdMap(database: CutoverDatabase): Promise<number> {
  const validationByModel = new Map(
    sourceValidationManifest.map((entry) => [entry.sourceModel, entry] as const)
  );
  const mappings: IdMappingRow[] = [];

  for (const entry of legacyModelDispositionLedger.filter((candidate) => candidate.disposition === "BACKFILL")) {
    const validation = validationByModel.get(entry.sourceModel)!;
    const identities = await database.query<{ source_id: string }>(
      `SELECT ${quoteIdentifier(validation.identityField)}::text AS source_id
         FROM cutover_legacy.${quoteIdentifier(entry.physicalTable)}
        ORDER BY ${quoteIdentifier(validation.identityField)}::text`
    );
    for (const row of identities.rows) {
      entry.targets.forEach((targetModel, index) => {
        const stableSuffix = index === 0 ? "" : stableSuffixForTarget(targetModel);
        mappings.push({
          sourceModel: entry.sourceModel,
          sourceId: row.source_id,
          targetModel,
          stableSuffix,
          targetId: mapCutoverId({
            sourceModel: entry.sourceModel,
            sourceId: row.source_id,
            suffix: stableSuffix || undefined,
          }),
        });
      });
    }
  }

  const projectAccess = await database.query<{ member_id: string; project_id: string }>(
    `SELECT member.id::text AS member_id, project.id::text AS project_id
       FROM cutover_legacy."OrgMember" member
       JOIN cutover_legacy."Project" project ON project."organizationId" = member."organizationId"
      ORDER BY member.id, project.id`
  );
  for (const row of projectAccess.rows) {
    const stableSuffix = `project-membership-${row.project_id}`;
    mappings.push({
      sourceModel: "OrgMember",
      sourceId: row.member_id,
      targetModel: "ProjectMembership",
      stableSuffix,
      targetId: mapCutoverId({ sourceModel: "OrgMember", sourceId: row.member_id, suffix: stableSuffix }),
    });
  }

  const seenTargets = new Set<string>();
  for (const mapping of mappings) {
    const targetKey = `${mapping.targetModel}:${mapping.targetId}`;
    if (seenTargets.has(targetKey)) throw new Error(`target UUID collision for ${mapping.targetModel}`);
    seenTargets.add(targetKey);
  }

  for (const chunk of deterministicChunks(mappings)) {
    const values: unknown[] = [];
    const tuples = chunk.map((mapping, index) => {
      const base = index * 5;
      values.push(
        mapping.sourceModel,
        mapping.sourceId,
        mapping.targetModel,
        mapping.stableSuffix,
        mapping.targetId
      );
      return `(1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::uuid)`;
    });
    if (tuples.length) {
      await database.query(
        `INSERT INTO cutover_legacy.cutover_id_map
           (mapping_version, source_model, source_id, target_model, stable_suffix, target_id)
         VALUES ${tuples.join(", ")}`,
        values
      );
    }
  }
  return mappings.length;
}

export async function dropTemporaryCutoverSchema(database: CutoverDatabase): Promise<void> {
  await database.query('DROP SCHEMA "cutover_legacy" CASCADE');
}

export async function backfillCoreTenancy(database: CutoverDatabase): Promise<void> {
  await database.query(`
    INSERT INTO public."User"
      (id, email, "displayName", "avatarUrl", "dashboardPreferences", "platformOperator", "createdAt", "updatedAt")
    SELECT id_map.target_id,
           lower(btrim(source.email)),
           coalesce(nullif(btrim(source."displayName"), ''), nullif(btrim(source.name), '')),
           source."avatarUrl",
           source."dashboardPreferences",
           source.admin,
           source."createdAt",
           source."updatedAt"
      FROM cutover_legacy."User" source
      JOIN cutover_legacy.cutover_id_map id_map
        ON id_map.mapping_version = 1 AND id_map.source_model = 'User'
       AND id_map.source_id = source.id AND id_map.target_model = 'User' AND id_map.stable_suffix = ''
     ORDER BY source.id`);

  await database.query(`
    INSERT INTO public."OperatorIdentity"
      (id, "userId", provider, subject, "providerEmail", "createdAt", "updatedAt")
    SELECT identity_map.target_id,
           user_map.target_id,
           source."authenticationMethod"::text::public."OperatorIdentityProvider",
           CASE source."authenticationMethod"::text
             WHEN 'MAGIC_LINK' THEN lower(btrim(source.email))
             ELSE split_part(source."authIdentifier", ':', 2)
           END,
           lower(btrim(source.email)),
           source."createdAt",
           source."updatedAt"
      FROM cutover_legacy."User" source
      JOIN cutover_legacy.cutover_id_map user_map
        ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
       AND user_map.source_id = source.id AND user_map.target_model = 'User' AND user_map.stable_suffix = ''
      JOIN cutover_legacy.cutover_id_map identity_map
        ON identity_map.mapping_version = 1 AND identity_map.source_model = 'User'
       AND identity_map.source_id = source.id AND identity_map.target_model = 'OperatorIdentity'
     ORDER BY source.id`);

  await database.query(`
    INSERT INTO public."Organization" (id, slug, name, "archivedAt", "createdAt", "updatedAt")
    SELECT id_map.target_id, lower(btrim(source.slug)), source.title, source."deletedAt",
           source."createdAt", source."updatedAt"
      FROM cutover_legacy."Organization" source
      JOIN cutover_legacy.cutover_id_map id_map
        ON id_map.mapping_version = 1 AND id_map.source_model = 'Organization'
       AND id_map.source_id = source.id AND id_map.target_model = 'Organization'
     ORDER BY source.id`);

  await database.query(`
    WITH ranked AS (
      SELECT source.*,
             row_number() OVER (
               PARTITION BY source."organizationId"
               ORDER BY CASE source.role::text WHEN 'ADMIN' THEN 0 ELSE 1 END,
                        source."createdAt", source.id
             ) AS owner_rank
        FROM cutover_legacy."OrgMember" source
    )
    INSERT INTO public."OrganizationMembership"
      (id, "organizationId", "userId", role, "createdAt", "updatedAt")
    SELECT member_map.target_id, organization_map.target_id, user_map.target_id,
           CASE WHEN ranked.owner_rank = 1 THEN 'OWNER'::public."OrganizationRole"
                WHEN ranked.role::text = 'ADMIN' THEN 'ADMIN'::public."OrganizationRole"
                ELSE 'MEMBER'::public."OrganizationRole" END,
           ranked."createdAt", ranked."updatedAt"
      FROM ranked
      JOIN cutover_legacy.cutover_id_map member_map
        ON member_map.mapping_version = 1 AND member_map.source_model = 'OrgMember'
       AND member_map.source_id = ranked.id AND member_map.target_model = 'OrganizationMembership'
      JOIN cutover_legacy.cutover_id_map organization_map
        ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
       AND organization_map.source_id = ranked."organizationId" AND organization_map.target_model = 'Organization'
      JOIN cutover_legacy.cutover_id_map user_map
        ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
       AND user_map.source_id = ranked."userId" AND user_map.target_model = 'User'
     ORDER BY ranked.id`);

  await database.query(`
    INSERT INTO public."Project"
      (id, "organizationId", slug, name, "archivedAt", "createdAt", "updatedAt")
    SELECT project_map.target_id, organization_map.target_id, lower(btrim(source.slug)), source.name,
           source."deletedAt", source."createdAt", source."updatedAt"
      FROM cutover_legacy."Project" source
      JOIN cutover_legacy.cutover_id_map project_map
        ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
       AND project_map.source_id = source.id AND project_map.target_model = 'Project'
      JOIN cutover_legacy.cutover_id_map organization_map
        ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
       AND organization_map.source_id = source."organizationId" AND organization_map.target_model = 'Organization'
     ORDER BY source.id`);

  await database.query(`
    INSERT INTO public."ProjectMembership"
      (id, "projectId", "organizationMembershipId", "organizationId", role, "createdAt", "updatedAt")
    SELECT access_map.target_id, project_map.target_id, member_map.target_id, organization_map.target_id,
           CASE WHEN member.role::text = 'ADMIN' THEN 'ADMIN'::public."ProjectRole"
                ELSE 'VIEWER'::public."ProjectRole" END,
           greatest(member."createdAt", project."createdAt"),
           greatest(member."updatedAt", project."updatedAt")
      FROM cutover_legacy."OrgMember" member
      JOIN cutover_legacy."Project" project ON project."organizationId" = member."organizationId"
      JOIN cutover_legacy.cutover_id_map access_map
        ON access_map.mapping_version = 1 AND access_map.source_model = 'OrgMember'
       AND access_map.source_id = member.id AND access_map.target_model = 'ProjectMembership'
       AND access_map.stable_suffix = 'project-membership-' || project.id
      JOIN cutover_legacy.cutover_id_map member_map
        ON member_map.mapping_version = 1 AND member_map.source_model = 'OrgMember'
       AND member_map.source_id = member.id AND member_map.target_model = 'OrganizationMembership'
      JOIN cutover_legacy.cutover_id_map project_map
        ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
       AND project_map.source_id = project.id AND project_map.target_model = 'Project'
      JOIN cutover_legacy.cutover_id_map organization_map
        ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
       AND organization_map.source_id = project."organizationId" AND organization_map.target_model = 'Organization'
     ORDER BY member.id, project.id`);

  await database.query(`
    WITH ranked AS (
      SELECT source.*,
             count(*) OVER (PARTITION BY source."projectId", lower(btrim(source.slug))) AS slug_count,
             row_number() OVER (
               PARTITION BY source."projectId", lower(btrim(source.slug)) ORDER BY source.id
             ) AS slug_rank
        FROM cutover_legacy."RuntimeEnvironment" source
    )
    INSERT INTO public."Environment" (id, "projectId", slug, name, "archivedAt", "createdAt", "updatedAt")
    SELECT environment_map.target_id, project_map.target_id,
           CASE WHEN ranked.slug_count = 1 THEN lower(btrim(ranked.slug))
                ELSE lower(btrim(ranked.slug)) || '--' || ranked.slug_rank::text END,
           coalesce(nullif(btrim(ranked."branchName"), ''), initcap(replace(btrim(ranked.slug), '-', ' '))),
           ranked."archivedAt", ranked."createdAt", ranked."updatedAt"
      FROM ranked
      JOIN cutover_legacy.cutover_id_map environment_map
        ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
       AND environment_map.source_id = ranked.id AND environment_map.target_model = 'Environment'
      JOIN cutover_legacy.cutover_id_map project_map
        ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
       AND project_map.source_id = ranked."projectId" AND project_map.target_model = 'Project'
     ORDER BY ranked.id`);
}

export async function validateCoreTenancyBackfill(database: CutoverDatabase): Promise<void> {
  const result = await database.query<{ id: string; source_count: string; target_count: string }>(`
    WITH equations(id, source_count, target_count) AS (
      VALUES
        ('users', (SELECT count(*) FROM cutover_legacy."User"), (SELECT count(*) FROM public."User")),
        ('identities', (SELECT count(*) FROM cutover_legacy."User"), (SELECT count(*) FROM public."OperatorIdentity")),
        ('organizations', (SELECT count(*) FROM cutover_legacy."Organization"), (SELECT count(*) FROM public."Organization")),
        ('memberships', (SELECT count(*) FROM cutover_legacy."OrgMember"), (SELECT count(*) FROM public."OrganizationMembership")),
        ('projects', (SELECT count(*) FROM cutover_legacy."Project"), (SELECT count(*) FROM public."Project")),
        ('project-memberships',
          (SELECT count(*) FROM cutover_legacy."OrgMember" member JOIN cutover_legacy."Project" project
             ON project."organizationId" = member."organizationId"),
          (SELECT count(*) FROM public."ProjectMembership")),
        ('environments', (SELECT count(*) FROM cutover_legacy."RuntimeEnvironment"), (SELECT count(*) FROM public."Environment"))
    )
    SELECT id, source_count::text, target_count::text FROM equations WHERE source_count <> target_count`);
  if (result.rows.length) throw new Error("core tenancy conservation equations failed");

  const ownership = await database.query(`
    SELECT organization.id
      FROM public."Organization" organization
     WHERE (SELECT count(*) FROM public."OrganizationMembership" membership
             WHERE membership."organizationId" = organization.id AND membership.role = 'OWNER') <> 1
     LIMIT 1`);
  if (ownership.rows.length) throw new Error("core tenancy owner validation failed");
}

export async function exportTransactionArtifacts(database: CutoverDatabase): Promise<{
  readonly idMap: readonly Record<string, unknown>[];
  readonly journal: readonly Record<string, unknown>[];
}> {
  const idMap = await database.query(
    `SELECT mapping_version, source_model, source_id, target_model, stable_suffix, target_id::text
       FROM cutover_legacy.cutover_id_map
      ORDER BY source_model, source_id, target_model, stable_suffix`
  );
  const journal = await database.query(
    `SELECT sequence::text, run_id::text, phase, status, evidence, recorded_at
       FROM cutover_legacy.cutover_journal ORDER BY sequence`
  );
  return { idMap: idMap.rows, journal: journal.rows };
}
