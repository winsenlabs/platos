// The analytical tables this context is SOLE WRITER of (ADR M0.3 §1, row 12).
//
// The names are the live installation's names and are transcribed, not chosen:
// `internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql`
// creates exactly these four in exactly this database, and the erasure sweep
// addresses them by name. This is a REFACTOR — renaming one here would not
// rename a table, it would make the projection write into nothing.
//
// ORDER IS THREAD -> TURN -> STEP -> TOOL CALL, and then the usage ledger. It is
// the M0.3 event model's own order, and it is preserved everywhere a table list
// is iterated so a batch, a health probe and an erasure plan enumerate the same
// tables in the same sequence.
//
// The projection database is deliberately SEPARATE from the legacy span store.
// One is the turn-shaped model this context owns; the other is a telemetry
// adapter's, and conflating them is what made "the analytical store" mean two
// different things in two different files.

/** The projection's own database. Never the span/telemetry database. */
export const PROJECTION_DATABASE = "platos_observability";

export const PROJECTION_TABLES = ["turns_v1", "steps_v1", "tool_calls_v1", "usage_events_v1"] as const;

export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

/**
 * One row, as it will be sent. String | number | null and nothing else: the
 * store's parser sees text, and a nested value in a column is either a silently
 * stringified object or a rejected batch.
 */
export type ProjectionRow = Readonly<Record<string, string | number | null>>;

/** The rows one committed Turn projects into, grouped by their table. */
export type ProjectionRows = {
  readonly [Table in ProjectionTable]: readonly ProjectionRow[];
};

export function emptyProjectionRows(): ProjectionRows {
  return { turns_v1: [], steps_v1: [], tool_calls_v1: [], usage_events_v1: [] };
}

export function projectionRowCount(rows: ProjectionRows): number {
  return PROJECTION_TABLES.reduce((total, table) => total + rows[table].length, 0);
}

/** Tables carrying at least one row, in canonical order. Empty ones are skipped. */
export function populatedTables(rows: ProjectionRows): readonly ProjectionTable[] {
  return PROJECTION_TABLES.filter((table) => rows[table].length > 0);
}

export function isProjectionTable(value: string): value is ProjectionTable {
  return (PROJECTION_TABLES as readonly string[]).includes(value);
}

/** `<database>.<table>`, the one place the two are joined. */
export function qualifiedTable(table: ProjectionTable): string {
  return `${PROJECTION_DATABASE}.${table}`;
}
