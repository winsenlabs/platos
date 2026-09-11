#!/usr/bin/env node
// THE STREAM-CONTRACT DRIFT CHECK. M0.4 §2 names it and it did not exist.
//
// The ADR's own drift-check column for the WS and SSE rows says:
//
//   "`check:stream-contracts`: AST-walk all `.emit(` sites -> every emitted `t`
//    has a contract entry & vice-versa (orphan = fail)"
//
// Nothing in this repository did that. The consequence is measurable rather than
// theoretical: the live gateway emits socket events and frame types that appear in
// no document, no census and no test, so the streaming vocabulary was whatever the
// last person to add an `.emit(` decided. A contract nobody enumerates is not a
// contract.
//
// -----------------------------------------------------------------------------
// FIVE RULES, AND EVERY ONE OF THEM JOINS TO SOMETHING THIS SCRIPT DOES NOT OWN
//
//   S1  The five envelope families in `packages/kernel/src/vo/stream-frame.ts` are
//       EXACTLY the five ADR M0.4 §1.2 names, parsed out of the accepted document
//       on disk. A sixth lane added to the tree without moving the ADR fails here.
//       This rule lives in a script rather than in the kernel's own suite because
//       `kernel-content` rule K1 forbids a kernel test from importing `node:fs` —
//       reading a document is exactly the ambient dependency the kernel is a leaf
//       to avoid.
//
//   S2  The stream MAJOR is written ONCE. No file in the scanned roots may hold an
//       `sv:` property with a numeric literal except the kernel module that
//       declares the constant. This is the same structural rule M0.4 D1 imposes on
//       the REST prefix — "the break axis is structural, not a string" — and the
//       same one `no-bare-prefix` enforces for `api/v1`.
//
//   S3  Every terminal frame type the CANONICAL lane can put on the wire is a
//       member of the kernel's `TERMINAL_FRAME_TYPES`, and every member of that
//       list is reachable from some producer or transport. Read back from the
//       transport's own fault table, so a code added there without a frame type,
//       or a frame type nothing can emit, both fail.
//
//   S4  THE ORPHAN CHECK, in BOTH directions, against a committed inventory:
//       every socket event name and every frame type literal the scanned roots
//       emit has a row, and every row is still emitted. This is the rule the ADR
//       asked for, and it is what makes the LEGACY vocabulary visible: the
//       inventory is the first complete census of what the live lanes put on a
//       wire.
//
//   S5  Every row declares which LANE emits it and which envelope FAMILY it
//       belongs to, and a row whose family is not one of the five fails. A census
//       that recorded names without families would not be a version contract.
//
// -----------------------------------------------------------------------------
// WHAT IT DOES NOT CLAIM
//
// It does not claim the legacy lanes are CORRECT. NOT ONE of the eleven socket
// event names it records carries a sequence — `seq` does not appear as a frame
// field anywhere in `connections.gateway.ts` — so no browser on that lane can tell
// a dropped frame from no frame, and one of the eleven is `<computed>`: the gateway
// relays `payload.event`, so the set it can emit is decided by whatever publishes
// to it. Those are findings this inventory makes VISIBLE and this tranche does not
// fix. What the rule buys is that the set cannot grow silently, and that the
// canonical lane's vocabulary is joined to the same document the legacy one is
// measured against.
//
//   node scripts/arch/stream-contracts.mjs           # check, exit 1 on drift
//   node scripts/arch/stream-contracts.mjs --write   # regenerate the inventory
//   node scripts/arch/stream-contracts.mjs --json    # machine-readable

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The accepted document the family names come from. Never a list written here. */
export const CONTRACT_ADR = "docs/adr/M0.4-contract-versioning.md";

/** Where the vocabulary constant lives. The ONE place `sv` may be a literal. */
export const VOCABULARY_MODULE = "packages/kernel/src/vo/stream-frame.ts";

/** The committed census this gate joins the tree to. */
export const INVENTORY_PATH = "docs/audits/M4.6-stream-vocabulary.json";

