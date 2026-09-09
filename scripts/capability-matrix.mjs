#!/usr/bin/env node
// WIN-247 — capability & persisted-state parity matrix.
//
// Re-enumerates the V1 capability surface FROM SOURCE at the frozen baseline and
// emits a durable machine-readable artifact. Non-vacuous by construction: the
// REST/MCP inventory is read from apps/agent/src/control-plane/
// operation-manifest.generated.json (the deterministic control-plane generator,
// corrected to 300 REST / 120 operator by WIN-294) and the persisted-state
// inventory from the tenancy Prisma schema, so a route or model added to the
// codebase that is missing from the matrix makes `--check` FAIL.
//
// Usage:
//   node scripts/capability-matrix.mjs           # regenerate the artifact
//   node scripts/capability-matrix.mjs --check    # fail if the committed artifact is stale/incomplete
//
// WIN-256 — the `owner` column. Owners come from `scripts/arch/route-ownership.mjs`,
// which resolves each row against ADR M0.3 §1 by the canonical rows its handler
// WRITES. There is no fallback: an unresolved path throws, so the former
// retired unresolved-owner placeholder is not producible here. `--check` also runs
// `validateOwners`, so a missing, empty, unknown or non-ADR owner fails the gate,
// and the rendered `.md` view is emitted from this same build rather than kept by
// hand, so the two cannot diverge.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  MCP_TOOL_OWNER,
  ORACLE_DERIVED_ROW_COUNT,
  PERMITTED_OWNERS,
  PLATFORM_TRANSPORT,
  PLATFORM_TRANSPORT_ROW_COUNT,
  ownerForRoute,
  validateOwners,
} from "./arch/route-ownership.mjs";
// WIN-267 — the scan roots are DECLARED ONCE, in the independent census, and
// imported here. Two files each keeping their own copy of "which directories the
// V1 REST surface lives in" is how one of them ends up a directory behind.
import { SCAN_ROOTS } from "./rest-census-independent.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "apps/agent/src/control-plane/operation-manifest.generated.json");
const SCHEMA = join(ROOT, "internal-packages/tenancy-database/prisma/schema.prisma");
const END_USER_SCHEMA = join(ROOT, "internal-packages/tenancy-database/prisma/end-user.prisma");
const OUT_JSON = join(ROOT, "docs/audits/M0.2-capability-matrix.json");
const OUT_MD = join(ROOT, "docs/audits/M0.2-capability-matrix.md");

const read = (p) => readFileSync(p, "utf8");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ── REST + MCP, re-enumerated from the control-plane manifest ────────────────
function restAndMcp() {
  const m = JSON.parse(read(MANIFEST));
  const rest = m.inventories.restOperations.map((o) => {
    const id = `${o.method} ${o.path}`;
    const resolved = ownerForRoute(id, o.path);
    return {
      id,
      surface: "rest",
      method: o.method,
      path: o.path,
      classification: o.classification,
      requiresOperator: (o.implementations || []).some((i) => i.requiresOperator),
      owner: resolved.owner,
      ownerSource: resolved.ownerSource,
      ...(resolved.ownerSource === "oracle-derived"
        ? {
            canonicalWrites: resolved.writes,
            canonicalReads: resolved.reads,
            ownerRationale: resolved.rationale,
            ownerEvidence: resolved.evidence,
          }
        : {}),
      persistence: "see owner context (M0.3 ADR)",
      compatibility: "V1 canonical /api/v1; versioned per WIN-249",
    };
  });
  const mcp = (m.inventories.mcpTools || []).map((t) => ({
    id: `mcp:${t.name ?? t}`,
    surface: "mcp-tool",
    name: t.name ?? t,
    owner: MCP_TOOL_OWNER,
    ownerSource: "adr-merge",
    auth: "oauth-bearer / platform token",
    compatibility: "MCP serverInfo.version 1; per WIN-249",
  }));
  return {
    rest,
    mcp,
    restCount: rest.length,
    mcpCount: mcp.length,
    operatorCount: rest.filter((r) => r.requiresOperator).length,
    scanRoots: scanRootAccounting(m),
  };
}

