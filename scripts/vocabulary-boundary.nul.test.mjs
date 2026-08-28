// WIN-295: the vocabulary gate must not have a NUL-byte blind spot.
//
// Before the fix, the text/binary heuristic classified any file containing a NUL
// byte as binary and skipped it, so a source file with an embedded NUL evaded
// the gate entirely. These adversarial fixtures assert the gate now fails CLOSED
// for source-like inputs (scanned even with NUL bytes, encoding disguises, or
// truncation) while still skipping genuine binary artifacts so it never
// vocab-scans image or font bytes.
//
// This test file is itself scanned by the production gate, so it must never
// spell the forbidden term literally in its own source. The word is assembled
// from pieces at runtime and only ever exists inside on-disk fixture bytes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  BINARY_EXTENSIONS,
  decodeForScan,
  scanRepository,
} from "./vocabulary-boundary.mjs";

const NUL = Buffer.from([0]);
const RULE = ["t", "r", "i", "g", "g", "e", "r"].join(""); // the vocabulary rule under test
const WORD = RULE[0].toUpperCase() + RULE.slice(1); // the flagged term, capitalized
const HEAD = WORD.slice(0, 4); // first half of the term
const TAIL = WORD.slice(4); // second half of the term
const FLAGGED = `External ${WORD}`; // a phrase the gate must catch once decoded
const NOW = new Date("2026-08-24T12:00:00Z");

