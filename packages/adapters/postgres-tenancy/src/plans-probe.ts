// WIN-258 T7 — the measurement kit the plan suites share.
//
// WHAT THIS FILE IS FOR. WIN-258's acceptance asks that "dense fixtures show no
// N+1/full hydration regressions", and the four things that sentence needs are
// all mechanical: count the statements a read sends, replay one of them under
// `EXPLAIN` to see the plan PostgreSQL actually chose, read the number of rows
// that plan touched, and name the indexes it used. None of that is assertable
// from a returned value — a full table scan and an index scan return the same
// rows — so it is measured here and pinned by the suites.
//
// THE PROBE PATTERN IS ANCHORED, AND THIS IS WHY THE FILTER LOOKS PARANOID.
// Tranche 3 pinned an advisory lock at a statement count and measured ZERO: the
// lock projected `SELECT 1`, which is exactly the shape the statement suites
// strip to discard the driver's connection probe, so a mutation that deleted the
// lock outright survived the sweep. `countedQueries` therefore matches the probe
// only when the WHOLE statement is `SELECT 1` and nothing else, and every
// measurement carries the unfiltered total beside the filtered count so a
// measurement can never be smaller than the thing it is measuring.
//
// THE PLAN IS TAKEN FROM THE STATEMENT THE STORE SENT, NOT FROM ONE RETYPED
// HERE. A suite that hand-wrote the SQL it expected would prove that PostgreSQL
// can plan that SQL well, which is not the question; the question is whether the
// statement THIS ADAPTER emits is planned well. So the suites pick a captured
// statement, hand it back with the values the driver bound to it, and read the
// plan of that.
//
// `EXPLAIN ANALYZE` RUNS THE STATEMENT A SECOND TIME. That is acceptable for the
// reads measured here — every one of them is a SELECT — and it is the only form
// that reports ACTUAL rows rather than the planner's estimate. An estimate would
// make a full hydration look like whatever the statistics happened to say.

import type { TenancyDatabaseClient } from "./client.js";
import type { CapturedStatement } from "./harness.js";

/**
 * The two methods a measurement needs from whichever harness a suite holds.
 *
 * Structural rather than `TenancyHarness`, because two of the five context
 * harnesses flatten the base one away and re-export these by name. Naming the
 * capability instead of the type is what lets one kit serve all of them without
 * a cast at each call site.
 */
export interface StatementLog {
  statements(): readonly string[];
  resetStatements(): void;
}

/** What one measured call cost, filtered and unfiltered. */
export interface Measurement {
  /** Statements that are neither transaction frame nor connection probe. */
  readonly counted: number;
  /** Every statement the client sent, including the frame. Never smaller. */
  readonly total: number;
}

/**
 * The statements that count towards an N+1, from a captured run.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping. The
 * `SELECT 1` clause is anchored at both ends on purpose: see the header.
 */
export function countedQueries(statements: readonly string[]): readonly string[] {
  return statements.filter(
    (statement) =>
      !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
      !/^\s*SELECT\s+1\s*$/iu.test(statement),
  );
}

/**
 * Let the client's `query` events arrive.
 *
 * THE EVENT IS EMITTED ASYNCHRONOUSLY, AFTER THE CALL HAS RESOLVED, and a count
 * taken in the same tick can miss the last statement. That is not merely a
 * measurement that reads low: the missed event lands in the NEXT measurement's
 * array, so one pin reads one short and the pin after it reads one long. Tranche
 * 5 saw both halves in a single run on a real container.
 */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

/** Run `work` with a clean statement log and report what it cost. */
export async function measure(
  harness: StatementLog,
  work: () => Promise<unknown>,
): Promise<Measurement> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  const statements = harness.statements();
  return { counted: countedQueries(statements).length, total: statements.length };
}

/** Capture the statements one call sent, so a suite can plan one of them. */
export async function capture(
  harness: StatementLog & { events(): readonly CapturedStatement[] },
  work: () => Promise<unknown>,
): Promise<readonly CapturedStatement[]> {
  await settle();
  harness.resetStatements();
  await work();
  await settle();
  // COPIED, not handed over. `resetStatements` swaps the array; returning the
  // live one would let a later measurement append to a snapshot a suite already
  // holds.
  return [...harness.events()];
}

/**
 * The one captured statement a suite wants to plan.
 *
 * It THROWS when the match is not unique, and that is the point rather than a
 * convenience: a plan pinned to "the first SELECT that mentions Thread" would
 * silently start measuring the count statement the day the read order changed,
 * and would keep passing.
 */