/**
 * WIN-267 — the REST total, split by the tree each operation came from.
 *
 * The matrix used to publish one REST number over one application, at a moment
 * when a second application was being built to serve the same surface. A total
 * that cannot say which tree it covers cannot notice a tree it does not cover.
 *
 * This is a RE-DERIVATION, not a read: the split is computed here from each
 * implementation's own `source` path, and then checked against the split the
 * generator wrote into `summary.restScanRoots`. The generator counted while
 * walking; this counts the emitted rows. Agreement is the claim; disagreement
 * names the root and both numbers.
 */
export function scanRootAccounting(manifest) {
  const declared = SCAN_ROOTS.map((root) => ({ ...root, operations: 0, routeBindings: 0 }));
  const unattributed = [];
  for (const operation of manifest.inventories.restOperations) {
    const owning = new Set();
    for (const implementation of operation.implementations ?? []) {
      const source = String(implementation.source ?? "").split("\\").join("/");
      const match = declared.find((r) => source === r.dir || source.startsWith(`${r.dir}/`));
      if (!match) {
        unattributed.push(`${operation.id} <- ${source || "(no source recorded)"}`);
        continue;
      }
      match.routeBindings += 1;
      owning.add(match.id);
    }
    for (const id of owning) declared.find((r) => r.id === id).operations += 1;
  }

  const errors = [];
  if (unattributed.length > 0) {
    errors.push(
      `scan-root-unattributed: ${unattributed.length} REST implementation source(s) fall outside every declared scan root (${SCAN_ROOTS.map((r) => r.dir).join(", ")}): ${unattributed.sort().slice(0, 8).join("; ")}`,
    );
  }
  const generated = manifest.summary?.restScanRoots;
  if (!Array.isArray(generated)) {
    errors.push(
      "scan-root-missing-from-manifest: the control-plane manifest publishes no summary.restScanRoots, so this re-derivation has nothing to agree with; regenerate it with `pnpm --filter platos-agent generate:control-plane`",
    );
  } else {
    for (const root of declared) {
      const theirs = generated.find((g) => g.id === root.id);
      if (!theirs) {
        errors.push(`scan-root-absent: the manifest's restScanRoots does not name ${root.id} (${root.dir})`);
        continue;
      }
      if (theirs.operations !== root.operations) {
        errors.push(
          `scan-root-count: ${root.id} — the generator recorded ${theirs.operations} operation(s) while re-deriving the emitted rows gives ${root.operations}`,
        );
      }
    }
    for (const theirs of generated) {
      if (!declared.some((root) => root.id === theirs.id)) {
        errors.push(
          `scan-root-undeclared: the manifest's restScanRoots names ${theirs.id} (${theirs.dir}), which SCAN_ROOTS in scripts/rest-census-independent.mjs does not declare`,
        );
      }
    }
  }

  return {
    authority: "scripts/rest-census-independent.mjs SCAN_ROOTS",
    roots: declared.map((r) => ({ id: r.id, dir: r.dir, operations: r.operations, routeBindings: r.routeBindings })),
    unattributed: unattributed.sort(),
    /**
     * WIN-268 (M4.2) P1 — the operations counted under MORE THAN ONE root.
     *
     * `owning` above is a SET, so an operation served twice inside one root is
     * counted once for that root — correct. What it cannot avoid is an operation
     * served by two DIFFERENT roots being counted once for each, so the roots'
     * operation counts sum to more than the surface has operations. That is not
     * an error and it is not a rounding: the two MCP token mints really are
     * served by both deployables, `apps/agent` since before V1 and
     * `apps/core-api` now that the `Idempotency-Key` gate has a handler behind
     * the templates it binds.
     *
     * Published so the sum stays an EQUALITY with a named term rather than
     * becoming a tolerance: `sum(roots) - shared === restOperations`.
     */
    sharedAcrossRoots: manifest.inventories.restOperations.filter((operation) => {
      const roots = new Set();
      for (const implementation of operation.implementations ?? []) {
        const source = String(implementation.source ?? "").split("\\").join("/");
        const match = declared.find((r) => source === r.dir || source.startsWith(`${r.dir}/`));
        if (match) roots.add(match.id);
      }
      return roots.size > 1;
    }).length,
    errors,
  };
}

