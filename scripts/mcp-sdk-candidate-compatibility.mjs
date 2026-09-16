#!/usr/bin/env node
// WIN-268 (M4.2) — THE MCP SDK 1.30.x CANDIDATE, COMPATIBILITY-TESTED BEFORE ADOPTION.
//
// THE CLAUSE is "SDK 1.30.x candidate upgrade is compatibility-tested before
// adoption". This file turns that from a sentence into a derived, committed
// result that CI re-derives and compares byte for byte:
//
//   node scripts/mcp-sdk-candidate-compatibility.mjs --write   # run, derive, write
//   node scripts/mcp-sdk-candidate-compatibility.mjs --check   # run, derive, compare
//
// WHAT IS RUN. The suites that ask the adopted SDK and the candidate THE SAME
// QUESTIONS, named below as path constants:
//
//   CLIENT SIDE  the official SDK client, both builds, against Platos' own MCP
//                servers (platform, entity, docs) over Streamable HTTP and legacy
//                SSE, and across two agent processes sharing one Redis.
//   SERVER SIDE  both builds' own `McpServer` (Streamable HTTP and legacy SSE)
//                behind the Platos MCP client in `packages/contexts/tools`.
//
// WHAT IS DERIVED. Every executed case is keyed by its name with the build label
// taken out, so `adopted SDK -> platform server …` and `candidate SDK -> platform
// server …` become ONE QUESTION with two answers. The result is compatible only
// if every question has BOTH answers and both passed. A question answered by one
// build only is refused rather than counted — that is how a parameterisation that
// silently dropped the candidate would present — and a skipped or pending case is
// refused, because a skip and a pass are indistinguishable in a summary.
//
// WHAT IS JOINED. The two versions recorded are read from the INSTALLED manifests
// and required to equal what `pnpm-lock.yaml` resolved for both importers, and the
// adopted runtime pins are required to be unchanged: this result is evidence FOR a
// decision, and adopting the candidate is a separate, reviewed change.
//
// NO TIMINGS, NO DATES. The file is a fixpoint of the tree and the services, so a
// re-derivation that differs is a real difference.
//
// Needs PLATOS_POSTGRES_INTEGRATION_DATABASE_URL (pgvector) and PLATOS_TEST_REDIS_URL,
// and the dist builds the suites resolve through (`@platos/tenancy-database`,
// `@internal/workload-identity`, `@internal/docs`, `@platos/context-tools...`).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

export const RESULT_PATH = "docs/audits/win-268-mcp-sdk-candidate-compatibility.json";
export const CANDIDATE_ALIAS = "@modelcontextprotocol/sdk-candidate";
export const SDK_PACKAGE = "@modelcontextprotocol/sdk";

/** The importers that carry both builds, as path constants. */
export const IMPORTERS = Object.freeze([
  { importer: "apps/agent", package: "platos-agent", adoptedSpecifier: "^1.26.0" },
  { importer: "packages/contexts/tools", package: "@platos/context-tools", adoptedSpecifier: "1.26.0" },
]);

/** The suites that ask both builds the same questions. */
export const SUITES = Object.freeze([
  {
    package: "@platos/context-tools",
    root: "packages/contexts/tools",
    file: "adapters/dispatch.integration.test.ts",
    side: "server",
    flags: {},
  },
  {
    package: "platos-agent",
    root: "apps/agent",
    file: "src/mcp-platform/mcp-protocol-conformance.integration.test.ts",
    side: "client",
    flags: { MCP_CONFORMANCE_REQUIRED: "1" },
  },
  {
    package: "platos-agent",
    root: "apps/agent",
    file: "src/mcp-platform/mcp-sse-multi-node.integration.test.ts",
    side: "client",
    flags: { MCP_MULTI_NODE_REQUIRED: "1" },
  },
]);

const BUILD_LABEL = /'?\b(adopted|candidate)\b'?/gu;

/**
 * The build a case name is about, or null for a case asked once of the PAIR —
 * one that names neither build (a recorded non-conformance, the two-process
 * boot check) or both (the case that joins the two installed versions).
 */
export function buildOf(name) {
  const found = new Set([...name.matchAll(BUILD_LABEL)].map((match) => match[1]));
  return found.size === 1 ? [...found][0] : null;
}

