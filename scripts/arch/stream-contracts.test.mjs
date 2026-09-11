// THE SECOND RECONCILIATION FOR `stream-contracts`, AND ITS NON-VACUITY CONTROLS.
//
// `audit:v1-ledger` was green through every commit of a tranche while
// `scripts/v1-ledger.test.mjs` was red, and that is the lesson this file is built
// on: a gate whose only evidence is its own green run has not been shown to be
// able to fail. Every rule below is exercised twice — once against the live tree,
// and once against a copy with ONE thing changed — so a rule that had stopped
// biting would fail here rather than pass quietly.
//
// THE MUTATIONS ARE APPLIED TO A COPY OF THE REAL TREE. A fixture tree would prove
// the rules can fail against a fixture; these prove they can fail against THIS
// repository, which is the claim that matters. The copy is made with `cp -R` of
// only the paths each rule reads, because copying the whole tree per case would
// cost minutes.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditStreamContracts,
  buildInventory,
  canonicalTerminals,
  CONTRACT_ADR,
  declaredFamilies,
  declaredSseTurnEvents,
  emissionsIn,
  INVENTORY_PATH,
  RULES,
  SCANNED_ROOTS,
  scanEmissions,
  SSE_EVENT_CHANNEL_DIR,
  sseEventChannelNames,
  SSE_TURN_EVENT_COUNT,
  SV_LITERAL_ROOTS,
  TERMINAL_TYPES_WITHOUT_A_PRODUCER,
  vocabularyFamilies,
  vocabularySseTurnEvents,
  vocabularyTerminals,
  VOCABULARY_MODULE,
} from "./stream-contracts.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The paths every rule reads. A copy of these is a copy of the gate's world. */
const COPIED = [
  CONTRACT_ADR,
  VOCABULARY_MODULE,
  INVENTORY_PATH,
  "apps/agent/src",
  "apps/core-api/src/transports",
];

function copyPaths(paths) {
  const root = mkdtempSync(join(tmpdir(), "stream-contracts-"));
  for (const path of paths) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repositoryRoot, path), destination, { recursive: true });
  }
  return root;
}

function realTreeCopy() {
  return copyPaths(COPIED);
}

/** The same copy plus the whole kernel source, for the two S2 sweep cases. */
function realTreeCopyWithKernel() {
  return copyPaths([...COPIED, "packages/kernel/src"]);
}

function edit(root, path, mutate) {
  const absolute = join(root, path);
  writeFileSync(absolute, mutate(readFileSync(absolute, "utf8")));
}

function problemsFor(root) {
  return auditStreamContracts(root).problems;
}

// ---------------------------------------------------------------------------
// The live tree, and the shape of what the gate reads.
// ---------------------------------------------------------------------------

test("the live tree passes, and the gate reads a NONZERO vocabulary", () => {
  const result = auditStreamContracts(repositoryRoot);
  assert.deepEqual(result.problems, []);
  // NON-VACUITY. A scan that matched nothing would satisfy every rule below by
  // finding no counterexample, which is precisely how a gate stops meaning
  // anything. Both kinds must be present and the families must be the five.
  const socketEvents = result.rows.filter((row) => row.kind === "socket-event");
  const frameTypes = result.rows.filter((row) => row.kind === "frame-type");
  assert.ok(socketEvents.length >= 10, `only ${String(socketEvents.length)} socket event name(s)`);
  assert.ok(frameTypes.length >= 4, `only ${String(frameTypes.length)} frame type(s)`);
  assert.equal(result.families.length, 5);
  assert.equal(RULES.length, 6);
});

test("both lanes are represented, so neither half of the surface is invisible", () => {
  // The whole point of a SECOND scan root: a gate that only reached `apps/agent`
  // would have said nothing about the canonical lane, and one that only reached
  // `apps/core-api` would have left the live vocabulary unenumerated.
  const { rows } = scanEmissions(repositoryRoot);
  const lanes = new Set(rows.map((row) => row.lane));
  assert.deepEqual([...lanes].sort(), SCANNED_ROOTS.map((root) => root.id).sort());
});

