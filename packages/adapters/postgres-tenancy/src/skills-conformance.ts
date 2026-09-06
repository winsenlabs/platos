// One scenario, written once, so `InMemorySkillsRepository` and this adapter can
// be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts` and the
// four tranche-5 scenarios beside them, and the same reason: two independently
// written suites measure two things and agree by coincidence. This module drives
// one sequence of port calls and records what came back; a test runs it twice and
// compares verbatim. A divergence is then a named step with a value on each side.
//
// EVERY IDENTIFIER IS SUPPLIED BY THE CALLER AND EVERY ONE IS A REAL UUID. That
// is not tidiness. `Skill.id`, `Skill.organizationId`, `ProjectSkill.projectId`
// and `EnvironmentSkill.environmentId` are all `@db.Uuid`, and this context's own
// `SequenceIdGenerator` mints `id-0001` while `scopeFor("org-1", ...)` in
// `in-memory-skills-repository.ts` mints `org-1`. Both satisfy the double and
// both are refused by PostgreSQL — the second trap this issue has sprung twice
// already. The scenario uses values BOTH stores accept, so a divergence here is a
// behaviour difference rather than a shape difference; the shape refusals have
// their own named cases in `skills-constraints.integration.test.ts`.
//
// IDS AND INSTANTS ARE OBSERVED AS RELATIONSHIPS, NOT AS VALUES. The double
// mints from an injected sequence and the adapter mints real uuids off a
// monotonic clock, so comparing either literally would compare the two id
// sources rather than the two stores. What IS compared is every fact the port
// makes a promise about: that a re-registration lands on the SAME row id, that
// its `createdAt` did not move, that `updatedAt` did, and that a repeated install
// returns the id it returned the first time. Those are the claims; the digits are
// not.
//
// EVERY REFUSING CALL IS ALONE IN ITS TRANSACTION. On PostgreSQL a statement that
// violates a constraint aborts the WHOLE transaction, so a scenario that wrote a
// refused row and then carried on in the same unit of work would measure 25P02
// rather than the refusal it meant to. Every write below that can refuse avoids
// raising at all — the guards run before the statement — which is what lets the
// caller keep its transaction; the scenario is still written this way so the
// property is visible rather than assumed.
//
// NOTHING IS NORMALISED. Dates are excluded by the projection rather than
// rounded, and everything the projection does carry — booleans, counts,
// orderings, `null`-versus-absent, the stored manifest object and the `Result`
// errors themselves — compares literally.

import type {
  CatalogueDraft,
  CatalogueEntry,
  CatalogueScope,
  Result,
  SkillIdentity,
  SkillManifest,
  SkillsRepository,
  TransactionScope,
} from "@platos/context-skills/application/ports/index.js";
import {
  asIdentifier,
  skillIdentity,
} from "@platos/context-skills/application/ports/index.js";

import { runSkillsInstallConformance } from "./skills-conformance-installs.js";

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface SkillsConformanceIds {
  readonly missingSkillId: string;
  readonly missingEnvironmentSkillId: string;
  readonly foreignOrganizationId: string;
}

export type SkillsObservation = Record<string, unknown>;

