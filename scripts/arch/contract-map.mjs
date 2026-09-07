#!/usr/bin/env node
// WIN-249 design-to-contract map — builder and validator.
//
// Emits the durable artifact docs/audits/M0.4-design-contract-map.{json,md} from
// the ADR M0.4 (docs/adr/M0.4-contract-versioning.md §3, §7) coverage matrix, and
// validates it against the real design directory so the map cannot silently drift
// from the settled screens.
//
//   node scripts/arch/contract-map.mjs --write   # (re)write the JSON + MD artifacts
//   node scripts/arch/contract-map.mjs            # validate (default; --check alias)
//
// The validator asserts, against design/platos-ui-refactor/*.dc.html:
//   * every design page is accounted for (mapped demand OR explicit exclusion);
//   * the 4 undemanded pages are exactly 00-index, 43-docs, 47-parts, PlatosNav;
//   * the canonical /api/v1 prefix rule and the 18 literal controllers pending
//     the M4 @Version migration are recorded;
//   * the D0–D7 accepted corrections are recorded;
//   * the committed JSON/MD match what this source would emit (no drift).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const repoDir = fileURLToPath(repoRoot);
const designDir = fileURLToPath(new URL("design/platos-ui-refactor/", repoRoot));
const jsonOut = fileURLToPath(new URL("docs/audits/M0.4-design-contract-map.json", repoRoot));
const mdOut = fileURLToPath(new URL("docs/audits/M0.4-design-contract-map.md", repoRoot));

// ── THE LITERAL MIGRATION, MEASURED (WIN-267) ───────────────────────────────
//
// This file used to WRITE `count: 18` into the model and then assert
// `literalMigration.count !== 18` against the model it had just written. An
// assertion comparing two things one file controls cannot fail: the "18-literal
// @Version migration note not recorded" error was unreachable in every tree,
// including one with zero literals left, which is the opposite of what a
// pre-gate for the migration is for.
//
// It is now MEASURED FROM THE TREE by two mechanisms, and the validator checks
// the COMMITTED artifact against a fresh measurement, so the number on disk and
// the number in the source are joined to something neither of them controls.
//
// THE MEASURED TRUTH, and the correction it forces: 18 was never derived from
// anything. Scanning every production TypeScript file for `api/v1` string
// literals inside a Nest routing decorator finds 24 literals on 23 source lines
// across 20 controller files — identical on the frozen `main` oracle and on
// `v1`. The gap is not drift: `memory.controller.ts` puts two literals on ONE
// line (the `api/v1/platos/memory` alias), and four of the twenty carry the
// prefix on a method decorator rather than on `@Controller`, which a count of
// "@Controller literals" misses entirely.
export const ROUTING_DECORATORS = Object.freeze([
  "Controller",
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "All",
  "Options",
  "Head",
]);
export const LITERAL_SCAN_ROOTS = Object.freeze(["apps", "packages", "internal-packages"]);
const SOURCE_FILE = /\.tsx?$/u;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/u;

function productionSources(root, acc = []) {
  if (!existsSync(root)) return acc;
  for (const entry of readdirSync(root)) {
    if (["node_modules", "dist", "build", ".turbo", ".next"].includes(entry)) continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) productionSources(path, acc);
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith(".d.ts"))
      acc.push(path);
  }
  return acc;
}

/**
 * Mechanism A — structural. Walks the balanced argument list of every routing
 * decorator and collects the string literals inside it that carry `api/v1`.
 * Comment- and string-aware, so a decorator name in prose counts for nothing and
 * a `)` inside a literal does not end the argument list early.
 */
export function measureApiV1Literals(root = repoDir) {
  const decorator = new RegExp(`@(?:${ROUTING_DECORATORS.join("|")})\\s*\\(`, "gu");
  const sites = [];
  for (const scanRoot of LITERAL_SCAN_ROOTS) {
    for (const path of productionSources(join(root, scanRoot))) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("api/v1")) continue;
      const file = path.slice(root.length).replace(/^[/\\]/u, "").split("\\").join("/");
      for (const match of text.matchAll(decorator)) {
        const open = match.index + match[0].length;
        let depth = 1;
        let index = open;
        let quote = null;
        let literalStart = -1;
        while (index < text.length && depth > 0) {
          const ch = text[index];
          if (quote !== null) {
            if (ch === "\\") index += 1;
            else if (ch === quote) {
              const value = text.slice(literalStart + 1, index);
              if (value.includes("api/v1"))
                sites.push({
                  file,
                  line: text.slice(0, literalStart).split("\n").length,
                  decorator: match[0].slice(1, -1).trim().replace(/\s*\($/u, ""),
                  literal: value,
                });
              quote = null;
            }
            index += 1;
            continue;
          }
          if (ch === "/" && text[index + 1] === "/") {
            index = text.indexOf("\n", index);
            if (index === -1) break;
            continue;
          }
          if (ch === "/" && text[index + 1] === "*") {
            const end = text.indexOf("*/", index + 2);
            index = end === -1 ? text.length : end + 2;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            literalStart = index;
          } else if (ch === "(") depth += 1;
          else if (ch === ")") depth -= 1;
          index += 1;
        }
      }
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.literal.localeCompare(b.literal));
  return {
    literals: sites.length,
    sourceLines: new Set(sites.map((s) => `${s.file}:${s.line}`)).size,
    files: new Set(sites.map((s) => s.file)).size,
    sites,
  };
}

