// The `SkillsRepository` port — the canonical store, seen only as an interface.
//
// ADR M0.3 §1 makes this context the SOLE WRITER of `Skill`, `ProjectSkill` and
// `EnvironmentSkill`. This port is where that ownership is expressed: every
// mutation of those three tables in the V1 system passes through one of the
// methods below, and there is deliberately no generic `save(row)` or
// `query(where)` escape hatch through which another context could reach them
// sideways.
//
// `AgentSkill` IS ABSENT, AND ITS ABSENCE IS THE POINT. ADR M0.3 §7 decision 5
// gives that row to `agents`, because a loadout is authoring. So this port can
// resolve an `EnvironmentSkill` binding and report what a set of bindings
// contains, but it cannot read or write the agent-version link. `agents` owns
// that link and calls this context for the rest, which is what keeps the edge
// `agents -> skills` one-way.
//
// EVERY READ IS SCOPED. There is no `findSkill(id)`. There is
// `findVisibleSkill(scope, id)`, and an implementation MUST return `null` — not
// a row from another organization — when the id exists elsewhere. Making the
// scope a parameter rather than an ambient means a scope-less lookup does not
// compile. The one exception is `findOfficialCatalogue`, which takes an
// `OrganizationScope`: seeding has no environment, and inventing one would be
// worse than naming the level honestly.
//
// EVERY MUTATION TAKES A `TransactionScope`. The kernel's handle is opaque by
// construction (ADR M0.3 §3: no context passes a vendor transaction handle
// across a port), which is what lets a row write and an outbox append be atomic
// without either side naming the other's technology.
//
// Every method returns `Result`. A rejected promise is a defect, not an outcome.

import type {
  EnvironmentScope,
  OrganizationScope,
  Result,
  TenantScope,
  TransactionScope,
} from "@platos/kernel";

import type {
  CatalogueDraft,
  CatalogueEntry,
  CataloguePatch,
  CatalogueScope,
  EnvironmentInstallation,
  EnvironmentSkillId,
  Installation,
  ProjectInstallation,
  SkillId,
  SkillIdentity,
} from "../../domain/index.js";

/** One page of a catalogue read. */
export interface CataloguePage {
  readonly items: readonly CatalogueEntry[];
  /** Total matching the same filter, ignoring the window. */
  readonly total: number;
}

export interface CatalogueQuery {
  readonly limit: number;
  readonly offset: number;
  readonly search: string | null;
}

/**
 * What identifies the subject of an erasure inside this context's rows.
 *
 * `scope` is a full `TenantScope`, not an `EnvironmentScope`: an erasure may be
 * addressed at an organization, and this context's rows sit at three different
 * levels of the tree, so an implementation resolves the selector by containment
 * (the kernel's `contains`) rather than by equality.
 */
export interface SkillsErasureSelector {
  readonly scope: TenantScope;
  /** Matches the principal recorded as an authored skill's author. */
  readonly principalId: string | null;
}

export interface SkillsRepository {
  // --- Skill: the catalogue rows this context writes ------------------------

  /**
   * Insert or update by `(organizationId, slug, version)`.
   *
   * Upsert, not insert: the identity triple is the uniqueness key, and
   * re-registering a manifest MUST land on the existing row. An implementation
   * MUST NOT convert a unique violation into a second row under a fresh uuid.
   */
  upsertSkill(draft: CatalogueDraft, transaction: TransactionScope): Promise<Result<CatalogueEntry>>;

  /** Resolve by row id, confined to what this scope may see. */
  findVisibleSkill(scope: CatalogueScope, skillId: SkillId): Promise<Result<CatalogueEntry | null>>;

  /**
   * Resolve by row id OR slug, confined to what this scope may see.
   *
   * A slug names a FAMILY of rows, one per version, so an implementation MUST
   * return the highest version — the same tie-break the catalogue ordering uses.
   */
  findVisibleSkillByReference(
    scope: CatalogueScope,
    reference: string,
  ): Promise<Result<CatalogueEntry | null>>;

  /** Resolve an exact identity, for the upsert path. Not scope-filtered. */
  findSkillByIdentity(identity: SkillIdentity): Promise<Result<CatalogueEntry | null>>;

  /** Every visible row, already ordered. */
  listVisibleSkills(scope: CatalogueScope): Promise<Result<readonly CatalogueEntry[]>>;

  /** One window of the visible rows, plus the unwindowed total. */
  pageVisibleSkills(scope: CatalogueScope, query: CatalogueQuery): Promise<Result<CataloguePage>>;

  /** Whether this organization holds any official row yet. Drives lazy seeding. */
  hasOfficialSkills(organization: OrganizationScope): Promise<Result<boolean>>;

  /** Apply the editable columns. Nothing outside `CataloguePatch` may move. */
  patchSkill(
    skillId: SkillId,
    patch: CataloguePatch,
    transaction: TransactionScope,
  ): Promise<Result<CatalogueEntry>>;

  // --- ProjectSkill / EnvironmentSkill: the install rows --------------------

  /** Upsert `(projectId, skillId)`, enabling it. */
  upsertProjectInstallation(
    scope: CatalogueScope,
    skillId: SkillId,
    transaction: TransactionScope,
  ): Promise<Result<ProjectInstallation>>;

  /** Upsert `(environmentId, projectSkillId)`, enabling it. */
  upsertEnvironmentInstallation(
    scope: CatalogueScope,
    project: ProjectInstallation,
    transaction: TransactionScope,
  ): Promise<Result<EnvironmentInstallation>>;

  /** Both halves for one skill in one environment, or null. */
  findInstallation(scope: CatalogueScope, skillId: SkillId): Promise<Result<Installation | null>>;

  /** Both halves, addressed by the environment-level row id. */
  findInstallationById(
    scope: CatalogueScope,
    environmentSkillId: EnvironmentSkillId,
  ): Promise<Result<Installation | null>>;

  /**
   * Resolve many bindings at once, for the runtime load.
   *
   * A binding the scope does not cover is simply absent from the result; the
   * caller compares counts and decides, which is what keeps a partial answer
   * from looking complete.
   */
  findInstallationsByIds(
    scope: CatalogueScope,
    environmentSkillIds: readonly EnvironmentSkillId[],
  ): Promise<Result<readonly Installation[]>>;

  /** The catalogue rows behind a set of environment bindings. */
  findSkillsForInstallations(
    scope: CatalogueScope,
    installations: readonly Installation[],
  ): Promise<Result<readonly CatalogueEntry[]>>;

  /**
   * Remove this environment's binding. The project adoption and the catalogue
   * row both survive: uninstalling from staging must not uninstall from
   * production, and neither may delete organization-wide catalogue content.
   */
  deleteEnvironmentInstallation(
    scope: CatalogueScope,
    skillId: SkillId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  // --- Erasure: this context's half of the kernel `ErasureTarget` -----------

  countAuthoredSkills(selector: SkillsErasureSelector): Promise<Result<number>>;

  /**
   * Overwrite the authoring attribution on this subject's rows.
   *
   * Anonymise, not delete — see `application/skills-erasure-target.ts` for why a
   * skill row must survive its author.
   */
  anonymizeAuthoredSkills(
    selector: SkillsErasureSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>>;
}

/** The environment a catalogue scope resolves to, for adapters that need it. */
export function environmentOf(scope: CatalogueScope): EnvironmentScope {
  return scope.environment;
}
