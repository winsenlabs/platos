// The `ProjectSkill` / `EnvironmentSkill` half — an install is TWO rows at two
// levels, and every method here is written around that.
//
// THE SECOND ROW IS KEYED BY THE FIRST ROW'S ID, not by the skill. That is what
// makes an environment binding unreachable without a project adoption, what lets
// production and staging of one project hold different `config` for the same
// skill, and what makes a half-created install unrepresentable.
//
// *** TWO TRIGGERS GOVERN THESE TABLES AND NEITHER IS IN `schema.prisma` ***
//
//   ProjectSkill_ancestry      BEFORE INSERT OR UPDATE. Demands that the project
//                              and the skill share an ORGANIZATION. So adopting
//                              another organization's catalogue row is refused by
//                              the database — and the in-memory double creates
//                              it happily, because a `ProjectSkill` in the double
//                              is a record with a `skillId` in it and no tree
//                              behind it.
//
//   EnvironmentSkill_ancestry  BEFORE INSERT OR UPDATE. Demands that the
//                              environment and the project adoption share a
//                              PROJECT. So binding a sibling project's adoption
//                              is refused. The double checks `projectSkillId` and
//                              `environmentId` and nothing above either.
//
// BOTH FIRE ON UPDATE AS WELL AS ON INSERT, which is why the upserts below never
// move `projectId`, `skillId`, `environmentId` or `projectSkillId`: an UPDATE
// that touched one would put the row through the ancestry check again, and an
// UPDATE that moved `projectId` or `environmentId` would meet
// `ProjectSkill_owner_immutable` / `EnvironmentSkill_owner_immutable` first.
//
// BOTH UPSERTS RE-ENABLE AND NEITHER TOUCHES `config`. `domain/installation.ts`
// fixes both: delivery is at-least-once everywhere in this system and an
// operator clicking twice is normal, so a repeat sets `enabled: true` rather
// than failing — and a re-install is the documented way to undo a disable. The
// environment row's `config` is the tenant's own per-environment setting, so a
// re-install must not silently reset it.