/**
 * Mechanism B — line-based, and deliberately cruder. Counts SOURCE LINES on
 * which a routing decorator opens with an `api/v1` literal. It cannot see the
 * second literal on a shared line, which is exactly why it is a useful second
 * opinion: A and B must agree on the LINE count, and their disagreement on the
 * LITERAL count is the alias this file exists to record.
 */
export function measureApiV1LiteralLines(root = repoDir) {
  const pattern = new RegExp(
    `@(?:${ROUTING_DECORATORS.join("|")})\\s*\\(\\s*\\[?\\s*["'\`][^"'\`]*api/v1`,
    "u",
  );
  let lines = 0;
  for (const scanRoot of LITERAL_SCAN_ROOTS) {
    for (const path of productionSources(join(root, scanRoot))) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("api/v1")) continue;
      for (const line of text.split("\n")) if (pattern.test(line)) lines += 1;
    }
  }
  return lines;
}

// The canonical version-surface facts (ADR M0.4 §2, D1). "V1 is the frozen
// semantic surface, not a URL." The major axis is the URL segment via Nest
// @Version, promoted from per-controller literals.
function canonicalPrefix(measured) {
  return {
    prefix: "/api/v1",
    rule: "A version is a property of the contract, not the code path. The REST major axis is the URL segment, pinned by Nest @Version — never a per-controller literal string.",
    expression: 'setGlobalPrefix("api") + enableVersioning({ type: URI, defaultVersion: "1" }) + @Version("1")',
    buildIdHeader: "X-Platos-Contract-Version",
    floorRequestHeader: "X-Platos-Contract-Min",
    literalMigration: {
      literals: measured.literals,
      sourceLines: measured.sourceLines,
      files: measured.files,
      measuredBy:
        "scripts/arch/contract-map.mjs measureApiV1Literals — string literals containing \"api/v1\" inside the balanced argument list of a Nest routing decorator (@Controller/@Get/@Post/@Put/@Patch/@Delete/@All/@Options/@Head), over production .ts/.tsx under apps/, packages/ and internal-packages/ (tests and .d.ts excluded).",
      crossCheckedBy:
        "measureApiV1LiteralLines — an independent line-based count that must agree on sourceLines.",
      supersedes: {
        count: 18,
        why: "ADR M0.4 §2/D1 recorded 18 and this file both wrote and asserted that number, so nothing could contradict it. 18 counts neither the literals, nor the lines, nor the files: two literals share one line in memory.controller.ts, and four of the twenty files carry the prefix on a method decorator rather than on @Controller.",
      },
      from: '@Controller("api/v1/...") hardcoded literals',
      to: 'setGlobalPrefix + enableVersioning + @Version("1")',
      milestone: "M4",
      status: measured.literals === 0 ? "complete" : "pending",
      enforcedBy:
        'no-bare-prefix lint: generation fails on any literal "api/v1" string once the migration lands, so the drift-check reads structure, not a string (ADR M0.4 §2 REST row, §5 item 2).',
      prerequisiteFor:
        'the "version is a contract, not a path" guarantee — the drift-check only reads a string until every literal becomes @Version("1") (D1).',
      sites: measured.sites,
    },
  };
}

// The seven accepted D-decisions with their binding corrections (ADR M0.4 §7).
const CORRECTIONS = {
  D0: {
    title: "Screen reconciliation",
    status: "RESOLVED",
    text: "The design directory holds 47 HTML pages: 46 numbered (files 06 and 33 do not exist) plus PlatosNav. 43 carry mapped demand. The 4 existing-but-undemanded pages are exactly 00-index, 43-docs, 47-parts, and PlatosNav (index, docs viewer, component parts, and the nav shell — structural, not feature screens). Each gets mapped demand or an explicit no-backend-contract exclusion before M4 exit.",
  },
  D1: {
    title: "REST version lives in URL major + additive build-id header",
    status: "accepted",
    text: "URL pins the major; a contract header carries the additive build id. Migrate the 18 literal @Controller(\"api/v1/...\") controllers to @Version(\"1\") FIRST, before the drift-check can enforce anything.",
  },
  D2: {
    title: "MCP contract version separate from protocol negotiation",
    status: "accepted",
    text: "The MCP protocol date stays spec-negotiated; the Platos semver rides in serverInfo.version + _meta. Collapse the three hardcoded \"0.1.0\" into one const first.",
  },
  D3: {
    title: "Durable-token lifetime",
    status: "CORRECTED",
    text: "Durable tokens survive until terminal state plus their retention window — NOT literally forever. A token is honored while its run can still reach a terminal state and through its defined retention.",
  },
  D4: {
    title: "Absent stream version baseline",
    status: "CORRECTED",
    text: "A missing stream version maps to V1 only at identified legacy ingress points, not as a blanket default everywhere. New surfaces must carry an explicit sv/pv.",
  },
  D5: {
    title: "Introducing the canonical envelope over live bare-object routes",
    status: "CORRECTED",
    text: "Compatibility adapters preserve the legacy response shape and must not emit an ambiguous dual response shape. Existing routes keep their exact current shape during the window; new contexts are envelope-native. No route ever returns two shapes ambiguously.",
  },
  D6: {
    title: "Self-host the OpenAPI UI",
    status: "accepted",
    text: "Vendor swagger-ui-dist locally rather than loading it from a CDN, so the contract document does not depend on a third party.",
  },
  D7: {
    title: "Field-level compatibility enforcement",
    status: "accepted",
    text: "Mandate DTO schema declaration on all new v1 contexts plus the retrofitted envelope, so the breaking-change guard can enforce additive-only field compatibility.",
  },
  D8: {
    title: "Both pre-gate numbers were unmeasured; they are now derived from the tree",
    status: "CORRECTED",
    text: "Two figures this map published were written by hand and asserted against themselves. (1) The literal migration was recorded as 18 and validated by comparing the model to the constant that produced it, so no tree could fail it; measured, it is 24 `api/v1` literals on 23 source lines across 20 controller files, identical on the 89c12b8 oracle and on v1. (2) `totals.newContracts` was the sum of a hand-kept per-screen `newCount` that disagreed with the contract rows on 12 of the 43 screens; the histogram over the 124 rows is N 104, E 16, E-stream 3, E-partial 1, so net-new is 104 and not 98. Both are now derived — the literal count from the source tree, the contract counts from the rows themselves — and both are validated against the COMMITTED artifact rather than against the source that emitted it.",
  },
};