// ── Persisted state, re-enumerated from the Prisma schemas ───────────────────
function models(path) {
  return [...read(path).matchAll(/^model\s+(\w+)\s*\{/gmu)].map((x) => x[1]);
}

// ── Streaming / stores / SDK / provider surfaces (baseline-confirmed, M0.2) ───
// These are recorded as reviewed inventory (the WS/SSE/Redis/ClickHouse/MinIO
// surfaces enumerated + baseline-re-verified in WIN-247's M0.2 sweep).
function otherSurfaces() {
  return {
    streaming: {
      wsInbound: 6, wsOutboundDistinct: 9, wsDynamic: 1, agentStreamEventVariants: 20,
      toolSyncIn: 4, toolSyncOut: 7, sseProducerFiles: 4, mcpTransportFamilies: 3, redisFanInChannels: 3,
      notes: "connections.gateway.ts (@SubscribeMessage x6), tool-sync-ws, agent SSE, 3 MCP transports, Redis approval:event/thread:lifecycle/overview:event. approval_needed carries durableToken.",
    },
    stores: {
      clickhouseDatabases: 2, clickhouseLiveTables: 18, clickhouseLiveMVs: 7, minioBuckets: 1,
      redisKeyFamilies: 64, redisPrefix: "platos:",
      notes: "ClickHouse platos_telemetry (renamed from the legacy run-engine database) + platos_observability; MinIO platos-media; Redis under ioredis keyPrefix platos:.",
    },
    sdksProviders: {
      sdkPackages: ["@platosdev/client", "platos-client-py", "@platosdev/platools-sdk", "platools-py", "@platosdev/token-mint"],
      providerManifests: 14,
      notes: "14+ provider manifests (anthropic/openai/google/google-vertex/groq/mistral/xai/deepseek/cerebras/perplexity/together/fireworks/sakana/azure); model catalog + routing/fallback + cost.",
    },
  };
}

// ── Known persisted-state gaps carried to downstream issues ──────────────────
function gaps() {
  return [
    {
      id: "oidc-session-erasure-gap",
      finding: "McpOidcSession (schema.prisma) stores end-user email / displayName / avatar / externalSubject and is NOT referenced by apps/agent/src/privacy — only Environment/Entity onDelete:Cascade removes it. An end-user erasure request leaves OIDC PII behind.",
      severity: "privacy",
      downstreamIssue: "WIN-278 (M5.6 — preserve privacy, audit, retention and cryptographic erasure across every store)",
      status: "recorded; NOT fixed in M0",
    },
    {
      id: "mcp-anonymous-session-lifecycle",
      finding: "McpAnonymousSession (IP + UA) has no sweeper/TTL/revocation cron.",
      severity: "privacy",
      downstreamIssue: "WIN-278",
      status: "recorded",
    },
  ];
}

/**
 * The owner column, counted. Pinned here so a future row cannot slip in without
 * moving a number a reader can see: `restRows` must equal the REST total, and
 * the two ownerSource counts must add up to it.
 */
function ownershipSummary(rest, mcp) {
  const byOwner = {};
  for (const r of [...rest, ...mcp]) byOwner[r.owner] = (byOwner[r.owner] ?? 0) + 1;
  const oracleDerived = rest.filter((r) => r.ownerSource === "oracle-derived");
  return {
    authority: "docs/adr/M0.3-bounded-contexts.md §1",
    resolvedBy: "scripts/arch/route-ownership.mjs",
    oracle: "89c12b8",
    permittedOwners: [...PERMITTED_OWNERS],
    restRows: rest.length,
    mcpRows: mcp.length,
    oracleDerivedRestRows: oracleDerived.length,
    pathPrefixRestRows: rest.filter((r) => r.ownerSource === "path-prefix").length,
    platformTransportRows: rest.filter((r) => r.owner === PLATFORM_TRANSPORT).length,
    byOwner: Object.fromEntries(Object.entries(byOwner).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))),
    note:
      `Every row names one of the ${PERMITTED_OWNERS.length} permitted values. ${oracleDerived.length} REST rows carry per-row evidence (the handler at the oracle and the canonical rows it writes) and are checked against table-ownership.mjs; the remaining ${rest.length - oracleDerived.length} are derived from the URL prefix and are marked ownerSource "path-prefix" so the weaker claim is visible.`,
  };
}

