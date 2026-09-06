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
  inlineParameters,
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

  test("keeps a statement whose FIRST WORD merely begins with a discarded one", () => {
    // `BEGINNING` is not `BEGIN`, and the word boundary is what says so. The
    // earlier form of this case put the word in the projection of a `SELECT`,
    // which the anchor never looked at — so it passed with the boundary removed
    // and the sweep reported the guard as surviving. It is stated here as it is
    // measured: the anchor reads the statement's FIRST token, and this is a
    // token that starts with a discarded word without being one.
    expect(countedQueries(["BEGINNING FROM x", "BEGIN"])).toEqual(["BEGINNING FROM x"]);
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

describe("inlineParameters", () => {
  test("puts a value back where the driver logged a placeholder", () => {
    expect(inlineParameters('SELECT * FROM t WHERE a = $1 AND b = $2', ["x", 5])).toBe(
      "SELECT * FROM t WHERE a = 'x' AND b = 5",
    );
  });

  test("fills the TENTH placeholder before the first, so `$1` cannot eat `$10`", () => {
    const params = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "TENTH"];
    expect(inlineParameters("v $10 w $1", params)).toBe("v 'TENTH' w 'a'");
  });

  test("renders each kind the driver logs", () => {
    expect(inlineParameters("$1 $2 $3 $4", [null, true, ["p", "q"], { k: 1 }])).toBe(
      `NULL true ARRAY['p', 'q'] '{"k":1}'`,
    );
  });

  test("doubles a quote rather than closing the literal early", () => {
    expect(inlineParameters("$1", ["O'Hara"])).toBe("'O''Hara'");
  });

  test("WHY THIS EXISTS: a re-bound uuid arrives as text and PostgreSQL refuses it", () => {
    // The captured value is a string in the log whatever the column type is.
    // Inlined, `"id" = 'aaaa…'` resolves against a `uuid` column; re-bound, it
    // arrives as `text` and the comparison has no operator.
    expect(inlineParameters('"id" = $1', ["aa000000-0000-4000-8000-000000000004"])).toBe(
      `"id" = 'aa000000-0000-4000-8000-000000000004'`,
    );
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