/** Every contract-status token the map may carry. Anything else fails validation. */
const CONTRACT_STATUSES = ["N", "E", "E-stream", "E-partial"];

// The 43 screens that carry mapped demand (ADR M0.4 §3, clusters A–E). Each
// entry: cluster, transports touched, count of NEW contracts, and a compact list
// of the contracts the screen depends on with status:
//   E = served by an existing contract   N = new contract (does not exist today)
//   E-stream = existing stream, needs versioning   E-partial = partial today
const SCREENS = [
  // Cluster A — auth · tenancy · billing · admin (7)
  { id: "01-auth", cluster: "A", transports: ["REST", "SSE"], newCount: 5, contracts: [
    { name: "instance/plan capability descriptor", status: "N" },
    { name: "auth session lifecycle (OAuth + MFA + magic-link) consume", status: "N" },
    { name: "operator break-glass passcode", status: "N" },
    { name: "backup-codes consume", status: "N" },
    { name: "SSE auth_completed{flow,requestId}", status: "N" } ] },
  { id: "02-onboarding", cluster: "A", transports: ["REST"], newCount: 4, contracts: [
    { name: "createWorkspace → org+project+prodEnv atomic", status: "E" },
    { name: "invitation detail read", status: "E" },
    { name: "invite decline", status: "N" },
    { name: "VIEWER role", status: "N" },
    { name: "per-env tool-approval rights", status: "N" },
    { name: "plan options (billing)", status: "N" } ] },
  { id: "05-orgs", cluster: "A", transports: ["REST", "WS"], newCount: 4, contracts: [
    { name: "org membership/member/invite reads", status: "E" },
    { name: "changeMemberRole (ends all target sessions)", status: "E" },
    { name: "invite resend/revoke", status: "N" },
    { name: "VIEWER role", status: "N" },
    { name: "org/fleet 7d cost rollup", status: "N" },
    { name: "WS session_revoked{userId,sessionId,reason}", status: "N" } ] },
  { id: "07-billing", cluster: "A", transports: ["REST", "Webhook"], newCount: 2, contracts: [
    { name: "entire billing/subscription context (plan/status/usage/card/invoices/cancel/export/dunning)", status: "N" },
    { name: "webhook subscription_status{status,readOnlyAt,retry}", status: "N" } ] },
  { id: "08-account", cluster: "A", transports: ["REST", "SSE"], newCount: 5, contracts: [
    { name: "profile/theme", status: "E" },
    { name: "TOTP re-enroll", status: "E" },
    { name: "PAT CRUD (model exists, no REST contract)", status: "N" },
    { name: "backup-codes view/regenerate", status: "N" },
    { name: "device-authorization grant", status: "N" },
    { name: "active-session list + revoke-by-id", status: "N" },
    { name: "SSE device_authorization + auth_completed", status: "N" } ] },
  { id: "40-settings", cluster: "A", transports: ["REST"], newCount: 3, contracts: [
    { name: "env identity rename / tracing toggle / retention / delete", status: "N" },
    { name: "env-scoped MCP token mint/revoke (pk_mcp_, shown-once)", status: "N" },
    { name: "rate-limit config + p99 usage", status: "N" } ] },
  { id: "45-admin", cluster: "A", transports: ["REST", "SSE"], newCount: 4, contracts: [
    { name: "cross-org fleet aggregates", status: "N" },
    { name: "impersonation start/stop (domain exists, unexposed)", status: "N" },
    { name: "fleet feature-flag rollout", status: "N" },
    { name: "SSE fleet_metrics + impersonation_started|ended", status: "N" } ] },

  // Cluster B — home · command · agents · skills (11)
  { id: "03-home", cluster: "B", transports: ["REST", "WS"], newCount: 8, contracts: [
    { name: "env needs-attention heterogeneous aggregate feed", status: "N" },
    { name: "env + per-agent spend/turn-ledger rollup", status: "N" },
    { name: "WS agent.presence/entity.heartbeat/spend.updated/thread.state/approval_needed/job.failed", status: "N" } ] },
  { id: "04-command", cluster: "B", transports: ["REST", "SSE"], newCount: 2, contracts: [
    { name: "unified cross-context search (agents+threads+tools+memories)", status: "N" },
    { name: "contextual blocked-right-now (open approvals + entity reconnect)", status: "N" },
    { name: "inline approve via durableToken", status: "E-stream" } ] },
  { id: "09-agent-share", cluster: "B", transports: ["REST"], newCount: 1, contracts: [
    { name: "guest share-link lifecycle (create/revoke+reason+actor, guest limits, activity rollup)", status: "N" } ] },
  { id: "10-agents", cluster: "B", transports: ["REST", "WS"], newCount: 3, contracts: [
    { name: "agent list read", status: "E" },
    { name: "cost columns + trend spark (ledger rollup)", status: "N" },
    { name: "health rollup + broken-entity note", status: "N" },
    { name: "WS presence/heartbeat", status: "N" } ] },
  { id: "11-agent-new", cluster: "B", transports: ["REST"], newCount: 2, contracts: [
    { name: "agent create", status: "E" },
    { name: "model catalog + per-model credential status + env cost-estimate band", status: "N" },
    { name: "name-availability surfacing archived collision", status: "N" } ] },
  { id: "12-agent-config", cluster: "B", transports: ["REST"], newCount: 3, contracts: [
    { name: "agent config read/save-as-vN", status: "E" },
    { name: "structured prompt-block contract", status: "N" },
    { name: "effective/assembled-config preview", status: "N" },
    { name: "canary health metric", status: "N" } ] },
  { id: "13-agent-context", cluster: "B", transports: ["REST"], newCount: 1, contracts: [
    { name: "prompt-variable resolution diagnostics", status: "N" } ] },
  { id: "14-agent-tools", cluster: "B", transports: ["REST", "WS"], newCount: 2, contracts: [
    { name: "tool inventory read", status: "E" },
    { name: "live dispatchability probe (per-tool yes/no + latency)", status: "N" },
    { name: "WS entity.reachability + tool.dispatch.result", status: "N" } ] },
  { id: "15-agent-versions", cluster: "B", transports: ["REST"], newCount: 2, contracts: [
    { name: "version history read", status: "E" },
    { name: "semantic config diff grouped by domain", status: "N" },
    { name: "canary health metrics (escalation-rate vs stable)", status: "N" } ] },
  { id: "27-clusters", cluster: "B", transports: ["REST"], newCount: 1, contracts: [
    { name: "cluster list read", status: "E" },
    { name: "cluster membership as guarded data-boundary mutation with impact preview + recall-audit (no optimistic)", status: "N" } ] },
  { id: "28-skills", cluster: "B", transports: ["REST"], newCount: 1, contracts: [
    { name: "skill list/detail read", status: "E" },
    { name: "skill-manifest reconciliation vs live entity tool inventory", status: "N" } ] },

  // Cluster C — conversations · jobs · observability (7)
  { id: "16-threads", cluster: "C", transports: ["REST", "WS"], newCount: 2, contracts: [
    { name: "thread-list read model with turn-ledger-joined aggregates + CSV export", status: "N" },
    { name: "WS thread.status_changed + new-thread append", status: "N" } ] },
  { id: "17-thread", cluster: "C", transports: ["REST", "SSE"], newCount: 4, contracts: [
    { name: "thread/turn read", status: "E" },
    { name: "per-turn token-economics (cache-read/write/full-price lanes)", status: "N" },
    { name: "tool-call error-attribution (dispatch|provider, misattributed flag) + retry", status: "N" },
    { name: "erase-user-data (GDPR) per-thread/user", status: "N" },
    { name: "versioned streaming turn envelope", status: "N" } ] },
  { id: "18-trace", cluster: "C", transports: ["REST"], newCount: 1, contracts: [
    { name: "trace/span read + latency-profile segmentation + per-span cost join + OTLP export", status: "N" } ] },
  { id: "19-playground", cluster: "C", transports: ["SSE", "REST"], newCount: 2, contracts: [
    { name: "live turn (SSE)", status: "E-stream" },
    { name: "context-assembly dry-run (what would be sent next turn before the model runs)", status: "N" },
    { name: "turn feedback thumbs keyed to turnId", status: "N" } ] },
  { id: "32-traces", cluster: "C", transports: ["REST", "WS"], newCount: 2, contracts: [
    { name: "traces-list read + latency profile + OTLP export", status: "N" },
    { name: "WS trace.created live-append", status: "N" } ] },
  { id: "34-approvals", cluster: "C", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "approvals-queue contract (blocking vs post-hoc, wait timers, risk, change-preview diff) + durableToken approve/approve-with-edit/reject", status: "N" },
    { name: "WS approval_needed + approval_resolved", status: "E-stream" } ] },
  { id: "38-jobs", cluster: "C", transports: ["REST", "WS"], newCount: 2, contracts: [
    { name: "user-facing scheduled-jobs contract (CRUD, cron, run-history, surfaced stderr, run-now/pause); distinct from internal durable-runtime work", status: "N" },
    { name: "WS job.run_started|run_finished", status: "N" } ] },

  // Cluster D — entities · mcp · tools · providers · connect · widget (7)
  { id: "20-entities", cluster: "D", transports: ["REST", "WS"], newCount: 4, contracts: [
    { name: "entity list", status: "E" },
    { name: "live heartbeat + connection-state push", status: "N" },
    { name: "live tool-discovery probe (true vs cache count + drift flag)", status: "N" },
    { name: "purge-stale-registry-entry action", status: "N" },
    { name: "WS entity_heartbeat + entity_discovery", status: "N" } ] },
  { id: "21-entity", cluster: "D", transports: ["REST"], newCount: 3, contracts: [
    { name: "entity detail", status: "E" },
    { name: "connection-history timeline entity_event{connected|discovery|heartbeat_ok|lost}", status: "N" },
    { name: "structured wire-test / MCP-handshake-test", status: "N" },
    { name: "wire secret mint (shown-once, hash-stored) + rotate", status: "N" } ] },
  { id: "22-mcp", cluster: "D", transports: ["REST"], newCount: 2, contracts: [
    { name: "create-wire / create-MCP (OAuth|Bearer|None)", status: "E-partial" },
    { name: "structured handshake-test result", status: "N" },
    { name: "wire secret-once mint", status: "N" } ] },
  { id: "23-tools", cluster: "D", transports: ["REST", "WS"], newCount: 2, contracts: [
    { name: "unified cross-source tool registry (wire+mcp+sys-runtime+skills) with dispatch stats", status: "N" },
    { name: "WS tool_probe", status: "N" } ] },
  { id: "24-providers", cluster: "D", transports: ["REST", "WS"], newCount: 3, contracts: [
    { name: "BYOK provider/credential registry (list+test-all+per-provider test+rotate+spend7d)", status: "N" },
    { name: "model-route resolution config (ordered fallback chains, silent-fallback detection)", status: "N" },
    { name: "versioned verified rate table (provenance + immutable historical rates)", status: "N" },
    { name: "WS credential_status + route_fallback", status: "N" } ] },
  { id: "42-connect", cluster: "D", transports: ["REST", "Webhook"], newCount: 3, contracts: [
    { name: "Slack install with two ownership models + channel→agent mapping", status: "N" },
    { name: "integrator session-token mint (agent, operator-asserted user_ref, ttl→token,expires_at) + stats", status: "N" },
    { name: "durable mention/inbound queue (buffer during revoked-cred outage, drain on re-install)", status: "N" },
    { name: "webhook channel_status{queuedMentionCount}", status: "N" } ] },
  { id: "41-widget", cluster: "D", transports: ["REST", "SSE"], newCount: 3, contracts: [
    { name: "embed widget config (agent binding, CSS-var theme, copyable snippet)", status: "N" },
    { name: "public guest-session bootstrap (no-login) + guest-mode capability gating", status: "N" },
    { name: "public guest/embed SSE stream with reconnect + full message replay", status: "N" } ] },

  // Cluster E — memory · graph · monitoring · cost · budgets · governance · evals · audit · secrets (11)
  { id: "25-memory", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "memory context (CRUD + tier taxonomy, semantic search, embedding-status + re-embed, provenance, ratings, cluster-scoped visibility, GDPR cascade)", status: "N" },
    { name: "WS memory_embedding_status + embedding_backlog", status: "N" } ] },
  { id: "26-graph", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "knowledge-graph context (entities+edges w/ evidence/confidence/provenance, ego query, hub ranking, merge/delete)", status: "N" },
    { name: "WS graph_extraction_status + graph_edge_created", status: "N" } ] },
  { id: "29-monitoring", cluster: "E", transports: ["REST", "SSE"], newCount: 1, contracts: [
    { name: "live metrics contract (p50/p95 latency, tool-failure-rate vs baseline, turns/min, dispatch-log ground-truth cause, incident detection)", status: "N" },
    { name: "SSE metric_tick + incident_opened", status: "N" } ] },
  { id: "30-cost", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "turn-ledger contract (immutable per-turn billable rows, cost-lane taxonomy, per-turn rate-table version pin, export)", status: "N" },
    { name: "WS rollup_status", status: "N" } ] },
  { id: "31-budgets", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "budget context (scope env/agent/lane/guest, cap, hard-stop/soft, alert-threshold; ONE query shared with the cost ledger; breach events; raise-cap-once)", status: "N" },
    { name: "WS budget_position (per-turn) + budget_breached", status: "N" } ] },
  { id: "35-governance", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "governance/policy context (rule defs, safety-event log w/ outcome, hit counters, baseline set, rule→event linkage; held outcomes share the approval durableToken flow)", status: "N" },
    { name: "WS safety_event", status: "N" } ] },
  { id: "36-evals", cluster: "E", transports: ["REST", "SSE"], newCount: 1, contracts: [
    { name: "evals context (criteria, runs comparing two config versions on sampled threads, per-criterion judge scores, canary rollback/promote tied to version bindings)", status: "N" },
    { name: "SSE eval_progress", status: "N" } ] },
  { id: "37-audit", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "audit context (append-only across tool-calls+admin+config-saves+role-changes+cross-scope access, unsampled cross-reach guarantee, export-range)", status: "N" },
    { name: "WS audit_appended tail", status: "N" } ] },
  { id: "39-variables", cluster: "E", transports: ["REST"], newCount: 1, contracts: [
    { name: "secrets/variables context (secret write-only/encrypted/masked-forever vs plain, reference-tracking to byok-bindings/prompt-vars/entities/channels)", status: "N" } ] },
  { id: "44-debug", cluster: "E", transports: ["REST"], newCount: 1, contracts: [
    { name: "prompt-assembly introspection (exact runtime assembly, per-block tokens+cache boundaries+provenance, tool round-trip capture, recalled-memory similarity, send-test-turn against a named config version — tokenizer-exact)", status: "N" } ] },
  { id: "46-errors", cluster: "E", transports: ["REST", "WS"], newCount: 1, contracts: [
    { name: "standardized error envelope {code,title,body,error-id,trace-ref,version} (this IS the REST ERROR envelope in §2)", status: "N" },
    { name: "rate-limit {limit,usage,retry-after}; degraded-service health signal; WS reconnect/replay; session-TTL(14d)+restore-location", status: "N" } ] },
];