/**
 * The roots that may put a frame on a wire.
 *
 * `apps/webapp` IS DELIBERATELY ABSENT AND THAT IS NOT AN OVERSIGHT. Its public
 * guest and embed routes are a PROXY: `api.v1.public.agents.$agentId.chat.
 * stream.ts` copies the upstream body through untouched, so it emits no frame type
 * of its own and a rule that scanned it would find nothing and prove nothing.
 * Whatever the SSE lane's vocabulary is, theirs is the same one.
 */
export const SCANNED_ROOTS = [
  { id: "agent", dir: "apps/agent/src" },
  { id: "core-api", dir: "apps/core-api/src/transports" },
];

/**
 * Where S2 looks for a second `sv` literal. WIDER than the emission roots, and
 * the difference is the whole value of the rule.
 *
 * The emission scan asks "what does a lane put on a wire", so it reads the two
 * lanes. S2 asks "is the major written once", and the file most likely to hold a
 * second copy is the one NEXT TO the declaration — a helper in
 * `packages/kernel/src/vo/` that built a frame with `sv: 1` inline would be
 * invisible to a rule that only walked the apps. The FIRST draft of this gate had
 * exactly that hole: its exemption for the declaring module was dead code, because
 * the module was not in any scanned root, so the case asserting the exemption
 * passed for the wrong reason.
 */
export const SV_LITERAL_ROOTS = [
  "apps/agent/src",
  "apps/core-api/src/transports",
  "packages/kernel/src",
];

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/**
 * The terminal frame types NOTHING IN THIS TREE CAN WRITE, and why.
 *
 * A LIST WITH TWO REASONS RATHER THAN A RELAXED RULE, and it is read back in both
 * directions so neither reason can quietly stop being true.
 *
 * `turn.done` is the terminal frame a COMPLETED TURN carries, and the party that
 * writes it is the turn engine. `conversations` is on
 * `UNIMPORTABLE_CONTEXT_FACTORIES`, so it cannot be composed in `apps/core-api` at
 * all, and the legacy lane spells the same outcome `done` rather than `turn.done` —
 * which is the rename M0.4 §2 pins and this tranche does not perform. The
 * canonical name is therefore written by the journal's PRODUCER, and in this build
 * the only producer is a test. The day a composed engine emits it, the second half
 * of S3 fails and this entry has to go.
 *
 * `stream.offline` is the frame M0.4 §2 gives the guest and embed lanes for
 * kept-message replay, and the canonical lane deliberately writes NOTHING on the
 * two endings it would fit — a client that went away has nobody to read it, and a
 * consumer too slow to drain is one this process cannot write to at all. It is in
 * the vocabulary because a CLIENT must be able to classify one (`classifyStreamEnd`
 * answers `interrupted` for it, the only resumable terminal frame), and a reader
 * has to handle a frame a future producer sends whether or not this build sends it.
 */
export const TERMINAL_TYPES_WITHOUT_A_PRODUCER = ["turn.done", "stream.offline"];

/**
 * How many event names ADR M0.4 §2's SSE row specifies.
 *
 * A NUMBER, HERE, SO THE PARSE CANNOT SILENTLY FIND FEWER. Every other half of S6 is
 * a set comparison between the document and the kernel, and two comparisons between
 * two empty sets both pass — which is exactly how a gate goes green for the wrong
 * reason. This is the non-vacuity floor and it is deliberately NOT derived from
 * either side: if the ADR's cell changes, this number is the line a reviewer has to
 * move by hand, and moving it is the moment somebody asks whether a superseding
 * record is owed.
 */
export const SSE_TURN_EVENT_COUNT = 9;

export const RULES = [
  { id: "S1", description: "the envelope families are exactly ADR M0.4 §1.2's five" },
  { id: "S2", description: "the stream major is a literal in one module and nowhere else" },
  { id: "S3", description: "the canonical lane's terminal frames are the kernel's, and each is reachable" },
  { id: "S4", description: "every emitted name has an inventory row and every row is still emitted" },
  { id: "S5", description: "every inventory row names a lane and one of the five families" },
  { id: "S6", description: "the SSE turn vocabulary is exactly ADR M0.4 section 2's nine names" },
];