/** The question a case asks, with its build label removed. */
export function questionOf(name) {
  return name.replaceAll(BUILD_LABEL, "<build>");
}

/**
 * Derive the result from executed cases.
 *
 * `cases` is `[{ suite, name, status }]`, `status` as Vitest reports it.
 */
export function derive({ adopted, candidate, cases }) {
  const refused = cases.filter((entry) => entry.status !== "passed" && entry.status !== "failed");
  if (refused.length > 0) {
    throw new Error(
      `a case did not execute (${refused.map((entry) => `${entry.status}: ${entry.name}`).join("; ")}); a skip is not evidence`,
    );
  }
  const questions = new Map();
  const shared = [];
  for (const entry of cases) {
    const build = buildOf(entry.name);
    if (build === null) {
      shared.push({ suite: entry.suite, case: entry.name, status: entry.status });
      continue;
    }
    const key = `${entry.suite}\u0000${questionOf(entry.name)}`;
    const row = questions.get(key) ?? { suite: entry.suite, question: questionOf(entry.name) };
    if (row[build] !== undefined) throw new Error(`question asked twice of the ${build} build: ${row.question}`);
    row[build] = entry.status;
    questions.set(key, row);
  }
  const rows = [...questions.values()].sort((a, b) => `${a.suite}${a.question}`.localeCompare(`${b.suite}${b.question}`));
  const oneSided = rows.filter((row) => row.adopted === undefined || row.candidate === undefined);
  if (oneSided.length > 0) {
    throw new Error(`questions answered by one build only: ${oneSided.map((row) => row.question).join("; ")}`);
  }
  if (rows.length === 0) throw new Error("no question was asked of both builds; the parameterisation is gone");
  shared.sort((a, b) => `${a.suite}${a.case}`.localeCompare(`${b.suite}${b.case}`));
  const totals = {
    questions: rows.length,
    adoptedPassed: rows.filter((row) => row.adopted === "passed").length,
    candidatePassed: rows.filter((row) => row.candidate === "passed").length,
    sharedCases: shared.length,
    sharedPassed: shared.filter((row) => row.status === "passed").length,
  };
  const compatible =
    totals.adoptedPassed === rows.length && totals.candidatePassed === rows.length && totals.sharedPassed === shared.length;
  return {
    clause: "SDK 1.30.x candidate upgrade is compatibility-tested before adoption",
    adopted,
    candidate,
    adoption: "NOT ADOPTED — every runtime importer still resolves the adopted version; adopting the candidate is a separate change",
    suites: SUITES.map(({ root, file, side }) => ({ file: `${root}/${file}`, side })),
    totals,
    verdict: compatible ? "compatible" : "incompatible",
    questions: rows,
    shared,
  };
}