/** The rendered view. Emitted from this build, so it cannot drift from the JSON. */
function renderMarkdown(m) {
  const o = m.ownership;
  const lines = [
    "# M0.2 — Capability & Persisted-State Parity Matrix (WIN-247)",
    "",
    "> Durable artifact generated by `scripts/capability-matrix.mjs` from source (control-plane manifest + Prisma schemas). This view and `M0.2-capability-matrix.json` are written by the same run, so they cannot diverge. Validate: `pnpm audit:capability-matrix`. Non-vacuous.",
    "",
    "## Totals (source-derived)",
    "| Surface | Count |",
    "|---|---|",
    `| REST operations | ${m.totals.restOperations} |`,
    ...m.scanRoots.roots.map((r) => `| — from \`${r.dir}\` (${r.id}) | ${r.operations} |`),
    `| operator-protected | ${m.totals.operatorProtectedRest} |`,
    `| MCP tools | ${m.totals.mcpTools} |`,
    `| Tenancy models | ${m.totals.tenancyModels} |`,
    `| End-user models | ${m.totals.endUserRestrictedModels} |`,
    "",
    `Source digest \`${m.sourceDigest.slice(0, 16)}\``,
    "",
    "## Ownership (WIN-256)",
    "",
    `Authority: ${o.authority}. Resolved by \`${o.resolvedBy}\` against the ${o.oracle} oracle.`,
    `${o.restRows} REST rows = ${o.oracleDerivedRestRows} resolved from the handler + ${o.pathPrefixRestRows} from the URL prefix. ${o.platformTransportRows} carry \`${PLATFORM_TRANSPORT}\`, the one non-context value, admitted only for rows that write and read no canonical row.`,
    "",
    "| Owner | Rows (REST + MCP) |",
    "|---|---|",
    ...Object.entries(o.byOwner).map(([owner, n]) => `| \`${owner}\` | ${n} |`),
    "",
    "## Persisted-state gaps (downstream, not fixed in M0)",
    ...m.persistedStateGaps.map((g) => `- **${g.id}** → ${g.downstreamIssue}`),
    "",
  ];
  return lines.join("\n");
}

function build() {
  const rm = restAndMcp();
  const tenancyModels = models(SCHEMA);
  const endUserModels = models(END_USER_SCHEMA);
  const matrix = {
    milestone: "M0.2",
    issue: "WIN-247",
    title: "Capability & persisted-state parity matrix",
    baseline: "89c12b8 (frozen main oracle); re-enumerated from operation-manifest.generated.json + tenancy Prisma schemas",
    generatedBy: "scripts/capability-matrix.mjs",
    totals: {
      restOperations: rm.restCount,
      operatorProtectedRest: rm.operatorCount,
      mcpTools: rm.mcpCount,
      tenancyModels: tenancyModels.length,
      endUserRestrictedModels: endUserModels.length,
      restOperationsByScanRoot: Object.fromEntries(rm.scanRoots.roots.map((r) => [r.id, r.operations])),
      // WIN-268 P1 — how many of those are the SAME operation under two roots.
      // `sum(restOperationsByScanRoot) - restOperationsSharedAcrossScanRoots ===
      // restOperations`, which is what `capability-matrix.test.mjs` asserts.
      restOperationsSharedAcrossScanRoots: rm.scanRoots.sharedAcrossRoots,
    },
    scanRoots: rm.scanRoots,
    surfaces: {
      rest: rm.rest,
      mcp: rm.mcp,
      streaming: otherSurfaces().streaming,
      stores: { ...otherSurfaces().stores, tenancyModels, endUserModels },
      sdksProviders: otherSurfaces().sdksProviders,
    },
    ownership: ownershipSummary(rm.rest, rm.mcp),
    persistedStateGaps: gaps(),
    acceptanceCriterion:
      "Every REST binding in operation-manifest.generated.json and every tenancy Prisma model appears here; counts are read from source, never hardcoded; --check fails on any drift. Every row names an ADR M0.3 §1 context, or the one non-context value `<platform-transport>` under the admission rule in scripts/arch/route-ownership.mjs; the retired unresolved-owner placeholder is neither producible nor accepted, and is refused by its own named rule.",
  };
  // integrity digest over the source-derived skeleton (not the prose)
  matrix.sourceDigest = sha256(JSON.stringify({
    rest: rm.rest.map((r) => r.id).sort(),
    mcp: rm.mcp.map((r) => r.id).sort(),
    tenancyModels: [...tenancyModels].sort(),
    endUserModels: [...endUserModels].sort(),
    totals: matrix.totals,
  }));
  return matrix;
}

