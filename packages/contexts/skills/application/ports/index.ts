// The driven ports of the `skills` context.
//
// Four, and the split between them is by TECHNOLOGY OWNER rather than by
// convenience: the canonical store, the network fetch, the environment-key
// directory, and the confined runtime. Each has exactly one adapter, each
// adapter is the sole holder of its client, and none of them is visible from
// `domain/`.
//
// This barrel is published as its own package entrypoint
// (`./application/ports/index.js`) because an adapter must import the interface
// it implements. ADR M0.3 §13 makes adapter-facing ports context-owned rather
// than kernel-hosted: they belong to the context whose capability they serve,
// and living under `packages/adapters/` does not move ownership.
//
// The context-FACING surface is `contracts/`, and these do not appear there. A
// peer context has no business holding this context's repository.
export * from "./skills-repository.js";
export * from "./skill-source-fetcher.js";
export * from "./environment-key-directory.js";
export * from "./skill-sandbox.js";

// WIN-258 T5 — the domain values `SkillsRepository`'s own SIGNATURES already
// name.
//
// WITHOUT THIS BLOCK THE CANONICAL-STORE PORT IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `skills-repository.ts` above imports `CatalogueDraft`,
// `CatalogueEntry`, `CataloguePatch`, `CatalogueScope`, `Installation` and six
// more from `../../domain/*.js` as TYPES and re-exports none of them;
// `contracts/index.ts` publishes the flattened VIEWS instead, on purpose,
// because a peer context has no business holding a stored manifest. So every
// method was declared in terms of names an ADAPTER package — the only kind of
// package ADR M0.3 §2 permits to implement a driven port — had no way to spell.
// The same omission has now been found five times on this issue: `EndUserStore`,
// `SessionRevocationOrder`, `cost-monitoring`'s whole aggregate set, `secrets`'
// two, and this. It is repaired the same way each time — the port entry point
// publishes exactly what the port's own signatures use, and nothing more.
//
// THE VALUE EXPORTS ARE HERE FOR A STRONGER REASON THAN THE TYPES.
// `SKILL_ORIGINS` and `isSkillOrigin` are the CLOSED set `Skill.origin` is read
// back through, and that column is a plain `TEXT` with no enum behind it: a
// store unable to name the set would have written its own literal list, and two
// lists over one column is how a row becomes unreadable by the release that did
// not write it. `compareCatalogueEntries` and `matchesSearch` are the ORDER and
// the FILTER a paged read has to encode in SQL, and `isVisible` is the
// three-clause predicate that decides whether one organization's rows can be
// seen from another's environment — an adapter that re-derived any of the three
// would be a second statement of a cross-tenant rule. `skillIdentityPath` is the
// one place a `(organization, slug, version)` triple becomes a key, and
// `repositoryUnavailable` is the ONE refusal `domain/errors.ts` says a store may
// answer with.
//
// THE OTHER THREE PORTS IN THIS BARREL ARE NOT SERVED BY THIS BLOCK, and that
// is deliberate rather than an oversight. `SkillSourceFetcher`, `SkillSandbox`
// and `EnvironmentKeyDirectory` name `SkillSlug`, `ToolName` and
// `EnvironmentKey` too — those three appear below because the CANONICAL STORE
// needs them — but nothing else of theirs is published here. Their adapters do
// not exist yet, and publishing a name against a port nobody implements would
// claim a boundary that is not being held.
//
// The kernel values these signatures name are republished for the reason
// `identity-access`'s, `cost-monitoring`'s and `secrets`' port entry points
// republish theirs: `Result`, `TransactionScope` and the three scope types are
// in nearly every method above, and an adapter that reached for `@platos/kernel`
// directly would be a second import edge into the kernel from a package whose
// only declared dependency is the context whose port it satisfies.
export type {
  EnvironmentScope,
  JsonValue,
  OrganizationScope,
  ProjectScope,
  Result,
  TenantScope,
  TransactionScope,
} from "@platos/kernel";
export { asIdentifier, contains, err, ok, resolvePath } from "@platos/kernel";

export type {
  CatalogueDraft,
  CatalogueEntry,
  CataloguePatch,
  CatalogueRevision,
  CatalogueScope,
  EnvironmentInstallation,
  EnvironmentKey,
  EnvironmentSkillId,
  Installation,
  ProjectInstallation,
  ProjectSkillId,
  SkillId,
  SkillIdentity,
  SkillManifest,
  SkillOrigin,
  SkillProvidedTool,
  SkillSlug,
  SkillVersion,
  ToolName,
} from "../../domain/index.js";
export {
  DEFAULT_SKILL_VERSION,
  EMPTY_SKILL_CONFIG,
  SKILL_ORIGINS,
  applyPatch,
  catalogueScope,
  compareCatalogueEntries,
  isSkillOrigin,
  isVisible,
  matchesSearch,
  organizationOf,
  repositoryUnavailable,
  revisionFrom,
  skillIdentity,
  skillIdentityPath,
} from "../../domain/index.js";
