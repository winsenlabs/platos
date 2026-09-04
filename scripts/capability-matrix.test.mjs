// WIN-256 — the owner column of the M0.2 capability matrix.
//
// Two halves, deliberately. The `committed …` tests read
// `docs/audits/M0.2-capability-matrix.json` off disk, so editing that file to
// re-introduce a bad owner turns them red. The `refuses …` tests drive
// `validateOwners` with one crafted row each, so every rule has a control that
// proves it can fail, and each asserts the EXACT rule id and the EXACT row id
// in the message — a rule that fired for the wrong reason does not pass here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ADR_M03_CONTEXTS,
  ORACLE_DERIVED_ROW_COUNT,
  PERMITTED_OWNERS,
  PLATFORM_TRANSPORT,
  PLATFORM_TRANSPORT_ROWS,
  PLATFORM_TRANSPORT_ROW_COUNT,
  RETIRED_OWNER_PLACEHOLDER,
  ROUTE_OWNERSHIP,
  ownerForRoute,
  validateOwners,
} from "./arch/route-ownership.mjs";
import { OWNER } from "./arch/table-ownership.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX = JSON.parse(
  readFileSync(join(ROOT, "docs/audits/M0.2-capability-matrix.json"), "utf8"),
);
const RENDERED = readFileSync(
  join(ROOT, "docs/audits/M0.2-capability-matrix.md"),
  "utf8",
);
const REST = MATRIX.surfaces.rest;
const MCP = MATRIX.surfaces.mcp;

/** A row that passes every rule, so a control changes exactly one thing. */
function cleanRow(overrides = {}) {
  return {
    id: "GET /api/v1/agent/eval-criteria/:criterionId",
    owner: "governance",
    ownerSource: "oracle-derived",
    canonicalWrites: ["EvalCriterion"],
    canonicalReads: [],
    ownerRationale: "recorded",
    ...overrides,
  };
}

/** Run one crafted row and return only the failures naming it. */
function failuresFor(row) {
  return validateOwners([row], []).filter((e) => e.includes(row.id ?? "<no id>"));
}

// ── the fixture itself is not vacuous ────────────────────────────────────────

test("the clean control row passes, so every control below isolates one rule", () => {
  assert.deepEqual(validateOwners([cleanRow()], []), []);
});

// ── the committed artifact ───────────────────────────────────────────────────

test("committed matrix: validateOwners accepts it with zero failures", () => {
  assert.deepEqual(validateOwners(REST, MCP), []);
});

test("committed matrix: no row carries the retired unresolved-owner placeholder", () => {
  const offenders = [...REST, ...MCP]
    .filter((r) => r.owner === RETIRED_OWNER_PLACEHOLDER)
    .map((r) => r.id);
  assert.deepEqual(offenders, []);
});

test("committed matrix: every row names one of the 19 permitted owners", () => {
  assert.equal(PERMITTED_OWNERS.length, 19);
  assert.equal(ADR_M03_CONTEXTS.length, 18);
  const permitted = new Set(PERMITTED_OWNERS);
  const offenders = [...REST, ...MCP]
    .filter((r) => !permitted.has(r.owner))
    .map((r) => `${r.id} -> ${r.owner}`);
  assert.deepEqual(offenders, []);
});

test("committed matrix: row counts are pinned exactly", () => {
  // 300 = 42 resolved from the handler at the oracle + 258 from the URL prefix.
  assert.equal(REST.length, 300);
  assert.equal(REST.filter((r) => r.ownerSource === "oracle-derived").length, 42);
  assert.equal(REST.filter((r) => r.ownerSource === "path-prefix").length, 258);
  assert.equal(42 + 258, REST.length);
  assert.equal(MCP.length, 202);
  assert.equal(MATRIX.totals.restOperations, 300);
  assert.equal(MATRIX.ownership.restRows, 300);
  assert.equal(MATRIX.ownership.oracleDerivedRestRows, 42);
  assert.equal(MATRIX.ownership.pathPrefixRestRows, 258);
});

test("committed matrix: exactly 5 rows carry the non-context value, and they are the pinned 5", () => {
  assert.equal(PLATFORM_TRANSPORT_ROW_COUNT, 5);
  assert.equal(PLATFORM_TRANSPORT_ROWS.length, 5);
  const carrying = REST.filter((r) => r.owner === PLATFORM_TRANSPORT).map((r) => r.id).sort();
  assert.deepEqual(carrying, [...PLATFORM_TRANSPORT_ROWS].sort());
  assert.equal(carrying.length, 5);
  assert.equal(MATRIX.ownership.platformTransportRows, 5);
});

