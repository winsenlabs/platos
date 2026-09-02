#!/usr/bin/env node
// WIN-284 — the differential capability coverage matrix.
//
// Enumerates every capability cell the M0 censuses found and gives each one a
// declared status. A cell is `covered` only if a scenario in
// tests/differential-harness/scenarios.mjs twin-runs it; everything else is
// `uncovered` and names the milestone that will build the surface.
//
// THE POINT OF THIS FILE IS THE DENOMINATOR.
//
// The acceptance clause asks that every capability cell carry an oracle and a
// result. At this baseline that is not achievable and saying otherwise would be
// the lie: there is no V1 REST, MCP, SDK, channel or stream implementation to
// twin-run against. The two honest failure modes are (a) claim coverage that
// does not exist, or (b) quietly shrink the denominator to whatever is covered
// so the percentage looks respectable. This gate forbids both:
//
//   * the denominator is read from the censuses on every run, so a cell cannot
//     be dropped without the digest moving and `--check` failing;
//   * the numerator is COMPUTED from the scenario registry, so coverage cannot
//     be asserted in this file at all;
//   * a claim naming a cell no census contains is a hard error, so a typo
//     inflates nothing;
//   * every uncovered cell carries the issue that will cover it, so the gap is
//     a work item rather than a silence.
//
// Usage: node scripts/differential-coverage.mjs [--write|--check]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RULES as VOCABULARY_RULES } from "./vocabulary-boundary.mjs";
import { gateSafeJson } from "./v1-ledger.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const JSON_PATH = "docs/audits/win-284-differential-coverage.json";
export const MARKDOWN_PATH = "docs/audits/win-284-differential-coverage.md";

export const CENSUS_SOURCES = Object.freeze([
  "docs/audits/M0.2-capability-matrix.json",
  "docs/audits/M0.9-rest-census-independent.json",
  "docs/audits/M0.9-webapp-bff-matrix.json",
  "docs/audits/M0.4-design-contract-map.json",
]);

// Which issue makes each surface twin-runnable. `uncovered` is only meaningful
// if it names who closes it; an uncovered cell with no owner is a silence with
// extra steps.
export const SURFACE_OWNERS = Object.freeze({
  rest: { issue: "WIN-267", milestone: "M4", reason: "no V1 REST transport exists at this baseline" },
  mcp: { issue: "WIN-268", milestone: "M4", reason: "no V1 MCP surface exists at this baseline" },
  sdk: { issue: "WIN-269", milestone: "M4", reason: "no V1 SDK surface exists at this baseline" },
  channel: { issue: "WIN-270", milestone: "M4", reason: "no V1 channel surface exists at this baseline" },
  streaming: { issue: "WIN-271", milestone: "M4", reason: "no V1 streaming surface exists at this baseline" },
  bff: { issue: "WIN-272", milestone: "M4", reason: "the webapp BFF is not decomposed at this baseline" },
  screen: { issue: "WIN-272", milestone: "M4", reason: "screen contracts land with the transports that serve them" },
  store: {
    issue: "WIN-285",
    milestone: "M7",
    reason: "the store is twin-runnable today; enumerating every model is coverage execution, which M7.2 owns",
  },
});

export const STATUSES = Object.freeze(["covered", "uncovered"]);