export interface SkillsConformanceEnvironment {
  readonly repository: SkillsRepository;
  /** `prod` of the project under test. */
  readonly scope: CatalogueScope;
  /** A SECOND environment of the SAME project. The visibility witness. */
  readonly staging: CatalogueScope;
  /** An environment of a whole second organization. */
  readonly foreign: CatalogueScope;
  readonly ids: SkillsConformanceIds;
  /** Open one transaction. The fake's stand-in, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}

/** The author every scenario skill declares, and the subject of its erasure. */
export const CONFORMANCE_AUTHOR = "subject-a";

/** What an anonymised row's author reads as, on both stores. */
export const CONFORMANCE_ANONYMISED = "[erased]";

export function conformanceManifest(
  slug: string,
  version: string,
  overrides: Partial<SkillManifest> = {},
): SkillManifest {
  return {
    id: asIdentifier(slug),
    name: `the ${slug} skill`,
    description: "searches the web and returns citations",
    version: asIdentifier(version),
    author: CONFORMANCE_AUTHOR,
    origin: null,
    spec_version: "1",
    required_env: [asIdentifier("SEARCH_API_KEY")],
    optional_env: [asIdentifier("SEARCH_REGION")],
    provides_tools: [
      {
        name: asIdentifier("run_query"),
        description: "run one query",
        inputSchema: { type: "object" },
        outputSchema: null,
        handler: "job:search",
      },
    ],
    tags: ["search", "web"],
    importedFrom: null,
    category: "research",
    ...overrides,
  };
}

export function conformanceIdentity(
  scope: CatalogueScope,
  slug: string,
  version: string,
): SkillIdentity {
  return skillIdentity(
    { level: "organization", organizationId: scope.environment.organizationId },
    asIdentifier(slug),
    asIdentifier(version),
  );
}

export function conformanceDraft(
  scope: CatalogueScope,
  slug: string,
  version: string,
  overrides: {
    readonly isOfficial?: boolean;
    readonly manifest?: Partial<SkillManifest>;
    readonly source?: string;
    readonly promptBlock?: string;
  } = {},
): CatalogueDraft {
  const isOfficial = overrides.isOfficial ?? false;
  return {
    identity: conformanceIdentity(scope, slug, version),
    origin: isOfficial ? "official" : "custom",
    isOfficial,
    source: overrides.source ?? `---\nid: ${slug}\nversion: ${version}\n---\nuse it wisely`,
    manifest: conformanceManifest(slug, version, overrides.manifest ?? {}),
    promptBlock: overrides.promptBlock ?? "use it wisely",
  };
}

/**
 * A `Result`, reduced to what compares across two stores.
 *
 * Exported because `skills-conformance-installs.ts` records into the same map
 * and must reduce a `Result` the SAME way — a second projection written beside
 * the first is how two halves of one transcript come to disagree about what "an
 * error" looks like.
 */
export function outcome<Value>(
  result: Result<Value>,
  project: (value: Value) => unknown,
): Record<string, unknown> {
  if (result.ok) return { ok: true, value: project(result.value) };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
    // The REASON is deliberately not carried. It leads with an adapter-side code
    // (`skills.write.identifier_not_uuid` and the rest) that the double has no
    // counterpart for and no business inventing; comparing it would make every
    // refusal a divergence and force the scenario to normalise the one field
    // that is allowed to differ.
    hasReason: typeof result.error.details["reason"] === "string",
  };
}

/** A catalogue row, reduced to the columns the port makes promises about. */
export function describeEntry(entry: CatalogueEntry): Record<string, unknown> {
  return {
    slug: entry.identity.slug,
    version: entry.identity.version,
    organizationId: entry.identity.organization.organizationId,
    name: entry.name,
    description: entry.description,
    author: entry.author,
    origin: entry.origin,
    isOfficial: entry.isOfficial,
    tags: [...entry.tags],
    source: entry.source,
    promptBlock: entry.promptBlock,
    manifest: entry.manifest,
    providesTools: [...entry.providesTools],
    requiredEnvironmentKeys: [...entry.requiredEnvironmentKeys],
    optionalEnvironmentKeys: [...entry.optionalEnvironmentKeys],
    // The ORDERING of a stamped pair, which the port promises and which no id
    // comparison could catch: a store that stamped `createdAt` after `updatedAt`
    // would put a row in the future of itself.
    createdAtNotAfterUpdatedAt: entry.createdAt.getTime() <= entry.updatedAt.getTime(),
  };
}

/** The slug/version pairs of an ordered read — the catalogue ordering itself. */
export function describeOrder(entries: readonly CatalogueEntry[]): readonly string[] {
  return entries.map((entry) => `${entry.identity.slug}@${entry.identity.version}`);
}

const CUSTOM = "acme.search";
const OFFICIAL = "platos.web_search";

/**
 * Drive the whole scenario and record what came back.
 *
 * The sequence is fixed and the observations are keyed by STEP NAME, so a
 * divergence names the call rather than an index into an array.
 */
