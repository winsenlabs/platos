#!/usr/bin/env node
// The env-access gate's own evidence.
//
// Three kinds of case, and the third is the one that matters:
//
//   THE ANALYSER — every spelling of an environment read this gate models, each
//   proved against a source string, each with a NEGATIVE control beside it so a
//   matcher that fired on everything would fail rather than pass eight times.
//
//   THE JUDGEMENT — every violation code, raised against a synthetic scan. The
//   live tree by design raises none, so without this half five of the six codes
//   would be unreachable text and nobody would know if one had stopped working.
//
//   THE LIVE TREE, JOINED TO SOMETHING THIS FILE DOES NOT CONTROL. The 2026-09-02
//   verification's fifth finding: an assertion that compares two things you both
//   control cannot fail. So the AST census is reconciled against an INDEPENDENT
//   text scan of the same tree — a different tool, a different definition of the
//   word — and the two are required to disagree in exactly the five places where
//   `process.env` is PROSE and nowhere else. That reconciliation found the fifth
//   one on its first run; the list this file was written with had four.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ALLOWED, EXPECTED_FILE_COUNT, VIOLATION_CODES, analyse, findEnvironmentReads, judge, scan } from "./env-access.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const kinds = (source) => findEnvironmentReads("fixture.ts", source).map((read) => read.kind);

// ---------------------------------------------------------------------------
// THE ANALYSER
// ---------------------------------------------------------------------------

test("the ordinary form is a read", () => {
  assert.deepEqual(kinds('const a = process.env.PLATOS_ENVIRONMENT;'), ["process.env"]);
  assert.deepEqual(kinds('const a = process.env["PLATOS_ENVIRONMENT"];'), ["process.env"]);
});

test("element access on the process object is a read", () => {
  assert.deepEqual(kinds('const a = process["env"].HOME;'), ["process['env']"]);
});

test("both global spellings are reads", () => {
  assert.deepEqual(kinds("const a = globalThis.process.env.HOME;"), ["process.env"]);
  assert.deepEqual(kinds("const a = global.process.env.HOME;"), ["process.env"]);
});

test("destructuring the environment off the process is a read", () => {
  assert.deepEqual(kinds("const { env } = process;"), ["destructured-env"]);
  assert.deepEqual(kinds("const { env: e } = process;"), ["destructured-env"]);
});

test("a local alias of the process carries the read with it", () => {
  assert.deepEqual(kinds("const p = process;\nconst a = p.env.HOME;"), ["process.env"]);
});

test("the module's default import is an alias of the process", () => {
  assert.deepEqual(kinds('import p from "node:process";\nconst a = p.env.HOME;'), ["process.env"]);
  assert.deepEqual(kinds('import * as p from "node:process";\nconst a = p.env.HOME;'), ["process.env"]);
});

test("the module's named env export is a read at every use, not at the import", () => {
  // Two uses, two reads. Counting the import instead would let a file import it
  // once and read it forty times against a pin of one.
  assert.deepEqual(kinds('import { env } from "node:process";\nconst a = env.HOME;\nconst b = env.PATH;'), [
    "named-env-import",
    "named-env-import",
  ]);
  assert.deepEqual(kinds('import { env as e } from "node:process";\nconst a = e.HOME;'), ["named-env-import"]);
});

test("the bundler spelling is a read", () => {
  assert.deepEqual(kinds("const a = import.meta.env.MODE;"), ["import.meta.env"]);
});

test("a computed key on the process object is UNATTRIBUTABLE, not ignored", () => {
  // It cannot be shown to be `env` or shown not to be, so it is refused wherever
  // it appears — the axis `sole-writer.mjs` records after six of seven spellings
  // of a Prisma write turned out to be invisible to a literal matcher.
  assert.deepEqual(kinds('const key = "env";\nconst a = process[key];'), ["computed-process-key"]);
});

test("NEGATIVE CONTROL: prose is not a read", () => {
  // The four mentions of `process.env` under packages/contexts/** at f88c8364
  // are all comments explaining why a limit is a parameter. A text scan would
  // have called the tree broken on day one.
  assert.deepEqual(kinds("// a limit read from process.env inside a domain rule is untestable\nexport const a = 1;"), []);
  assert.deepEqual(kinds('const message = "do not read process.env here";'), []);
  assert.deepEqual(kinds("/* process.env.HOME */\nexport const b = 2;"), []);
});

test("NEGATIVE CONTROL: the process object without its environment is not a read", () => {
  assert.deepEqual(kinds("process.exit(1);\nconst v = process.argv[1];\nprocess.on('SIGTERM', () => {});"), []);
});

test("NEGATIVE CONTROL: an unrelated object with an env property is not a read", () => {
  assert.deepEqual(kinds("const a = options.env.HOME;\nconst b = context.env;"), []);
});

