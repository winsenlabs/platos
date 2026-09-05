// What PostgreSQL refuses, named — and the reason every one of those refusals
// has to be caught inside a SAVEPOINT.
//
// THE SAVEPOINT IS NOT TIDINESS. It is the finding this tranche exists to
// record, and it was measured rather than reasoned about.
//
//   A statement that violates a constraint inside an interactive transaction
//   ABORTS that transaction. Every later statement then fails, and the COMMIT
//   the client sends at the end is executed by PostgreSQL as a ROLLBACK — with
//   no error. So a repository method that catches a unique violation and returns
//   `err(agentAlreadyExists(...))`, which is exactly what this context's
//   in-memory double does, would hand the caller a business outcome while
//   silently discarding every write the caller had already made in the same
//   transaction. Measured on a real container: `$transaction` RESOLVED and the
//   row written immediately before the refused one was NOT there afterwards.
//
//   Wrapping the refusable statement in `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`
//   undoes only that statement. Measured on the same container with the same
//   two writes: the earlier row IS there afterwards.
//
// SO THE COMMIT IS NOW HONEST RATHER THAN EMPTY, AND THAT IS A DIFFERENT CLAIM
// FROM "SAFE". `UnitOfWork.run` commits when its callback RESOLVES, and every
// use case in this context returns `err(...)` from inside that callback when a
// repository write refuses. With the savepoint, the writes made before the
// refusal really are committed; without it they really are not, and nobody is
// told either way. Which of the two a caller wants is the caller's decision and
// this adapter does not make it — what it removes is the outcome where the
// answer depends on whether the store happened to raise.
//
// A REFUSAL THIS MODULE DOES NOT RECOGNISE IS RETHROWN. A rejected promise is a
// defect (ADR M0.3 §4, and the port's own header), and turning an unrecognised
// SQLSTATE into `repositoryUnavailable` would file every future constraint under
// one code that nothing can tell apart.

import type { DomainError, Result } from "@platos/context-agents/application/ports/index.js";
import { err, ok, repositoryUnavailable } from "@platos/context-agents/application/ports/index.js";

import type { TenancyTransactionClient } from "./client.js";

/**
 * The `reason` each refusal carries on `AGENTS_REPOSITORY_UNAVAILABLE`.
 *
 * The context publishes ONE code for a store refusal, so the reason is the only
 * thing that tells two of them apart. Four of these are spelled exactly as the
 * in-memory double spells them, because the shared conformance scenario compares
 * the two stores' observations verbatim and a store that renamed a reason would
 * be reporting a different outcome for the same event.
 */
export const AGENT_MISSING = "agent_missing";
export const BINDING_MISSING = "binding_missing";
export const BINDING_ALREADY_EXISTS = "binding_already_exists";
export const CLUSTER_MISSING = "cluster_missing";
export const DUPLICATE_ENVIRONMENT_SKILL = "duplicate_environment_skill_in_loadout";

/** Refusals only a real database can produce. Each is distinct, on purpose. */
export const OWNER_KEY_IMMUTABLE = "owner_key_immutable";
export const CROSSES_OWNER_ANCESTRY = "crosses_owner_ancestry";
export const CANARY_PERCENT_OUT_OF_RANGE = "canary_percent_out_of_range";
export const ENVIRONMENT_SKILL_UNKNOWN = "environment_skill_unknown";
export const MACRO_NAME_TAKEN = "macro_name_taken";
export const TEMPLATE_NAME_TAKEN = "template_name_taken";
export const VERSION_STILL_SERVED = "version_still_served";
export const BINDING_MOVED = "binding_moved_underneath";
export const CLUSTER_STILL_HELD = "cluster_still_held";

/** PostgreSQL SQLSTATEs this adapter recognises, by name rather than by digit. */
export const UNIQUE_VIOLATION = "23505";
export const FOREIGN_KEY_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";

// THE SAME REFUSAL REACHES THIS ADAPTER IN THREE DIFFERENT SHAPES, and all three
// were read off a real container rather than guessed:
//
//   a delegate call whose violation the client KNOWS  -> `code` is `P2002`/`P2003`
//     and `meta.target` names the columns;
//   a delegate call whose violation it does not      -> `code` is undefined and
//     the driver's `PostgresError { code: "23514", message: "…" }` is inside the
//     message text — which is how EVERY rule the migrations install arrives;
//   a raw statement                                  -> `code` is `P2010` and
//     `meta` carries `{ code, message }` directly.
//
// Reading only the first shape would have made every ancestry and immutability
// rule invisible, and reading only `code` would have filed all three under one
// answer.
const SQLSTATE_PATTERN = /PostgresError \{ code: "([0-9A-Z]{5})"/u;
const RAISED_MESSAGE_PATTERN = /PostgresError \{ code: "[0-9A-Z]{5}", message: "([^"]*)"/u;

function textOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function metaOf(error: unknown): Readonly<Record<string, unknown>> {
  if (typeof error !== "object" || error === null) return {};
  const meta = (error as { readonly meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return {};
  return meta as Readonly<Record<string, unknown>>;
}

/** The SQLSTATE behind a client error, in whichever of the three shapes it came. */
export function sqlstateOf(error: unknown): string | null {
  const code = codeOf(error);
  if (code === "P2002") return UNIQUE_VIOLATION;
  if (code === "P2003") return FOREIGN_KEY_VIOLATION;
  const raw = metaOf(error)["code"];
  if (typeof raw === "string") return raw;
  return SQLSTATE_PATTERN.exec(textOf(error))?.[1] ?? null;
}

/** The message a migration's rule raised, when the refusal came from one. */
export function raisedMessageOf(error: unknown): string {
  const raw = metaOf(error)["message"];
  if (typeof raw === "string") return raw;
  return RAISED_MESSAGE_PATTERN.exec(textOf(error))?.[1] ?? "";
}

/**
 * True when a refusal names this constraint, index or column tuple.
 *
 * `meta.target` is the COLUMN LIST for a known unique violation — `["projectId",
 * "slug"]`, not the index name — so both spellings are matched. A caller that
 * compared only the index name would never have told two unique violations on
 * one table apart, and `PostmanTemplate` has one three-column index and one
 * single-column one.
 */
export function namesConstraint(error: unknown, constraint: string): boolean {
  const target = metaOf(error)["target"];
  if (typeof target === "string" && target === constraint) return true;
  if (Array.isArray(target) && target.join(",") === constraint) return true;
  return `${textOf(error)} ${raisedMessageOf(error)}`.includes(constraint);
}

/**
 * The two rules `reject_canonical_owner_change` and `enforce_domain_ancestry`
 * raise, told apart by the text they raise with.
 *
 * They share SQLSTATE `23514` with every CHECK constraint in the schema, which
 * is why the text is read at all: `AgentBinding_canaryPercent_check` and
 * "AgentBinding crosses its canonical owner ancestry" are two different defects
 * and a caller that could not tell them apart would retry the wrong one.
 */
export function checkRefusal(error: unknown): string | null {
  const raised = raisedMessageOf(error);
  if (raised.includes("crosses its canonical owner ancestry")) return CROSSES_OWNER_ANCESTRY;
  if (raised.includes("is immutable")) return OWNER_KEY_IMMUTABLE;
  if (namesConstraint(error, "AgentBinding_canaryPercent_check")) return CANARY_PERCENT_OUT_OF_RANGE;
  return null;
}

/** A refusal reason, as the domain error every store method returns. */
export function refused(reason: string): DomainError {
  return repositoryUnavailable(reason);
}

let savepoints = 0;

/**
 * Run one refusable statement so its refusal costs the caller's transaction
 * nothing else.
 *
 * `classify` decides which refusals are OUTCOMES. It answers `null` for anything
 * it does not recognise, and an unrecognised refusal is rethrown with the
 * savepoint already rolled back — so a defect still reaches the caller as a
 * rejected promise, and still rolls the whole transaction back through
 * `UnitOfWork.run`, exactly as it would without a savepoint.
 *
 * THREE STATEMENTS, NOT ONE. `SAVEPOINT`, the write, and then `RELEASE SAVEPOINT`
 * or `ROLLBACK TO SAVEPOINT`. That cost is on WRITES only and is pinned as such;
 * the reads this package measures for N+1 are untouched by it.
 */
export async function refusable<Value>(
  client: TenancyTransactionClient,
  work: () => Promise<Value>,
  classify: (error: unknown) => DomainError | null,
): Promise<Result<Value>> {
  savepoints += 1;
  const name = `agents_sp_${savepoints}`;
  await client.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const value = await work();
    await client.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return ok(value);
  } catch (error) {
    await client.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    const refusal = classify(error);
    if (refusal === null) throw error;
    return err(refusal);
  }
}

/**
 * Whether a string is a UUID this schema could hold, checked BEFORE it reaches a
 * uuid column.
 *
 * `Agent.id` is `@db.Uuid`, and the agent listing's search term is matched
 * against it when "the term looks like one". Handing the driver a term that is
 * not a UUID does not return no rows — it fails the whole read with
 * "Error creating UUID, invalid character", so every search for an ordinary word
 * would have been an error rather than a result. The in-memory double compares
 * the two strings in JavaScript and cannot see this at all.
 */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function looksLikeUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}