// The 4 existing-but-undemanded pages (ADR M0.4 D0). No backend contract.
const UNDEMANDED = [
  { id: "00-index", reason: "index / landing shell — structural, not a feature screen", classification: "no-backend-contract" },
  { id: "43-docs", reason: "docs viewer — renders static content; no backend contract", classification: "no-backend-contract" },
  { id: "47-parts", reason: "component-parts gallery — design-system reference; no backend contract", classification: "no-backend-contract" },
  { id: "PlatosNav", reason: "navigation shell — structural chrome shared by screens; no backend contract", classification: "no-backend-contract" },
];

const EXPECTED_UNDEMANDED = ["00-index", "43-docs", "47-parts", "PlatosNav"];

function designPages() {
  return readdirSync(designDir)
    .filter((f) => f.endsWith(".dc.html"))
    .map((f) => f.replace(/\.dc\.html$/, ""))
    .sort();
}

/** The contract-status histogram over every row of every demanded screen. */
export function contractHistogram(screens = SCREENS) {
  const byStatus = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0]));
  let rows = 0;
  for (const screen of screens)
    for (const contract of screen.contracts) {
      rows += 1;
      if (Object.hasOwn(byStatus, contract.status)) byStatus[contract.status] += 1;
      else byStatus[contract.status] = (byStatus[contract.status] ?? 0) + 1;
    }
  return { rows, byStatus };
}

