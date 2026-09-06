// The `Skill` half of `SkillsRepository` — the catalogue rows this context is
// SOLE WRITER of (ADR M0.3 §1 row 6).
//
// THE UPSERT IS A DATABASE UPSERT, AND THE PORT SAYS WHY. "Upsert, not insert:
// the identity triple is the uniqueness key, and re-registering a manifest MUST
// land on the existing row. An implementation MUST NOT convert a unique
// violation into a second row under a fresh uuid." A read-then-branch would do
// exactly that under concurrency — two registrations of one manifest both see no
// row, both insert, and one gets a unique violation that takes the caller's
// whole transaction with it. `ON CONFLICT ... DO UPDATE` is one statement and
// has no window.
//
// `id` AND `createdAt` SURVIVE A RE-REGISTRATION. Neither appears in the update
// clause, so a manifest uploaded again keeps the row it already had and the
// instant it first arrived. A row that looked new after every edit is a row
// nobody can audit, and `AgentSkill.environmentSkillId` — which `agents` owns —
// hangs off a chain rooted in this id.
//
// `organizationId`, `slug` AND `version` DO NOT APPEAR IN THE UPDATE CLAUSE
// EITHER, and there the reason is a database rule rather than an argument.
// `Skill_owner_immutable` fires BEFORE UPDATE and raises 23514 if
// `organizationId` moves; the other two ARE the key being matched on, so writing
// them would either be a no-op or a rename onto another row's identity.
//
// EVERY READ HERE IS SCOPED AND THE SCOPE IS A PARAMETER. There is no
// `findSkill(id)` on the port, deliberately, and there is none here: a
// scope-less lookup does not compile. The one exception is
// `hasOfficialSkills`, which takes an `OrganizationScope`, because seeding has no
// environment and inventing one would be worse than naming the level honestly.