/** The adopted and candidate versions, joined to the manifests and the lockfile. */
export function resolvedVersions(root = repositoryRoot) {
  const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  let adopted = null;
  let candidate = null;
  for (const { importer, adoptedSpecifier } of IMPORTERS) {
    const manifest = JSON.parse(readFileSync(path.join(root, importer, "package.json"), "utf8"));
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    assert.equal(declared[SDK_PACKAGE], adoptedSpecifier, `${importer} no longer declares the adopted SDK as ${adoptedSpecifier}`);
    const aliasSpecifier = declared[CANDIDATE_ALIAS];
    assert.match(aliasSpecifier ?? "", /^npm:@modelcontextprotocol\/sdk@1\.30\.\d+$/u, `${importer} must alias an EXACT 1.30.x candidate`);
    assert.equal(manifest.dependencies?.[CANDIDATE_ALIAS], undefined, `${importer} ships the candidate as a runtime dependency`);
    const aliasVersion = aliasSpecifier.slice("npm:@modelcontextprotocol/sdk@".length);

    const start = lockfile.indexOf(`\n  ${importer}:\n`);
    assert.ok(start !== -1, `pnpm-lock.yaml has no importer ${importer}`);
    const end = lockfile.indexOf("\n\n", start + 1);
    const block = lockfile.slice(start, end);
    const adoptedMatch = block.match(
      new RegExp(`'${SDK_PACKAGE.replace("/", "\\/")}':\\n\\s+specifier: ${adoptedSpecifier.replace("^", "\\^")}\\n\\s+version: ([0-9.]+)\\(`, "u"),
    );
    assert.ok(adoptedMatch, `pnpm-lock.yaml does not resolve ${SDK_PACKAGE} for ${importer}`);
    const candidateMatch = block.match(
      /'@modelcontextprotocol\/sdk-candidate':\n\s+specifier: (npm:@modelcontextprotocol\/sdk@[0-9.]+)\n\s+version: '@modelcontextprotocol\/sdk@([0-9.]+)\(/u,
    );
    assert.ok(candidateMatch, `pnpm-lock.yaml does not resolve ${CANDIDATE_ALIAS} for ${importer}`);
    assert.equal(candidateMatch[1], aliasSpecifier);
    assert.equal(candidateMatch[2], aliasVersion);

    const installedAdopted = JSON.parse(readFileSync(path.join(root, importer, "node_modules", SDK_PACKAGE, "package.json"), "utf8"));
    const installedCandidate = JSON.parse(readFileSync(path.join(root, importer, "node_modules", CANDIDATE_ALIAS, "package.json"), "utf8"));
    assert.equal(installedAdopted.name, SDK_PACKAGE);
    assert.equal(installedCandidate.name, SDK_PACKAGE, `${CANDIDATE_ALIAS} in ${importer} is not the SDK`);
    assert.equal(installedAdopted.version, adoptedMatch[1]);
    assert.equal(installedCandidate.version, aliasVersion);

    adopted ??= installedAdopted.version;
    candidate ??= installedCandidate.version;
    assert.equal(installedAdopted.version, adopted, "the two importers disagree on the adopted SDK");
    assert.equal(installedCandidate.version, candidate, "the two importers disagree on the candidate");
  }
  assert.notEqual(adopted, candidate, "the adopted SDK and the candidate are the same version; nothing was compared");
  return { adopted, candidate };
}

function runSuite(suite) {
  const directory = mkdtempSync(path.join(tmpdir(), "mcp-sdk-candidate-"));
  const outputFile = path.join(directory, "report.json");
  try {
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        suite.package,
        "exec",
        "vitest",
        "run",
        suite.file,
        "--no-file-parallelism",
        "--testTimeout=120000",
        "--hookTimeout=300000",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0", ...suite.flags },
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    let report;
    try {
      report = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      throw new Error(`${suite.file} produced no Vitest JSON report (exit ${String(result.status)})`);
    }
    const files = report.testResults ?? [];
    assert.equal(files.length, 1, `${suite.file}: expected exactly one executed file, got ${String(files.length)}`);
    assert.ok(files[0].name.endsWith(suite.file), `${suite.file}: the report is for ${files[0].name}`);
    return files[0].assertionResults.map((entry) => ({
      suite: `${suite.root}/${suite.file}`,
      name: entry.fullName,
      status: entry.status,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2];
  assert.ok(mode === "--write" || mode === "--check", "usage: --write | --check");
  for (const name of ["PLATOS_POSTGRES_INTEGRATION_DATABASE_URL", "PLATOS_TEST_REDIS_URL"]) {
    assert.ok(process.env[name]?.trim(), `${name} is required; the client-side suites run against real PostgreSQL and Redis`);
  }
  const versions = resolvedVersions();
  const cases = SUITES.flatMap((suite) => runSuite(suite));
  const result = derive({ ...versions, cases });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  console.log(
    `MCP SDK ${versions.adopted} vs candidate ${versions.candidate}: ${String(result.totals.questions)} questions, ` +
      `adopted ${String(result.totals.adoptedPassed)} passed, candidate ${String(result.totals.candidatePassed)} passed, ` +
      `${String(result.totals.sharedPassed)}/${String(result.totals.sharedCases)} shared — ${result.verdict}`,
  );
  if (mode === "--write") {
    writeFileSync(path.join(repositoryRoot, RESULT_PATH), text);
    console.log(`wrote ${RESULT_PATH}`);
    return;
  }
  const committed = readFileSync(path.join(repositoryRoot, RESULT_PATH), "utf8");
  // THE GATE IS EQUALITY, NOT THE VERDICT. An incompatible candidate is valid
  // evidence too, and it would be committed as such; what must never happen is a
  // committed result the tree no longer derives.
  assert.equal(text, committed, `${RESULT_PATH} is not what this tree derives; run --write and review the diff`);
  console.log(`OK — ${RESULT_PATH} is current`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
