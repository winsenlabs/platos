// The published surface of the `skills` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The two contexts
// permitted to reach it by the §1 DAG are `agents` and `conversations`, and the
// composition root wires it.
//
// It is types only. Nothing here has a runtime representation, so importing this
// module costs a consumer no code and cannot drag an implementation across a
// context boundary. The implementation is `createSkillsContract` in
// `application/`, and it is reached only through the composition root.
//
// The driven ports — `SkillsRepository`, `SkillSourceFetcher`,
// `EnvironmentKeyDirectory`, `SkillSandbox` — are NOT re-exported here. They are
// adapter-facing, not context-facing, and they are published from
// `application/ports/index.js` where their adapters import them (ADR M0.3 §13).
//
// WHAT THE SHAPE OF THIS SURFACE SAYS ABOUT THE `agents` SEAM. ADR M0.3 §7
// decision 5 gives `AgentSkill` to `agents`, so nothing here reads or writes an
// agent loadout. `bind` resolves and gates an ENVIRONMENT binding and hands back
// its id for `agents` to record; `composeRuntime` takes binding ids back and
// returns what a turn should see. That is the entire seam, and it is why the
// edge `agents -> skills` stays one-way.

import type { ErasureTarget, JsonValue, OrganizationScope, PrincipalId, Result } from "@platos/kernel";

import type {
  CatalogueScope,
  EnvironmentKey,
  EnvironmentSkillId,
  NamespacedToolName,
  SkillId,
  SkillSlug,
  SkillVersion,
} from "../domain/index.js";

// The identifier and scope vocabulary a caller needs to build a command.
// Branded types, so a slug cannot reach a row-id parameter across the boundary
// any more than it can inside it.
export type {
  CatalogueScope,
  EnvironmentKey,
  EnvironmentSkillId,
  NamespacedToolName,
  ProjectSkillId,
  SkillId,
  SkillOrigin,
  SkillSlug,
  SkillVersion,
  ToolName,
} from "../domain/index.js";

/** One tool a skill contributes, as seen from outside. */
export interface SkillToolView {
  /** The namespaced name the runtime dispatches on. */
  readonly name: NamespacedToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>> | null;
  readonly outputSchema: Readonly<Record<string, JsonValue>> | null;
  /** The skill that owns it — how a dispatch finds its way back here. */
  readonly slug: SkillSlug;
}

/**
 * A catalogue row, as seen from outside.
 *
 * `envReady` is three-valued and the third value is not decoration: `null` means
 * readiness was not evaluated, which is the honest answer for a row read outside
 * any environment. A caller must not collapse it to `false`, which would paint
 * every freshly seeded skill as broken.
 */
