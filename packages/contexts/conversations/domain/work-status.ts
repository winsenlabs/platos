// `WorkStatus`, and the transitions this context is willing to make.
//
// The enum is shared by `Thread`, `Turn` and `PostmanExecution` in the canonical
// schema. Prisma will store any of the five in any of the three columns; what it
// cannot express is that SUCCEEDED, FAILED and CANCELLED are TERMINAL, and that
// is the whole of what goes wrong in the extraction source. A turn that ended in
// an error is patched to SUCCEEDED by a late-arriving stream close; a cancelled
// turn is re-opened by a retry that never checked. Both are one missing rule.
//
// THE TRANSITION TABLE IS THE RULE, AND IT IS THE SAME TABLE FOR ALL THREE ROWS.
// A thread is ACTIVE and settles; a turn is PENDING, becomes ACTIVE when the
// first step opens, and settles; a postman execution is PENDING and settles.
// They differ in which status they START at, not in where they may go, so the
// table is declared once and the start state is the caller's.

import { err, ok, type Result } from "@platos/kernel";

import { turnAlreadySettled } from "./errors.js";

export const WORK_STATUSES = ["PENDING", "ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED"] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];

/** The three that no transition leaves. */
export const TERMINAL_WORK_STATUSES: readonly WorkStatus[] = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export function isWorkStatus(value: string): value is WorkStatus {
  return (WORK_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: WorkStatus): boolean {
  return TERMINAL_WORK_STATUSES.includes(status);
}

/**
 * Where each status may go.
 *
 * PENDING may be abandoned before it ever runs, which is why CANCELLED is
 * reachable from it and not only from ACTIVE: a queued turn whose caller
 * disconnects has to settle somewhere, and leaving it PENDING forever is what
 * fills a thread with rows nothing will ever close.
 */
const ALLOWED: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = Object.freeze({
  PENDING: Object.freeze<WorkStatus[]>(["ACTIVE", "SUCCEEDED", "FAILED", "CANCELLED"]),
  ACTIVE: Object.freeze<WorkStatus[]>(["SUCCEEDED", "FAILED", "CANCELLED"]),
  SUCCEEDED: Object.freeze<WorkStatus[]>([]),
  FAILED: Object.freeze<WorkStatus[]>([]),
  CANCELLED: Object.freeze<WorkStatus[]>([]),
});

export function canTransition(from: WorkStatus, to: WorkStatus): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * Move a row's status, or refuse.
 *
 * The refusal carries the id and the status it is already in, because the
 * operator question is always "what closed it first", and a bare "invalid
 * transition" cannot answer it.
 */
export function transition(id: string, from: WorkStatus, to: WorkStatus): Result<WorkStatus> {
  if (!canTransition(from, to)) return err(turnAlreadySettled(id, from));
  return ok(to);
}