function readCensus(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function cell(id, surface, detail) {
  return { id, surface, ...detail };
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export function enumerateCells(root = repositoryRoot) {
  const capability = readCensus(root, "docs/audits/M0.2-capability-matrix.json");
  const bff = readCensus(root, "docs/audits/M0.9-webapp-bff-matrix.json");
  const contracts = readCensus(root, "docs/audits/M0.4-design-contract-map.json");

  const cells = [];

  for (const route of capability.surfaces.rest) {
    cells.push(cell(route.id, "rest", { owner: route.owner, requiresOperator: Boolean(route.requiresOperator) }));
  }
  for (const tool of capability.surfaces.mcp) {
    cells.push(cell(tool.id, "mcp", { owner: tool.owner }));
  }
  for (const model of capability.surfaces.stores.tenancyModels) {
    cells.push(
      cell(`store:${model}`, "store", {
        owner: "tenancy",
        endUserReachable: capability.surfaces.stores.endUserModels.includes(model),
      }),
    );
  }
  for (const entry of bff.entries) {
    if (entry.loader) cells.push(cell(`bff:${entry.file}#loader`, "bff", { owner: "webapp" }));
    if (entry.action) cells.push(cell(`bff:${entry.file}#action`, "bff", { owner: "webapp" }));
  }
  for (const screen of contracts.screens) {
    cells.push(cell(`screen:${screen.id}`, "screen", { owner: `cluster ${screen.cluster}`, transports: screen.transports }));
  }
  for (const screen of contracts.undemandedScreens) {
    cells.push(cell(`screen:${screen.id}`, "screen", { owner: "no-backend-contract", classification: screen.classification }));
  }
  for (const [key, value] of Object.entries(capability.surfaces.streaming)) {
    if (typeof value === "number") cells.push(cell(`streaming:${key}`, "streaming", { owner: "streaming", population: value }));
  }
  for (const packageName of capability.surfaces.sdksProviders.sdkPackages) {
    cells.push(cell(`sdk:${packageName}`, "sdk", { owner: "sdk" }));
  }

  const seen = new Set();
  for (const entry of cells) {
    if (seen.has(entry.id)) throw new Error(`duplicate capability cell ${entry.id}`);
    seen.add(entry.id);
  }
  return cells.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export function buildMatrix(cells, registry, claims) {
  const known = new Set(cells.map((entry) => entry.id));
  const errors = [];
  for (const claim of claims) {
    if (!known.has(claim)) {
      errors.push(`scenario registry claims ${claim}, which no census contains; a claim cannot invent a capability`);
    }
  }

  const claimants = new Map();
  for (const scenario of registry) {
    for (const capability of scenario.capabilities ?? []) {
      if (!claimants.has(capability)) claimants.set(capability, []);
      claimants.get(capability).push(scenario.id);
    }
  }

  const rows = cells.map((entry) => {
    const covering = claimants.get(entry.id) ?? [];
    if (covering.length > 0) {
      return { ...entry, status: "covered", scenarios: covering.sort(), blockedBy: null, reason: null };
    }
    const owner = SURFACE_OWNERS[entry.surface];
    if (!owner) errors.push(`surface ${entry.surface} has no owning issue; an uncovered cell must name who covers it`);
    return {
      ...entry,
      status: "uncovered",
      scenarios: [],
      blockedBy: owner ? owner.issue : null,
      milestone: owner ? owner.milestone : null,
      reason: owner ? owner.reason : null,
    };
  });

  return { rows, errors };
}

export function summarise(rows) {
  const bySurface = {};
  for (const row of rows) {
    bySurface[row.surface] ??= { total: 0, covered: 0, uncovered: 0 };
    bySurface[row.surface].total += 1;
    bySurface[row.surface][row.status] += 1;
  }
  return {
    cells: rows.length,
    covered: rows.filter((row) => row.status === "covered").length,
    uncovered: rows.filter((row) => row.status === "uncovered").length,
    bySurface: Object.fromEntries(Object.entries(bySurface).sort(([left], [right]) => (left < right ? -1 : 1))),
  };
}

// The digest covers cell identity and status only, not the prose. A reworded
// `reason` must not force a matrix refresh, because that teaches reviewers to
// refresh the matrix without reading it.
export function matrixDigest(rows) {
  const text = rows.map((row) => `${row.id}\t${row.surface}\t${row.status}\t${row.blockedBy ?? "-"}`).join("\n");
  return createHash("sha256").update(`${text}\n`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const reservedText = new RegExp(VOCABULARY_RULES.map((rule) => rule.pattern.source).join("|"), "giu");

// Eighteen MCP tool ids name the external orchestration integration and so
// carry reserved vocabulary. The JSON artifact escapes them the way the ledger
// does; the Markdown cannot, so it never enumerates individual cell ids. This
// guard makes that a mechanical property rather than a convention someone
// breaks later by adding one covered id too many.
export function assertMarkdownIsGateSafe(markdown) {
  const matches = [...markdown.matchAll(reservedText)].map((match) => match[0]);
  if (matches.length > 0) {
    throw new Error(
      `the coverage summary contains reserved vocabulary (${[...new Set(matches)].join(", ")}); ` +
        "aggregate by surface instead of naming individual capability ids",
    );
  }
  return markdown;
}

export function renderMarkdown(document) {
  const lines = [
    "# WIN-284 — differential capability coverage",
    "",
    `Generated by \`scripts/differential-coverage.mjs\` from ${CENSUS_SOURCES.length} M0 censuses.`,
    "Coverage is computed from `tests/differential-harness/scenarios.mjs`; it cannot be asserted here.",
    "",
    "## Why the covered count is small, and why that is the honest answer",
    "",
    "At the `v1` baseline there is no V1 REST, MCP, SDK, channel or stream implementation",
    "to twin-run against, so those cells have no candidate side and cannot be compared.",
    "They are enumerated as uncovered against the issue that will build them rather than",
    "removed from the denominator. The harness exists and is proven sensitive; what is",
    "missing is the second system, not the instrument.",
    "",
    "## Totals",
    "",
    `- capability cells enumerated: **${document.summary.cells}**`,
    `- covered by a twin-run scenario: **${document.summary.covered}**`,
    `- uncovered, each attributed to an owning issue: **${document.summary.uncovered}**`,
    "",
    "## By surface",
    "",
    "| surface | cells | covered | uncovered | covered when |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const [surface, counts] of Object.entries(document.summary.bySurface)) {
    const owner = SURFACE_OWNERS[surface];
    lines.push(
      `| ${surface} | ${counts.total} | ${counts.covered} | ${counts.uncovered} | ${owner.issue} (${owner.milestone}) |`,
    );
  }
  lines.push(
    "",
    "## Covered cells",
    "",
    "Each row names the scenario that twin-runs it against two isolated equivalent stores.",
    "",
    "| capability | scenario |",
    "| --- | --- |",
  );
  for (const row of document.rows.filter((entry) => entry.status === "covered")) {
    lines.push(`| \`${row.id}\` | ${row.scenarios.join(", ")} |`);
  }
  lines.push(
    "",
    "## What each uncovered surface is waiting for",
    "",
  );
  for (const [surface, owner] of Object.entries(SURFACE_OWNERS)) {
    lines.push(`- **${surface}** — ${owner.issue} (${owner.milestone}): ${owner.reason}`);
  }
  lines.push("", `Matrix digest: \`${document.digest}\``, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

export async function buildDocument(root = repositoryRoot) {
  const { SCENARIO_REGISTRY, assertRegistryIsWellFormed, claimedCapabilities } = await import(
    join(root, "tests/differential-harness/scenarios.mjs")
  );
  const registryFailures = assertRegistryIsWellFormed(SCENARIO_REGISTRY);
  const cells = enumerateCells(root);
  const { rows, errors } = buildMatrix(cells, SCENARIO_REGISTRY, claimedCapabilities(SCENARIO_REGISTRY));
  const summary = summarise(rows);
  const digest = matrixDigest(rows);
  return {
    document: {
      version: 1,
      issue: "WIN-284",
      title: "Differential capability coverage — every census cell carries a declared status",
      oracle: "89c12b8aa8da75c561dc879f370aaefb6e3359bc",
      sources: [...CENSUS_SOURCES],
      generatedBy: "scripts/differential-coverage.mjs",
      coverageComputedFrom: "tests/differential-harness/scenarios.mjs",
      summary,
      digest,
      rows,
    },
    failures: [...registryFailures, ...errors],
  };
}

function main(argv) {
  const mode = argv.includes("--write") ? "write" : "check";
  return buildDocument().then(({ document, failures }) => {
    const markdown = assertMarkdownIsGateSafe(renderMarkdown(document));
    const json = `${gateSafeJson(document)}\n`;

    if (failures.length) {
      console.log(["differential-coverage: the matrix is not usable", ...failures.map((entry) => `FAIL: ${entry}`)].join("\n"));
      process.exitCode = 1;
      return;
    }

    if (mode === "write") {
      writeFileSync(join(repositoryRoot, JSON_PATH), json);
      writeFileSync(join(repositoryRoot, MARKDOWN_PATH), markdown);
      console.log(`differential-coverage: wrote ${document.summary.cells} cells (${document.summary.covered} covered)`);
      return;
    }

    const drift = [];
    for (const [path, expected] of [[JSON_PATH, json], [MARKDOWN_PATH, markdown]]) {
      let actual = null;
      try {
        actual = readFileSync(join(repositoryRoot, path), "utf8");
      } catch {
        drift.push(`${path} is missing; run node scripts/differential-coverage.mjs --write`);
        continue;
      }
      if (actual !== expected) drift.push(`${path} is stale; run node scripts/differential-coverage.mjs --write`);
    }
    console.log(
      [
        `differential-coverage: ${document.summary.cells} cells, ${document.summary.covered} covered, ${document.summary.uncovered} uncovered`,
        ...Object.entries(document.summary.bySurface).map(
          ([surface, counts]) => `  ${surface.padEnd(10)} ${String(counts.covered).padStart(4)}/${String(counts.total).padStart(4)}`,
        ),
        ...drift.map((entry) => `STALE: ${entry}`),
        drift.length === 0 ? "ok: the coverage matrix is current and every cell carries a status" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (drift.length) process.exitCode = 1;
  });
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("differential-coverage.mjs");
if (invokedDirectly) await main(process.argv.slice(2));
