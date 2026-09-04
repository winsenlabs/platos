// Everything a turn must clear before a single token is bought.
//
// SIX GUARDS, SIX CODES, IN A FIXED ORDER, AND THE ORDER IS PART OF THE DESIGN.
// A request that breaches several must answer deterministically, or a test that
// deletes one guard can be rescued by another and the mutation is invisible.
//
//   1. THE GRANT     — cheapest, and everything after it reads tenant data. A
//                      request whose grant does not reach this scope must not
//                      learn whether the thread exists.
//   2. THE KILL SWITCH — an installation that has turned turns off should not be
//                      answering questions about its threads either.
//   3. THE THREAD    — present, and this end user's. Absent and somebody else's
//                      answer identically; `authorization.ts` says why.
//   4. WRITABLE      — an archived thread takes no more turns. Its own code,
//                      because an operator can un-archive and the message should
//                      say so.
//   5. IDEMPOTENCY   — before the ceiling, because a REDELIVERY of a turn that
//                      already exists must succeed even on a thread that is at
//                      its ceiling. Checking the ceiling first would make a
//                      network retry fail on a turn that was already accepted.
//   6. THE CEILING   — last, because it is the only one that needs a count.
//
// THE IDEMPOTENCY BRANCH IS THE SUBTLE ONE. `@@unique([threadId, idempotencyKey])`
// stops a second row; it cannot tell a caller which row the first delivery made,
// and it cannot tell a REDELIVERY from a caller reusing a key for different
// input. So the input is fingerprinted and compared:
//
//   same key, same input      -> the existing turn, and no second turn. Not an
//                                error, and it has no code.
//   same key, different input -> `CONVERSATIONS_TURN_IDEMPOTENCY_CONFLICT`.
//                                Answering the first turn here would hand this
//                                caller a result computed from another request.
//
// The fingerprint is a plain serialization rather than a hash: it is compared,
// never stored and never shown, so a digest would buy nothing and would need a
// port for the hashing.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  requireWritable,
  turnCeilingExceeded,
  turnIdempotencyConflict,
  turnsDisabled,
  type EndUserId,
  type IdempotencyKey,
  type Thread,
  type ThreadId,
  type Turn,
} from "../domain/index.js";
import { requireOwnedThread, verifyRuntime, type SecretsRuntimeGrant } from "./authorization.js";
import type { ConversationsDependencies } from "./dependencies.js";

export interface TurnAdmissionRequest {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  readonly threadId: ThreadId;
  /** Asserted by the transport that authenticated the session. Never verified here. */
  readonly endUserId: EndUserId;
  readonly inputText: string | null;
  readonly idempotencyKey: IdempotencyKey | null;
}

/** Either a turn to run, or the turn a previous delivery already produced. */
export type TurnAdmission =
  | { readonly kind: "admitted"; readonly thread: Thread; readonly grant: SecretsRuntimeGrant }
  | { readonly kind: "replayed"; readonly turn: Turn };

/**
 * What a turn's input amounts to, for the idempotency comparison.
 *
 * Deliberately covers the INPUT and nothing else. Two deliveries of one request
 * differ in their timestamps, their request ids and their trace headers, and
 * folding any of those in would make every redelivery look like a conflict.
 */
export function fingerprintInput(inputText: string | null): string {
  return JSON.stringify({ inputText });
}

export async function admitTurn(
  dependencies: ConversationsDependencies,
  request: TurnAdmissionRequest,
): Promise<Result<TurnAdmission>> {
  const grant = verifyRuntime(request.authorization, request.scope);
  if (!grant.ok) return err(grant.error);

  if (!dependencies.policy.turn.turnsEnabled) return err(turnsDisabled());

  const found = await dependencies.threads.findThread(request.scope, request.threadId);
  if (!found.ok) return err(found.error);
  const owned = requireOwnedThread(found.value, request.threadId, request.endUserId);
  if (!owned.ok) return err(owned.error);

  const writable = requireWritable(owned.value);
  if (!writable.ok) return err(writable.error);

  if (request.idempotencyKey !== null) {
    const existing = await dependencies.turns.findTurnByIdempotencyKey(
      request.scope,
      request.threadId,
      request.idempotencyKey,
    );
    if (!existing.ok) return err(existing.error);
    if (existing.value !== null) {
      const seen = fingerprintInput(existing.value.inputText);
      if (seen !== fingerprintInput(request.inputText)) {
        return err(turnIdempotencyConflict(request.idempotencyKey));
      }
      return ok({ kind: "replayed", turn: existing.value });
    }
  }

  const count = await dependencies.threads.countTurns(request.scope, request.threadId);
  if (!count.ok) return err(count.error);
  if (count.value >= dependencies.policy.turn.maxTurnsPerThread) {
    return err(turnCeilingExceeded(count.value, dependencies.policy.turn.maxTurnsPerThread));
  }

  return ok({ kind: "admitted", thread: writable.value, grant: grant.value });
}