test("committed matrix: every non-context row writes and reads zero canonical rows", () => {
  for (const row of REST.filter((r) => r.owner === PLATFORM_TRANSPORT)) {
    assert.deepEqual(row.canonicalWrites, [], `${row.id} must write nothing`);
    assert.deepEqual(row.canonicalReads, [], `${row.id} must read nothing`);
  }
});

test("committed matrix: the 31 rows WIN-256 was opened for are all resolved", () => {
  // The exact ids that carried the retired placeholder at 95cbacc1.
  const wasUnassigned = [
    "GET /api/health",
    "GET /api/v1/agent/activity/recent",
    "GET /api/v1/agent/connect",
    "POST /api/v1/agent/durable-approvals/:token/resolve",
    "GET /api/v1/agent/eval-criteria",
    "POST /api/v1/agent/eval-criteria",
    "DELETE /api/v1/agent/eval-criteria/:criterionId",
    "GET /api/v1/agent/eval-criteria/:criterionId",
    "PATCH /api/v1/agent/eval-criteria/:criterionId",
    "GET /api/v1/agent/feature-flags",
    "GET /api/v1/agent/golden-sets",
    "POST /api/v1/agent/golden-sets",
    "DELETE /api/v1/agent/golden-sets/:goldenSetId",
    "GET /api/v1/agent/golden-sets/:goldenSetId",
    "PATCH /api/v1/agent/golden-sets/:goldenSetId",
    "POST /api/v1/agent/golden-sets/:goldenSetId/run",
    "GET /api/v1/agent/openapi.json",
    "GET /api/v1/agent/postman-templates",
    "POST /api/v1/agent/postman-templates",
    "DELETE /api/v1/agent/postman-templates/:id",
    "PUT /api/v1/agent/postman-templates/:id",
    "POST /api/v1/agent/postman-templates/:id/execute",
    "POST /api/v1/agent/prompt/assemble",
    "GET /api/v1/agent/prompt/defaults",
    "POST /api/v1/agent/prompt/preview",
    "GET /api/v1/agent/secrets/status",
    "GET /api/v1/agent/tool-calls",
    "GET /api/v1/agent/tool-calls/:toolCallId",
    "POST /api/v1/agent/tool-calls/:toolCallId/replay",
    "GET /metrics",
    "GET /openapi",
  ];
  assert.equal(wasUnassigned.length, 31);
  const byId = new Map(REST.map((r) => [r.id, r]));
  for (const id of wasUnassigned) {
    const row = byId.get(id);
    assert.ok(row, `${id} left the matrix`);
    assert.equal(row.ownerSource, "oracle-derived", `${id} must carry oracle evidence`);
    assert.notEqual(row.owner, RETIRED_OWNER_PLACEHOLDER);
    assert.ok(
      typeof row.ownerEvidence === "string" && /^[\w.-]+\.ts:\d+$/u.test(row.ownerEvidence),
      `${id} must cite a handler as <basename>:<line>, got ${row.ownerEvidence}`,
    );
  }
});

test("committed matrix: the specific owners the evidence settles", () => {
  const owner = (id) => REST.find((r) => r.id === id)?.owner;
  // The postman pair ADR M0.3 §1 splits: the template is authoring, the
  // execution is a turn. Same URL prefix, different context.
  assert.equal(owner("PUT /api/v1/agent/postman-templates/:id"), "agents");
  assert.equal(owner("POST /api/v1/agent/postman-templates/:id/execute"), "conversations");
  assert.equal(owner("POST /api/v1/agent/eval-criteria"), "governance");
  assert.equal(owner("POST /api/v1/agent/golden-sets/:goldenSetId/run"), "governance");
  assert.equal(owner("GET /api/v1/agent/tool-calls"), "tools");
  assert.equal(owner("GET /api/v1/agent/secrets/status"), "secrets");
  assert.equal(owner("POST /api/v1/agent/durable-approvals/:token/resolve"), "jobs");
  assert.equal(owner("GET /api/v1/agent/activity/recent"), "observability");
  assert.equal(owner("GET /api/v1/agent/feature-flags"), "agents");
  assert.equal(owner("POST /internal/execute-tool"), "tools");
  assert.equal(owner("POST /internal/env/invalidate"), "providers");
  assert.equal(owner("POST /api/v1/agent/internal/skill-run"), "skills");
  assert.equal(owner("POST /api/v1/agent/internal/budget-alert"), "cost-monitoring");
  assert.equal(owner("POST /api/v1/agent/internal/durable-turn"), "conversations");
});

test("committed matrix: every MCP row is `tools`, the ADR M0.3 §1 row 7 merge", () => {
  assert.deepEqual([...new Set(MCP.map((r) => r.owner))], ["tools"]);
});

