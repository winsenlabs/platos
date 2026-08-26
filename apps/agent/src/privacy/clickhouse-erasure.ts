/**
 * ClickHouse hard erasure — submit, wait, then prove.
 *
 * ClickHouse has no transactional DELETE. Erasure is an `ALTER TABLE …
 * DELETE/UPDATE`, which registers a MUTATION and returns immediately: the
 * statement succeeding means the server accepted the work, not that the rows
 * are gone. Every honest step of this module falls out of that one fact.
 *
 *   1. SUBMIT the mutation with `mutations_sync=0`, explicitly, so the code
 *      does not depend on a server default to know what it is waiting for.
 *   2. POLL `system.mutations` for `is_done`. An in-flight mutation is
 *      `unknown` (erasure-receipt.ts, rule 1) and `unknown` blocks completion.
 *   3. VERIFY NEGATIVELY by re-counting the subject's rows afterwards. The
 *      receipt's claim rests on that count, never on the mutation succeeding.
 *
 * NOT_PROVISIONED IS NOT EVIDENCE OF DELETION
 *
 * ClickHouse is deliberately absent from local/dev compose, and `not_provisioned`
 * settles the operation (erasure-receipt.ts `isStoreSettled`) so an absent store
 * does not hold an otherwise complete erasure open. That makes it the most
 * dangerous outcome in this file: anything that reaches it is asserting the
 * store cannot hold subject data. So it is reachable from exactly two places —
 * no endpoint configured, and a SUCCESSFUL schema probe that found none of the
 * erasure tables — and `notProvisioned()` below hard-zeroes the deletion
 * counters and records `not_applicable` so no reader, and no later aggregation,
 * can mistake it for erasure. An unreachable, unauthorized or erroring
 * ClickHouse is `failed`/`unknown`, NEVER not_provisioned: the installation has
 * one and we could not prove anything about it.
 *
 * WHAT IS ERASED, AND WHY THE TWO SHAPES DIFFER
 *
 * The M0.3 event model is Thread → Turn → Step → Tool Call (see
 * docs/observability-model.md). Those tables are the analytical projection of
 * work Postgres already owns, and they carry immutable billing facts, so the
 * subject is UNLINKED from them rather than deleted: `end_user_id` and the
 * plaintext identity columns are cleared, the pseudonymous `subject_key_hash`
 * and the aggregate row survive. Deleting a usage event to serve an erasure
 * would destroy a financial record to remove an identifier that can be removed
 * on its own.
 *
 * The legacy `platos_spans_v1` projection is different in kind: its `attrs`
 * column is an unbounded JSON blob that the writer folds display name and email
 * into, with no allow-list at the write boundary. Nothing can certify that blob
 * identity-free, so those rows are DELETED. A store we cannot certify, we do
 * not keep.
 */

import { pendingStore, type StoreOutcome } from "./erasure-receipt";
import type { SubjectKeys } from "./subject-graph";
import { TELEMETRY_DATABASE } from "../shared/telemetry-namespace";
import {
  clickhouseArrayParam,
  parseTabSeparated,
  type ClickhouseErasureTransport,
} from "./clickhouse";

/** Turn-shaped analytical projection (docs/observability-model.md). */
export const OBSERVABILITY_DATABASE = "platos_observability";
/** Legacy span projection, still the table holding plaintext identity today. */
export const SPAN_DATABASE = TELEMETRY_DATABASE;

/** A column the mutation empties. `NULL` for Nullable columns, `''` otherwise. */
export interface ClearedColumn {
  name: string;
  to: "''" | "NULL";
}

export type ClickhouseErasureAction =
  | { kind: "delete" }
  | { kind: "clear"; columns: ClearedColumn[] };

export interface ClickhouseErasureTable {
  database: string;
  table: string;
  /** Columns carrying a canonical or legacy subject id. */
  subjectIdColumns: string[];
  /** Column carrying the Thread id, when the table has one. */
  threadColumn?: string;
  /** Column carrying the pseudonymous subject key, when the table has one. */
  subjectHashColumn?: string;
  action: ClickhouseErasureAction;
}

/**
 * Every table erasure must touch, in Thread → Turn → Step → Tool Call order.
 *
 * Enumerated rather than discovered, for the reason subject-graph.ts enumerates
 * its tables: an allow-list is auditable, and a scan for "columns that look like
 * an id" is a loaded gun pointed at operator data. Adding a plaintext identity
 * column to any of these without adding it here is the failure mode this list
 * exists to make visible.
 */
