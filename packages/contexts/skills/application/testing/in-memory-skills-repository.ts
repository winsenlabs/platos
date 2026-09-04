// An in-memory `SkillsRepository`.
//
// It is a REAL implementation of the port's contract, not a stub that returns
// whatever a test wants. In particular it enforces the two properties a Postgres
// implementation would enforce with constraints, because a double that does not
// is a double that lets a broken use case pass:
//
//   THE UNIQUENESS KEY. `upsertSkill` matches on (organization, slug, version)
//     and updates in place. Registering the same manifest twice yields one row
//     with one id and a preserved `createdAt`.
//
//   VISIBILITY. Every scoped read applies `isVisible` — the same domain
//     predicate the adapter's query has to encode. A row from another
//     organization, or a non-official row with no install here, reads as null
//     rather than being filtered by the caller afterwards.
//
// `failNext` is how the unavailable paths are exercised. Without it, "the store
// is down" is unreachable in a test and every `repositoryUnavailable` branch is
// dead code that nobody has ever run.

import {
  asIdentifier,
  contains,
  err,
  ok,
  type OrganizationScope,
  type Result,
  type TransactionScope,
} from "@platos/kernel";

import {
  applyPatch,
  catalogueScope,
  compareCatalogueEntries,
  isVisible,
  matchesSearch,
  repositoryUnavailable,
  skillIdentityPath,
  EMPTY_SKILL_CONFIG,
  type CatalogueDraft,
  type CatalogueEntry,
  type CataloguePatch,
  type CatalogueScope,
  type EnvironmentInstallation,
  type EnvironmentSkillId,
  type Installation,
  type ProjectInstallation,
  type ProjectSkillId,
  type SkillId,
  type SkillIdentity,
} from "../../domain/index.js";
import type {
  CataloguePage,
  CatalogueQuery,
  SkillsErasureSelector,
  SkillsRepository,
} from "../ports/index.js";

interface Stamps {
  now(): Date;
  skillId(): SkillId;
  projectSkillId(): ProjectSkillId;
  environmentSkillId(): EnvironmentSkillId;
}

/** The author attribution an anonymised row carries. */
export const ANONYMIZED_AUTHOR = "[erased]";

export class InMemorySkillsRepository implements SkillsRepository {
  private readonly skills = new Map<string, CatalogueEntry>();
  private readonly projects: ProjectInstallation[] = [];
  private readonly environments: EnvironmentInstallation[] = [];
  /** Set to make the very next call report the store as unavailable. */
  private failure: string | null = null;

  constructor(private readonly stamps: Stamps) {}

  failNext(reason: string): void {
    this.failure = reason;
  }

  private guard<Value>(): Result<Value> | null {
    if (this.failure === null) return null;
    const reason = this.failure;
    this.failure = null;
    return err(repositoryUnavailable(reason));
  }

  allSkills(): readonly CatalogueEntry[] {
    return [...this.skills.values()];
  }

  allProjectInstallations(): readonly ProjectInstallation[] {
    return [...this.projects];
  }

  allEnvironmentInstallations(): readonly EnvironmentInstallation[] {
    return [...this.environments];
  }

  /** Seed a row directly, for tests that need a starting catalogue. */
  put(entry: CatalogueEntry): void {
    this.skills.set(skillIdentityPath(entry.identity), entry);
  }

