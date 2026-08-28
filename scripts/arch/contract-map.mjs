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

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../", import.meta.url);
const designDir = fileURLToPath(new URL("design/platos-ui-refactor/", repoRoot));
const jsonOut = fileURLToPath(new URL("docs/audits/M0.4-design-contract-map.json", repoRoot));
const mdOut = fileURLToPath(new URL("docs/audits/M0.4-design-contract-map.md", repoRoot));

// The canonical version-surface facts (ADR M0.4 §2, D1). "V1 is the frozen
// semantic surface, not a URL." The major axis is the URL segment via Nest
// @Version, promoted from per-controller literals.
const CANONICAL_PREFIX = {
  prefix: "/api/v1",
  rule: "A version is a property of the contract, not the code path. The REST major axis is the URL segment, pinned by Nest @Version — never a per-controller literal string.",
  expression: 'setGlobalPrefix("api") + enableVersioning({ type: URI, defaultVersion: "1" }) + @Version("1")',
  buildIdHeader: "X-Platos-Contract-Version",
  floorRequestHeader: "X-Platos-Contract-Min",
  literalMigration: {
    count: 18,
    from: '@Controller("api/v1/...") hardcoded literals',
    to: 'setGlobalPrefix + enableVersioning + @Version("1")',
    milestone: "M4",
    status: "pending",
    enforcedBy:
      'no-bare-prefix lint: generation fails on any literal "api/v1" string once the migration lands, so the drift-check reads structure, not a string (ADR M0.4 §2 REST row, §5 item 2).',
    prerequisiteFor:
      'the "version is a contract, not a path" guarantee — the drift-check only reads a string until the 18 literals become @Version("1") (D1).',
  },
};

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
};

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

function buildModel() {
  return {
    milestone: "M0.4",
    issue: "WIN-249",
    title: "Platos V1 design-to-contract map",
    source: "docs/adr/M0.4-contract-versioning.md",
    generatedBy: "scripts/arch/contract-map.mjs",
    designDirectory: "design/platos-ui-refactor",
    acceptanceCriterion: "zero orphans — every settled screen maps to at least one contract or an explicit no-backend-contract exclusion",
    totals: {
      pages: SCREENS.length + UNDEMANDED.length,
      demanded: SCREENS.length,
      undemanded: UNDEMANDED.length,
      newContracts: SCREENS.reduce((n, s) => n + s.newCount, 0),
    },
    canonicalPrefix: CANONICAL_PREFIX,
    corrections: CORRECTIONS,
    screens: SCREENS,
    undemandedScreens: UNDEMANDED,
  };
}

function renderMarkdown(model) {
  const L = [];
  L.push(`# ${model.title} (${model.issue} / ${model.milestone})`);
  L.push("");
  L.push(`> Durable audit artifact. Source of truth: \`${model.source}\` §3, §7. Generated by \`${model.generatedBy}\` and validated against \`${model.designDirectory}/*.dc.html\`. Do not edit by hand — regenerate with \`node scripts/arch/contract-map.mjs --write\`.`);
  L.push("");
  L.push(`**Acceptance criterion:** ${model.acceptanceCriterion}.`);
  L.push("");
  L.push(`**Totals:** ${model.totals.pages} design pages = ${model.totals.demanded} with mapped demand + ${model.totals.undemanded} no-backend-contract. ${model.totals.newContracts} new contracts across the demanded screens.`);
  L.push("");
  L.push("## Canonical REST prefix");
  L.push("");
  L.push(`- **Prefix:** \`${model.canonicalPrefix.prefix}\``);
  L.push(`- **Rule:** ${model.canonicalPrefix.rule}`);
  L.push(`- **Expression:** \`${model.canonicalPrefix.expression}\``);
  L.push(`- **Build-id header:** \`${model.canonicalPrefix.buildIdHeader}\` · **floor request:** \`${model.canonicalPrefix.floorRequestHeader}\``);
  L.push(`- **Literal migration (M4 pre-gate):** ${model.canonicalPrefix.literalMigration.count} \`${model.canonicalPrefix.literalMigration.from}\` → \`${model.canonicalPrefix.literalMigration.to}\` — status **${model.canonicalPrefix.literalMigration.status}**. ${model.canonicalPrefix.literalMigration.enforcedBy}`);
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
      const contracts = s.contracts.map((c) => `${c.name} **[${c.status}]**`).join("; ").replace(/\|/g, "\\|");
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
  L.push("");
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

  // Canonical prefix + 18-literal migration must be recorded.
  if (model.canonicalPrefix?.prefix !== "/api/v1") errors.push("canonical prefix /api/v1 not recorded");
  if (model.canonicalPrefix?.literalMigration?.count !== 18) errors.push("18-literal @Version migration note not recorded");

  // D0–D7 must all be present.
  for (const d of ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"]) {
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
      `/api/v1 prefix + 18-literal migration + D0–D7 recorded; artifacts in sync.\n`
  );
}

main();