export const CLICKHOUSE_ERASURE_PLAN: ClickhouseErasureTable[] = [
  {
    database: OBSERVABILITY_DATABASE,
    table: "turns_v1",
    subjectIdColumns: ["end_user_id"],
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    // The only table carrying plaintext identity in the turn-shaped model.
    action: {
      kind: "clear",
      columns: [
        { name: "end_user_id", to: "''" },
        { name: "user_display_name", to: "NULL" },
        { name: "user_email", to: "NULL" },
      ],
    },
  },
  {
    database: OBSERVABILITY_DATABASE,
    table: "steps_v1",
    subjectIdColumns: ["end_user_id"],
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    action: { kind: "clear", columns: [{ name: "end_user_id", to: "''" }] },
  },
  {
    database: OBSERVABILITY_DATABASE,
    table: "tool_calls_v1",
    subjectIdColumns: ["end_user_id"],
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    action: { kind: "clear", columns: [{ name: "end_user_id", to: "''" }] },
  },
  {
    database: OBSERVABILITY_DATABASE,
    table: "usage_events_v1",
    subjectIdColumns: ["end_user_id"],
    threadColumn: "thread_id",
    subjectHashColumn: "subject_key_hash",
    // Immutable charge facts: unlink the subject, keep the money.
    action: { kind: "clear", columns: [{ name: "end_user_id", to: "''" }] },
  },
  {
    database: SPAN_DATABASE,
    table: "platos_spans_v1",
    // `user_id` here is the denormalized scope.userId — the same legacy handle
    // the Redis and Postgres sweeps address the subject by.
    subjectIdColumns: ["user_id"],
    threadColumn: "thread_id",
    action: { kind: "delete" },
  },
];

/** How the subject is addressed in ClickHouse. */
export interface ClickhouseSubjectAddress {
  /** Canonical PlatosEndUser ids and legacy scope.userId values. */
  ids: string[];
  /** Thread ids, read from Postgres while Postgres still exists. */
  threadIds: string[];
  /** Salted, org-scoped subject key. Content-free by construction. */
  hashes: string[];
}