function buildModel(measured = measureApiV1Literals()) {
  // `newCount` is DERIVED from the rows rather than carried beside them. It used
  // to be a hand-kept integer that disagreed with its own contract list on 12 of
  // the 43 screens — 8 claimed for `03-home` against 3 rows marked N, 1 claimed
  // for each of nine cluster-E screens carrying 2 — and the totals were the sum
  // of the claim rather than of the rows. A count next to the thing it counts is
  // a count that will eventually be wrong; this one cannot be.
  const screens = SCREENS.map((screen) => ({
    ...screen,
    newCount: screen.contracts.filter((c) => c.status === "N").length,
  }));
  const histogram = contractHistogram(screens);
  return {
    milestone: "M0.4",
    issue: "WIN-249",
    title: "Platos V1 design-to-contract map",
    source: "docs/adr/M0.4-contract-versioning.md",
    generatedBy: "scripts/arch/contract-map.mjs",
    designDirectory: "design/platos-ui-refactor",
    acceptanceCriterion: "zero orphans — every settled screen maps to at least one contract or an explicit no-backend-contract exclusion",
    totals: {
      pages: screens.length + UNDEMANDED.length,
      demanded: screens.length,
      undemanded: UNDEMANDED.length,
      contractRows: histogram.rows,
      byStatus: histogram.byStatus,
      newContracts: histogram.byStatus.N,
    },
    canonicalPrefix: canonicalPrefix(measured),
    corrections: CORRECTIONS,
    screens,
    undemandedScreens: UNDEMANDED,
  };
}