test("NEGATIVE CONTROL: a named import called env from somewhere else is not a read", () => {
  assert.deepEqual(kinds('import { env } from "./config.js";\nconst a = env.HOME;'), []);
});

test("every read carries the file, the line and the spelling that produced it", () => {
  const reads = findEnvironmentReads("x/y.ts", "const a = 1;\nconst b = process.env.HOME;");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].path, "x/y.ts");
  assert.equal(reads[0].line, 2);
  assert.equal(reads[0].kind, "process.env");
});

// ---------------------------------------------------------------------------
// THE JUDGEMENT — one case per violation code
// ---------------------------------------------------------------------------

/** A synthetic scan: the declared files at their pinned counts, plus whatever. */
function syntheticScan(extra = new Map(), extraFiles = []) {
  const files = [...ALLOWED.map((entry) => entry.path), ...extraFiles];
  const readsByFile = new Map();
  for (const entry of ALLOWED) {
    readsByFile.set(
      entry.path,
      Array.from({ length: entry.reads }, (_unused, index) => ({
        path: entry.path,
        line: index + 1,
        kind: "process.env",
        text: "process.env",
      })),
    );
  }
  for (const [path, reads] of extra) readsByFile.set(path, reads);
  return { files, readsByFile };
}

const codesOf = (result) => result.violations.map((violation) => violation.code);

test("a synthetic scan matching every pin is clean", () => {
  const scanned = syntheticScan();
  assert.deepEqual(codesOf(judge(scanned, scanned.files.length)), []);
});

test("ENV-001: a read in a context that is not declared fails, and names the context file", () => {
  // THE PROOF WIN-260's ACCEPTANCE ASKS FOR, at the judgement layer. The same
  // edit made to the real file on disk is recorded as M01 in
  // apps/core-api/mutations-config.json and was seen to turn this gate red.
  const path = "packages/contexts/tenancy/domain/policy.ts";
  const scanned = syntheticScan(
    new Map([[path, [{ path, line: 12, kind: "process.env", text: "process.env.PLATOS_MAX_PROJECTS" }]]]),
    [path],
  );
  const result = judge(scanned, scanned.files.length);
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.UNDECLARED]);
  assert.equal(result.violations[0].path, path);
  assert.equal(result.violations[0].line, 12);
  assert.match(result.violations[0].message, /environment/u);
});

test("ENV-002: a declared file that GAINS a read fails", () => {
  const path = "apps/core-api/src/config/environment.ts";
  const scanned = syntheticScan(
    new Map([
      [
        path,
        [
          { path, line: 43, kind: "process.env", text: "process.env" },
          { path, line: 44, kind: "process.env", text: "process.env" },
        ],
      ],
    ]),
  );
  const result = judge(scanned, scanned.files.length);
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.ABOVE_PIN]);
  assert.match(result.violations[0].message, /declares 1 environment read\(s\) and now holds 2/u);
});

test("ENV-003: a declared file that LOSES a read fails too, so a pin cannot outlive its read", () => {
  const path = "apps/core-api/src/process.test.ts";
  const scanned = syntheticScan(new Map([[path, [{ path, line: 52, kind: "process.env", text: "process.env" }]]]));
  const result = judge(scanned, scanned.files.length);
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.BELOW_PIN]);
});

test("ENV-003 also fires when a declared file drops to zero reads", () => {
  const scanned = syntheticScan();
  scanned.readsByFile.delete("apps/mcp-stdio/src/environment.ts");
  const result = judge(scanned, scanned.files.length);
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.BELOW_PIN]);
  assert.match(result.violations[0].message, /now holds 0/u);
});

test("ENV-004: a declared file that no longer exists fails rather than being ignored", () => {
  const scanned = syntheticScan();
  scanned.files = scanned.files.filter((path) => path !== "apps/core-api/src/config/environment.ts");
  scanned.readsByFile.delete("apps/core-api/src/config/environment.ts");
  const result = judge(scanned, scanned.files.length);
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.MISSING_FILE]);
});

test("ENV-005: a scan that read back a different number of files fails", () => {
  const scanned = syntheticScan();
  const result = judge(scanned, scanned.files.length + 1);
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.CENSUS_DRIFT]);
});

test("ENV-006: a computed process key fails even inside a DECLARED file", () => {
  const path = "apps/core-api/src/config/environment.ts";
  const scanned = syntheticScan(
    new Map([
      [
        path,
        [
          { path, line: 43, kind: "process.env", text: "process.env" },
          { path, line: 44, kind: "computed-process-key", text: "process[key]" },
        ],
      ],
    ]),
  );
  const result = judge(scanned, scanned.files.length);
  // The computed access is refused AND is not counted toward the pin, so the
  // declared file still reconciles at one. Two codes would be a worse report.
  assert.deepEqual(codesOf(result), [VIOLATION_CODES.UNATTRIBUTABLE]);
});

