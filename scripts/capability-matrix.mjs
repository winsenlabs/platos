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
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "apps/agent/src/control-plane/operation-manifest.generated.json");
const SCHEMA = join(ROOT, "internal-packages/tenancy-database/prisma/schema.prisma");
const END_USER_SCHEMA = join(ROOT, "internal-packages/tenancy-database/prisma/end-user.prisma");
const OUT_JSON = join(ROOT, "docs/audits/M0.2-capability-matrix.json");

const read = (p) => readFileSync(p, "utf8");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// ── REST + MCP, re-enumerated from the control-plane manifest ────────────────
function restAndMcp() {
  const m = JSON.parse(read(MANIFEST));
  const rest = m.inventories.restOperations.map((o) => ({
    id: `${o.method} ${o.path}`,
    surface: "rest",
    method: o.method,
    path: o.path,
    classification: o.classification,
    requiresOperator: (o.implementations || []).some((i) => i.requiresOperator),
    owner: contextForPath(o.path),
    persistence: "see owner context (M0.3 ADR)",
    compatibility: "V1 canonical /api/v1; versioned per WIN-249",
  }));
  const mcp = (m.inventories.mcpTools || []).map((t) => ({
    id: `mcp:${t.name ?? t}`,
    surface: "mcp-tool",
    name: t.name ?? t,
    owner: "tools (mcp-platform)",
    auth: "oauth-bearer / platform token",
    compatibility: "MCP serverInfo.version 1; per WIN-249",
  }));
  return { rest, mcp, restCount: rest.length, mcpCount: mcp.length, operatorCount: rest.filter((r) => r.requiresOperator).length };
}

// Map a REST path prefix to its proposed V1 bounded context (M0.3 ADR).
function contextForPath(p) {
  const map = [
    [/\/access-key|\/oauth|\/session|\/guest|\/auth/, "identity-access"],
    [/\/orgs|\/projects|\/environments|\/entities|\/entity/, "tenancy"],
    [/\/providers|\/models|\/keys/, "providers"],
    [/\/agents|\/agent-versions|\/clusters|\/canary/, "agents"],
    [/\/skills/, "skills"],
    [/\/tools|\/mcp/, "tools"],
    [/\/memory|\/graph/, "memory"],
    [/\/channels|\/channel-apps/, "channels"],
    [/\/threads|\/messages|\/turns|\/stream/, "conversations"],
    [/\/jobs|\/approvals|\/schedules|\/batch/, "jobs"],
    [/\/budgets|\/cost|\/monitoring/, "cost-monitoring"],
    [/\/evals|\/safety|\/ratings|\/governance/, "governance"],
    [/\/files|\/attachments|\/artifacts/, "files"],
    [/\/privacy|\/erasure|\/gdpr/, "privacy"],
    [/\/internal\//, "durable-runtime / internal-callbacks"],
  ];
  for (const [re, ctx] of map) if (re.test(p)) return ctx;
  return "unassigned (review)";
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
    },
    surfaces: {
      rest: rm.rest,
      mcp: rm.mcp,
      streaming: otherSurfaces().streaming,
      stores: { ...otherSurfaces().stores, tenancyModels, endUserModels },
      sdksProviders: otherSurfaces().sdksProviders,
    },
    persistedStateGaps: gaps(),
    acceptanceCriterion:
      "Every REST binding in operation-manifest.generated.json and every tenancy Prisma model appears here; counts are read from source, never hardcoded; --check fails on any drift.",
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
  if (check) {
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
    console.error(`capability-matrix: current. REST ${fresh.totals.restOperations} (operator ${fresh.totals.operatorProtectedRest}), MCP ${fresh.totals.mcpTools}, models ${fresh.totals.tenancyModels}+${fresh.totals.endUserRestrictedModels}. digest ${fresh.sourceDigest.slice(0, 12)}`);
    return;
  }
  writeFileSync(OUT_JSON, serialized);
  console.error(`capability-matrix: wrote ${OUT_JSON} — REST ${fresh.totals.restOperations}/${fresh.totals.operatorProtectedRest}op, MCP ${fresh.totals.mcpTools}, models ${fresh.totals.tenancyModels}+${fresh.totals.endUserRestrictedModels}, digest ${fresh.sourceDigest.slice(0, 12)}`);
}

main();