export function onlyStatement(
  events: readonly CapturedStatement[],
  matches: (statement: string) => boolean,
): CapturedStatement {
  const found = events.filter((event) => matches(event.query));
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one matching statement, found ${String(found.length)}:\n${found
        .map((event) => event.query)
        .join("\n")}`,
    );
  }
  return found[0] as CapturedStatement;
}

/** One node of a PostgreSQL plan, in the fields these suites read. */
export interface PlanNode {
  readonly nodeType: string;
  readonly relationName: string | null;
  readonly indexName: string | null;
  readonly actualRows: number;
  readonly actualLoops: number;
  readonly children: readonly PlanNode[];
}

interface RawPlanNode {
  readonly "Node Type"?: unknown;
  readonly "Relation Name"?: unknown;
  readonly "Index Name"?: unknown;
  readonly "Actual Rows"?: unknown;
  readonly "Actual Loops"?: unknown;
  readonly Plans?: unknown;
}

function numberAt(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringAt(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNode(raw: RawPlanNode): PlanNode {
  const children = Array.isArray(raw.Plans) ? (raw.Plans as RawPlanNode[]) : [];
  return {
    nodeType: stringAt(raw["Node Type"]) ?? "unknown",
    relationName: stringAt(raw["Relation Name"]),
    indexName: stringAt(raw["Index Name"]),
    actualRows: numberAt(raw["Actual Rows"]),
    actualLoops: numberAt(raw["Actual Loops"]),
    children: children.map(readNode),
  };
}

/**
 * Dig the plan tree out of whatever the driver wrapped it in.
 *
 * `EXPLAIN (FORMAT JSON)` is one row of one column holding a one-element array
 * whose only member has a `Plan`. The driver may hand that back as the parsed
 * value or as a string, and the column name has a SPACE in it, so the unwrapping
 * is written as a search for the `Plan` key rather than as a chain of indexes
 * that would break on a driver upgrade without saying why.
 */
function findPlan(value: unknown, depth = 0): RawPlanNode | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return findPlan(JSON.parse(value) as unknown, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) {
      const found = findPlan(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.Plan !== undefined && typeof record.Plan === "object") {
    return record.Plan as RawPlanNode;
  }
  for (const entry of Object.values(record)) {
    const found = findPlan(entry, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Parse an `EXPLAIN (FORMAT JSON)` result into the node tree. */
export function readPlan(result: unknown): PlanNode {
  const raw = findPlan(result);
  if (raw === null) throw new Error("no Plan node in the EXPLAIN result");
  return readNode(raw);
}

/**
 * Plan the statement the store actually sent, with the values it bound.
 *
 * `$queryRawUnsafe` is the only form that can take a statement built elsewhere.
 * The name says unsafe and it is: the text here comes from the driver's own
 * query log inside a test container, never from a caller.
 */
export async function explain(
  client: TenancyDatabaseClient,
  statement: CapturedStatement,
): Promise<PlanNode> {
  const result: unknown = await client.$queryRawUnsafe(
    `EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${statement.query}`,
    ...statement.params,
  );
  return readPlan(result);
}

/** Every node of the plan, root first. */
export function nodesOf(node: PlanNode): readonly PlanNode[] {
  return [node, ...node.children.flatMap(nodesOf)];
}

/** The indexes the plan actually used, in plan order and without repeats. */
export function indexesUsed(node: PlanNode): readonly string[] {
  const names = nodesOf(node)
    .map((entry) => entry.indexName)
    .filter((name): name is string => name !== null);
  return [...new Set(names)];
}

/** The node types the plan used, without repeats. Sorted, so a pin is stable. */
export function nodeTypesOf(node: PlanNode): readonly string[] {
  return [...new Set(nodesOf(node).map((entry) => entry.nodeType))].sort();
}

/**
 * Rows the plan pulled OUT OF one relation, summed over every loop.
 *
 * This is the full-hydration measure. A page of twenty-five drawn from three
 * hundred rows should touch tens of rows, not hundreds; a store that reads the
 * whole set and slices it in JavaScript touches all three hundred, and the
 * returned page looks identical either way.
 *
 * `Actual Rows` is PER LOOP, so it is multiplied by the loop count. A relation
 * scanned once per outer row — the shape of an N+1 the planner turned into a
 * nested loop — reports a small `Actual Rows` and a large `Actual Loops`, and
 * summing without the multiply would report it as cheap.
 */
export function rowsFrom(node: PlanNode, relation: string): number {
  return nodesOf(node)
    .filter((entry) => entry.relationName === relation)
    .reduce((sum, entry) => sum + entry.actualRows * Math.max(entry.actualLoops, 1), 0);
}

/** True when the plan reads `relation` without going through any index. */
export function scansSequentially(node: PlanNode, relation: string): boolean {
  return nodesOf(node).some(
    (entry) => entry.relationName === relation && entry.nodeType === "Seq Scan",
  );
}

/**
 * The page windows that cover `total` rows in steps of `size`.
 *
 * Written here rather than in each suite because the paging property every suite
 * proves — that the pages partition the listing, dropping nothing and repeating
 * nothing — is only as good as the windows it walks, and an off-by-one in the
 * last window would make a dropped row invisible.
 */
export function windows(total: number, size: number): readonly number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset < total; offset += size) offsets.push(offset);
  return offsets;
}

/** True when `values` holds no value twice. The no-repeats half of paging. */
export function allDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
