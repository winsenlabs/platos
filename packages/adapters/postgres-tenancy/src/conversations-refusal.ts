// The one place a thrown thing becomes a `Result` for `conversations`' stores.
//
// The four ports say every method answers a `Result`; a rejected promise is a
// defect and not an outcome. Three kinds of throw reach these stores and only
// two of them are outcomes:
//
//   `ConversationsWriteRefused` — a value the canonical schema will not hold,
//   caught before any statement was sent. An outcome.
//
//   `UnreadableRowError` — a stored column this binary cannot read, which is a
//   real event during an expand/contract window and the reason
//   `conversations-rows.ts` validates rather than casts. An outcome.
//
//   `TransactionScopeError` — a write issued outside any transaction, with a
//   finished token, or with another transaction's token. NOT an outcome and
//   deliberately RETHROWN: those three refusals carry three distinct codes so
//   the three mistakes stay distinguishable, and folding them into a `Result`
//   would let an erasure that lost its transaction carry on as though a row had
//   merely failed to write.
//
// EVERYTHING ELSE IS ALSO RETHROWN, for the reason `governance-refusal.ts`
// gives: a `TypeError` in this package is a bug in this package, and reporting a
// defect as an outage is the shape of mistake that makes an incident take a day.
//
// THE ONE CODE THE CALLER SEES IS `CONVERSATIONS_REPOSITORY_UNAVAILABLE`, and
// that is the CONTEXT's decision rather than this file's. `domain/errors.ts`
// publishes it as the single store failure and `application/ports/index.ts`
// republishes it and `queueUnavailable` as the two an adapter may construct. The
// fourteen write refusals and the seven unreadable-row codes are therefore
// carried in the REASON string, distinct code first, so an operator reads them
// and a caller matches on one stable code — the same arrangement `secrets` makes
// for a sharper reason of its own.

import type { DomainError, Result } from "@platos/context-conversations/application/ports/index.js";
import {
  err,
  ok,
  repositoryUnavailable,
} from "@platos/context-conversations/application/ports/index.js";

import { ConversationsWriteRefused } from "./conversations-guards.js";
import { UnreadableRowError } from "./mapping.js";

/** True for the driver's own errors, whatever SQLSTATE they carry. */
function isDriverError(error: unknown): boolean {
  return error instanceof Error && error.name.startsWith("PrismaClient");
}

/**
 * The reason string a refusal carries.
 *
 * The distinct CODE leads, so `details.reason` begins with the code an operator
 * matches on and the human detail follows it. Two guards with one code cannot be
 * told apart in a log; two guards whose codes lead the same string can.
 */
function reasonOf(error: unknown, label: string): string {
  if (error instanceof ConversationsWriteRefused) return `${error.code}: ${error.detail}`;
  if (error instanceof UnreadableRowError) return `${error.code}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run one store method, turning the two kinds of outcome into a `Result`.
 *
 * `label` names the METHOD rather than the table, because the driver's own
 * message says which table and never says which port call sent the statement.
 */
export async function refuse<Value>(
  work: () => Promise<Result<Value>>,
  label: string,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof ConversationsWriteRefused ||
      error instanceof UnreadableRowError ||
      isDriverError(error)
    ) {
      return err(repositoryUnavailable(reasonOf(error, label)));
    }
    throw error;
  }
}

let savepoints = 0;

/**
 * Run one refusable statement so its refusal costs the caller's transaction
 * nothing else.
 *
 * WHY THIS EXISTS HERE AND NOT ONLY IN `agents-guards.ts`. On PostgreSQL a
 * violated constraint aborts the WHOLE transaction, so a `Turn` that loses the
 * `@@unique([threadId, sequence])` race would take the outbox append beside it
 * down as well — and `run-turn.ts` composes exactly that: allocate, create,
 * settle, append, in one unit of work. The in-memory double answers
 * `CONVERSATIONS_TURN_SEQUENCE_TAKEN` and carries on, and a store that answered
 * the same code over a dead transaction would be behaviourally identical for one
 * statement and catastrophically different for the next.
 *
 * `classify` decides which refusals are OUTCOMES. It answers `null` for anything
 * it does not recognise, and an unrecognised refusal is rethrown with the
 * savepoint already rolled back — so a defect still reaches the caller as a
 * rejected promise and still rolls the whole transaction back through
 * `UnitOfWork.run`, exactly as it would without a savepoint.
 *
 * THREE STATEMENTS, NOT ONE. `SAVEPOINT`, the write, then `RELEASE SAVEPOINT` or
 * `ROLLBACK TO SAVEPOINT`. That cost falls on WRITES only and is pinned as such;
 * the reads this package measures for N+1 are untouched by it.
 */
export async function refusable<Value>(
  client: { $executeRawUnsafe(text: string): Promise<number> },
  work: () => Promise<Value>,
  classify: (error: unknown) => DomainError | null,
): Promise<Result<Value>> {
  savepoints += 1;
  const name = `conversations_sp_${savepoints}`;
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