export interface SkillView {
  readonly skillId: SkillId;
  readonly slug: SkillSlug;
  readonly version: SkillVersion;
  readonly name: string;
  readonly description: string;
  readonly author: string | null;
  readonly origin: string;
  readonly isOfficial: boolean;
  readonly tags: readonly string[];
  readonly category: string;
  readonly promptBlock: string;
  readonly providesTools: readonly SkillToolView[];
  readonly requiredEnvironmentKeys: readonly EnvironmentKey[];
  readonly optionalEnvironmentKeys: readonly EnvironmentKey[];
  readonly envReady: boolean | null;
  /** Per-key presence for the REQUIRED keys, so a surface can say which. */
  readonly environmentKeyPresence: Readonly<Record<string, boolean>>;
  readonly importedFrom: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillPageView {
  readonly items: readonly SkillView[];
  readonly total: number;
}

/** An environment binding, and the skill it points at. */
export interface SkillBindingView {
  readonly environmentSkillId: EnvironmentSkillId;
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly skill: SkillView;
}

export interface SkillUninstallView {
  readonly uninstalled: boolean;
  /** The stable code explaining a refusal, or null when there was none. */
  readonly refusedBecause: string | null;
}

/** Why a requested binding did not reach the turn. */
export type SkillSkipReason = "unresolved" | "disabled" | "environment-not-ready";

export interface SkippedSkillView {
  readonly environmentSkillId: EnvironmentSkillId;
  readonly reason: SkillSkipReason;
}

/**
 * What a turn should see.
 *
 * `admitted` is a PREFIX of what was requested when `truncated` is true: the
 * character budget stops at the first block that will not fit rather than
 * looking for a smaller one, so the outcome is stable and explicable.
 */
export interface SkillRuntimeView {
  readonly promptBlock: string;
  /** `basePrompt` and `promptBlock`, joined. */
  readonly systemPrompt: string;
  readonly tools: readonly SkillToolView[];
  readonly admitted: readonly SkillSlug[];
  readonly omitted: readonly SkillSlug[];
  readonly truncated: boolean;
  readonly skipped: readonly SkippedSkillView[];
}

/** What a sandboxed run cost. `costCents` null means unknown, NOT free. */
export interface SkillToolUsageView {
  readonly inputUnits: number | null;
  readonly outputUnits: number | null;
  readonly costCents: number | null;
  readonly latencyMillis: number;
}

export interface SkillToolResultView {
  readonly result: JsonValue;
  readonly usage: SkillToolUsageView;
}

export interface SkillSeedFailureView {
  readonly declaredId: SkillSlug;
  readonly code: string;
  readonly message: string;
}

export interface SkillSeedView {
  readonly seeded: readonly SkillView[];
  /** Bundled sources that did not seed. One bad source never costs the others. */
  readonly failed: readonly SkillSeedFailureView[];
}

export interface RequestSkillCatalogue {
  readonly scope: CatalogueScope;
}

export interface RequestSkillPage {
  readonly scope: CatalogueScope;
  readonly limit: number;
  readonly offset: number;
  readonly search?: string | null;
}

export interface RequestSkill {
  readonly scope: CatalogueScope;
  /** A row id or a slug. A slug resolves to its highest version. */
  readonly reference: string;
}

export interface RequestSkillRegistration {
  readonly scope: CatalogueScope;
  readonly source: string;
  /** Recorded as provenance when the source came from somewhere nameable. */
  readonly importedFrom?: string | null;
  /** `official` is unreachable: promotion happens only through seeding. */
  readonly origin?: "community" | "custom" | undefined;
}

export interface RequestSkillImport {
  readonly scope: CatalogueScope;
  readonly url: string;
}

export interface RequestSkillPatch {
  readonly scope: CatalogueScope;
  readonly reference: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface RequestSkillToolRun {
  readonly scope: CatalogueScope;
  readonly reference: string;
  readonly toolName: NamespacedToolName;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export interface RequestSkillRuntime {
  readonly scope: CatalogueScope;
  /** The bindings the loadout has switched on, in loadout order. */
  readonly environmentSkillIds: readonly EnvironmentSkillId[];
  readonly basePrompt?: string | null;
}

export interface RequestOfficialSeeding {
  readonly organization: OrganizationScope;
  readonly sources: readonly { readonly declaredId: SkillSlug; readonly source: string }[];
  /** When true, seeding is skipped if the organization already holds official rows. */
  readonly onlyIfAbsent?: boolean;
}

/**
 * The `skills` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface SkillsContract {
  readonly name: "skills";

  /** Every visible row, ordered official-first. */
  list(request: RequestSkillCatalogue): Promise<Result<readonly SkillView[]>>;

  /** One window of the visible rows, plus the unwindowed total. */
  page(request: RequestSkillPage): Promise<Result<SkillPageView>>;

  /** Resolve one row by id or slug. Invisible reads as absent, never forbidden. */
  describe(request: RequestSkill): Promise<Result<SkillView>>;

  /** Parse raw source and register it into the caller's organization. */
  register(request: RequestSkillRegistration): Promise<Result<SkillView>>;

  /** Fetch, parse and register from a URL. Always lands as `community`. */
  importFromUrl(request: RequestSkillImport): Promise<Result<SkillView>>;

  /** Edit presentation only: name, description, tags. */
  patch(request: RequestSkillPatch): Promise<Result<SkillView>>;

  /** Make a visible skill usable here: both halves of the install, enabled. */
  install(request: RequestSkill): Promise<Result<SkillBindingView>>;

  /**
   * Remove this environment's binding. The project adoption and the catalogue
   * row survive, and an official row is refused rather than silently untouched.
   */
  uninstall(request: RequestSkill): Promise<Result<SkillUninstallView>>;

  /**
   * Resolve the binding a loadout will point at, gating on environment
   * readiness. `agents` calls this, then records the agent-version link itself.
   */
  bind(request: RequestSkill): Promise<Result<SkillBindingView>>;

  /** Read a binding without creating one and without gating. */
  findBinding(request: RequestSkill): Promise<Result<SkillBindingView | null>>;

  /** Turn a set of bindings into the prompt block and tool catalogue for a turn. */
  composeRuntime(request: RequestSkillRuntime): Promise<Result<SkillRuntimeView>>;

  /** Run one skill-provided tool under confinement. */
  runTool(request: RequestSkillToolRun): Promise<Result<SkillToolResultView>>;

  /** Seed the bundled official catalogue. Idempotent; partial by design. */
  seedOfficial(request: RequestOfficialSeeding): Promise<Result<SkillSeedView>>;

  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one of these per context and injects the array
   * into `privacy` (ADR M0.3 §3).
   */
  erasureTarget(): ErasureTarget;
}

/** The principal recorded as a skill's author, for erasure selection. */
export type SkillAuthorPrincipal = PrincipalId;