export interface ClickhousePollPolicy {
  intervalMs: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Bounded wait, because `requestErasure` runs inline in an admin HTTP request.
 * Running out of budget is not a failure and not a success: the receipt says
 * `unknown` and a retry re-drives the store, which is the only honest way to
 * bound a wait on work that has no deadline of its own.
 */
const DEFAULT_POLL: ClickhousePollPolicy = {
  intervalMs: 500,
  timeoutMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface ClickhouseErasureArgs {
  clickhouse: ClickhouseErasureTransport | null | undefined;
  subject: SubjectKeys;
  organizationId: string;
  /** Thread ids for the subject, discovered before Postgres deletes them. */
  threadIds: string[];
  subjectKeyHash?: string | null;
  plan?: ClickhouseErasureTable[];
  poll?: Partial<ClickhousePollPolicy>;
}

/**
 * The one constructor for a not_provisioned ClickHouse outcome.
 *
 * Deletion counters are pinned to zero and verification to `not_applicable`:
 * an absent store settles the operation, and the price of that is that it must
 * be structurally incapable of contributing a single row of apparent evidence.
 */
export function notProvisioned(note: string): StoreOutcome {
  return {
    ...pendingStore("clickhouse"),
    status: "not_provisioned",
    discovered: 0,
    deleted: 0,
    anonymized: 0,
    retained: 0,
    failures: 0,
    verificationStatus: "not_applicable",
    note,
  };
}

/** Error CLASS only — ClickHouse quotes the failing statement in its bodies. */
function errorClass(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    return status === undefined ? err.name : `${err.name} ${status}`;
  }
  return "Error";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

export function subjectAddress(
  subject: SubjectKeys,
  threadIds: string[],
  subjectKeyHash?: string | null,
): ClickhouseSubjectAddress {
  // Blank ids are dropped before they reach a predicate. `end_user_id IN ['']`
  // matches every system-attributed row in the organization, which would turn
  // one person's erasure into a tenant-wide wipe.
  return {
    ids: unique([...subject.platosEndUserIds, ...subject.legacyUserIds]),
    threadIds: unique(threadIds),
    hashes: unique(subjectKeyHash ? [subjectKeyHash] : []),
  };
}

/** Table restricted to the columns this installation actually has. */
interface EffectiveTable extends ClickhouseErasureTable {
  addressable: boolean;
}

function effectiveTable(
  spec: ClickhouseErasureTable,
  columns: Set<string>,
  address: ClickhouseSubjectAddress,
): EffectiveTable {
  const subjectIdColumns = spec.subjectIdColumns.filter((c) => columns.has(c));
  const threadColumn = spec.threadColumn && columns.has(spec.threadColumn) ? spec.threadColumn : undefined;
  const subjectHashColumn =
    spec.subjectHashColumn && columns.has(spec.subjectHashColumn) ? spec.subjectHashColumn : undefined;
  const action: ClickhouseErasureAction =
    spec.action.kind === "clear"
      ? { kind: "clear", columns: spec.action.columns.filter((c) => columns.has(c.name)) }
      : spec.action;
  const locators =
    (address.ids.length ? subjectIdColumns.length : 0) +
    (address.threadIds.length && threadColumn ? 1 : 0) +
    (address.hashes.length && subjectHashColumn ? 1 : 0);
  return {
    ...spec,
    subjectIdColumns,
    threadColumn,
    subjectHashColumn,
    action,
    addressable:
      columns.has("organization_id") &&
      locators > 0 &&
      (action.kind === "delete" || action.columns.length > 0),
  };
}

/** `WHERE` shared by discovery, mutation and verification — deliberately one string. */
function subjectWhere(spec: EffectiveTable, address: ClickhouseSubjectAddress): string {
  const locators: string[] = [];
  if (address.ids.length) {
    for (const column of spec.subjectIdColumns) locators.push(`${column} IN {ids:Array(String)}`);
  }
  if (address.threadIds.length && spec.threadColumn) {
    locators.push(`${spec.threadColumn} IN {threads:Array(String)}`);
  }
  if (address.hashes.length && spec.subjectHashColumn) {
    locators.push(`${spec.subjectHashColumn} IN {hashes:Array(String)}`);
  }
  const where = [`organization_id = {organization:String}`, `(${locators.join(" OR ")})`];
  if (spec.action.kind === "clear") {
    // Residue clause. Without it, verification would be a tautology: the
    // mutation empties the very columns the locator matches on, so re-running
    // the locator alone returns zero whether or not the mutation ran. What must
    // be proved is that no row for this subject STILL CARRIES identity — and
    // the hash column is deliberately not part of that, because policy retains
    // it. Mutation and verification share this string so they cannot drift.
    where.push(`(${spec.action.columns.map((c) => `coalesce(${c.name}, '') != ''`).join(" OR ")})`);
  }
  return where.join(" AND ");
}

function mutationSql(spec: EffectiveTable, where: string): string {
  const target = `${spec.database}.${spec.table}`;
  if (spec.action.kind === "delete") return `ALTER TABLE ${target} DELETE WHERE ${where}`;
  const assignments = spec.action.columns.map((c) => `${c.name} = ${c.to}`).join(", ");
  return `ALTER TABLE ${target} UPDATE ${assignments} WHERE ${where}`;
}

function countSql(spec: EffectiveTable, where: string): string {
  return `SELECT count() FROM ${spec.database}.${spec.table} WHERE ${where} FORMAT TabSeparated`;
}

const SYSTEM_COLUMNS_SQL =
  "SELECT database, table, name FROM system.columns" +
  " WHERE database IN {databases:Array(String)} AND table IN {tables:Array(String)}" +
  " FORMAT TabSeparated";

/**
 * `latest_fail_reason` is reduced to a flag IN THE QUERY.
 *
 * ClickHouse puts the failing statement into that string, and the failing
 * statement is a list of the identifiers being erased. Pulling it into this
 * process would put personal data one careless template literal away from the
 * receipt, so the server is asked for a boolean instead of the text.
 */
const SYSTEM_MUTATIONS_SQL =
  "SELECT database, table, mutation_id, is_done, if(latest_fail_reason = '', 0, 1)" +
  " FROM system.mutations" +
  " WHERE database IN {databases:Array(String)} AND table IN {tables:Array(String)}" +
  " FORMAT TabSeparated";

interface MutationRow {
  key: string;
  mutationId: string;
  done: boolean;
  failed: boolean;
}

function tableKey(spec: { database: string; table: string }): string {
  return `${spec.database}.${spec.table}`;
}

async function readMutations(
  clickhouse: ClickhouseErasureTransport,
  params: Record<string, string>,
): Promise<MutationRow[]> {
  const rows = parseTabSeparated(await clickhouse.query(SYSTEM_MUTATIONS_SQL, { params }));
  return rows.map((cells) => ({
    key: `${cells[0]}.${cells[1]}`,
    mutationId: cells[2] ?? "",
    done: cells[3] === "1",
    failed: cells[4] === "1",
  }));
}

/** Per-table bookkeeping. Every field is a fact we either measured or did not. */
interface TableRun {
  spec: EffectiveTable;
  where: string;
  /** Rows carrying subject identity before the mutation; null when unmeasured. */
  before: number | null;
  submitted: boolean;
  /** A mutation of ours reported is_done. */
  confirmed: boolean;
  /** Survivors after the mutation; null when verification did not or could not run. */
  survivors: number | null;
}

/**
 * Erase one subject from ClickHouse and return the store's outcome.
 *
 * Never throws: a thrown executor is recorded by the orchestrator as `unknown`,
 * which is correct but coarse. Handling the failure modes here lets the receipt
 * say which of them happened.
 */
export async function eraseClickhouseSubject(args: ClickhouseErasureArgs): Promise<StoreOutcome> {
  const outcome = pendingStore("clickhouse");
  const plan = args.plan ?? CLICKHOUSE_ERASURE_PLAN;
  const policy: ClickhousePollPolicy = { ...DEFAULT_POLL, ...args.poll };
  const clickhouse = args.clickhouse;

  // Absent by configuration. The local/dev stack ships no ClickHouse, and this
  // is the only branch that may say so.
  if (!clickhouse?.available) {
    return notProvisioned("no clickhouse endpoint configured; nothing submitted");
  }

  const address = subjectAddress(args.subject, args.threadIds, args.subjectKeyHash);
  if (!address.ids.length && !address.threadIds.length && !address.hashes.length) {
    // Nothing to address means nothing can be proved. The orchestrator already
    // refuses empty subjects; this is the belt to that braces.
    return {
      ...outcome,
      status: "failed",
      failures: 1,
      verificationStatus: "unknown",
      note: "subject resolved to no clickhouse-addressable key",
    };
  }

  const params: Record<string, string> = {
    organization: args.organizationId,
    ids: clickhouseArrayParam(address.ids),
    threads: clickhouseArrayParam(address.threadIds),
    hashes: clickhouseArrayParam(address.hashes),
  };
  const catalogParams = {
    databases: clickhouseArrayParam(unique(plan.map((s) => s.database))),
    tables: clickhouseArrayParam(unique(plan.map((s) => s.table))),
  };

  // Schema probe. A THROW here is a store we could not reach; only a successful
  // probe that returns no matching table may report the store absent.
  let columnsByTable: Map<string, Set<string>>;
  try {
    columnsByTable = new Map();
    for (const cells of parseTabSeparated(
      await clickhouse.query(SYSTEM_COLUMNS_SQL, { params: catalogParams }),
    )) {
      const key = `${cells[0]}.${cells[1]}`;
      const columns = columnsByTable.get(key) ?? new Set<string>();
      columns.add(cells[2] ?? "");
      columnsByTable.set(key, columns);
    }
  } catch (err) {
    return {
      ...outcome,
      status: "failed",
      failures: 1,
      verificationStatus: "unknown",
      note: `clickhouse schema probe failed (${errorClass(err)}); store NOT reported absent`,
    };
  }

  const runs: TableRun[] = [];
  let drifted = 0;
  for (const spec of plan) {
    const columns = columnsByTable.get(tableKey(spec));
    if (!columns || columns.size === 0) continue;
    const effective = effectiveTable(spec, columns, address);
    if (!effective.addressable) {
      // The table is here but carries none of the columns erasure addresses it
      // by. That is schema drift, not absence, and it is a failure.
      drifted++;
      continue;
    }
    runs.push({
      spec: effective,
      where: subjectWhere(effective, address),
      before: null,
      submitted: false,
      confirmed: false,
      survivors: null,
    });
  }

  if (runs.length === 0) {
    if (drifted === 0) {
      return notProvisioned(
        `no erasure tables present in this installation (probed ${plan.length}); not evidence of deletion`,
      );
    }
    // Tables are here, and erasure cannot address any of them. Absent is not
    // the word for that.
    return {
      ...outcome,
      status: "failed",
      failures: drifted,
      verificationStatus: "unknown",
      note: `${drifted} tables present but not addressable (schema drift); store NOT reported absent`,
    };
  }
  outcome.failures += drifted;

  // Pre-count. Evidence, not bookkeeping: "found N, now find 0" is a materially
  // stronger statement than "found 0" from a predicate that may match nothing.
  for (const run of runs) {
    try {
      run.before = Number(
        (await clickhouse.query(countSql(run.spec, run.where), { params })).trim(),
      );
      if (!Number.isFinite(run.before)) run.before = null;
    } catch {
      run.before = null;
    }
  }

  // Snapshot mutations BEFORE submitting so ours are identifiable afterwards.
  // ClickHouse's HTTP interface returns no mutation id, and correlating on
  // create_time races other operations; a set difference cannot.
  const known = new Set<string>();
  let snapshotFailed = false;
  try {
    for (const row of await readMutations(clickhouse, catalogParams)) {
      known.add(`${row.key}#${row.mutationId}`);
    }
  } catch {
    snapshotFailed = true;
  }

  for (const run of runs) {
    try {
      await clickhouse.query(mutationSql(run.spec, run.where), {
        params,
        // Explicit: the poll below is the source of truth about completion, so
        // the statement must not be allowed to block on a server-side default.
        settings: { mutations_sync: "0" },
      });
      run.submitted = true;
    } catch (err) {
      outcome.failures++;
      outcome.note = `mutation submit failed (${errorClass(err)})`;
    }
  }

  // Poll for is_done. Submission is acceptance, not completion, and the gap
  // between the two is exactly where a receipt starts lying.
  const deadline = policy.now() + policy.timeoutMs;
  const countedFailures = new Set<string>();
  const stuck = new Set<string>();
  let pollFailed = false;
  if (!snapshotFailed) {
    for (;;) {
      let rows: MutationRow[];
      try {
        rows = await readMutations(clickhouse, catalogParams);
      } catch {
        pollFailed = true;
        break;
      }
      const fresh = rows.filter((r) => !known.has(`${r.key}#${r.mutationId}`));
      for (const run of runs) {
        if (!run.submitted) continue;
        const mine = fresh.filter((r) => r.key === tableKey(run.spec));
        run.confirmed = mine.length > 0 && mine.every((r) => r.done);
        for (const mutation of mine) {
          // A mutation ClickHouse is failing to apply. It may yet retry, so it
          // is not proof anything survived — but it is a failure, counted once
          // rather than once per poll, and the verification below is what
          // decides what is actually still there.
          if (!mutation.failed || countedFailures.has(mutation.mutationId)) continue;
          countedFailures.add(mutation.mutationId);
          outcome.failures++;
        }
        if (!run.confirmed && mine.some((r) => r.failed)) stuck.add(tableKey(run.spec));
      }
      const settled = runs.every(
        (run) => !run.submitted || run.confirmed || stuck.has(tableKey(run.spec)),
      );
      if (settled) break;
      if (policy.now() >= deadline) break;
      await policy.sleep(policy.intervalMs);
    }
  }

  // Negative verification. Only ever runs where it can mean something: a
  // confirmed mutation, or a table that had nothing in it to begin with.
  for (const run of runs) {
    const verifiable = run.confirmed || (run.before === 0 && run.submitted);
    if (!verifiable) continue;
    try {
      const survivors = Number(
        (await clickhouse.query(countSql(run.spec, run.where), { params })).trim(),
      );
      run.survivors = Number.isFinite(survivors) ? survivors : null;
    } catch {
      run.survivors = null;
    }
  }

  for (const run of runs) {
    outcome.discovered += run.before ?? 0;
    if (!run.confirmed) continue;
    const covered = run.before ?? 0;
    if (run.spec.action.kind === "delete") outcome.deleted += covered;
    else outcome.anonymized += covered;
  }

  const confirmedSurvivors = runs.reduce((total, run) => total + (run.survivors ?? 0), 0);
  const unverified = runs.filter((run) => run.survivors === null);
  outcome.verificationStatus =
    confirmedSurvivors > 0 ? "failed" : unverified.length > 0 ? "unknown" : "passed";
  outcome.status = outcome.failures > 0 ? "failed" : "done";

  const notes = [
    `${runs.length} tables, ${outcome.deleted} rows deleted, ${outcome.anonymized} rows unlinked`,
    `mutations confirmed ${runs.filter((r) => r.confirmed).length}/${runs.filter((r) => r.submitted).length}`,
    `${confirmedSurvivors} survivors, ${unverified.length} unverified (treated as still present)`,
  ];
  if (drifted) notes.push(`${drifted} tables present but not addressable (schema drift)`);
  if (stuck.size) notes.push(`${stuck.size} mutations reported a failure`);
  if (snapshotFailed || pollFailed) notes.push("system.mutations unreadable; completion unproven");
  if (outcome.anonymized) notes.push("subject_key_hash retained by policy");
  outcome.note = [outcome.note, ...notes].filter(Boolean).join("; ");
  return outcome;
}
