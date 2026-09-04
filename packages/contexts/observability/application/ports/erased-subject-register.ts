// Has this subject already been erased?
//
// WHY THIS PORT EXISTS AT ALL, AND WHY IT IS NOT AN IMPORT OF `privacy`.
//
// The queue is a WRITER THE ERASURE SWEEP DOES NOT WAIT FOR. An erasure clears
// the analytical store, confirms it, and verifies negatively — and an
// undelivered envelope minted before all that still holds the subject's
// `end_user_id`, display name and email. A drain landing in that window
// re-inserts every one of them into a table whose receipt already says "erased,
// verification passed".
//
// So the drain has to ask. It cannot ask `privacy`: ADR M0.3 §1 gives this
// context exactly two dependencies, `tenancy` and the kernel, and §3 keeps
// `privacy` depending on nobody's internals in either direction. The question is
// therefore a driven port, wired at the composition root over whatever holds the
// tombstone register.
//
// IT FAILS CLOSED, AND THAT IS THE WHOLE DESIGN. A lookup that cannot run
// REFUSES THE PASS rather than delivering blind. The envelopes stay queued,
// which costs a delay measured in minutes; delivering blind costs an erasure
// that has already been certified to a regulator.

import type { ErasureSubject, Result } from "@platos/kernel";

export interface ErasedSubjectQuery {
  /** The register is organization-scoped; one pass may span several tenants. */
  readonly organizationId: string;
  /** Canonical end-user ids to ask about. Never blank — a blank matches all. */
  readonly endUserIds: readonly string[];
}

export interface ErasedSubjectRegister {
  /**
   * The subset of `endUserIds` whose data this organization has erased.
   *
   * Returns the SUBSET rather than a boolean per id so one round trip answers
   * for a whole batch, and returns ids rather than a count so the caller knows
   * WHICH envelopes to discard. An `err` refuses the pass: see the header.
   */
  erasedSubjects(query: ErasedSubjectQuery): Promise<Result<readonly string[]>>;
}

/**
 * The supplementary columns a subject's rows can be found by.
 *
 * WHY THIS IS A PORT AND NOT A CONSTRUCTOR ARGUMENT.
 *
 * The kernel's `ErasureTarget.plan` takes an `ErasureSubject` and nothing else —
 * a kind, an id and a scope. But an analytical row whose `end_user_id` was
 * already blank (a system-attributed Step, a row from before the id was
 * recorded) is STILL the subject's row, and addressing it by id alone leaves it
 * behind. The thread ids and the salted subject key that reach it are discovered
 * by whoever orchestrates the erasure, and they are PER SUBJECT.
 *
 * Binding them when the target is constructed would give every subject in the
 * installation the same set — which is not a smaller answer, it is a wrong one:
 * one person's plan would enumerate another person's threads. So they are asked
 * for, per call, through this port.
 *
 * The threads belong to `conversations` and the key to `privacy`; this context
 * may import neither (ADR M0.3 §1 gives it `tenancy` and the kernel). The
 * composition root resolves it.
 */
export interface SubjectLocators {
  /** Thread ids, read while the canonical store still holds them. */
  readonly threadIds: readonly string[];
  /** Salted, organization-scoped subject keys. Content-free by construction. */
  readonly subjectKeyHashes: readonly string[];
}

export interface SubjectLocatorSource {
  /**
   * The supplementary locators for one subject.
   *
   * An `err` REJECTS the erasure rather than narrowing it. A plan built from
   * fewer locators than exist is a plan that under-reports what is held, and an
   * erasure carried out from one leaves rows behind while the receipt says
   * otherwise.
   */
  locatorsFor(subject: ErasureSubject): Promise<Result<SubjectLocators>>;
}