test("the inventory on disk is byte-identical to a fresh build", () => {
  const committed = readFileSync(join(repositoryRoot, INVENTORY_PATH), "utf8");
  assert.equal(committed, `${JSON.stringify(buildInventory(repositoryRoot), null, 2)}\n`);
});

test("the ADR and the vocabulary agree, and the ADR is the authority", () => {
  const adr = declaredFamilies(repositoryRoot);
  assert.deepEqual(adr, vocabularyFamilies(repositoryRoot));
  // NAMED rather than counted, so a family renamed in both places at once — which
  // S1 could not see — fails here.
  assert.deepEqual(adr, [
    "ws.agent_event",
    "sse.turn",
    "webhook.ingest",
    "internal.callback",
    "trigger.payload",
  ]);
});

// ---------------------------------------------------------------------------
// S1 — the families
// ---------------------------------------------------------------------------

test("S1 fails when the vocabulary gains a family the ADR does not name", () => {
  const root = realTreeCopy();
  edit(root, VOCABULARY_MODULE, (source) =>
    // ANCHORED ON THE FOURTH FAMILY AND NOT THE FIFTH, deliberately. The fifth
    // name carries a word the vocabulary boundary refuses, and spelling it here
    // would have needed two more reviewed exceptions for a mutation that works
    // just as well one line earlier.
    source.replace('  "internal.callback",\n', '  "internal.callback",\n  "grpc.stream",\n'),
  );
  assert.ok(problemsFor(root).some((problem) => problem.startsWith("S1 ")));
  rmSync(root, { recursive: true, force: true });
});

test("S1 fails when the ADR names a family the vocabulary drops", () => {
  const root = realTreeCopy();
  edit(root, VOCABULARY_MODULE, (source) => source.replace('  "internal.callback",\n', ""));
  assert.ok(problemsFor(root).some((problem) => problem.startsWith("S1 ")));
  rmSync(root, { recursive: true, force: true });
});