test("committed matrix: the rendered .md agrees with the .json it was built from", () => {
  assert.match(RENDERED, /generated by `scripts\/capability-matrix\.mjs`/u);
  assert.ok(
    RENDERED.includes(`${MATRIX.ownership.restRows} REST rows = ${MATRIX.ownership.oracleDerivedRestRows} resolved from the handler + ${MATRIX.ownership.pathPrefixRestRows} from the URL prefix.`),
    "the .md must restate the .json row split verbatim",
  );
  for (const [owner, count] of Object.entries(MATRIX.ownership.byOwner)) {
    assert.ok(
      RENDERED.includes(`| \`${owner}\` | ${count} |`),
      `the .md is missing the ${owner} row (${count})`,
    );
  }
});

// ── the recorded evidence is real ────────────────────────────────────────────

test("recorded evidence: every canonical row name exists in table-ownership.mjs", () => {
  for (const [id, entry] of Object.entries(ROUTE_OWNERSHIP)) {
    for (const model of [...entry.writes, ...entry.reads]) {
      assert.ok(model in OWNER, `${id} names "${model}", which is not a canonical row`);
    }
  }
});

test("recorded evidence: every writing row agrees with the ADR write-owner", () => {
  let writingRows = 0;
  for (const [id, entry] of Object.entries(ROUTE_OWNERSHIP)) {
    if (entry.writes.length === 0) continue;
    writingRows += 1;
    const owners = [...new Set(entry.writes.map((m) => OWNER[m]))];
    assert.equal(owners.length, 1, `${id} writes rows owned by ${owners.join(" and ")}`);
    assert.equal(owners[0], entry.owner, `${id} writes ${entry.writes.join(", ")}`);
  }
  // Not vacuous: most of the resolved rows do write something.
  assert.equal(writingRows, 20);
  assert.equal(Object.keys(ROUTE_OWNERSHIP).length, ORACLE_DERIVED_ROW_COUNT);
  assert.equal(ORACLE_DERIVED_ROW_COUNT, 42);
});

test("recorded evidence: every write-free row records a rationale", () => {
  const writeFree = Object.entries(ROUTE_OWNERSHIP).filter(([, e]) => e.writes.length === 0);
  assert.equal(writeFree.length, 22);
  for (const [id, entry] of writeFree) {
    assert.ok(entry.rationale.trim().length > 0, `${id} has no rationale`);
  }
});

// ── the generator cannot fall back ───────────────────────────────────────────

test("generator: an unresolved path throws instead of yielding a placeholder", () => {
  assert.throws(
    () => ownerForRoute("GET /api/v1/agent/no-such-surface", "/api/v1/agent/no-such-surface"),
    (err) => {
      assert.match(err.message, /no owner for GET \/api\/v1\/agent\/no-such-surface/u);
      assert.match(err.message, /There is no fallback value/u);
      assert.ok(
        !err.message.includes(RETIRED_OWNER_PLACEHOLDER),
        "the throw must not restate the retired value as an option",
      );
      return true;
    },
  );
});

// ── negative controls, one rule each ─────────────────────────────────────────

test("refuses the retired unresolved-owner placeholder, by its own name", () => {
  const row = cleanRow({ owner: RETIRED_OWNER_PLACEHOLDER });
  assert.deepEqual(failuresFor(row), [
    `owner-is-retired-placeholder: ${row.id} carries the placeholder WIN-256 retired; resolve it against the 89c12b8 oracle and record it in ROUTE_OWNERSHIP`,
  ]);
});

test("refuses a row with no owner at all", () => {
  const row = cleanRow({ owner: undefined });
  assert.deepEqual(failuresFor(row), [`owner-missing: ${row.id} has no owner`]);
});

test("refuses a row whose owner is the empty string", () => {
  const row = cleanRow({ owner: "   " });
  assert.deepEqual(failuresFor(row), [`owner-missing: ${row.id} has no owner`]);
});

test("refuses a misspelled context name", () => {
  const row = cleanRow({ owner: "governence" });
  const errors = failuresFor(row);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^owner-not-in-adr: /u);
  assert.ok(errors[0].includes('names "governence"'));
});

test("refuses a name ADR M0.3 §1 does not define, even a plausible one", () => {
  // `monitoring` is the grab-bag §1 split into three; it is not a context.
  const row = cleanRow({ owner: "monitoring" });
  const errors = failuresFor(row);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^owner-not-in-adr: /u);
  // platform-kernel owns no capability row either.
  const kernel = failuresFor(cleanRow({ owner: "platform-kernel" }));
  assert.equal(kernel.length, 1);
  assert.match(kernel[0], /^owner-not-in-adr: /u);
});