  async upsertSkill(draft: CatalogueDraft, _transaction: TransactionScope): Promise<Result<CatalogueEntry>> {
    const failed = this.guard<CatalogueEntry>();
    if (failed !== null) return failed;
    const key = skillIdentityPath(draft.identity);
    const now = this.stamps.now();
    const existing = this.skills.get(key);
    const manifest = draft.manifest;
    const entry: CatalogueEntry = {
      // The id and the creation instant survive an update: a re-registration is
      // the same row, and a row that looks new after every edit is a row nobody
      // can audit.
      skillId: existing?.skillId ?? this.stamps.skillId(),
      identity: draft.identity,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      origin: draft.origin,
      isOfficial: draft.isOfficial,
      tags: manifest.tags,
      source: draft.source,
      manifest,
      promptBlock: draft.promptBlock,
      providesTools: manifest.provides_tools,
      requiredEnvironmentKeys: manifest.required_env,
      optionalEnvironmentKeys: manifest.optional_env,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.skills.set(key, entry);
    return ok(entry);
  }

  private installationFor(scope: CatalogueScope, skillId: SkillId): Installation | null {
    const project = this.projects.find(
      (candidate) =>
        candidate.skillId === skillId &&
        candidate.scope.projectId === scope.environment.projectId &&
        candidate.scope.organizationId === scope.environment.organizationId,
    );
    if (project === undefined) return null;
    const environment = this.environments.find(
      (candidate) =>
        candidate.projectSkillId === project.projectSkillId &&
        candidate.scope.environmentId === scope.environment.environmentId,
    );
    if (environment === undefined) return null;
    return { project, environment };
  }

  private visible(scope: CatalogueScope): CatalogueEntry[] {
    return [...this.skills.values()]
      .filter((entry) => isVisible(entry, scope, this.installationFor(scope, entry.skillId)))
      .sort(compareCatalogueEntries);
  }

  async findVisibleSkill(
    scope: CatalogueScope,
    skillId: SkillId,
  ): Promise<Result<CatalogueEntry | null>> {
    const failed = this.guard<CatalogueEntry | null>();
    if (failed !== null) return failed;
    return ok(this.visible(scope).find((entry) => entry.skillId === skillId) ?? null);
  }

  async findVisibleSkillByReference(
    scope: CatalogueScope,
    reference: string,
  ): Promise<Result<CatalogueEntry | null>> {
    const failed = this.guard<CatalogueEntry | null>();
    if (failed !== null) return failed;
    const visible = this.visible(scope);
    const byId = visible.find((entry) => entry.skillId === reference);
    if (byId !== undefined) return ok(byId);
    // A slug names a family; `visible` is already sorted with the highest
    // version first within a slug, so the first match IS the highest.
    return ok(visible.find((entry) => entry.identity.slug === reference) ?? null);
  }

  async findSkillByIdentity(identity: SkillIdentity): Promise<Result<CatalogueEntry | null>> {
    const failed = this.guard<CatalogueEntry | null>();
    if (failed !== null) return failed;
    return ok(this.skills.get(skillIdentityPath(identity)) ?? null);
  }

  async listVisibleSkills(scope: CatalogueScope): Promise<Result<readonly CatalogueEntry[]>> {
    const failed = this.guard<readonly CatalogueEntry[]>();
    if (failed !== null) return failed;
    return ok(this.visible(scope));
  }

  async pageVisibleSkills(scope: CatalogueScope, query: CatalogueQuery): Promise<Result<CataloguePage>> {
    const failed = this.guard<CataloguePage>();
    if (failed !== null) return failed;
    const matching = this.visible(scope).filter((entry) => matchesSearch(entry, query.search));
    return ok({
      items: matching.slice(query.offset, query.offset + query.limit),
      // The total is of the FILTER, not of the window. A caller paging on a
      // windowed total would never reach the last page.
      total: matching.length,
    });
  }

  async hasOfficialSkills(organization: OrganizationScope): Promise<Result<boolean>> {
    const failed = this.guard<boolean>();
    if (failed !== null) return failed;
    return ok(
      [...this.skills.values()].some(
        (entry) => entry.isOfficial && contains(organization, entry.identity.organization),
      ),
    );
  }

  async patchSkill(
    skillId: SkillId,
    patch: CataloguePatch,
    _transaction: TransactionScope,
  ): Promise<Result<CatalogueEntry>> {
    const failed = this.guard<CatalogueEntry>();
    if (failed !== null) return failed;
    for (const [key, entry] of this.skills) {
      if (entry.skillId !== skillId) continue;
      const next = { ...applyPatch(entry, patch), updatedAt: this.stamps.now() };
      this.skills.set(key, next);
      return ok(next);
    }
    return err(repositoryUnavailable(`no such skill ${skillId}`));
  }

  async upsertProjectInstallation(
    scope: CatalogueScope,
    skillId: SkillId,
    _transaction: TransactionScope,
  ): Promise<Result<ProjectInstallation>> {
    const failed = this.guard<ProjectInstallation>();
    if (failed !== null) return failed;
    const now = this.stamps.now();
    const index = this.projects.findIndex(
      (candidate) =>
        candidate.skillId === skillId && candidate.scope.projectId === scope.environment.projectId,
    );
    if (index >= 0) {
      const existing = this.projects[index];
      if (existing !== undefined) {
        const next = { ...existing, enabled: true, updatedAt: now };
        this.projects[index] = next;
        return ok(next);
      }
    }
    const created: ProjectInstallation = {
      projectSkillId: this.stamps.projectSkillId(),
      scope: {
        level: "project",
        organizationId: scope.environment.organizationId,
        projectId: scope.environment.projectId,
      },
      skillId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(created);
    return ok(created);
  }

  async upsertEnvironmentInstallation(
    scope: CatalogueScope,
    project: ProjectInstallation,
    _transaction: TransactionScope,
  ): Promise<Result<EnvironmentInstallation>> {
    const failed = this.guard<EnvironmentInstallation>();
    if (failed !== null) return failed;
    const now = this.stamps.now();
    const index = this.environments.findIndex(
      (candidate) =>
        candidate.projectSkillId === project.projectSkillId &&
        candidate.scope.environmentId === scope.environment.environmentId,
    );
    if (index >= 0) {
      const existing = this.environments[index];
      if (existing !== undefined) {
        const next = { ...existing, enabled: true, updatedAt: now };
        this.environments[index] = next;
        return ok(next);
      }
    }
    const created: EnvironmentInstallation = {
      environmentSkillId: this.stamps.environmentSkillId(),
      scope: scope.environment,
      projectSkillId: project.projectSkillId,
      enabled: true,
      config: EMPTY_SKILL_CONFIG,
      createdAt: now,
      updatedAt: now,
    };
    this.environments.push(created);
    return ok(created);
  }

  async findInstallation(
    scope: CatalogueScope,
    skillId: SkillId,
  ): Promise<Result<Installation | null>> {
    const failed = this.guard<Installation | null>();
    if (failed !== null) return failed;
    return ok(this.installationFor(scope, skillId));
  }

  async findInstallationById(
    scope: CatalogueScope,
    environmentSkillId: EnvironmentSkillId,
  ): Promise<Result<Installation | null>> {
    const failed = this.guard<Installation | null>();
    if (failed !== null) return failed;
    return ok(this.byBindingId(scope, environmentSkillId));
  }

  private byBindingId(
    scope: CatalogueScope,
    environmentSkillId: EnvironmentSkillId,
  ): Installation | null {
    const environment = this.environments.find(
      (candidate) =>
        candidate.environmentSkillId === environmentSkillId &&
        candidate.scope.environmentId === scope.environment.environmentId,
    );
    if (environment === undefined) return null;
    const project = this.projects.find(
      (candidate) => candidate.projectSkillId === environment.projectSkillId,
    );
    if (project === undefined) return null;
    return { project, environment };
  }

  async findInstallationsByIds(
    scope: CatalogueScope,
    environmentSkillIds: readonly EnvironmentSkillId[],
  ): Promise<Result<readonly Installation[]>> {
    const failed = this.guard<readonly Installation[]>();
    if (failed !== null) return failed;
    const found: Installation[] = [];
    for (const environmentSkillId of environmentSkillIds) {
      const installation = this.byBindingId(scope, environmentSkillId);
      // An id this scope does not cover is simply absent, never a placeholder.
      if (installation !== null) found.push(installation);
    }
    return ok(found);
  }

  async findSkillsForInstallations(
    scope: CatalogueScope,
    installations: readonly Installation[],
  ): Promise<Result<readonly CatalogueEntry[]>> {
    const failed = this.guard<readonly CatalogueEntry[]>();
    if (failed !== null) return failed;
    const wanted = new Set(installations.map((installation) => installation.project.skillId));
    return ok(this.visible(scope).filter((entry) => wanted.has(entry.skillId)));
  }

  async deleteEnvironmentInstallation(
    scope: CatalogueScope,
    skillId: SkillId,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const failed = this.guard<boolean>();
    if (failed !== null) return failed;
    const installation = this.installationFor(scope, skillId);
    if (installation === null) return ok(false);
    const index = this.environments.indexOf(installation.environment);
    if (index < 0) return ok(false);
    this.environments.splice(index, 1);
    // The project adoption survives on purpose: a sibling environment's binding
    // hangs off it, and removing it here would uninstall from there too.
    return ok(true);
  }

  private authored(selector: SkillsErasureSelector): CatalogueEntry[] {
    if (selector.principalId === null) return [];
    return [...this.skills.values()].filter(
      (entry) =>
        entry.author === selector.principalId && contains(selector.scope, entry.identity.organization),
    );
  }

  async countAuthoredSkills(selector: SkillsErasureSelector): Promise<Result<number>> {
    const failed = this.guard<number>();
    if (failed !== null) return failed;
    return ok(this.authored(selector).length);
  }

  async anonymizeAuthoredSkills(
    selector: SkillsErasureSelector,
    _transaction: TransactionScope,
  ): Promise<Result<number>> {
    const failed = this.guard<number>();
    if (failed !== null) return failed;
    const rows = this.authored(selector);
    for (const entry of rows) {
      this.skills.set(skillIdentityPath(entry.identity), {
        ...entry,
        author: ANONYMIZED_AUTHOR,
        // The manifest carries the author too, so overwriting only the column
        // would leave the name legible in the stored JSON.
        manifest: { ...entry.manifest, author: ANONYMIZED_AUTHOR },
        updatedAt: this.stamps.now(),
      });
    }
    return ok(rows.length);
  }
}

/** The catalogue scope for an environment, spelled once for tests. */
export function scopeFor(
  organizationId: string,
  projectId: string,
  environmentId: string,
): CatalogueScope {
  return catalogueScope({
    level: "environment",
    organizationId: asIdentifier(organizationId),
    projectId: asIdentifier(projectId),
    environmentId: asIdentifier(environmentId),
  });
}