function renderTableText(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/{/g, "&lbrace;")
    .replace(/}/g, "&rbrace;")
    .replace(/\|/g, "\\|");
}

function renderMarkdown(model) {
  const L = [];
  L.push(`# ${model.title} (${model.issue} / ${model.milestone})`);
  L.push("");
  L.push(`> Durable audit artifact. Source of truth: \`${model.source}\` §3, §7. Generated by \`${model.generatedBy}\` and validated against \`${model.designDirectory}/*.dc.html\`. Do not edit by hand — regenerate with \`node scripts/arch/contract-map.mjs --write\`.`);
  L.push("");
  L.push(`**Acceptance criterion:** ${model.acceptanceCriterion}.`);
  L.push("");
  L.push(`**Totals:** ${model.totals.pages} design pages = ${model.totals.demanded} with mapped demand + ${model.totals.undemanded} no-backend-contract. ${model.totals.contractRows} contract rows across the demanded screens — ${Object.entries(model.totals.byStatus).map(([k, v]) => `**${k}** ${v}`).join(" · ")} — so ${model.totals.newContracts} are net-new. Every one of these is derived from the rows themselves (D8).`);
  L.push("");
  L.push("## Canonical REST prefix");
  L.push("");
  L.push(`- **Prefix:** \`${model.canonicalPrefix.prefix}\``);
  L.push(`- **Rule:** ${model.canonicalPrefix.rule}`);
  L.push(`- **Expression:** \`${model.canonicalPrefix.expression}\``);
  L.push(`- **Build-id header:** \`${model.canonicalPrefix.buildIdHeader}\` · **floor request:** \`${model.canonicalPrefix.floorRequestHeader}\``);
  const lm = model.canonicalPrefix.literalMigration;
  L.push(`- **Literal migration (M4 pre-gate):** ${lm.literals} \`${lm.from}\` on ${lm.sourceLines} source line(s) across ${lm.files} file(s) → \`${lm.to}\` — status **${lm.status}**. ${lm.enforcedBy}`);
  L.push(`- **Measured, not asserted (D8):** ${lm.measuredBy} Cross-checked by ${lm.crossCheckedBy} This supersedes the recorded figure of ${lm.supersedes.count}: ${lm.supersedes.why}`);
  L.push("");
  L.push("## Accepted decisions (D0–D7)");
  L.push("");
  L.push("| # | Decision | Status | Correction |");
  L.push("|---|---|---|---|");
  for (const [k, d] of Object.entries(model.corrections)) {
    L.push(`| ${k} | ${d.title} | **${d.status}** | ${d.text.replace(/\|/g, "\\|")} |`);
  }
  L.push("");
  L.push("## Screen → contract coverage (43 demanded)");
  L.push("");
  const byCluster = { A: "auth · tenancy · billing · admin", B: "home · command · agents · skills", C: "conversations · jobs · observability", D: "entities · mcp · tools · providers · connect · widget", E: "memory · graph · monitoring · cost · budgets · governance · evals · audit · secrets" };
  for (const cl of ["A", "B", "C", "D", "E"]) {
    const rows = model.screens.filter((s) => s.cluster === cl);
    L.push(`### Cluster ${cl} — ${byCluster[cl]} (${rows.length})`);
    L.push("");
    L.push("| Screen | Transports | New | Contracts |");
    L.push("|---|---|---|---|");
    for (const s of rows) {
      const contracts = renderTableText(
        s.contracts.map((c) => `${c.name} **[${c.status}]**`).join("; ")
      );
      L.push(`| \`${s.id}\` | ${s.transports.join(", ")} | ${s.newCount} | ${contracts} |`);
    }
    L.push("");
  }
  L.push("## Undemanded pages — no backend contract (D0)");
  L.push("");
  L.push("These 4 existing pages carry no mapped demand and are explicitly excluded from contract coverage; they are structural rather than feature screens.");
  L.push("");
  L.push("| Page | Reason |");
  L.push("|---|---|");
  for (const u of model.undemandedScreens) L.push(`| \`${u.id}\` | ${u.reason} |`);
  L.push("");
  L.push("Legend: **[E]** existing contract · **[N]** new contract · **[E-stream]** existing stream needing versioning · **[E-partial]** partial today.");
  return L.join("\n");
}

