// The self-describing envelope, and what this drain does with one.
//
// ADR M0.3 §1 row 12 says this context is "fed only by self-describing outbox
// envelopes", and §7 decision 8 puts ONE physical outbox behind multiple drains.
// Both halves matter here. Because there is one outbox, this drain necessarily
// SEES envelopes that belong to `eventing` — and because the envelope is
// self-describing, it can tell without importing the context that produced it.
//
// THREE OUTCOMES, AND CONFLATING ANY TWO OF THEM IS A DEFECT.
//
//   project  a name this drain projects, at a version it understands.
//   ignore   not ours. Settled, counted, never written and NEVER PARKED.
//            M0.4 §1.1: "readers ignore unknown fields and unknown event names."
//            Parking another drain's envelopes would fill the failed count with
//            events that were never this context's to deliver.
//   refuse   ours by name, and undeliverable. Parked immediately, because
//            neither a bad shape nor a version this binary is too old to read
//            heals by waiting.
//
// TWO NAMES ARE PROJECTED, AND THE SECOND ONE IS THE MIGRATION.
//
//   `conversations.turn.finalized`  the V1 producer's envelope: the OBSERVED
//     WORK, in the producer's vocabulary. Columns are this context's business,
//     so a producer states what happened and the row shape is decided here.
//
//   `observability.turn.rows`       the pre-V1 queue's payload: rows already in
//     column form. Admitted so the queue an installation is already carrying
//     drains through this context rather than being abandoned mid-migration. Its
//     first segment is `observability` because the ROW SHAPE was always this
//     context's; the runtime that wrote it was only ever a courier for it.
//
// Every unrecognised FIELD inside a payload is ignored; an unrecognised NAME is
// ignored; a bumped VERSION is refused. That asymmetry is deliberate: a new
// field is additive by construction, and a bumped version is the producer saying
// the meaning changed, which is not something a reader may ignore.

import type { DomainEvent, EnvironmentScope, TenantScope } from "@platos/kernel";
import type { DomainError } from "@platos/kernel";

import { envelopeMalformed, envelopeVersionUnsupported } from "./errors.js";
import { asArray, asCell, asObject } from "./json-read.js";
import { readTurnWork } from "./observed-work-codec.js";
import { projectTurnWork } from "./projection.js";
import {
  emptyProjectionRows,
  isProjectionTable,
  type ProjectionRow,
  type ProjectionRows,
} from "./projection-tables.js";

/** The V1 producer's envelope: observed work, in the producer's vocabulary. */
export const TURN_FINALIZED_EVENT = "conversations.turn.finalized";

/** The pre-V1 queue's payload: rows already in column form. */
export const TURN_ROWS_EVENT = "observability.turn.rows";

/** The highest schema version this drain understands, per event name. */
export const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  [TURN_FINALIZED_EVENT]: 1,
  [TURN_ROWS_EVENT]: 1,
});

export type EnvelopeDecision =
  | { readonly kind: "project"; readonly rows: ProjectionRows }
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "refuse"; readonly error: DomainError };

function project(rows: ProjectionRows): EnvelopeDecision {
  return { kind: "project", rows };
}

function ignore(reason: string): EnvelopeDecision {
  return { kind: "ignore", reason };
}

function refuse(error: DomainError): EnvelopeDecision {
  return { kind: "refuse", error };
}

export function isProjectedEventName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_SCHEMA_VERSIONS, name);
}

/**
 * The environment an envelope addresses, or null when it addresses something
 * wider.
 *
 * Every projection column set is keyed by all three tenancy columns, so an
 * organization- or project-scoped envelope cannot become a row: there is no
 * environment to put in `environment_id`, and inventing one would file a Turn
 * under a tenant that never ran it.
 */
export function environmentOf(scope: TenantScope): EnvironmentScope | null {
  return scope.level === "environment" ? scope : null;
}

/**
 * Read a stored row payload back.
 *
 * Refuses anything that is not the shape this projection writes, INCLUDING a
 * cell that is not a scalar. That last check is stricter than the pre-V1 decoder
 * it replaces, which validated the table and row shapes and then trusted the
 * cells — so a nested object could reach the store, where it is either silently
 * stringified into a column or refuses the whole batch. Refusing here names the
 * table and the column instead.
 *
 * A table this drain does not know is IGNORED rather than refused, matching the
 * unknown-field rule: a newer writer adding a fifth table is additive, and the
 * four this binary owns are still correct.
 */
export function readProjectionRows(payload: unknown): EnvelopeDecision {
  const source = asObject(payload);
  if (!source) return refuse(envelopeMalformed("payload must be a JSON object"));

  const rows: { [Table in keyof ProjectionRows]: ProjectionRow[] } = {
    turns_v1: [],
    steps_v1: [],
    tool_calls_v1: [],
    usage_events_v1: [],
  };
  for (const key of Object.keys(source)) {
    if (!isProjectionTable(key)) continue;
    const entries = asArray(source[key]);
    if (entries === undefined) {
      return refuse(envelopeMalformed(`payload.${key} must be an array`));
    }
    for (const [index, entry] of entries.entries()) {
      const row = asObject(entry);
      if (!row) return refuse(envelopeMalformed(`payload.${key}[${index}] must be an object`));
      const cells: Record<string, string | number | null> = {};
      for (const column of Object.keys(row)) {
        const cell = asCell(row[column]);
        if (cell === undefined) {
          return refuse(
            envelopeMalformed(`payload.${key}[${index}].${column} must be a string, number, or null`, [
              { field: `${key}.${column}`, code: "not_a_cell", message: "nested values never reach a column" },
            ]),
          );
        }
        cells[column] = cell;
      }
      rows[key].push(cells);
    }
  }
  return project({ ...emptyProjectionRows(), ...rows });
}

/**
 * Decide what to do with one queued envelope.
 *
 * The name is read BEFORE the version and the version BEFORE the payload, and
 * that order is the whole reason this is safe: a name belonging to another drain
 * never reaches a version check it would fail, and a payload from the future is
 * never parsed by a reader that would misread it.
 */
export function decideEnvelope(event: DomainEvent): EnvelopeDecision {
  if (!isProjectedEventName(event.name)) {
    return ignore(`${event.name} is not projected by this context`);
  }
  const supported = SUPPORTED_SCHEMA_VERSIONS[event.name] ?? 0;
  if (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
    return refuse(envelopeMalformed(`schemaVersion ${String(event.schemaVersion)} is not a version`));
  }
  if (event.schemaVersion > supported) {
    return refuse(envelopeVersionUnsupported(event.name, event.schemaVersion, supported));
  }

  if (event.name === TURN_ROWS_EVENT) return readProjectionRows(event.payload);

  const environment = environmentOf(event.scope);
  if (environment === null) {
    return refuse(
      envelopeMalformed(`${event.name} must be environment-scoped; a projection row has no wider address`),
    );
  }
  const work = readTurnWork(event.payload, environment);
  if (!work.ok) {
    return refuse(
      envelopeMalformed(`payload.${work.failure.field} ${work.failure.reason}`, [
        { field: work.failure.field, code: "invalid", message: work.failure.reason },
      ]),
    );
  }
  return project(projectTurnWork(work.value));
}
