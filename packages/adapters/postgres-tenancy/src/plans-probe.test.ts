// The measurement kit, measured. No container.
//
// WHY THIS FILE EXISTS AT ALL. Every plan suite in this tranche reports a number
// that the kit below produced, so a defect IN THE KIT is a defect in all of them
// at once — and the failure mode is silent: a filter that discarded too much
// reports a smaller statement count, which reads as better. Tranche 3 lost an
// advisory lock exactly that way. The cases here are the ones that would have
// caught it, run without Docker so they cannot be skipped.

import { describe, expect, test } from "vitest";

import {
  allDistinct,
  countedQueries,
  indexesUsed,
  nodeTypesOf,
  nodesOf,
  onlyStatement,
  readPlan,
  rowsFrom,
  scansSequentially,
  windows,
} from "./plans-probe.js";

/** A plan shaped like the one `pageThreads` produces: sort over a scan. */
const SORTED_SCAN = [
  {
    Plan: {
      "Node Type": "Limit",
      "Actual Rows": 25,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Sort",
          "Actual Rows": 25,
          "Actual Loops": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "Thread",
              "Actual Rows": 300,
              "Actual Loops": 1,
            },
          ],
        },
      ],
    },
  },
];

/** A plan shaped like an N+1: a small inner scan run once per outer row. */
const NESTED_LOOP = [
  {
    Plan: {
      "Node Type": "Nested Loop",
      "Actual Rows": 300,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Index Scan",
          "Relation Name": "AgentBinding",
          "Index Name": "AgentBinding_environmentId_agentId_key",
          "Actual Rows": 300,
          "Actual Loops": 1,
        },
        {
          "Node Type": "Index Scan",
          "Relation Name": "Agent",
          "Index Name": "Agent_pkey",
          "Actual Rows": 1,
          "Actual Loops": 300,
        },
      ],
    },
  },
];

describe("countedQueries", () => {
  test("discards the transaction frame the driver adds", () => {
    expect(
      countedQueries(["BEGIN", "SELECT * FROM x", "COMMIT", "DEALLOCATE ALL", "ROLLBACK"]),
    ).toEqual(["SELECT * FROM x"]);
  });

  test("discards the connection probe, which is `SELECT 1` and NOTHING else", () => {
    expect(countedQueries(["SELECT 1", "  select 1  "])).toEqual([]);
  });

  test("KEEPS a read that happens to project a constant — tranche 3's trap", () => {
    // The advisory lock projected `SELECT 1 FROM pg_advisory_xact_lock(...)`.
    // A probe filter anchored only at the start swallows it, the lock measures
    // ZERO statements, and deleting the lock outright survives a sweep.
    const lock = "SELECT 1 FROM pg_advisory_xact_lock($1)";
    expect(countedQueries([lock, "SELECT 1"])).toEqual([lock]);
  });

  test("keeps a statement whose text merely begins with a discarded word", () => {
    // `BEGINNING` is not `BEGIN`, and the word boundary is what says so.
    expect(countedQueries(['SELECT "BEGINNING" FROM x'])).toHaveLength(1);
  });
});

describe("onlyStatement", () => {
  const events = [
    { query: "SELECT a FROM t", params: [] },
    { query: "SELECT COUNT(*) FROM t", params: [] },
  ];

  test("returns the single match, with the values bound to it", () => {
    expect(onlyStatement(events, (sql) => sql.includes("COUNT")).query).toBe(
      "SELECT COUNT(*) FROM t",
    );
  });

  test("REFUSES an ambiguous match rather than taking the first", () => {
    // A plan pinned to "the first SELECT mentioning t" would quietly start
    // measuring the count statement the day the read order changed.
    expect(() => onlyStatement(events, (sql) => sql.includes("FROM t"))).toThrow(/found 2/u);
  });

  test("REFUSES a match that found nothing", () => {
    expect(() => onlyStatement(events, () => false)).toThrow(/found 0/u);
  });
});

describe("readPlan", () => {
  test("finds the plan whether the driver parsed it or handed back a string", () => {
    expect(readPlan(SORTED_SCAN).nodeType).toBe("Limit");
    expect(readPlan(JSON.stringify(SORTED_SCAN)).nodeType).toBe("Limit");
  });

  test("finds it through the column whose name has a space in it", () => {
    expect(readPlan([{ "QUERY PLAN": SORTED_SCAN }]).nodeType).toBe("Limit");
  });

  test("refuses a result with no plan in it rather than inventing an empty one", () => {
    expect(() => readPlan([{ ok: true }])).toThrow(/no Plan node/u);
  });
});

describe("the plan readers", () => {
  test("nodesOf walks the whole tree, root first", () => {
    expect(nodesOf(readPlan(SORTED_SCAN)).map((node) => node.nodeType)).toEqual([
      "Limit",
      "Sort",
      "Seq Scan",
    ]);
  });

  test("indexesUsed names the indexes and nothing else", () => {
    expect(indexesUsed(readPlan(NESTED_LOOP))).toEqual([
      "AgentBinding_environmentId_agentId_key",
      "Agent_pkey",
    ]);
    expect(indexesUsed(readPlan(SORTED_SCAN))).toEqual([]);
  });

  test("nodeTypesOf is sorted, so a pin does not depend on plan order", () => {
    expect(nodeTypesOf(readPlan(SORTED_SCAN))).toEqual(["Limit", "Seq Scan", "Sort"]);
  });

  test("rowsFrom sums a relation's rows ACROSS LOOPS, which is where an N+1 hides", () => {
    // One row per loop, three hundred loops. Reading `Actual Rows` alone would
    // report this relation as costing a single row.
    expect(rowsFrom(readPlan(NESTED_LOOP), "Agent")).toBe(300);
    expect(rowsFrom(readPlan(SORTED_SCAN), "Thread")).toBe(300);
  });

  test("rowsFrom answers zero for a relation the plan never touched", () => {
    expect(rowsFrom(readPlan(SORTED_SCAN), "Turn")).toBe(0);
  });

  test("scansSequentially names the relation, not the plan as a whole", () => {
    expect(scansSequentially(readPlan(SORTED_SCAN), "Thread")).toBe(true);
    expect(scansSequentially(readPlan(SORTED_SCAN), "Turn")).toBe(false);
    expect(scansSequentially(readPlan(NESTED_LOOP), "Agent")).toBe(false);
  });
});

describe("the paging helpers", () => {
  test("windows covers every row, and the last window is short rather than absent", () => {
    expect(windows(7, 3)).toEqual([0, 3, 6]);
    expect(windows(6, 3)).toEqual([0, 3]);
    expect(windows(0, 3)).toEqual([]);
  });

  test("allDistinct is what makes a repeated row across pages visible", () => {
    expect(allDistinct(["a", "b", "c"])).toBe(true);
    expect(allDistinct(["a", "b", "a"])).toBe(false);
  });
});