import type {
  CatalogueScope,
  EnvironmentInstallation,
  EnvironmentSkillId,
  Installation,
  ProjectInstallation,
  Result,
  SkillId,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import { ok } from "@platos/context-skills/application/ports/index.js";

import type { SkillsStamps } from "./skills-catalogue.js";
import {
  CONFIG_NOT_OBJECT,
  looksLikeUuid,
  requireCoherentScope,
  requireInstant,
  requireJsonObject,
  requireUuid,
} from "./skills-guards.js";
import { refuseSkills } from "./skills-refusal.js";
import {
  ENVIRONMENT_SKILL_COLUMNS,
  PROJECT_SKILL_COLUMNS,
  readEnvironmentInstallation,
  readProjectInstallation,
  type EnvironmentSkillRow,
  type ProjectSkillRow,
} from "./skills-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** Both halves, with the environment row's project adoption hydrated. */
const INSTALLATION_SELECT = {
  ...ENVIRONMENT_SKILL_COLUMNS,
  projectSkill: { select: PROJECT_SKILL_COLUMNS },
} as const;

interface InstallationRow extends EnvironmentSkillRow {
  readonly projectSkill: ProjectSkillRow;
}

/**
 * The environment binding's WHERE, confined to the reading scope in FULL.
 *
 * The project clause is not redundant with the environment clause, and the
 * organization clause is not redundant with the project clause. Every read of
 * this table is addressed by an `EnvironmentScope` the CALLER supplied, and the
 * only thing that makes the three ids a real chain is a join that says so — the
 * database's own ancestry triggers check the rows against each other when they
 * are WRITTEN and have nothing to say about a scope produced later. The
 * in-memory double compares `organizationId` on the project half for exactly
 * this reason.
 */
function boundHere(scope: CatalogueScope) {
  return {
    environmentId: scope.environment.environmentId,
    projectSkill: {
      projectId: scope.environment.projectId,
      project: { organizationId: scope.environment.organizationId },
    },
  };
}

export function createSkillsInstallations(
  transactions: TenancyTransactions,
  stamps: SkillsStamps,
) {
  function hydrate(row: InstallationRow, scope: CatalogueScope): Installation {
    return {
      project: readProjectInstallation(row.projectSkill, scope.environment),
      environment: readEnvironmentInstallation(row, scope.environment),
    };
  }

  return {
    async upsertProjectInstallation(
      scope: CatalogueScope,
      skillId: SkillId,
      transaction: TransactionScope,
    ): Promise<Result<ProjectInstallation>> {
      return refuseSkills(async () => {
        requireCoherentScope(
          scope.environment.organizationId,
          scope.environment.projectId,
          scope.environment.environmentId,
        );
        requireUuid("ProjectSkill.skillId", skillId);
        const at = requireInstant("ProjectSkill.updatedAt", stamps.now());
        const row = await transactions.writer(transaction).projectSkill.upsert({
          where: {
            projectId_skillId: { projectId: scope.environment.projectId, skillId },
          },
          create: {
            id: stamps.projectSkillId(),
            projectId: scope.environment.projectId,
            skillId,
            enabled: true,
            createdAt: at,
            updatedAt: at,
          },
          update: { enabled: true, updatedAt: at },
          select: PROJECT_SKILL_COLUMNS,
        });
        return ok(readProjectInstallation(row as ProjectSkillRow, scope.environment));
      }, "upsertProjectInstallation");
    },

    async upsertEnvironmentInstallation(
      scope: CatalogueScope,
      project: ProjectInstallation,
      transaction: TransactionScope,
    ): Promise<Result<EnvironmentInstallation>> {
      return refuseSkills(async () => {
        requireCoherentScope(
          scope.environment.organizationId,
          scope.environment.projectId,
          scope.environment.environmentId,
        );
        requireUuid("EnvironmentSkill.projectSkillId", project.projectSkillId);
        // The column default is `'{}'` behind `EnvironmentSkill_config_json_root`,
        // and the create below writes that literal. The guard stands over the
        // value the DEFAULT names rather than over a caller's, because this
        // method has no config parameter — which is precisely why it is easy to
        // change the create to something else and lose the only check there is.
        requireJsonObject(CONFIG_NOT_OBJECT, "EnvironmentSkill.config", {});
        const at = requireInstant("EnvironmentSkill.updatedAt", stamps.now());
        const row = await transactions.writer(transaction).environmentSkill.upsert({
          where: {
            environmentId_projectSkillId: {
              environmentId: scope.environment.environmentId,
              projectSkillId: project.projectSkillId,
            },
          },
          create: {
            id: stamps.environmentSkillId(),
            environmentId: scope.environment.environmentId,
            projectSkillId: project.projectSkillId,
            enabled: true,
            config: {},
            createdAt: at,
            updatedAt: at,
          },
          update: { enabled: true, updatedAt: at },
          select: ENVIRONMENT_SKILL_COLUMNS,
        });
        return ok(readEnvironmentInstallation(row as EnvironmentSkillRow, scope.environment));
      }, "upsertEnvironmentInstallation");
    },

    async findInstallation(
      scope: CatalogueScope,
      skillId: SkillId,
    ): Promise<Result<Installation | null>> {
      return refuseSkills(async () => {
        if (!looksLikeUuid(skillId)) return ok(null);
        const row = await transactions.reader().environmentSkill.findFirst({
          where: {
            environmentId: scope.environment.environmentId,
            projectSkill: {
              projectId: scope.environment.projectId,
              skillId,
              project: { organizationId: scope.environment.organizationId },
            },
          },
          select: INSTALLATION_SELECT,
        });
        return ok(row === null ? null : hydrate(row as InstallationRow, scope));
      }, "findInstallation");
    },

    async findInstallationById(
      scope: CatalogueScope,
      environmentSkillId: EnvironmentSkillId,
    ): Promise<Result<Installation | null>> {
      return refuseSkills(async () => {
        if (!looksLikeUuid(environmentSkillId)) return ok(null);
        const row = await transactions.reader().environmentSkill.findFirst({
          where: { id: environmentSkillId, ...boundHere(scope) },
          select: INSTALLATION_SELECT,
        });
        return ok(row === null ? null : hydrate(row as InstallationRow, scope));
      }, "findInstallationById");
    },

    async findInstallationsByIds(
      scope: CatalogueScope,
      environmentSkillIds: readonly EnvironmentSkillId[],
    ): Promise<Result<readonly Installation[]>> {
      return refuseSkills(async () => {
        // A non-uuid id is dropped rather than sent, for the reason every other
        // read here guards: one bad element in an `IN` list would abort the whole
        // statement and, inside a transaction, the transaction with it. The port
        // already says a binding this scope does not cover is simply ABSENT.
        const wanted = environmentSkillIds.filter((id) => looksLikeUuid(id));
        if (wanted.length === 0) return ok([]);
        const rows = await transactions.reader().environmentSkill.findMany({
          where: { id: { in: [...wanted] }, ...boundHere(scope) },
          select: INSTALLATION_SELECT,
        });
        // ONE statement for any number of ids, and the ORDER restored to the
        // caller's. A bare `IN` answers in whatever order the plan produced, and
        // the double answers in the order it was ASKED — so a store that returned
        // the rows as they arrived would diverge from the double on a list of
        // two, silently, in a method whose whole purpose is a bulk runtime load.
        const found = new Map(rows.map((row) => [row.id, hydrate(row as InstallationRow, scope)]));
        const ordered: Installation[] = [];
        for (const id of wanted) {
          const installation = found.get(id);
          if (installation !== undefined) ordered.push(installation);
        }
        return ok(ordered);
      }, "findInstallationsByIds");
    },

    async deleteEnvironmentInstallation(
      scope: CatalogueScope,
      skillId: SkillId,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuseSkills(async () => {
        if (!looksLikeUuid(skillId)) return ok(false);
        // ONLY the environment row. The project adoption and the catalogue row
        // both survive: uninstalling from staging must not uninstall from
        // production, and neither may delete organization-wide catalogue content.
        // `deleteMany` and not `delete`, because `delete` raises when nothing
        // matched and the port's answer for that is `false`.
        const outcome = await transactions.writer(transaction).environmentSkill.deleteMany({
          where: {
            environmentId: scope.environment.environmentId,
            projectSkill: {
              projectId: scope.environment.projectId,
              skillId,
              project: { organizationId: scope.environment.organizationId },
            },
          },
        });
        return ok(outcome.count > 0);
      }, "deleteEnvironmentInstallation");
    },
  };
}