test("every violation code is distinct, so two failures cannot be confused", () => {
  const values = Object.values(VIOLATION_CODES);
  assert.equal(new Set(values).size, values.length);
});

// ---------------------------------------------------------------------------
// THE LIVE TREE
// ---------------------------------------------------------------------------

test("the live tree has no environment-access violation", () => {
  const result = analyse();
  assert.deepEqual(result.violations, []);
});

test("the live scan is non-vacuous and matches the pinned file census", () => {
  const result = analyse();
  assert.equal(result.fileCount, EXPECTED_FILE_COUNT);
  assert.ok(result.fileCount > 1000, `expected a real scan, got ${String(result.fileCount)} files`);
  assert.equal(result.readCount, result.declaredReads);
});

test("the declared table is exactly the set of files that hold a read", () => {
  const { readsByFile } = scan();
  assert.deepEqual(
    [...readsByFile.keys()].sort(),
    ALLOWED.map((entry) => entry.path).sort(),
  );
});

test("exactly TWO files carry the configuration role, one per deployable", () => {
  const configuration = ALLOWED.filter((entry) => entry.role === "configuration");
  assert.deepEqual(configuration.map((entry) => entry.path).sort(), [
    "apps/core-api/src/config/environment.ts",
    "apps/mcp-stdio/src/environment.ts",
  ]);
  // One read each. A configuration home that grew a second read would be a
  // directory-shaped exception wearing a file's name.
  for (const entry of configuration) assert.equal(entry.reads, 1);
});

test("every declared entry carries a reason somebody wrote down", () => {
  for (const entry of ALLOWED) {
    assert.ok(entry.why.length > 60, `${entry.path} has no real reason`);
    assert.ok(["configuration", "test-support"].includes(entry.role), entry.path);
    assert.ok(Number.isInteger(entry.reads) && entry.reads > 0, entry.path);
  }
});

test("no CONTEXT and no KERNEL file reads the environment at all", () => {
  // The headline property, stated as its own case so it can go red on its own.
  const { readsByFile } = scan();
  const inCoreLayers = [...readsByFile.keys()].filter(
    (path) => path.startsWith("packages/contexts/") || path.startsWith("packages/kernel/"),
  );
  assert.deepEqual(inCoreLayers, []);
});

test("no ADAPTER reads the environment outside a test harness", () => {
  const { readsByFile } = scan();
  const productionAdapterReads = [...readsByFile.keys()].filter(
    (path) => path.startsWith("packages/adapters/") && !/(?:^|[-/])(?:harness\.ts|.*-harness\.ts|.*\.integration\.test\.ts)$/u.test(path),
  );
  assert.deepEqual(productionAdapterReads, []);
});

// THE INDEPENDENT RECONCILIATION.
//
// A text scan is a different tool with a different definition of "a read". It
// sees prose; the AST does not. Requiring the two to differ in EXACTLY the four
// known prose sites — named individually, not counted — joins the census to
// something this file does not control, so a mutation that silently narrowed the
// analyser would leave text hits with no AST read beside them and fail here.
//
// FIVE, not four. The fifth — `apps/core-api/src/runtime/lifecycle.ts` — was
// found by this very case: its banner says "nothing here reads `process.env`",
// which a text scan reads as an environment access and the parser does not. The
// list is spelled out rather than counted for exactly that reason.
const PROSE_ONLY = [
  "apps/core-api/src/runtime/lifecycle.ts",
  "packages/contexts/conversations/domain/policy.ts",
  "packages/contexts/files/domain/policy.ts",
  "packages/contexts/observability/application/dependencies.ts",
  "packages/contexts/privacy/domain/policy.ts",
];

test("an independent text scan finds process.env only where the AST does, plus five prose sites", () => {
  const { files, readsByFile } = scan();
  const textHits = files.filter((path) => {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    return /process\s*\.\s*env|process\s*\[\s*["']env["']\s*\]|import\.meta\s*\.\s*env/u.test(source);
  });
  const astHits = new Set(readsByFile.keys());
  const textOnly = textHits.filter((path) => !astHits.has(path)).sort();
  assert.deepEqual(textOnly, PROSE_ONLY);
});

test("each prose site really is prose: the text matches and the parser finds nothing", () => {
  for (const path of PROSE_ONLY) {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    assert.match(source, /process\.env/u, `${path} no longer mentions the environment`);
    assert.deepEqual(findEnvironmentReads(path, source), [], `${path} now READS the environment`);
  }
});

test("the AST finds no file the text scan misses", () => {
  // The other direction. A read the text scan cannot see would be one spelled
  // through an alias or a named import, and there are none in the tree today —
  // so if one arrives, this case says so rather than the census absorbing it.
  const { readsByFile } = scan();
  for (const path of readsByFile.keys()) {
    const source = readFileSync(join(repositoryRoot, path), "utf8");
    assert.match(source, /process\s*\.\s*env/u, `${path} reads the environment by a spelling no text scan sees`);
  }
});