test("refuses the non-context value on a row that WRITES a canonical row", () => {
  // The admission rule's whole point: a row with an owner may not opt out.
  const row = cleanRow({
    id: "GET /api/health",
    owner: PLATFORM_TRANSPORT,
    canonicalWrites: ["Thread"],
    canonicalReads: [],
  });
  // Two independent rules catch it, and both name the row: the admission rule,
  // and the ADR cutting rule that Thread has a writer and it is not this.
  assert.deepEqual(failuresFor(row), [
    `transport-touches-canonical-row: GET /api/health claims ${PLATFORM_TRANSPORT} but records writes [Thread] and reads []; a row that touches a canonical row has a context that owns it`,
    `write-owner-mismatch: GET /api/health names "${PLATFORM_TRANSPORT}" but writes Thread, owned by "conversations" in table-ownership.mjs`,
  ]);
});

test("refuses the non-context value on a row that READS a canonical row", () => {
  const row = cleanRow({
    id: "GET /metrics",
    owner: PLATFORM_TRANSPORT,
    canonicalWrites: [],
    canonicalReads: ["Budget"],
  });
  assert.deepEqual(failuresFor(row), [
    `transport-touches-canonical-row: GET /metrics claims ${PLATFORM_TRANSPORT} but records writes [] and reads [Budget]; a row that touches a canonical row has a context that owns it`,
  ]);
});

test("refuses the non-context value on a row outside the pinned enumeration", () => {
  const row = cleanRow({
    id: "GET /api/v1/agent/tool-calls",
    owner: PLATFORM_TRANSPORT,
    canonicalWrites: [],
    canonicalReads: [],
    ownerRationale: "recorded",
  });
  assert.deepEqual(failuresFor(row), [
    `transport-not-admitted: GET /api/v1/agent/tool-calls claims ${PLATFORM_TRANSPORT} but is not in PLATFORM_TRANSPORT_ROWS`,
  ]);
});

test("refuses quietly moving a pinned non-context row onto a context", () => {
  const row = cleanRow({
    id: "GET /openapi",
    owner: "tenancy",
    canonicalWrites: [],
    canonicalReads: [],
  });
  assert.deepEqual(failuresFor(row), [
    "transport-row-reassigned: GET /openapi is in PLATFORM_TRANSPORT_ROWS but names \"tenancy\"",
  ]);
});

test("refuses an owner that disagrees with the ADR write-owner of what it writes", () => {
  // Thread is `conversations` in table-ownership.mjs; claiming `memory` fails.
  const row = cleanRow({ owner: "memory", canonicalWrites: ["Thread"] });
  assert.deepEqual(failuresFor(row), [
    `write-owner-mismatch: ${row.id} names "memory" but writes Thread, owned by "conversations" in table-ownership.mjs`,
  ]);
});

test("refuses a row that writes canonical rows owned by two contexts", () => {
  const row = cleanRow({ owner: "conversations", canonicalWrites: ["Thread", "Budget"] });
  const errors = failuresFor(row);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^write-owner-split: /u);
  assert.ok(errors[0].includes("conversations and cost-monitoring"));
});

test("refuses a canonical row name that is not in table-ownership.mjs", () => {
  const row = cleanRow({ canonicalWrites: ["EvalCriterion"], canonicalReads: ["Threadd"] });
  assert.deepEqual(failuresFor(row), [
    `unknown-canonical-row: ${row.id} lists "Threadd" in canonicalReads, which is not a row in table-ownership.mjs`,
  ]);
});

test("refuses an evidenced write-free row that records no rationale", () => {
  const row = cleanRow({ canonicalWrites: [], canonicalReads: [], ownerRationale: "" });
  assert.deepEqual(failuresFor(row), [
    `rationale-missing: ${row.id} writes no canonical row, so its owner rests on a rationale, and none is recorded`,
  ]);
});

test("every rule has its own message, so two defects are never confused", () => {
  const ids = validateOwners(
    [
      cleanRow({ id: "A", owner: RETIRED_OWNER_PLACEHOLDER }),
      cleanRow({ id: "B", owner: undefined }),
      cleanRow({ id: "C", owner: "not-a-context" }),
      cleanRow({ id: "D", owner: "memory", canonicalWrites: ["Thread"] }),
      cleanRow({ id: "E", canonicalWrites: [], canonicalReads: [], ownerRationale: "" }),
      cleanRow({ id: "GET /openapi", owner: "tenancy", canonicalWrites: [], canonicalReads: [] }),
    ],
    [],
  ).map((e) => e.split(":")[0]);
  assert.deepEqual(ids, [
    "owner-is-retired-placeholder",
    "owner-missing",
    "owner-not-in-adr",
    "write-owner-mismatch",
    "rationale-missing",
    "transport-row-reassigned",
  ]);
  assert.equal(new Set(ids).size, ids.length);
});