function listSourceFiles(root, directory) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      // A SUITE IS NOT A PRODUCER. Every stream vocabulary in this repository has
      // a suite that names its own fixtures, and holding those to the inventory
      // would register frame types nothing serves — the same reason
      // `error-taxonomy.mjs` skips `.test.` and `/testing/`.
      if (entry.name.includes(".test.")) continue;
      if (absolute.includes(`${join("", "testing")}`)) continue;
      found.push(relative(root, absolute).split("\\").join("/"));
    }
  };
  walk(join(root, directory));
  return found.sort();
}

/** The five family names, parsed out of the ADR's own §1.2 sentence. */
export function declaredFamilies(root = repositoryRoot) {
  const adr = readFileSync(join(root, CONTRACT_ADR), "utf8");
  const sentence = /per envelope family\*\* \(([^)]*)\)/u.exec(adr);
  if (sentence === null) return null;
  return [...(sentence[1] ?? "").matchAll(/`([a-z_.]+)`/gu)].map((match) => match[1]);
}

/** The families the vocabulary module freezes, read out of its own array. */
export function vocabularyFamilies(root = repositoryRoot) {
  const source = readFileSync(join(root, VOCABULARY_MODULE), "utf8");
  const block = /export const STREAM_ENVELOPE_FAMILIES = Object\.freeze\(\[([\s\S]*?)\] as const\);/u.exec(
    source,
  );
  if (block === null) return null;
  return [...(block[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The terminal frame types the vocabulary module freezes. */
export function vocabularyTerminals(root = repositoryRoot) {
  const source = readFileSync(join(root, VOCABULARY_MODULE), "utf8");
  const block = /export const TERMINAL_FRAME_TYPES = Object\.freeze\(\[([\s\S]*?)\] as const\);/u.exec(
    source,
  );
  if (block === null) return null;
  return [...(block[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/**
 * THE NINE SSE TURN EVENT NAMES, PARSED OUT OF ADR M0.4 §2's SSE ROW.
 *
 * WHY THE DOCUMENT AND NOT A LIST HERE. This is rule S1's argument applied to the
 * vocabulary rather than to the families: the nine names lived in ONE table cell of
 * one document and nowhere in the tree, so a producer could emit a tenth, a rename
 * could land, and nothing could compare the two. Reading them back out of the cell
 * makes the ADR the authority and the kernel's `SSE_TURN_EVENTS` the claim.
 *
 * THE PARSE IS POSITIONAL, NOT A GREP FOR PLAUSIBLE WORDS. The row's cells are
 * `|`-separated, and the two that carry vocabulary are cell 2 (the version
 * expression, which holds the LEADING frame) and cell 3 (the canonical envelope,
 * which holds the turn's sequence and the guest/embed additions). From cell 2 only
 * a `<code>NAME{...}</code>` counts — its backticked tokens are `sv`, `/api/v1/`
 * and `Last-Event-ID`, none of them events. From cell 3 both a
 * `<code>NAME{...}</code>` and a bare `` `NAME` `` count, because the ADR writes a
 * field-carrying event the first way and a field-less one the second. A row that
 * gains a tenth name in either position parses to ten and S6 goes red, which is the
 * behaviour asked for.
 */
export function declaredSseTurnEvents(root = repositoryRoot) {
  const adr = readFileSync(join(root, CONTRACT_ADR), "utf8");
  const row = adr.split("\n").find((line) => line.startsWith("| **SSE**"));
  if (row === undefined) return null;
  const cells = row.split("|");
  const versionExpression = cells[2] ?? "";
  const canonicalEnvelope = cells[3] ?? "";
  const NAME = "[a-z][A-Za-z0-9_.]*";
  const fielded = (cell) =>
    [...cell.matchAll(new RegExp(`<code>(${NAME})&lbrace;`, "gu"))].map((match) => match[1]);
  const bare = (cell) => [...cell.matchAll(new RegExp("`(" + NAME + ")`", "gu"))].map((match) => match[1]);
  const found = [...fielded(versionExpression), ...fielded(canonicalEnvelope), ...bare(canonicalEnvelope)];
  return [...new Set(found)];
}

/** The nine names the vocabulary module freezes, read out of its own array. */
export function vocabularySseTurnEvents(root = repositoryRoot) {
  const source = readFileSync(join(root, VOCABULARY_MODULE), "utf8");
  const block = /export const SSE_TURN_EVENTS = Object\.freeze\(\[([\s\S]*?)\] as const\);/u.exec(source);
  if (block === null) return null;
  return [...(block[1] ?? "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/**
 * The SSE lane's own `event:` channel names, read off the transport that writes them.
 *
 * A DIRECTORY, NOT A FILENAME, and a NARROW one. `encodeStreamMeta` writes
 * `event: stream_meta` into a template literal, so `scanEmissions` cannot see it:
 * that scan looks for `.emit(` calls and `t:` properties, and the leading frame is
 * neither. Without this rule the one name the canonical lane puts on SSE's own
 * channel was outside every check.
 *
 * It is scoped to `apps/core-api/src/transports/ws` because that IS the turn lane.
 * `apps/agent`'s MCP controllers also write `event:` lines — `endpoint`, `message`,
 * `hello` — and those belong to JSON-RPC-over-SSE, a different lane with a different
 * vocabulary; holding them to the turn lane's nine names would report a violation
 * that is not one.
 */
export const SSE_EVENT_CHANNEL_DIR = "apps/core-api/src/transports/ws";

export function sseEventChannelNames(root = repositoryRoot) {
  const found = [];
  for (const path of listSourceFiles(root, SSE_EVENT_CHANNEL_DIR)) {
    const text = readFileSync(join(root, path), "utf8");
    for (const match of text.matchAll(/`event: ([A-Za-z0-9_.]+)\\n/gu)) {
      found.push({ name: match[1], path });
    }
  }
  return found;
}

function sourceFile(absolute) {
  return ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * The string-literal values of one property name inside a subtree.
 *
 * TWO FIELD NAMES AND TWO DIFFERENT SEARCH SCOPES, which is the one judgement in
 * this scan. `t` is the CANONICAL envelope's field (M0.4 §2), so a `t: "..."`
 * anywhere in the scanned roots is a frame type by construction and is collected
 * wherever it appears — including from a factory that returns a frame rather than
 * writing one. `type` is what the LEGACY lanes call the same thing, and it is also
 * one of the most common property names in any TypeScript tree: an alert channel's
 * probe body, a tool's parameter schema and a discriminated union all use it. So
 * `type` is collected ONLY inside an `emit(...)` payload, which is exactly the
 * scope the ADR's drift-check names, and a `type` outside one is not a frame.
 */
function propertyLiteralsIn(node, wanted) {
  const found = [];
  const visit = (current) => {
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
        if (name !== wanted) continue;
        if (ts.isStringLiteral(property.initializer)) found.push(property.initializer.text);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** Whether any `sv:` property in this file carries a numeric literal. */
function svLiterals(file) {
  const found = [];
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name === "sv" && ts.isNumericLiteral(node.initializer)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push({ line: line + 1, value: Number(node.initializer.text) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every socket event name and frame type one file puts on a wire.
 *
 * TWO KINDS OF NAME AND THEY ARE NOT THE SAME THING, which is the distinction the
 * ADR's own wording hides. `socket.emit("agent_event", {type:"token"})` carries a
 * TRANSPORT event name and, inside it, a FRAME type; M0.4 §2's `t` is the second.
 * Recording only the first would miss the vocabulary entirely; recording only the
 * second would miss `connected`, `joined_thread` and every other lane-level event
 * a browser subscribes to. Both are collected and each row says which it is.
 */
export function emissionsIn(root, path) {
  const absolute = join(root, path);
  const file = sourceFile(absolute);
  const rows = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "emit"
    ) {
      const [nameNode, payloadNode] = node.arguments;
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      if (nameNode !== undefined && ts.isStringLiteral(nameNode)) {
        rows.push({ kind: "socket-event", name: nameNode.text, path, line: line + 1 });
        if (payloadNode !== undefined) {
          for (const type of propertyLiteralsIn(payloadNode, "type")) {
            rows.push({ kind: "frame-type", name: type, path, line: line + 1 });
          }
        }
      } else if (nameNode !== undefined) {
        // A COMPUTED EVENT NAME IS RECORDED AS ONE ROW AND NOT SKIPPED. The
        // gateway relays `payload.event`, so the set of names it can emit is
        // decided by whatever publishes to it; a scan that dropped the site would
        // report a smaller vocabulary than the lane actually has.
        rows.push({ kind: "socket-event", name: "<computed>", path, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // AND EVERY CANONICAL `t` IN THE FILE, wherever it sits. The canonical lane
  // writes SSE bytes rather than calling `emit`, and its frames are built by
  // factories that RETURN them — a rule that only looked inside `emit` would see
  // the socket lane and miss the HTTP one entirely, which is the half of this
  // surface the whole tranche is about.
  for (const type of propertyLiteralsIn(file, "t")) {
    rows.push({ kind: "frame-type", name: type, path, line: 0 });
  }
  return rows;
}

/** Every emission in the scanned roots, de-duplicated by (lane, kind, name). */
export function scanEmissions(root = repositoryRoot) {
  const seen = new Map();
  const svOffenders = [];
  for (const scanned of SCANNED_ROOTS) {
    for (const path of listSourceFiles(root, scanned.dir)) {
      for (const row of emissionsIn(root, path)) {
        const key = `${scanned.id}|${row.kind}|${row.name}`;
        const held = seen.get(key);
        if (held === undefined) {
          seen.set(key, { lane: scanned.id, kind: row.kind, name: row.name, sites: [`${row.path}:${row.line}`] });
        } else {
          held.sites.push(`${row.path}:${row.line}`);
        }
      }
    }
  }
  for (const directory of SV_LITERAL_ROOTS) {
    for (const path of listSourceFiles(root, directory)) {
      // ONE FILE, NOT A DIRECTORY. A directory-shaped exemption grows a second
      // copy of the constant the week after it is written and nothing goes red —
      // which is the argument `env-access` makes about its own file list.
      if (path === VOCABULARY_MODULE) continue;
      for (const offender of svLiterals(sourceFile(join(root, path)))) {
        svOffenders.push({ path, line: offender.line, value: offender.value });
      }
    }
  }
  const rows = [...seen.values()].map((row) => ({ ...row, sites: [...row.sites].sort() }));
  rows.sort((left, right) =>
    left.lane.localeCompare(right.lane) ||
    left.kind.localeCompare(right.kind) ||
    left.name.localeCompare(right.name),
  );
  return { rows, svOffenders };
}

/** The terminal frame types the canonical lane's own fault table can produce. */
export function canonicalTerminals(root = repositoryRoot) {
  const path = "apps/core-api/src/transports/ws/streams.controller.ts";
  const source = readFileSync(join(root, path), "utf8");
  const block = /export function terminalErrorFrame[\s\S]*?t: "([^"]+)"/u.exec(source);
  const table = /export const TERMINAL_FAULTS[\s\S]*?Object\.freeze\(\{([\s\S]*?)\n  \}\);/u.exec(source);
  return {
    frameType: block === null ? null : block[1],
    faultKinds: table === null ? [] : [...(table[1] ?? "").matchAll(/"([a-z-]+)":/gu)].map((m) => m[1]),
  };
}

function readInventory(root) {
  try {
    return JSON.parse(readFileSync(join(root, INVENTORY_PATH), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build the inventory this gate compares against.
 *
 * FAMILY IS DERIVED FROM THE LANE AND NEVER INVENTED. The socket lane is
 * `ws.agent_event` and the HTTP lane is `sse.turn`, which is what M0.4 §1.2's own
 * naming says; a row whose lane is unknown gets no family and S5 refuses it, so a
 * new lane cannot be absorbed with a guessed axis.
 */
export function buildInventory(root = repositoryRoot) {
  const { rows } = scanEmissions(root);
  const familyFor = (lane) => (lane === "agent" ? "ws.agent_event" : "sse.turn");
  return {
    purpose:
      "WIN-272 (M4.6). Every socket event name and frame type the V1 stream lanes put on a wire, " +
      "with the lane and the M0.4 section 1.2 envelope family each belongs to. Regenerated by " +
      "scripts/arch/stream-contracts.mjs --write; joined to the tree in BOTH directions by that " +
      "script's rule S4, so a name added without a row and a row whose emitter was deleted both fail. " +
      "It carries no copy of the five envelope family names: rule S5 reads those from " +
      "packages/kernel/src/vo/stream-frame.ts on each run, and a copy here would be a second list to " +
      "keep true -- and would put a word the vocabulary boundary refuses into a generated artifact.",
    rows: rows.map((row) => ({
      lane: row.lane,
      kind: row.kind,
      name: row.name,
      family: familyFor(row.lane),
      sites: row.sites,
    })),
  };
}

export function auditStreamContracts(root = repositoryRoot) {
  const problems = [];
  const adrFamilies = declaredFamilies(root);
  const moduleFamilies = vocabularyFamilies(root);
  const terminals = vocabularyTerminals(root);

  // --- S1 ---
  if (adrFamilies === null) {
    problems.push(`S1 ${CONTRACT_ADR} no longer states the envelope families inline`);
  } else if (moduleFamilies === null) {
    problems.push(`S1 ${VOCABULARY_MODULE} declares no STREAM_ENVELOPE_FAMILIES array`);
  } else if (JSON.stringify(adrFamilies) !== JSON.stringify(moduleFamilies)) {
    problems.push(
      `S1 the vocabulary declares [${moduleFamilies.join(", ")}] and ${CONTRACT_ADR} §1.2 names ` +
        `[${adrFamilies.join(", ")}]`,
    );
  }

  const { rows, svOffenders } = scanEmissions(root);

  // --- S2 ---
  for (const offender of svOffenders) {
    problems.push(
      `S2 ${offender.path}:${offender.line} writes sv: ${String(offender.value)} as a literal; the stream ` +
        `major is declared once, in ${VOCABULARY_MODULE}`,
    );
  }

  // --- S3 ---
  const canonical = canonicalTerminals(root);
  if (terminals === null) {
    problems.push(`S3 ${VOCABULARY_MODULE} declares no TERMINAL_FRAME_TYPES array`);
  } else {
    if (canonical.frameType === null) {
      problems.push("S3 the canonical lane declares no terminal frame type");
    } else if (!terminals.includes(canonical.frameType)) {
      problems.push(
        `S3 the canonical lane emits terminal frame "${canonical.frameType}", which is not in ` +
          `TERMINAL_FRAME_TYPES [${terminals.join(", ")}]`,
      );
    }
    if (canonical.faultKinds.length === 0) {
      problems.push("S3 the canonical lane declares no TERMINAL_FAULTS table, so no ending carries a code");
    }
    // EVERY MEMBER OF THE LIST IS EITHER REACHABLE OR DECLARED UNREACHABLE, and
    // the rule refuses in BOTH directions. A terminal type nothing writes is a
    // contract entry with no wire behind it; a type on the declared list that HAS
    // gained a producer means the reason it was listed has expired.
    const emittedTypes = new Set(rows.filter((row) => row.kind === "frame-type").map((row) => row.name));
    const declaredUnreachable = new Set(TERMINAL_TYPES_WITHOUT_A_PRODUCER);
    for (const terminal of terminals) {
      const emitted = emittedTypes.has(terminal);
      const excused = declaredUnreachable.has(terminal);
      if (!emitted && !excused) {
        problems.push(
          `S3 no producer in the scanned roots emits ${terminal}, and it is not in ` +
            "TERMINAL_TYPES_WITHOUT_A_PRODUCER; a terminal type nothing writes is a contract entry with " +
            "no wire behind it",
        );
      }
      if (emitted && excused) {
        problems.push(
          `S3 ${terminal} IS emitted now, so its entry in TERMINAL_TYPES_WITHOUT_A_PRODUCER has expired ` +
            "and the reason recorded beside it is no longer true",
        );
      }
    }
    for (const excused of TERMINAL_TYPES_WITHOUT_A_PRODUCER) {
      if (!terminals.includes(excused)) {
        problems.push(`S3 TERMINAL_TYPES_WITHOUT_A_PRODUCER names ${excused}, which is not a terminal type`);
      }
    }
  }

  // --- S4 and S5 ---
  const inventory = readInventory(root);
  if (inventory === null) {
    problems.push(`S4 ${INVENTORY_PATH} is absent or unreadable; run --write`);
  } else {
    const declared = new Map(
      (inventory.rows ?? []).map((row) => [`${row.lane}|${row.kind}|${row.name}`, row]),
    );
    for (const row of rows) {
      const key = `${row.lane}|${row.kind}|${row.name}`;
      const held = declared.get(key);
      if (held === undefined) {
        problems.push(
          `S4 ${row.lane} emits ${row.kind} "${row.name}" at ${row.sites[0] ?? "?"} with no row in ` +
            INVENTORY_PATH,
        );
        continue;
      }
      if (JSON.stringify(held.sites ?? []) !== JSON.stringify(row.sites)) {
        problems.push(
          `S4 ${row.lane} ${row.kind} "${row.name}" is emitted at ${row.sites.length} site(s) and ` +
            `${INVENTORY_PATH} records ${String((held.sites ?? []).length)}`,
        );
      }
      declared.delete(key);
    }
    for (const [key, row] of declared) {
      problems.push(`S4 ${INVENTORY_PATH} records ${key}, which nothing in the scanned roots emits`);
      void row;
    }
    const permitted = new Set(moduleFamilies ?? []);
    for (const row of inventory.rows ?? []) {
      if (row.lane !== "agent" && row.lane !== "core-api") {
        problems.push(`S5 ${INVENTORY_PATH} row ${row.name} names lane "${String(row.lane)}", which is not scanned`);
      }
      if (!permitted.has(row.family)) {
        problems.push(
          `S5 ${INVENTORY_PATH} row ${row.name} names family "${String(row.family)}", which is not one of ` +
            `the five`,
        );
      }
    }
    // THE INVENTORY CARRIES NO FAMILY LIST, ON PURPOSE, so this is a refusal rather
    // than a comparison: a copy of the five names here would be a second list to
    // keep true, and rule S5 above already holds every ROW to the vocabulary's own
    // set read fresh on each run. It would also have put a word the vocabulary
    // boundary refuses into a GENERATED artifact, which is an exception nobody
    // reviews because nobody writes the file by hand.
    if (inventory.families !== undefined) {
      problems.push(
        `S5 ${INVENTORY_PATH} carries its own family list; the five names are read from ` +
          `${VOCABULARY_MODULE} on each run and must not be copied`,
      );
    }
  }

  // --- S6 ---
  //
  // THE SPELLING WAS SETTLED BY COUNTING, NOT BY TASTE, and the count is recorded in
  // the ADR's own D9 correction and in `SSE_TURN_EVENTS`' comment: `stream_offline`
  // occurred ONCE in this repository — in the ADR cell — with no producer, no
  // consumer, no test and no SDK, while `stream.offline` occurred fifteen times
  // including `classifyStreamEnd`'s own branch. Changing the shipped one is the
  // breaking change, so the document moved and this rule now holds both to one
  // spelling forever.
  const adrEvents = declaredSseTurnEvents(root);
  const moduleEvents = vocabularySseTurnEvents(root);
  if (adrEvents === null) {
    problems.push(`S6 ${CONTRACT_ADR} no longer carries an SSE row to read the vocabulary from`);
  } else if (moduleEvents === null) {
    problems.push(`S6 ${VOCABULARY_MODULE} declares no SSE_TURN_EVENTS array`);
  } else {
    // NON-VACUITY FIRST. A parse that silently found nothing would make the two
    // comparisons below pass against two empty sets, which is the shape of every
    // gate this programme has caught being green for the wrong reason.
    if (adrEvents.length !== SSE_TURN_EVENT_COUNT) {
      problems.push(
        `S6 ${CONTRACT_ADR} §2's SSE row names ${String(adrEvents.length)} event(s) ` +
          `[${adrEvents.join(", ")}]; the accepted vocabulary is ${String(SSE_TURN_EVENT_COUNT)} — a name ` +
          "added, renamed or removed in that cell is a contract change and needs a superseding record",
      );
    }
    const missing = adrEvents.filter((name) => !moduleEvents.includes(name));
    const extra = moduleEvents.filter((name) => !adrEvents.includes(name));
    for (const name of missing) {
      problems.push(`S6 ${CONTRACT_ADR} §2 names SSE event "${name}", which SSE_TURN_EVENTS omits`);
    }
    for (const name of extra) {
      problems.push(
        `S6 SSE_TURN_EVENTS declares "${name}", which ${CONTRACT_ADR} §2's SSE row does not name`,
      );
    }
  }

  // AND THE THIRD DIRECTION: a PRODUCER emitting a name nothing accepted.
  //
  // The `sse.turn` frame types the emission scan finds, plus the names the lane puts
  // on SSE's own `event:` channel, must each be either one of the nine or a
  // kernel-declared terminal. `stream.error` is the second case and is the reason
  // the union is not just the nine: the ADR's SSE row names `turn.done` as the only
  // ending and says nothing about a terminal ERROR frame, while the canonical lane
  // needs one — `TERMINAL_FRAME_TYPES` is where that is declared, and rule S3
  // already holds it to the transport's own fault table in both directions.
  const accepted = new Set([...(moduleEvents ?? []), ...(terminals ?? [])]);
  if (accepted.size > 0) {
    for (const row of rows) {
      if (row.lane !== "core-api" || row.kind !== "frame-type") continue;
      if (accepted.has(row.name)) continue;
      problems.push(
        `S6 the canonical lane emits frame type "${row.name}" at ${row.sites[0] ?? "?"}, which is neither ` +
          `one of ${CONTRACT_ADR} §2's nine SSE events nor a declared terminal frame type`,
      );
    }
    const channelNames = sseEventChannelNames(root);
    if (channelNames.length === 0) {
      problems.push(
        `S6 no \`event:\` channel name was found under ${SSE_EVENT_CHANNEL_DIR}; the leading frame is ` +
          "written as a template literal, so a parse that finds none has stopped looking rather than " +
          "found a clean lane",
      );
    }
    for (const channel of channelNames) {
      if (accepted.has(channel.name)) continue;
      problems.push(
        `S6 ${channel.path} writes SSE channel "event: ${channel.name}", which ${CONTRACT_ADR} §2's SSE ` +
          "row does not name",
      );
    }
  }

  return { rows, problems, families: moduleFamilies ?? [], terminals: terminals ?? [] };
}

function main() {
  const write = process.argv.includes("--write");
  if (write) {
    const inventory = buildInventory();
    writeFileSync(join(repositoryRoot, INVENTORY_PATH), `${JSON.stringify(inventory, null, 2)}\n`);
    process.stdout.write(
      `stream-contracts: wrote ${INVENTORY_PATH} — ${String(inventory.rows.length)} row(s) across ` +
        `${String(SCANNED_ROOTS.length)} lane(s)\n`,
    );
    return;
  }
  const result = auditStreamContracts();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.problems.length > 0 ? 1 : 0;
    return;
  }
  const socketEvents = result.rows.filter((row) => row.kind === "socket-event").length;
  const frameTypes = result.rows.filter((row) => row.kind === "frame-type").length;
  process.stdout.write(
    `stream-contracts: ${String(socketEvents)} socket event name(s) and ${String(frameTypes)} frame type(s) ` +
      `across ${String(SCANNED_ROOTS.length)} lane(s); ${String(result.families.length)} envelope famil(ies)\n`,
  );
  for (const problem of result.problems) process.stdout.write(`${problem}\n`);
  if (result.problems.length === 0) {
    process.stdout.write(
      "ok: the envelope families are the ADR's own, the stream major is a literal in one module, every " +
        "terminal type is reachable, the emitted vocabulary matches the committed inventory in both " +
        `directions, and the SSE turn lane's ${String(SSE_TURN_EVENT_COUNT)} event names are exactly the ` +
        "ones ADR M0.4 section 2's SSE row states.\n",
    );
  } else {
    process.stdout.write(`\n${String(result.problems.length)} stream-contract problem(s).\n`);
  }
  process.exitCode = result.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("stream-contracts.mjs")) main();