// A fixture that can hold raw bytes (Buffer) as well as text (string), so we can
// plant NUL bytes, UTF-16 encodings, real image signatures, and truncated
// multi-byte sequences on disk exactly as an evasion would.
function binaryFixture(files) {
  const root = mkdtempSync(join("/var/tmp", "platos-vocabulary-nul-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["add", "--all"], { cwd: root });
  return { root, manifest: { version: 1, exclusions: [], exceptions: [] } };
}

function flaggedFindings(result, path) {
  return result.findings.filter(
    (finding) => finding.path === path && finding.rule === RULE && finding.kind === "content"
  );
}

test("fail closed: a NUL byte inside a .ts source file is still scanned", () => {
  const path = "src/evasion.ts";
  // A real NUL byte planted next to the flagged word — the historical bug would
  // classify the whole file as binary and skip it.
  const content = Buffer.concat([
    Buffer.from(`const label = "${FLAGGED}";\nconst key = "org`),
    NUL,
    Buffer.from(`hash";\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "NUL-bearing .ts must be scanned, not skipped");
  assert(!result.binaryFiles.includes(path), "NUL-bearing .ts must not be treated as binary");
  assert.equal(flaggedFindings(result, path).length, 1, "the flagged word must be seen");
});

test("fail closed: a NUL byte cannot split a flagged word to evade the gate", () => {
  const path = "src/split.ts";
  // "<HEAD>\0<TAIL>" would let an evasion hide the word from a naive scan;
  // stripping the NUL rejoins the halves so the gate sees the whole term.
  const content = Buffer.concat([
    Buffer.from(`const x = '${HEAD}`),
    NUL,
    Buffer.from(`${TAIL}';\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "NUL-split source must be scanned");
  const findings = flaggedFindings(result, path);
  assert.equal(findings.length, 1, "the NUL-split word must rejoin and be flagged");
  assert.equal(findings[0].line, 1);
});

test("no false positive: a genuine PNG binary stays skipped even if its bytes spell a flagged word", () => {
  const path = "assets/logo.png";
  // Real PNG signature followed by bytes that happen to contain the lowercase
  // term and a NUL. A legitimate binary artifact must never be vocab-scanned.
  const content = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(RULE),
    NUL,
    Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02]),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.binaryFiles.includes(path), "a real PNG must remain classified as binary");
  assert(!result.files.includes(path), "a real PNG must not be scanned");
  assert.equal(flaggedFindings(result, path).length, 0, "image bytes must not be vocab-scanned");
});

test("encoding disguise: a UTF-16-LE source file with a BOM is decoded and scanned", () => {
  const path = "src/utf16.ts";
  // UTF-16-LE interleaves a NUL byte after every ASCII code unit and leads with a
  // BOM — a classic way to disguise a source file as binary.
  const content = Buffer.from(`﻿const label = "${FLAGGED}";\n`, "utf16le");
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "UTF-16 source must be scanned, not skipped");
  assert.equal(flaggedFindings(result, path).length, 1, "the flagged word must survive UTF-16 decode");
});

test("truncation: a source file cut mid multi-byte sequence is still scanned without throwing", () => {
  const path = "src/truncated.ts";
  // The emoji is a 4-byte UTF-8 sequence; lop off its final 2 bytes so the file
  // ends in an invalid/truncated sequence. Fail-closed decoding must not skip or
  // throw.
  const whole = Buffer.from(`const label = "${FLAGGED}"; // \u{1F600}`, "utf8");
  const content = whole.subarray(0, whole.length - 2);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "a truncated source file must still be scanned");
  assert.equal(flaggedFindings(result, path).length, 1, "the flagged word before the cut must be seen");
});

test("decodeForScan fails closed by default and strips NUL bytes from source-like files", () => {
  const root = mkdtempSync(join("/var/tmp", "platos-vocabulary-decode-"));
  writeFileSync(join(root, "a.ts"), Buffer.concat([Buffer.from(HEAD), NUL, Buffer.from(TAIL)]));
  writeFileSync(join(root, "b.png"), Buffer.concat([Buffer.from(RULE), NUL]));

  const source = decodeForScan(join(root, "a.ts"));
  assert.equal(source.sourceLike, true);
  assert.equal(source.text, WORD, "NUL must be stripped so the halves rejoin");
  assert(!source.text.includes(String.fromCharCode(0)), "no NUL may survive in scanned source text");

  const binary = decodeForScan(join(root, "b.png"));
  assert.equal(binary.sourceLike, false);
  assert.equal(binary.text, null, "a NUL-bearing genuine binary stays binary");
});

// WIN-295 residual blind spots: classification is by the file's true nature (a
// binary-extension denylist), NOT by an extension allowlist and NOT by whether
// the bytes contain a NUL. Reverting decodeForScan to the pre-fix allowlist /
// skip-on-NUL heuristic makes every case below flip to skipped and fails these
// tests — which is why the suite must be wired into the CI gate.
test("fail closed: an extensionless Dockerfile with a NUL-split term is scanned", () => {
  const path = "apps/agent/Dockerfile";
  const content = Buffer.concat([
    Buffer.from(`FROM node:20\nLABEL note="external ${HEAD}`),
    NUL,
    Buffer.from(`${TAIL} boundary"\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "a bare Dockerfile must be scanned, not skipped");
  assert(!result.binaryFiles.includes(path), "a bare Dockerfile must not be treated as binary");
  assert.equal(flaggedFindings(result, path).length, 1, "the NUL-split term must rejoin and flag");
});

test("fail closed: an extensionless Caddyfile with a NUL byte is scanned", () => {
  const path = "deploy/Caddyfile";
  const content = Buffer.concat([
    Buffer.from(`example.com {\n  # external ${WORD}`),
    NUL,
    Buffer.from(` route\n}\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "a bare Caddyfile must be scanned, not skipped");
  assert.equal(flaggedFindings(result, path).length, 1, "the flagged word must be seen");
});

test("fail closed: an extensionless Makefile with a NUL byte is scanned", () => {
  const path = "Makefile";
  const content = Buffer.concat([
    Buffer.from(`build:\n\t# external ${WORD}`),
    NUL,
    Buffer.from(` step\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "a bare Makefile must be scanned, not skipped");
  assert.equal(flaggedFindings(result, path).length, 1, "the flagged word must be seen");
});

test("fail closed: a .env.production file (extension parses as 'production') is scanned", () => {
  // The common dotenv naming makes the trailing dotted segment 'production',
  // which an allowlist keyed on 'env' would never protect — the denylist model
  // scans it because 'production' is not a binary extension.
  const path = "apps/webapp/.env.production";
  const content = Buffer.concat([
    Buffer.from(`API_MODE=external ${HEAD}`),
    NUL,
    Buffer.from(`${TAIL}\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "a .env.production must be scanned, not skipped");
  assert.equal(flaggedFindings(result, path).length, 1, "the NUL-split term must be flagged");
});

test("fail closed: a file with an unknown/novel extension and a NUL byte is still scanned", () => {
  // Anything not positively identified as binary must default to scanned, so a
  // brand-new source extension cannot become a skip-path evasion.
  const path = "config/settings.customlang";
  const content = Buffer.concat([
    Buffer.from(`setting = "external ${WORD}`),
    NUL,
    Buffer.from(` boundary"\n`),
  ]);
  const { root, manifest } = binaryFixture({ [path]: content });
  const result = scanRepository(root, manifest, { now: NOW });

  assert(result.files.includes(path), "an unknown-extension file must fail closed and be scanned");
  assert.equal(flaggedFindings(result, path).length, 1, "the flagged word must be seen");
});

test("genuine binaries stay skipped: a font and an archive with flagged bytes are not scanned", () => {
  const font = "assets/inter.woff2";
  const archive = "vendor/bundle.zip";
  const { root, manifest } = binaryFixture({
    [font]: Buffer.concat([Buffer.from("wOF2"), Buffer.from(RULE), NUL, Buffer.from([0x00, 0x01])]),
    [archive]: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(RULE), NUL]),
  });
  const result = scanRepository(root, manifest, { now: NOW });

  for (const path of [font, archive]) {
    assert(result.binaryFiles.includes(path), `${path} must remain classified as binary`);
    assert(!result.files.includes(path), `${path} must not be scanned`);
    assert.equal(flaggedFindings(result, path).length, 0, `${path} bytes must not be vocab-scanned`);
  }
});

test("the binary denylist skips genuine artifacts and never claims source/config extensions", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "pdf", "wasm", "zip", "mp4", "sqlite"]) {
    assert(BINARY_EXTENSIONS.has(ext), `${ext} must be treated as binary and skipped`);
  }
  for (const ext of [
    "ts", "tsx", "js", "mjs", "cjs", "jsx", "py", "go", "rb", "java",
    "sql", "md", "mdx", "json", "yml", "yaml", "sh", "css", "html",
    "svg", "env", "example", "production", "dockerfile", "make", "mk",
  ]) {
    assert(!BINARY_EXTENSIONS.has(ext), `${ext} must NOT be treated as binary (it fails closed and is scanned)`);
  }
});