import type {
  CatalogueDraft,
  CataloguePage,
  CataloguePatch,
  CatalogueQuery,
  CatalogueRevision,
  CatalogueScope,
  CatalogueEntry,
  Installation,
  OrganizationScope,
  Result,
  SkillId,
  SkillIdentity,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import {
  err,
  ok,
  repositoryUnavailable,
  revisionFrom,
} from "@platos/context-skills/application/ports/index.js";

import type { TenancyJsonInput } from "./client.js";
import { jsonList } from "./client.js";
import {
  MANIFEST_NOT_OBJECT,
  PROVIDED_TOOLS_NOT_ARRAY,
  looksLikeUuid,
  requireIdentitySegment,
  requireInstant,
  requireJsonArray,
  requireJsonObject,
  requireTextList,
  requireUuid,
} from "./skills-guards.js";
import { refuseSkills } from "./skills-refusal.js";
import { SKILL_COLUMNS, readSkill, type SkillRow } from "./skills-rows.js";
import { CATALOGUE_ORDER, referenceWhere, searchWhere, visibleWhere } from "./skills-visibility.js";
import type { TenancyTransactions } from "./transaction.js";

/** How a catalogue row is stamped and identified. Supplied, never ambient. */
export interface SkillsStamps {
  now(): Date;
  skillId(): string;
  projectSkillId(): string;
  environmentSkillId(): string;
}

/**
 * The columns a registration writes, checked against what the schema will hold.
 *
 * TWO OF THE THREE JSON-ROOT CHECKS LIVE HERE. `Skill_manifest_json_root` and
 * `Skill_providesTools_json_root` are migration-only: neither appears in
 * `schema.prisma` and the in-memory double enforces neither. The third,
 * `EnvironmentSkill_config_json_root`, guards a row this file does not write and
 * is checked in `skills-installations.ts`.
 */
function revisionColumns(revision: CatalogueRevision) {
  requireJsonObject(MANIFEST_NOT_OBJECT, "Skill.manifest", revision.manifest);
  requireJsonArray(PROVIDED_TOOLS_NOT_ARRAY, "Skill.providesTools", revision.providesTools);
  return {
    name: revision.name,
    description: revision.description,
    author: revision.author,
    origin: revision.origin,
    isOfficial: revision.isOfficial,
    tags: [...requireTextList("Skill.tags", revision.tags)],
    source: revision.source,
    manifest: revision.manifest as unknown as TenancyJsonInput,
    promptBlock: revision.promptBlock,
    providesTools: jsonList(revision.providesTools),
    requiredEnvironmentKeys: [
      ...requireTextList("Skill.requiredEnvironmentKeys", revision.requiredEnvironmentKeys),
    ],
    optionalEnvironmentKeys: [
      ...requireTextList("Skill.optionalEnvironmentKeys", revision.optionalEnvironmentKeys),
    ],
  };
}

export function createSkillsCatalogue(transactions: TenancyTransactions, stamps: SkillsStamps) {
  return {
    async upsertSkill(
      draft: CatalogueDraft,
      transaction: TransactionScope,
    ): Promise<Result<CatalogueEntry>> {
      return refuseSkills(async () => {
        const identity = draft.identity;
        const organizationId = identity.organization.organizationId;
        requireUuid("Skill.organizationId", organizationId);
        requireIdentitySegment("Skill.slug", identity.slug);
        requireIdentitySegment("Skill.version", identity.version);
        const columns = revisionColumns(revisionFrom(draft));
        const at = requireInstant("Skill.updatedAt", stamps.now());
        const client = transactions.writer(transaction);
        const row = await client.skill.upsert({
          where: {
            organizationId_slug_version: {
              organizationId,
              slug: identity.slug,
              version: identity.version,
            },
          },
          create: {
            id: stamps.skillId(),
            organizationId,
            slug: identity.slug,
            version: identity.version,
            ...columns,
            createdAt: at,
            updatedAt: at,
          },
          update: { ...columns, updatedAt: at },
          select: SKILL_COLUMNS,
        });
        return ok(readSkill(row as SkillRow));
      }, "upsertSkill");
    },

    async findVisibleSkill(
      scope: CatalogueScope,
      skillId: SkillId,
    ): Promise<Result<CatalogueEntry | null>> {
      return refuseSkills(async () => {
        // A non-uuid id is ABSENT rather than an error, which is what the double
        // answers and what keeps the caller's transaction alive: an unguarded
        // `{ id }` would reach `uuid_in`, and the driver's raise aborts the
        // transaction the read was issued inside.
        if (!looksLikeUuid(skillId)) return ok(null);
        const row = await transactions.reader().skill.findFirst({
          where: { AND: [visibleWhere(scope), { id: skillId }] },
          select: SKILL_COLUMNS,
        });
        return ok(row === null ? null : readSkill(row as SkillRow));
      }, "findVisibleSkill");
    },

    async findVisibleSkillByReference(
      scope: CatalogueScope,
      reference: string,
    ): Promise<Result<CatalogueEntry | null>> {
      return refuseSkills(async () => {
        // ONE statement for both arms, ordered by the catalogue's own comparison,
        // so the "highest version wins" rule the port states for a slug is the
        // ordering rather than a second query. `orderBy` is what makes the answer
        // the highest version; `findFirst` is what makes it one row.
        const row = await transactions.reader().skill.findFirst({
          where: { AND: [visibleWhere(scope), referenceWhere(reference)] },
          orderBy: [...CATALOGUE_ORDER],
          select: SKILL_COLUMNS,
        });
        return ok(row === null ? null : readSkill(row as SkillRow));
      }, "findVisibleSkillByReference");
    },

    async findSkillByIdentity(identity: SkillIdentity): Promise<Result<CatalogueEntry | null>> {
      return refuseSkills(async () => {
        // NOT scope-filtered, and the port says so: this is the upsert path's
        // own lookup, which has to see the row it is about to land on even when
        // no environment has installed it.
        if (!looksLikeUuid(identity.organization.organizationId)) return ok(null);
        const row = await transactions.reader().skill.findUnique({
          where: {
            organizationId_slug_version: {
              organizationId: identity.organization.organizationId,
              slug: identity.slug,
              version: identity.version,
            },
          },
          select: SKILL_COLUMNS,
        });
        return ok(row === null ? null : readSkill(row as SkillRow));
      }, "findSkillByIdentity");
    },

    async listVisibleSkills(scope: CatalogueScope): Promise<Result<readonly CatalogueEntry[]>> {
      return refuseSkills(async () => {
        const rows = await transactions.reader().skill.findMany({
          where: visibleWhere(scope),
          orderBy: [...CATALOGUE_ORDER],
          select: SKILL_COLUMNS,
        });
        return ok(rows.map((row) => readSkill(row as SkillRow)));
      }, "listVisibleSkills");
    },

    async findSkillsForInstallations(
      scope: CatalogueScope,
      installations: readonly Installation[],
    ): Promise<Result<readonly CatalogueEntry[]>> {
      return refuseSkills(async () => {
        // The set is taken from the PROJECT half of each install, because that is
        // the row that carries `skillId`; the environment half is keyed by the
        // project row's id and names no skill at all.
        const wanted = [
          ...new Set(
            installations
              .map((installation) => installation.project.skillId as string)
              .filter((skillId) => looksLikeUuid(skillId)),
          ),
        ];
        if (wanted.length === 0) return ok([]);
        // Still VISIBILITY-FILTERED, and that is the point rather than belt and
        // braces: a caller holding an install it resolved under one scope must
        // not be able to read another organization's catalogue row by handing it
        // back under a different one.
        const rows = await transactions.reader().skill.findMany({
          where: { AND: [visibleWhere(scope), { id: { in: wanted } }] },
          orderBy: [...CATALOGUE_ORDER],
          select: SKILL_COLUMNS,
        });
        return ok(rows.map((row) => readSkill(row as SkillRow)));
      }, "findSkillsForInstallations");
    },

    async pageVisibleSkills(
      scope: CatalogueScope,
      query: CatalogueQuery,
    ): Promise<Result<CataloguePage>> {
      return refuseSkills(async () => {
        const where = { AND: [visibleWhere(scope), searchWhere(query.search)] };
        const reader = transactions.reader();
        // Two statements, issued together. The total is of the FILTER and not of
        // the window — a caller paging on a windowed total would never reach the
        // last page — so it cannot be derived from the rows this read returned.
        const [rows, total] = await Promise.all([
          reader.skill.findMany({
            where,
            orderBy: [...CATALOGUE_ORDER],
            select: SKILL_COLUMNS,
            skip: query.offset,
            take: query.limit,
          }),
          reader.skill.count({ where }),
        ]);
        return ok({ items: rows.map((row) => readSkill(row as SkillRow)), total });
      }, "pageVisibleSkills");
    },

    async hasOfficialSkills(organization: OrganizationScope): Promise<Result<boolean>> {
      return refuseSkills(async () => {
        if (!looksLikeUuid(organization.organizationId)) return ok(false);
        // `findFirst` rather than `count`, because the question is EXISTENCE and
        // a count of every official row in the organization is work the answer
        // does not need. This runs on the lazy-seeding path, before every read.
        const row = await transactions.reader().skill.findFirst({
          where: { organizationId: organization.organizationId, isOfficial: true },
          select: { id: true },
        });
        return ok(row !== null);
      }, "hasOfficialSkills");
    },

    async patchSkill(
      skillId: SkillId,
      patch: CataloguePatch,
      transaction: TransactionScope,
    ): Promise<Result<CatalogueEntry>> {
      return refuseSkills(async () => {
        const absent = err<CatalogueEntry>(repositoryUnavailable(`no such skill ${skillId}`));
        if (!looksLikeUuid(skillId)) return absent;
        const at = requireInstant("Skill.updatedAt", stamps.now());
        const data = {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.tags === undefined ? {} : { tags: [...requireTextList("Skill.tags", patch.tags)] }),
          updatedAt: at,
        };
        // NOT scope-filtered, and that is a TRANSCRIPTION rather than an
        // endorsement. `domain/installation.ts` records that the live
        // `updateSkill` gates only on visibility while `remove` also gates on
        // `isOfficial: false`, and says the asymmetry is preserved deliberately
        // so the decision has one place to be revisited. Adding a scope here
        // would be a behaviour change smuggled in as a boundary extraction.
        //
        // `updateManyAndReturn` and not `update`, because `update` RAISES P2025
        // when nothing matched — and a raise inside the caller's transaction
        // aborts it, so the caller would lose the transaction along with the
        // answer the port says is an ordinary refusal.
        const rows = await transactions.writer(transaction).skill.updateManyAndReturn({
          where: { id: skillId },
          data,
          select: SKILL_COLUMNS,
        });
        const row = rows[0];
        if (row === undefined) return absent;
        return ok(readSkill(row as SkillRow));
      }, "patchSkill");
    },
  };
}