function validate(model) {
  const errors = [];
  const pages = designPages();
  const mapped = new Set([...model.screens.map((s) => s.id), ...model.undemandedScreens.map((u) => u.id)]);

  for (const page of pages) {
    if (!mapped.has(page)) errors.push(`design page ${page}.dc.html has no mapping (neither demand nor exclusion)`);
  }
  for (const id of mapped) {
    if (!pages.includes(id)) errors.push(`mapped screen ${id} has no corresponding design page`);
  }

  const undemanded = model.undemandedScreens.map((u) => u.id).sort();
  if (JSON.stringify(undemanded) !== JSON.stringify([...EXPECTED_UNDEMANDED].sort())) {
    errors.push(`the 4 undemanded pages must be exactly ${EXPECTED_UNDEMANDED.join(", ")}; got ${undemanded.join(", ")}`);
  }

  if (model.totals.pages !== pages.length) {
    errors.push(`totals.pages (${model.totals.pages}) != design pages on disk (${pages.length})`);
  }
  if (model.totals.demanded !== 43) errors.push(`expected 43 demanded screens; got ${model.totals.demanded}`);

  // Canonical prefix + the literal migration, ANCHORED TO THE TREE.
  //
  // The former check here read `model.canonicalPrefix.literalMigration.count !== 18`
  // against a model built from a constant that said 18. Both sides came from this
  // file, so the error was unreachable — including in a tree that had completed the
  // migration and had none left. The three assertions below each join to something
  // this file does not control: the tree (measured live), a second measuring
  // mechanism, and the COMMITTED artifact on disk.
  if (model.canonicalPrefix?.prefix !== "/api/v1") errors.push("canonical prefix /api/v1 not recorded");
  const measured = measureApiV1Literals();
  const crossChecked = measureApiV1LiteralLines();
  if (measured.sourceLines !== crossChecked) {
    errors.push(
      `api/v1 literal measurement is not corroborated: the structural scan found ${measured.sourceLines} source line(s), the independent line scan found ${crossChecked}`,
    );
  }
  // The COMMITTED artifact, against the live tree. `validate` is only ever called
  // on a freshly built model, so comparing the model to `measured` would repeat
  // the self-assertion this replaces; the artifact on disk is the other party.
  let committed = null;
  try {
    committed = JSON.parse(readFileSync(jsonOut, "utf8"));
  } catch {
    committed = null;
  }
  const recorded = committed?.canonicalPrefix?.literalMigration;
  if (!recorded) {
    errors.push("the committed artifact records no literalMigration measurement to check against the tree");
  } else {
    for (const [field, actual] of [
      ["literals", measured.literals],
      ["sourceLines", measured.sourceLines],
      ["files", measured.files],
    ]) {
      if (recorded[field] !== actual) {
        errors.push(
          `literalMigration.${field}: the committed artifact records ${JSON.stringify(recorded[field])} but the tree carries ${actual} — run --write, or the pre-gate is describing a tree that no longer exists`,
        );
      }
    }
    const expectedStatus = measured.literals === 0 ? "complete" : "pending";
    if (recorded.status !== expectedStatus) {
      errors.push(
        `literalMigration.status is "${recorded.status}" but the tree carries ${measured.literals} literal(s), which is "${expectedStatus}"`,
      );
    }
  }
  if (!Array.isArray(model.canonicalPrefix?.literalMigration?.sites)) {
    errors.push("literalMigration.sites must enumerate the measured literals, so the count names the files it came from");
  }

  // Contract-row accounting, derived rather than declared.
  const committedTotals = committed?.totals;
  const histogram = contractHistogram(model.screens);
  if (histogram.rows !== Object.values(histogram.byStatus).reduce((n, v) => n + v, 0)) {
    errors.push("the contract-status histogram does not sum to the number of contract rows");
  }
  for (const screen of model.screens) {
    for (const contract of screen.contracts) {
      if (!CONTRACT_STATUSES.includes(contract.status)) {
        errors.push(`screen ${screen.id} carries contract status "${contract.status}", which is not one of ${CONTRACT_STATUSES.join(", ")}`);
      }
    }
    const derived = screen.contracts.filter((c) => c.status === "N").length;
    if (screen.newCount !== derived) {
      errors.push(`screen ${screen.id} records newCount ${screen.newCount} but carries ${derived} row(s) marked N`);
    }
  }
  if (committedTotals) {
    if (committedTotals.contractRows !== histogram.rows) {
      errors.push(`totals.contractRows: committed ${committedTotals.contractRows}, rows on the screens ${histogram.rows}`);
    }
    if (committedTotals.newContracts !== histogram.byStatus.N) {
      errors.push(
        `totals.newContracts: committed ${committedTotals.newContracts}, rows marked N ${histogram.byStatus.N} — the net-new figure must be the histogram, not a hand-kept sum`,
      );
    }
  }

  // D0–D8 must all be present.
  for (const d of ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"]) {
    if (!model.corrections?.[d]) errors.push(`decision ${d} not recorded`);
  }

  // Every screen has at least one contract (zero orphans).
  for (const s of model.screens) {
    if (!s.contracts || s.contracts.length === 0) errors.push(`screen ${s.id} has zero contracts (orphan)`);
  }

  // Drift: committed artifacts must match this source.
  const expectedJson = `${JSON.stringify(model, null, 2)}\n`;
  const expectedMd = `${renderMarkdown(model)}\n`;
  let currentJson = "";
  let currentMd = "";
  try { currentJson = readFileSync(jsonOut, "utf8"); } catch { currentJson = ""; }
  try { currentMd = readFileSync(mdOut, "utf8"); } catch { currentMd = ""; }
  if (currentJson !== expectedJson) errors.push("docs/audits/M0.4-design-contract-map.json is stale — run --write");
  if (currentMd !== expectedMd) errors.push("docs/audits/M0.4-design-contract-map.md is stale — run --write");

  return errors;
}

function main() {
  const model = buildModel();
  const write = process.argv.includes("--write");
  if (write) {
    writeFileSync(jsonOut, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    writeFileSync(mdOut, `${renderMarkdown(model)}\n`, "utf8");
    process.stdout.write(`wrote ${jsonOut}\nwrote ${mdOut}\n`);
    return;
  }
  const errors = validate(model);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`FAIL: ${e}\n`);
    process.stderr.write(`\n${errors.length} contract-map validation error(s).\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `ok: ${model.totals.pages} design pages accounted for (${model.totals.demanded} demanded + ${model.totals.undemanded} no-backend-contract); ` +
      `${model.totals.contractRows} contract rows (N ${model.totals.byStatus.N}, E ${model.totals.byStatus.E}, E-stream ${model.totals.byStatus["E-stream"]}, E-partial ${model.totals.byStatus["E-partial"]}); ` +
      `/api/v1 prefix + ${model.canonicalPrefix.literalMigration.literals} measured literals on ${model.canonicalPrefix.literalMigration.sourceLines} lines across ${model.canonicalPrefix.literalMigration.files} files + D0–D8 recorded; artifacts in sync.\n`
  );
}

main();
