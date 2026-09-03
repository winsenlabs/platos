// The `ScaffoldingRepository` port — `Macro` and `PostmanTemplate`.
//
// Split from `AgentsRepository` rather than folded into it, for one reason that
// is not tidiness: these two tables are the only rows in this context that a
// SURFACE writes on its own behalf rather than as part of an agent's version
// history. A macro belongs to the operator who recorded it and outlives every
// version of every agent; a template belongs to one agent but is not part of its
// configuration. Neither participates in the version/binding invariant that
// every method on the other port has to respect, so keeping them apart is what
// stops a future method from quietly acquiring it.
//
// BOTH ARE ENVIRONMENT-SCOPED. Every read takes an `EnvironmentScope`, and an
// implementation MUST return `null` — never a row from another environment —
// when an id exists elsewhere. For macros that is the FIRST half of the
// visibility gate; the owner/shared half is a domain rule the use case applies
// to the row this port returned, because "may this caller see it" is not a
// question a store should be answering.

import type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";

import type {
  ActorId,
  AgentId,
  Macro,
  MacroId,
  PostmanTemplate,
  PostmanTemplateId,
} from "../../domain/index.js";

export interface MacroQuery {
  readonly limit: number;
  /**
   * Whose macros to return: this actor's own, plus every shared one in the
   * scope. Null means shared-only, which is what an unattributed caller sees.
   */
  readonly actorId: ActorId | null;
}

export interface TemplateQuery {
  readonly limit: number;
  readonly offset: number;
  /** Narrow to one agent. Null means every agent in the environment. */
  readonly agentId: AgentId | null;
  /** Case-insensitive substring across name and simulated user. Never empty. */
  readonly search: string | null;
}

export interface TemplatePage {
  readonly items: readonly PostmanTemplate[];
  readonly total: number;
}

export interface ScaffoldingRepository {
  // --- Macro: environment-scoped, sole-writer -------------------------------

  /**
   * The macros VISIBLE to this caller, in `byMacroOrder`.
   *
   * The store applies the cheap half of the gate — same environment, and either
   * this actor's or shared — because it is an index-backed predicate. The
   * expensive half is not a predicate at all: `macroAccessFor` decides on the
   * returned row, so a listing and a single read can never disagree about who
   * may see what.
   */
  listMacros(scope: EnvironmentScope, query: MacroQuery): Promise<Result<readonly Macro[]>>;

  /**
   * One macro in this environment, WITHOUT the owner/shared gate.
   *
   * Deliberately ungated: the use case needs the row to tell "not visible" from
   * "visible but not yours", and a store that pre-filtered would collapse those
   * two answers into one and lose the distinction the error catalogue keeps.
   */
  findMacro(scope: EnvironmentScope, macroId: MacroId): Promise<Result<Macro | null>>;

  insertMacro(macro: Macro, transaction: TransactionScope): Promise<Result<Macro>>;

  updateMacro(macro: Macro, transaction: TransactionScope): Promise<Result<Macro>>;

  deleteMacro(
    scope: EnvironmentScope,
    macroId: MacroId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  // --- PostmanTemplate: environment-scoped, sole-writer ---------------------

  findTemplate(
    scope: EnvironmentScope,
    templateId: PostmanTemplateId,
  ): Promise<Result<PostmanTemplate | null>>;

  /** One page, in `byTemplateOrder`: defaults first, then recency, then id. */
  pageTemplates(scope: EnvironmentScope, query: TemplateQuery): Promise<Result<TemplatePage>>;

  /**
   * Every template for one agent in this environment.
   *
   * Read before a promotion so the incumbents can be demoted in the same
   * transaction. Scoped by BOTH ids: the single-default invariant is per
   * `[environment, agent]`, and demoting by environment alone would clear the
   * default template of every other agent in it.
   */
  listTemplatesFor(
    scope: EnvironmentScope,
    agentId: AgentId,
  ): Promise<Result<readonly PostmanTemplate[]>>;

  insertTemplate(
    template: PostmanTemplate,
    transaction: TransactionScope,
  ): Promise<Result<PostmanTemplate>>;

  updateTemplate(
    template: PostmanTemplate,
    transaction: TransactionScope,
  ): Promise<Result<PostmanTemplate>>;

  deleteTemplate(
    scope: EnvironmentScope,
    templateId: PostmanTemplateId,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;
}