test("S1 fails when the ADR stops stating the families inline", () => {
  // The gate's own input can go away. A rule that parsed nothing and reported
  // nothing would be the silent failure this case exists to prevent.
  const root = realTreeCopy();
  edit(root, CONTRACT_ADR, (source) => source.replace("per envelope family**", "per envelope grouping**"));
  assert.ok(problemsFor(root).some((problem) => problem.includes("no longer states the envelope families")));
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// S2 — one place for the major
// ---------------------------------------------------------------------------

test("S2 fails on a second `sv` literal anywhere in the scanned roots", () => {
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/ws/sse.ts", (source) =>
    `${source}\nexport const SNEAKY_FRAME = { sv: 1, t: "x", seq: 1, ts: 0, fields: {} };\n`,
  );
  const problems = problemsFor(root);
  assert.ok(problems.some((problem) => problem.startsWith("S2 ") && problem.includes("sse.ts")));
  rmSync(root, { recursive: true, force: true });
});

test("S2's sweep REACHES the kernel, which its exemption would otherwise make vacuous", () => {
  // THE HOLE THE FIRST DRAFT OF THIS GATE HAD. The exemption for the declaring
  // module was dead code, because the module lived in no scanned root — so the case
  // asserting the exemption passed for the wrong reason and a second `sv` literal
  // beside the constant would have been invisible. Both halves are asserted now:
  // the sweep root list CONTAINS the kernel, and a literal added to a kernel file
  // that is NOT the declaring module fails.
  assert.ok(SV_LITERAL_ROOTS.some((directory) => VOCABULARY_MODULE.startsWith(directory)));
  const root = realTreeCopyWithKernel();
  edit(root, "packages/kernel/src/vo/retry.ts", (source) => `${source}\nexport const FRAME = { sv: 1 };\n`);
  assert.ok(problemsFor(root).some((problem) => problem.startsWith("S2 ") && problem.includes("retry.ts")));
  rmSync(root, { recursive: true, force: true });
});

test("S2 does NOT fire on the module that declares the constant", () => {
  // The exemption is one FILE and not a directory, and this is what says it is
  // narrow rather than a hole: the file beside it in the same package IS held, by
  // the case above.
  const root = realTreeCopyWithKernel();
  edit(root, VOCABULARY_MODULE, (source) => `${source}\nconst UNRELATED = { sv: 1 };\nvoid UNRELATED;\n`);
  assert.ok(!problemsFor(root).some((problem) => problem.startsWith("S2 ")));
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// S3 — terminal frames
// ---------------------------------------------------------------------------

test("S3 fails when the canonical lane emits a terminal type the kernel does not declare", () => {
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/ws/streams.controller.ts", (source) =>
    source.replace('t: "stream.error"', 't: "stream.exploded"'),
  );
  assert.ok(problemsFor(root).some((problem) => problem.startsWith("S3 ")));
  rmSync(root, { recursive: true, force: true });
});

test("S3 fails when the transport's fault table is removed, so no ending carries a code", () => {
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/ws/streams.controller.ts", (source) =>
    source.replace("export const TERMINAL_FAULTS", "const REMOVED_TERMINAL_FAULTS"),
  );
  assert.ok(problemsFor(root).some((problem) => problem.includes("declares no TERMINAL_FAULTS table")));
  rmSync(root, { recursive: true, force: true });
});

test("S3 fails when a terminal type gains a producer while still declared unreachable", () => {
  // THE HALF THAT MAKES THE EXCEPTION SELF-INVALIDATING. `turn.done` is excused
  // because no composed producer can write it in this build; the day one does,
  // the reason recorded beside it has expired and the gate says so.
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/ws/streams.controller.ts", (source) =>
    `${source}\nexport const FUTURE_DONE = { t: "turn.done" };\n`,
  );
  const problems = problemsFor(root);
  assert.ok(problems.some((problem) => problem.includes("IS emitted now")));
  rmSync(root, { recursive: true, force: true });
});

test("S3's excused list names only real terminal types", () => {
  const terminals = vocabularyTerminals(repositoryRoot);
  for (const excused of TERMINAL_TYPES_WITHOUT_A_PRODUCER) assert.ok(terminals.includes(excused), excused);
  // AND IT IS NOT THE WHOLE LIST. If every terminal type were excused, S3's
  // reachability half would be vacuous.
  assert.ok(TERMINAL_TYPES_WITHOUT_A_PRODUCER.length < terminals.length);
  assert.equal(canonicalTerminals(repositoryRoot).frameType, "stream.error");
});

// ---------------------------------------------------------------------------
// S4 — the orphan check, in both directions
// ---------------------------------------------------------------------------

test("S4 fails on a NEW socket event with no inventory row", () => {
  const root = realTreeCopy();
  edit(root, "apps/agent/src/connections/connections.gateway.ts", (source) =>
    source.replace(
      'emit("joined_thread"',
      'emit("undeclared_frame", { type: "surprise" });\n      client.emit("joined_thread"',
    ),
  );
  const problems = problemsFor(root);
  assert.ok(problems.some((problem) => problem.includes('socket-event "undeclared_frame"')));
  // AND THE FRAME TYPE INSIDE IT IS CAUGHT SEPARATELY, which is what makes the
  // two kinds two rows rather than one.
  assert.ok(problems.some((problem) => problem.includes('frame-type "surprise"')));
  rmSync(root, { recursive: true, force: true });
});

test("S4 fails on an inventory row whose emitter was DELETED", () => {
  // The direction a one-way gate misses, and the one the ADR names explicitly:
  // "every emitted `t` has a contract entry & vice-versa".
  const root = realTreeCopy();
  edit(root, INVENTORY_PATH, (source) => {
    const inventory = JSON.parse(source);
    inventory.rows.push({
      lane: "agent",
      kind: "socket-event",
      name: "retired_event",
      family: "ws.agent_event",
      sites: ["apps/agent/src/connections/connections.gateway.ts:1"],
    });
    return `${JSON.stringify(inventory, null, 2)}\n`;
  });
  assert.ok(problemsFor(root).some((problem) => problem.includes("retired_event")));
  rmSync(root, { recursive: true, force: true });
});

