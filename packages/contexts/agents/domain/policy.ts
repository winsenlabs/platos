// The tunable limits, in one place, as data.
//
// Every value here is transcribed from the behaviour the running
// `AgentCrudService`, `AgentClusterService` and macro tool handlers already
// have. They are a POLICY VALUE passed into a use case, not a module constant
// read from an ambient environment, because a limit read from a process variable
// inside a domain rule is untestable and is exactly the coupling ADR M0.3 §2
// bans.
//
// THE DEFAULTS ARE THE SOURCE'S, INCLUDING THE ONE THAT LOOKS WRONG.
// `contextLimit` defaults to 20 in the running create path even though the
// column's own schema default is 128000. That is not a transcription slip: the
// service passes `dto.contextLimit ?? 20` and the snapshot builder repeats it,
// so an agent created through the API today is created with 20 and the column
// default is only ever seen by a row written around the service. Both numbers
// are named below so the disagreement is visible rather than buried.

export interface AgentDefaultsPolicy {
  /** The model an agent gets when the request names none and no route is default. */
  readonly model: string;
  /** `AgentVersion.maxSteps` when the request omits it. */
  readonly maxSteps: number;
  /**
   * `AgentVersion.contextLimit` when the request omits it — the SERVICE default.
   * See the note above: the column's own default is `COLUMN_CONTEXT_LIMIT`.
   */
  readonly contextLimit: number;
  /** `rolling` or `compact`. Carried inside the version's runtime envelope. */
  readonly historyMode: string;
  readonly compactThreshold: number;
  /** `direct`, `sub-agent` or `execute-tool`. */
  readonly toolMode: string;
  /** `direct` (in-process) or `durable`. */
  readonly executionMode: string;
}

export interface AgentVersionPolicy {
  /** Widest version page a caller may ask for, whatever it requests. */
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  /** Newest N versions a prune always keeps, whatever their age. */
  readonly keepNewest: number;
  /** Versions younger than this are never eligible for a prune. */
  readonly keepDays: number;
}

export interface AgentMacroPolicy {
  /** Widest macro listing a caller may ask for. */
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  /** Ceiling on the recorded step list of one macro. */
  readonly maxSteps: number;
  /** Ceiling on an operator-supplied macro name. */
  readonly maxNameLength: number;
}

export interface AgentsPolicy {
  readonly defaults: AgentDefaultsPolicy;
  readonly versions: AgentVersionPolicy;
  readonly macros: AgentMacroPolicy;
  /** Ceiling on an operator-supplied agent, cluster or template name. */
  readonly maxNameLength: number;
  /** Widest agent or cluster listing page a caller may ask for. */
  readonly maxPageSize: number;
}

/**
 * `AgentVersion.contextLimit`'s SCHEMA default, which the service never uses.
 *
 * Named so the two numbers can be compared in one place. Nothing in this package
 * reads it: it exists to make the disagreement provable rather than folklore.
 */
export const COLUMN_CONTEXT_LIMIT = 128_000;

export const DEFAULT_AGENTS_POLICY: AgentsPolicy = Object.freeze({
  defaults: Object.freeze({
    model: "anthropic:claude-sonnet-4-6",
    maxSteps: 20,
    contextLimit: 20,
    historyMode: "rolling",
    compactThreshold: 40,
    toolMode: "direct",
    executionMode: "direct",
  }),
  versions: Object.freeze({
    maxPageSize: 200,
    defaultPageSize: 50,
    keepNewest: 50,
    keepDays: 90,
  }),
  macros: Object.freeze({
    maxPageSize: 500,
    defaultPageSize: 100,
    maxSteps: 500,
    maxNameLength: 200,
  }),
  maxNameLength: 200,
  maxPageSize: 200,
});
