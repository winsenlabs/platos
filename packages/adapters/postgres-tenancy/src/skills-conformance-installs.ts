// The second half of the shared scenario: the two install rows, the visibility
// rule they switch on, the paged read, the patch and the erasure.
//
// IT IS A SECOND MODULE AND NOT A SECOND SCENARIO. It writes into the SAME
// observation map, through the SAME `outcome` projection, driven from
// `runSkillsConformance`. The split is `max-file-lines`' doing and the seam is
// real: everything in `skills-conformance.ts` is a question about the CATALOGUE,
// which is organization-scoped, and everything here is a question about an
// INSTALL, which is not.
//
// THE STAGING READS ARE THE POINT OF THE WHOLE FILE. `domain/visibility.ts`
// requires a skill to be adopted in THIS project AND bound in THIS environment,
// and warns that "checking only the project half would leak a staging-only skill
// into production". A store that dropped the environment conjunct passes every
// case in this scenario except those three.

import type {
  CatalogueEntry,
  CatalogueScope,
  EnvironmentSkillId,
  Installation,
  ProjectInstallation,
  SkillId,
} from "@platos/context-skills/application/ports/index.js";
import { asIdentifier } from "@platos/context-skills/application/ports/index.js";
import { runResult } from "@platos/kernel";

import {
  CONFORMANCE_ANONYMISED,
  CONFORMANCE_AUTHOR,
  conformanceDraft,
  conformanceIdentity,
  describeEntry,
  describeOrder,
  outcome,
  type SkillsConformanceEnvironment,
  type SkillsObservation,
} from "./skills-conformance.js";

interface Slugs {
  readonly custom: string;
  readonly official: string;
  readonly customSkillId: SkillId | null;
}

/**
 * A minted identifier, replaced by the NAME of the row it belongs to.
 *
 * WHY NO OBSERVATION MAY CARRY A MINTED ID. `Skill.id`, `ProjectSkill.id` and
 * `EnvironmentSkill.id` are minted by the store, and the two stores mint from
 * different sources: the double from an injected sequence, PostgreSQL's adapter
 * from `crypto.randomUUID`. Comparing either literally compares the two id
 * SOURCES and fails on every run for a reason that is not a divergence — which
 * it did, on the first container run, at `upsertProjectInstallation.first`.
 *
 * Masking them out would have been the wrong repair: the identity of the row a
 * pointer points AT is exactly what a store can get wrong, and a projection that
 * dropped it would have stopped watching the column that matters. So an id is
 * replaced by the name of the row it was learned as, and an id nobody has named
 * reads as `<unnamed>` — which is a value the expected side never holds, so a
 * pointer to the wrong row still fails, and it fails naming the step.
 */
function labeller() {
  const named = new Map<string, string>();
  return {
    name(id: string | null, label: string): void {
      if (id !== null) named.set(id, label);
    },
    of(id: string | null): string | null {
      if (id === null) return null;
      return named.get(id) ?? "<unnamed>";
    },
  };
}

type Labels = ReturnType<typeof labeller>;

function describeProject(
  installation: ProjectInstallation,
  labels: Labels,
): Record<string, unknown> {
  return {
    level: installation.scope.level,
    organizationId: installation.scope.organizationId,
    projectId: installation.scope.projectId,
    skillId: labels.of(installation.skillId),
    projectSkillId: labels.of(installation.projectSkillId),
    enabled: installation.enabled,
    createdAtNotAfterUpdatedAt:
      installation.createdAt.getTime() <= installation.updatedAt.getTime(),
  };
}

function describeInstallation(installation: Installation | null, labels: Labels): unknown {
  if (installation === null) return null;
  return {
    project: describeProject(installation.project, labels),
    environment: {
      level: installation.environment.scope.level,
      environmentId: installation.environment.scope.environmentId,
      environmentSkillId: labels.of(installation.environment.environmentSkillId),
      projectSkillId: labels.of(installation.environment.projectSkillId),
      enabled: installation.environment.enabled,
      config: installation.environment.config,
    },
    // The pairing itself, which is the one invariant `domain/installation.ts`
    // calls structural: the environment row is keyed by the PROJECT ROW'S id.
    keyedByProjectRow:
      installation.environment.projectSkillId === installation.project.projectSkillId,
  };
}