export async function runSkillsConformance(
  environment: SkillsConformanceEnvironment,
): Promise<SkillsObservation> {
  const { repository, scope, ids } = environment;
  const observed: SkillsObservation = {};

  // ------------------------------------------------------------- catalogue
  const first = await environment.run((transaction) =>
    repository.upsertSkill(conformanceDraft(scope, CUSTOM, "1.0.0"), transaction),
  );
  observed["upsertSkill.first"] = outcome(first, describeEntry);
  const firstId = first.ok ? first.value.skillId : null;
  const firstCreatedAt = first.ok ? first.value.createdAt.getTime() : null;

  const repeat = await environment.run((transaction) =>
    repository.upsertSkill(
      conformanceDraft(scope, CUSTOM, "1.0.0", {
        manifest: { name: "renamed on re-registration", tags: ["search", "renamed"] },
        source: "---\nid: acme.search\nversion: 1.0.0\n---\nrewritten body",
        promptBlock: "rewritten body",
      }),
      transaction,
    ),
  );
  observed["upsertSkill.repeat"] = outcome(repeat, (entry) => ({
    ...describeEntry(entry),
    // THE THREE CLAIMS THE PORT MAKES ABOUT A RE-REGISTRATION, as booleans
    // rather than as digits: one row, the same row, and an origin instant that
    // did not move.
    sameRow: entry.skillId === firstId,
    createdAtPreserved: entry.createdAt.getTime() === firstCreatedAt,
    updatedAtMoved: entry.updatedAt.getTime() >= entry.createdAt.getTime(),
  }));

  observed["findSkillByIdentity.present"] = outcome(
    await repository.findSkillByIdentity(conformanceIdentity(scope, CUSTOM, "1.0.0")),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );
  observed["findSkillByIdentity.absent"] = outcome(
    await repository.findSkillByIdentity(conformanceIdentity(scope, CUSTOM, "9.9.9")),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );

  // A NON-OFFICIAL ROW IS INVISIBLE UNTIL IT IS INSTALLED, which is the first
  // conjunct of `isVisible` and the one an adapter is most likely to lose.
  observed["findVisibleSkill.beforeInstall"] = outcome(
    await repository.findVisibleSkill(scope, firstId ?? asIdentifier(ids.missingSkillId)),
    (entry) => (entry === null ? null : describeEntry(entry)),
  );
  observed["listVisibleSkills.beforeInstall"] = outcome(
    await repository.listVisibleSkills(scope),
    describeOrder,
  );

  // ------------------------------------------------- the official catalogue
  observed["hasOfficialSkills.beforeSeeding"] = outcome(
    await repository.hasOfficialSkills({
      level: "organization",
      organizationId: scope.environment.organizationId,
    }),
    (value) => value,
  );

  const official = await environment.run((transaction) =>
    repository.upsertSkill(
      conformanceDraft(scope, OFFICIAL, "1.0.0", { isOfficial: true }),
      transaction,
    ),
  );
  observed["upsertSkill.official"] = outcome(official, describeEntry);

  observed["hasOfficialSkills.afterSeeding"] = outcome(
    await repository.hasOfficialSkills({
      level: "organization",
      organizationId: scope.environment.organizationId,
    }),
    (value) => value,
  );
  observed["hasOfficialSkills.foreignOrganization"] = outcome(
    await repository.hasOfficialSkills({
      level: "organization",
      organizationId: asIdentifier(ids.foreignOrganizationId),
    }),
    (value) => value,
  );

  // An official row needs NO install and is visible immediately — and only
  // inside its own organization, which the foreign read below is the witness for.
  observed["listVisibleSkills.officialOnly"] = outcome(
    await repository.listVisibleSkills(scope),
    describeOrder,
  );
  observed["listVisibleSkills.fromForeignOrganization"] = outcome(
    await repository.listVisibleSkills(environment.foreign),
    describeOrder,
  );

  // A SLUG NAMES A FAMILY, and the port says the highest version wins. Two rows
  // of one slug, both official so both visible without an install.
  await environment.run((transaction) =>
    repository.upsertSkill(
      conformanceDraft(scope, OFFICIAL, "2.0.0", { isOfficial: true }),
      transaction,
    ),
  );
  observed["findVisibleSkillByReference.slug"] = outcome(
    await repository.findVisibleSkillByReference(scope, OFFICIAL),
    (entry) => (entry === null ? null : entry.identity.version),
  );
  observed["findVisibleSkillByReference.rowId"] = outcome(
    await repository.findVisibleSkillByReference(
      scope,
      official.ok ? official.value.skillId : ids.missingSkillId,
    ),
    (entry) => (entry === null ? null : entry.identity.version),
  );
  observed["findVisibleSkillByReference.unknownSlug"] = outcome(
    await repository.findVisibleSkillByReference(scope, "nobody.here"),
    (entry) => (entry === null ? null : entry.identity.version),
  );
  observed["findVisibleSkillByReference.unknownRowId"] = outcome(
    await repository.findVisibleSkillByReference(scope, ids.missingSkillId),
    (entry) => (entry === null ? null : entry.identity.version),
  );

  await runSkillsInstallConformance(environment, observed, {
    custom: CUSTOM,
    official: OFFICIAL,
    customSkillId: firstId,
  });
  return observed;
}