test("S4 fails when an emitter is deleted and the row is left behind", () => {
  const root = realTreeCopy();
  edit(root, "apps/agent/src/connections/connections.gateway.ts", (source) =>
    source.replace('emit("joined_thread", { threadId: data.threadId })', "emit(\"error\", {})"),
  );
  assert.ok(problemsFor(root).some((problem) => problem.includes("joined_thread")));
  rmSync(root, { recursive: true, force: true });
});

test("S4 counts SITES and not only names, so a lost emitter of a kept name fails", () => {
  // `error` is emitted from sixteen places. A gate that compared only the SET of
  // names would not notice fifteen of them going away.
  const root = realTreeCopy();
  edit(root, "apps/agent/src/connections/connections.gateway.ts", (source) =>
    source.replace('emit("error", { message: "Not authenticated" })', "emit(\"connected\", {})"),
  );
  assert.ok(problemsFor(root).some((problem) => problem.includes("is emitted at")));
  rmSync(root, { recursive: true, force: true });
});

test("S4 fails when the inventory is missing entirely", () => {
  const root = realTreeCopy();
  rmSync(join(root, INVENTORY_PATH));
  assert.ok(problemsFor(root).some((problem) => problem.includes("absent or unreadable")));
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// S5 — lanes and families on every row
// ---------------------------------------------------------------------------

test("S5 fails on a row whose family is not one of the five", () => {
  const root = realTreeCopy();
  edit(root, INVENTORY_PATH, (source) => source.replace('"family": "ws.agent_event"', '"family": "ws.legacy"'));
  assert.ok(problemsFor(root).some((problem) => problem.startsWith("S5 ")));
  rmSync(root, { recursive: true, force: true });
});

test("S5 fails on a row whose lane is not scanned", () => {
  const root = realTreeCopy();
  edit(root, INVENTORY_PATH, (source) => source.replace('"lane": "core-api"', '"lane": "webapp"'));
  assert.ok(problemsFor(root).some((problem) => problem.startsWith("S5 ")));
  rmSync(root, { recursive: true, force: true });
});

test("S5 REFUSES an inventory that carries its own copy of the family names", () => {
  // The rule is a refusal rather than a comparison, and the reason is worth a case:
  // a copy of the five names in a GENERATED artifact is a second list to keep true,
  // and it would put a word the vocabulary boundary refuses into a file nobody
  // writes by hand — so nobody would ever review the exception it needed. The first
  // draft of this gate did exactly that and `audit:vocabulary` caught it.
  const root = realTreeCopy();
  edit(root, INVENTORY_PATH, (source) => {
    const inventory = JSON.parse(source);
    inventory.families = ["ws.agent_event"];
    return `${JSON.stringify(inventory, null, 2)}\n`;
  });
  assert.ok(problemsFor(root).some((problem) => problem.includes("carries its own family list")));
  rmSync(root, { recursive: true, force: true });
});

test("the committed inventory carries no family list", () => {
  const inventory = JSON.parse(readFileSync(join(repositoryRoot, INVENTORY_PATH), "utf8"));
  assert.equal(inventory.families, undefined);
});

// ---------------------------------------------------------------------------
// The scan's own judgements
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// S6 — the nine SSE turn event names, and the one spelling
// ---------------------------------------------------------------------------
//
// THE DIVERGENCE THIS RULE CLOSED. The ADR wrote `stream_offline` and the kernel
// wrote `stream.offline`, and nothing pinned either, so both could have lived
// forever. The tie was settled by COUNTING: `stream_offline` occurred once in the
// repository — in the ADR cell — with no producer, no consumer, no test and no SDK,
// while `stream.offline` occurred fifteen times including `classifyStreamEnd`'s own
// branch. Changing the shipped name is the breaking change, so the document moved
// and D9 records it. These cases are what stops the pair coming back.

test("the ADR's nine SSE event names and SSE_TURN_EVENTS are the same set", () => {
  const adr = declaredSseTurnEvents(repositoryRoot);
  const module = vocabularySseTurnEvents(repositoryRoot);
  assert.equal(adr.length, SSE_TURN_EVENT_COUNT);
  assert.deepEqual([...adr].sort(), [...(module ?? [])].sort());
  // NAMED, not counted, so a rename landed in BOTH places at once — which the set
  // comparison cannot see — fails here. This is the list a reader can check against
  // the ADR cell by eye.
  assert.deepEqual([...adr].sort(), [
    "assistant.delta",
    "message_persisted",
    "meta",
    "reasoning.delta",
    "stream.offline",
    "stream_meta",
    "tool_call.result",
    "tool_call.start",
    "turn.done",
  ]);
  // AND THE SPELLING THAT LOST IS GONE FROM THE ROW. A cell that reverted to the
  // underscore would still parse to nine names and still match a kernel that
  // reverted with it, so the losing spelling is refused by name — in the ROW, which
  // is where the contract is stated. §7's D9 correction names it on purpose, and
  // that record is the reason a later reader does not re-litigate the choice.
  const adrSource = readFileSync(join(repositoryRoot, CONTRACT_ADR), "utf8");
  const sseRow = adrSource.split("\n").find((line) => line.startsWith("| **SSE**"));
  assert.ok(sseRow !== undefined);
  assert.ok(!sseRow.includes("stream_offline"), sseRow);
  assert.ok(!sseRow.includes("replayCursor"), sseRow);
  assert.ok(adrSource.includes("D9 \u2014 CORRECTED (M4 finish)"), "the correction record is missing");
});

test("S6 fails when the ADR renames an SSE event the kernel still declares", () => {
  const root = realTreeCopy();
  edit(root, CONTRACT_ADR, (source) => source.replace("`assistant.delta`", "`assistant_delta`"));
  const problems = problemsFor(root);
  assert.ok(
    problems.some((problem) => problem.startsWith("S6") && problem.includes("assistant.delta")),
    problems.join("\n"),
  );
});

test("S6 fails when the ADR's cell gains a TENTH name", () => {
  const root = realTreeCopy();
  edit(root, CONTRACT_ADR, (source) =>
    source.replace("`message_persisted`", "`message_persisted` + `message_recalled`"),
  );
  const problems = problemsFor(root);
  assert.ok(
    problems.some((problem) => problem.startsWith("S6") && problem.includes("10 event(s)")),
    problems.join("\n"),
  );
});

test("S6 fails when the kernel declares a name the ADR does not", () => {
  const root = realTreeCopy();
  edit(root, VOCABULARY_MODULE, (source) =>
    source.replace('  "message_persisted",\n', '  "message_persisted",\n  "message.recalled",\n'),
  );
  const problems = problemsFor(root);
  assert.ok(
    problems.some((problem) => problem.startsWith("S6") && problem.includes("message.recalled")),
    problems.join("\n"),
  );
});

test("S6 fails when a PRODUCER emits an sse.turn frame type nothing accepted", () => {
  const root = realTreeCopy();
  // A frame type, on the canonical lane, that is neither one of the nine nor a
  // declared terminal. The inventory row is added too, so S4 stays silent and the
  // failure is S6's alone.
  edit(root, "apps/core-api/src/transports/ws/sse.ts", (source) =>
    `${source}\nexport const INVENTED = { t: "turn.paused" };\n`,
  );
  edit(root, INVENTORY_PATH, (source) => {
    const inventory = JSON.parse(source);
    inventory.rows.push({
      lane: "core-api",
      kind: "frame-type",
      name: "turn.paused",
      family: "sse.turn",
      sites: ["apps/core-api/src/transports/ws/sse.ts:0"],
    });
    return `${JSON.stringify(inventory, null, 2)}\n`;
  });
  const problems = problemsFor(root);
  assert.ok(
    problems.some((problem) => problem.startsWith("S6") && problem.includes("turn.paused")),
    problems.join("\n"),
  );
});

test("S6 reaches the SSE `event:` channel, which no other rule can see", () => {
  // `encodeStreamMeta` writes its name into a template literal, so `scanEmissions`
  // — which looks for `.emit(` and `t:` — never sees it. Before this rule the one
  // name the canonical lane puts on SSE's own channel was outside every check.
  const channels = sseEventChannelNames(repositoryRoot);
  assert.deepEqual(
    channels.map((channel) => channel.name),
    ["stream_meta"],
  );
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/ws/sse.ts", (source) =>
    source.replace("`event: stream_meta\\ndata:", "`event: stream_header\\ndata:"),
  );
  const problems = problemsFor(root);
  assert.ok(
    problems.some((problem) => problem.startsWith("S6") && problem.includes("stream_header")),
    problems.join("\n"),
  );
});

test("S6 refuses a channel scan that finds NOTHING rather than calling it clean", () => {
  const root = realTreeCopy();
  edit(root, "apps/core-api/src/transports/ws/sse.ts", (source) =>
    source.replace("`event: stream_meta\\ndata:", "`data:"),
  );
  const problems = problemsFor(root);
  assert.ok(
    problems.some((problem) => problem.startsWith("S6") && problem.includes("stopped looking")),
    problems.join("\n"),
  );
});

test("S6 does NOT fire on the MCP lane's own `event:` names, which are a different vocabulary", () => {
  // `apps/agent`'s MCP controllers write `event: endpoint`, `event: message` and
  // `event: hello` — JSON-RPC over SSE, not the turn stream. Holding them to the
  // turn lane's nine names would report a violation that is not one, so the scan is
  // scoped to the directory that IS the turn lane.
  const mcpNames = readFileSync(
    join(repositoryRoot, "apps/agent/src/mcp-platform/mcp-entity.controller.ts"),
    "utf8",
  );
  assert.ok(mcpNames.includes("event: endpoint"), "the fixture assumes the MCP lane writes event: lines");
  assert.ok(SSE_EVENT_CHANNEL_DIR.startsWith("apps/core-api/src/transports/ws"));
  assert.deepEqual(problemsFor(repositoryRoot), []);
});

test("a `type` OUTSIDE an emit is not a frame, and a `t` anywhere is", () => {
  // THE ONE JUDGEMENT IN THE SCAN, asserted rather than described. `type` is one
  // of the most common property names in any TypeScript tree, so collecting it
  // outside an `emit` payload registered an alert channel's probe body as a stream
  // frame on the first run of this gate. `t` is the canonical envelope's own field
  // and is collected wherever it appears, because the canonical lane builds frames
  // in factories that RETURN them.
  const emitted = emissionsIn(repositoryRoot, "apps/core-api/src/transports/ws/streams.controller.ts");
  assert.ok(emitted.some((row) => row.kind === "frame-type" && row.name === "stream.error"));
  const alerts = emissionsIn(repositoryRoot, "apps/agent/src/mcp-platform/tools/alert_channels.ts");
  assert.deepEqual(alerts, []);
});

test("a COMPUTED event name is recorded rather than skipped", () => {
  // The gateway relays `payload.event`, so the set of names it can emit is decided
  // elsewhere. A scan that dropped the site would report a smaller vocabulary than
  // the lane has, which is the opposite of what this gate is for.
  const { rows } = scanEmissions(repositoryRoot);
  assert.ok(rows.some((row) => row.kind === "socket-event" && row.name === "<computed>"));
});

test("a suite is not a producer", () => {
  // Every stream vocabulary here has a suite that names its own fixtures, and
  // holding those to the inventory would register frame types nothing serves.
  const { rows } = scanEmissions(repositoryRoot);
  for (const row of rows) {
    for (const site of row.sites) assert.ok(!site.includes(".test."), site);
  }
});