function main() {
  const check = process.argv.includes("--check");
  const fresh = build();
  const serialized = JSON.stringify(fresh, null, 2) + "\n";
  const rendered = renderMarkdown(fresh);

  // WIN-256 — the owner column is checked on every run, generate and --check
  // alike, so a bad owner cannot be written to disk and then read back as
  // "current". Each failure names the offending row id and its rule.
  // WIN-267 — the scan-root split is checked on every run, generate and --check
  // alike, for the same reason the owner column is: a matrix written from a
  // manifest whose roots do not reconcile would be read back as "current".
  if (fresh.scanRoots.errors.length > 0) {
    console.error(`capability-matrix: ${fresh.scanRoots.errors.length} scan-root violation(s).`);
    for (const e of fresh.scanRoots.errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const ownerErrors = validateOwners(fresh.surfaces.rest, fresh.surfaces.mcp);
  if (ownerErrors.length > 0) {
    console.error(`capability-matrix: ${ownerErrors.length} owner violation(s) against ADR M0.3 §1.`);
    for (const e of ownerErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  if (check) {
    // WIN-256 — validate the COMMITTED rows too, not just the fresh build. A
    // hand-edited owner would otherwise only ever report as "out of date", and
    // the reader would not learn which rule they broke.
    try {
      const onDisk = JSON.parse(readFileSync(OUT_JSON, "utf8"));
      const committedErrors = validateOwners(
        onDisk.surfaces?.rest ?? [],
        onDisk.surfaces?.mcp ?? [],
      );
      if (committedErrors.length > 0) {
        console.error(`capability-matrix: ${committedErrors.length} owner violation(s) in the COMMITTED artifact against ADR M0.3 §1.`);
        for (const e of committedErrors) console.error(`  ${e}`);
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error(`capability-matrix: the committed artifact is not valid JSON — ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    let committedMd;
    try { committedMd = readFileSync(OUT_MD, "utf8"); } catch { committedMd = null; }
    if (committedMd !== rendered) {
      console.error("capability-matrix: OUT OF DATE — the committed .md view does not match a fresh render of the .json.");
      console.error("  run `node scripts/capability-matrix.mjs` and commit both files.");
      process.exit(1);
    }
    let committed;
    try { committed = readFileSync(OUT_JSON, "utf8"); } catch { committed = null; }
    if (committed !== serialized) {
      console.error("capability-matrix: OUT OF DATE — the committed matrix does not match a fresh re-enumeration from source.");
      console.error("  run `node scripts/capability-matrix.mjs` and commit the result.");
      if (committed) {
        const c = JSON.parse(committed);
        if (c.sourceDigest !== fresh.sourceDigest) console.error(`  sourceDigest drift: ${c.sourceDigest?.slice(0, 12)} -> ${fresh.sourceDigest.slice(0, 12)}`);
        if (JSON.stringify(c.totals) !== JSON.stringify(fresh.totals)) console.error(`  totals drift: ${JSON.stringify(c.totals)} -> ${JSON.stringify(fresh.totals)}`);
      }
      process.exit(1);
    }
    console.error(`capability-matrix: current. REST ${fresh.totals.restOperations} (operator ${fresh.totals.operatorProtectedRest}), MCP ${fresh.totals.mcpTools}, models ${fresh.totals.tenancyModels}+${fresh.totals.endUserRestrictedModels}. digest ${fresh.sourceDigest.slice(0, 12)}. owners: ${fresh.ownership.oracleDerivedRestRows} handler-resolved + ${fresh.ownership.pathPrefixRestRows} prefix-derived, ${fresh.ownership.platformTransportRows} ${PLATFORM_TRANSPORT}, ${PERMITTED_OWNERS.length} permitted values.`);
    return;
  }
  writeFileSync(OUT_JSON, serialized);
  writeFileSync(OUT_MD, rendered);
  console.error(`capability-matrix: wrote ${OUT_JSON} + ${OUT_MD} — REST ${fresh.totals.restOperations}/${fresh.totals.operatorProtectedRest}op, MCP ${fresh.totals.mcpTools}, models ${fresh.totals.tenancyModels}+${fresh.totals.endUserRestrictedModels}, digest ${fresh.sourceDigest.slice(0, 12)}, owners ${fresh.ownership.oracleDerivedRestRows}+${fresh.ownership.pathPrefixRestRows}`);
}

// Only when INVOKED. `scanRootAccounting` is imported by capability-matrix.test.mjs,
// and a module that regenerates the artifact on import would make the suite's
// exit code the gate's exit code.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