export async function runSkillsInstallConformance(
  environment: SkillsConformanceEnvironment,
  observed: SkillsObservation,
  slugs: Slugs,
): Promise<void> {
  const { repository, scope, staging, ids } = environment;
  const customSkillId = slugs.customSkillId ?? asIdentifier<SkillId>(ids.missingSkillId);
  const labels = labeller();
  labels.name(customSkillId, "skill:custom");
  labels.name(ids.missingSkillId, "missing:skill");
  labels.name(ids.missingEnvironmentSkillId, "missing:environmentSkill");

  // ----------------------------------------------------------- the install
  const project = await runResult(environment, (transaction) =>
    repository.upsertProjectInstallation(scope, customSkillId, transaction),
  );
  const projectRow = project.ok ? project.value : null;
  const projectSkillId = projectRow?.projectSkillId ?? null;
  labels.name(projectSkillId, "install:project");
  observed["upsertProjectInstallation.first"] = outcome(project, (row) =>
    describeProject(row, labels),
  );

  const binding =
    projectRow === null
      ? null
      : await runResult(environment, (transaction) =>
          repository.upsertEnvironmentInstallation(scope, projectRow, transaction),
        );
  const environmentSkillId =
    binding !== null && binding.ok ? binding.value.environmentSkillId : null;
  labels.name(environmentSkillId, "install:environment");
  observed["upsertEnvironmentInstallation.first"] =
    binding === null
      ? { ok: false, code: "no-project-row", category: "scenario", hasReason: false }
      : outcome(binding, (row) => ({
          level: row.scope.level,
          environmentId: row.scope.environmentId,
          environmentSkillId: labels.of(row.environmentSkillId),
          projectSkillId: labels.of(row.projectSkillId),
          enabled: row.enabled,
          config: row.config,
          keyedByProjectRow: row.projectSkillId === projectSkillId,
        }));

  observed["findInstallation.afterInstall"] = outcome(
    await repository.findInstallation(scope, customSkillId),
    (installation) => describeInstallation(installation, labels),
  );
  observed["findVisibleSkill.afterInstall"] = outcome(
    await repository.findVisibleSkill(scope, customSkillId),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );

  // THE THREE CONJUNCT WITNESSES. `staging` is a second environment of the SAME
  // project: the skill IS adopted there and is NOT bound there.
  observed["findInstallation.fromStaging"] = outcome(
    await repository.findInstallation(staging, customSkillId),
    (installation) => describeInstallation(installation, labels),
  );
  observed["findVisibleSkill.fromStaging"] = outcome(
    await repository.findVisibleSkill(staging, customSkillId),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );
  observed["findVisibleSkill.fromForeignOrganization"] = outcome(
    await repository.findVisibleSkill(environment.foreign, customSkillId),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );

  // BOTH UPSERTS RE-ENABLE AND NEITHER MINTS A SECOND ROW.
  const projectRepeat = await runResult(environment, (transaction) =>
    repository.upsertProjectInstallation(scope, customSkillId, transaction),
  );
  observed["upsertProjectInstallation.repeat"] = outcome(projectRepeat, (row) => ({
    ...describeProject(row, labels),
    sameRow: row.projectSkillId === projectSkillId,
  }));
  const bindingRepeat =
    projectRow === null
      ? null
      : await runResult(environment, (transaction) =>
          repository.upsertEnvironmentInstallation(scope, projectRow, transaction),
        );
  observed["upsertEnvironmentInstallation.repeat"] =
    bindingRepeat === null
      ? null
      : outcome(bindingRepeat, (row) => ({
          enabled: row.enabled,
          config: row.config,
          sameRow: row.environmentSkillId === environmentSkillId,
        }));

  // --------------------------------------------------- resolving bindings
  const bindingId = environmentSkillId ?? asIdentifier<EnvironmentSkillId>(ids.missingEnvironmentSkillId);
  observed["findInstallationById.present"] = outcome(
    await repository.findInstallationById(scope, bindingId),
    (installation) => describeInstallation(installation, labels),
  );
  observed["findInstallationById.fromStaging"] = outcome(
    await repository.findInstallationById(staging, bindingId),
    (installation) => describeInstallation(installation, labels),
  );
  observed["findInstallationById.absent"] = outcome(
    await repository.findInstallationById(
      scope,
      asIdentifier<EnvironmentSkillId>(ids.missingEnvironmentSkillId),
    ),
    (installation) => describeInstallation(installation, labels),
  );

  // A BINDING THIS SCOPE DOES NOT COVER IS ABSENT, NEVER A PLACEHOLDER — and the
  // ORDER is the caller's, which is why the known id is asked for twice around
  // the unknown one.
  observed["findInstallationsByIds.mixed"] = outcome(
    await repository.findInstallationsByIds(scope, [
      bindingId,
      asIdentifier<EnvironmentSkillId>(ids.missingEnvironmentSkillId),
      bindingId,
    ]),
    (installations) => ({
      count: installations.length,
      environmentSkillIds: installations.map((one) =>
        labels.of(one.environment.environmentSkillId),
      ),
    }),
  );
  observed["findInstallationsByIds.empty"] = outcome(
    await repository.findInstallationsByIds(scope, []),
    (installations) => installations.length,
  );

  const resolved = await repository.findInstallation(scope, customSkillId);
  const installations: readonly Installation[] =
    resolved.ok && resolved.value !== null ? [resolved.value] : [];
  observed["findSkillsForInstallations.visible"] = outcome(
    await repository.findSkillsForInstallations(scope, installations),
    describeOrder,
  );
  observed["findSkillsForInstallations.fromStaging"] = outcome(
    await repository.findSkillsForInstallations(staging, installations),
    describeOrder,
  );

  // --------------------------------------------------------- reading pages
  observed["listVisibleSkills.afterInstall"] = outcome(
    await repository.listVisibleSkills(scope),
    describeOrder,
  );
  observed["pageVisibleSkills.firstPage"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 2, offset: 0, search: null }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  observed["pageVisibleSkills.secondPage"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 2, offset: 2, search: null }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  observed["pageVisibleSkills.pastTheEnd"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 2, offset: 99, search: null }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  // The search term is TRIMMED and case-insensitive on both sides. Padding and
  // an upper-case spelling are separate steps because a store that lower-cased
  // and did not trim would pass one of them.
  observed["pageVisibleSkills.search"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 10, offset: 0, search: "acme" }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  observed["pageVisibleSkills.searchUpperCase"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 10, offset: 0, search: "ACME" }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  observed["pageVisibleSkills.searchPadded"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 10, offset: 0, search: "  acme  " }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  observed["pageVisibleSkills.searchBlank"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 10, offset: 0, search: "   " }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );
  observed["pageVisibleSkills.searchMisses"] = outcome(
    await repository.pageVisibleSkills(scope, { limit: 10, offset: 0, search: "zzzz" }),
    (page) => ({ total: page.total, items: describeOrder(page.items) }),
  );

  // --------------------------------------------------------------- patching
  observed["patchSkill.applied"] = outcome(
    await runResult(environment, (transaction) =>
      repository.patchSkill(
        customSkillId,
        { name: "patched", tags: ["patched"] },
        transaction,
      ),
    ),
    (entry: CatalogueEntry) => ({ name: entry.name, description: entry.description, tags: [...entry.tags] }),
  );
  observed["patchSkill.empty"] = outcome(
    await runResult(environment, (transaction) => repository.patchSkill(customSkillId, {}, transaction)),
    (entry: CatalogueEntry) => ({ name: entry.name, tags: [...entry.tags] }),
  );
  observed["patchSkill.unknown"] = outcome(
    await runResult(environment, (transaction) =>
      repository.patchSkill(asIdentifier<SkillId>(ids.missingSkillId), { name: "x" }, transaction),
    ),
    (entry: CatalogueEntry) => entry.name,
  );

  // ------------------------------------------------------------ uninstalling
  observed["deleteEnvironmentInstallation.first"] = outcome(
    await runResult(environment, (transaction) =>
      repository.deleteEnvironmentInstallation(scope, customSkillId, transaction),
    ),
    (removed) => removed,
  );
  observed["deleteEnvironmentInstallation.repeat"] = outcome(
    await runResult(environment, (transaction) =>
      repository.deleteEnvironmentInstallation(scope, customSkillId, transaction),
    ),
    (removed) => removed,
  );
  observed["findVisibleSkill.afterUninstall"] = outcome(
    await repository.findVisibleSkill(scope, customSkillId),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );
  // THE PROJECT ADOPTION SURVIVED, and re-adopting proves it by RETURNING THE
  // ROW THAT WAS ALREADY THERE. Without this the delete could have cascaded and
  // every other observation would still match.
  observed["upsertProjectInstallation.afterUninstall"] = outcome(
    await runResult(environment, (transaction) =>
      repository.upsertProjectInstallation(scope, customSkillId, transaction),
    ),
    (row) => ({ enabled: row.enabled, sameRow: row.projectSkillId === projectSkillId }),
  );

  // ---------------------------------------------------------------- erasure
  //
  // ONE ROW WITH NO AUTHOR AT ALL, registered first. Without it every row in the
  // organization carries a principal, `principalId: null` selects nothing for a
  // reason that has nothing to do with the guard, and a store that dropped the
  // null check would answer zero anyway — the guard would be unfalsifiable and
  // the case below would be theatre.
  observed["upsertSkill.unauthored"] = outcome(
    await runResult(environment, (transaction) =>
      repository.upsertSkill(
        conformanceDraft(scope, "acme.anon", "1.0.0", {
          isOfficial: true,
          manifest: { author: null },
        }),
        transaction,
      ),
    ),
    (entry) => ({ slug: entry.identity.slug, author: entry.author }),
  );

  observed["countAuthoredSkills.organization"] = outcome(
    await repository.countAuthoredSkills({
      scope: { level: "organization", organizationId: scope.environment.organizationId },
      principalId: CONFORMANCE_AUTHOR,
    }),
    (count) => count,
  );
  // A PROJECT-LEVEL SELECTOR MATCHES NOTHING, because `Skill` is
  // organization-scoped and the double resolves the selector by CONTAINMENT.
  // Transcribed rather than corrected; `skills-erasure.ts` says why.
  observed["countAuthoredSkills.projectScope"] = outcome(
    await repository.countAuthoredSkills({
      scope: {
        level: "project",
        organizationId: scope.environment.organizationId,
        projectId: scope.environment.projectId,
      },
      principalId: CONFORMANCE_AUTHOR,
    }),
    (count) => count,
  );
  observed["countAuthoredSkills.noPrincipal"] = outcome(
    await repository.countAuthoredSkills({
      scope: { level: "organization", organizationId: scope.environment.organizationId },
      principalId: null,
    }),
    (count) => count,
  );
  observed["countAuthoredSkills.otherPrincipal"] = outcome(
    await repository.countAuthoredSkills({
      scope: { level: "organization", organizationId: scope.environment.organizationId },
      principalId: "somebody-else",
    }),
    (count) => count,
  );

  observed["anonymizeAuthoredSkills.applied"] = outcome(
    await runResult(environment, (transaction) =>
      repository.anonymizeAuthoredSkills(
        {
          scope: { level: "organization", organizationId: scope.environment.organizationId },
          principalId: CONFORMANCE_AUTHOR,
        },
        transaction,
      ),
    ),
    (count) => count,
  );
  // BOTH PLACES THE NAME LIVED. The column AND the stored manifest, because the
  // frontmatter carries the author too and a store that overwrote only the
  // column would leave the name legible in the JSON.
  observed["findSkillByIdentity.afterErasure"] = outcome(
    await repository.findSkillByIdentity(conformanceIdentity(scope, slugs.custom, "1.0.0")),
    (entry) =>
      entry === null
        ? null
        : {
            author: entry.author,
            manifestAuthor: entry.manifest.author,
            anonymised: entry.author === CONFORMANCE_ANONYMISED,
          },
  );
  observed["countAuthoredSkills.afterErasure"] = outcome(
    await repository.countAuthoredSkills({
      scope: { level: "organization", organizationId: scope.environment.organizationId },
      principalId: CONFORMANCE_AUTHOR,
    }),
    (count) => count,
  );
  observed["anonymizeAuthoredSkills.repeat"] = outcome(
    await runResult(environment, (transaction) =>
      repository.anonymizeAuthoredSkills(
        {
          scope: { level: "organization", organizationId: scope.environment.organizationId },
          principalId: CONFORMANCE_AUTHOR,
        },
        transaction,
      ),
    ),
    (count) => count,
  );

  // The catalogue survived the erasure, which is the whole reason it is an
  // anonymisation rather than a delete.
  observed["listVisibleSkills.afterErasure"] = outcome(
    await repository.listVisibleSkills(scope),
    describeOrder,
  );
  // And an unrelated draft still registers over the anonymised row, so the
  // erasure did not leave the identity unusable.
  observed["upsertSkill.afterErasure"] = outcome(
    await runResult(environment, (transaction) =>
      repository.upsertSkill(
        conformanceDraft(scope, slugs.official, "3.0.0", { isOfficial: true }),
        transaction,
      ),
    ),
    (entry) => ({ slug: entry.identity.slug, version: entry.identity.version, author: entry.author }),
  );
}
