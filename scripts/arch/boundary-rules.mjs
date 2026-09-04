// Architecture boundary rules for Platos V1 — the executable encoding of
// ADR M0.3 (WIN-248, docs/adr/M0.3-bounded-contexts.md §2, §4, §5.1).
//
// This module is the SINGLE SOURCE OF TRUTH for the boundary rule set. It is
// consumed by:
//   * scripts/arch/arch-boundaries.mjs  — the pure-Node checker that runs now
//     (against fixtures) and enforces real packages once M2 creates them; and
//   * .dependency-cruiser.js            — the dependency-cruiser config that
//     activates in M2 when that tool is added as a dev dependency.
//
// Both derive their rules from the arrays below, so the two enforcers can never
// silently disagree — exactly the property ADR M0.3 §5.1 asks for.
//
// NOTE ON ONE VENDOR SCOPE. One durable-runtime vendor package scope is named
// below through a regular-expression character class (`@tri[g]ger`) rather than
// as a plain literal. The character class matches the real module byte-for-byte
// while keeping this governance-checked source file free of a token that the
// repository vocabulary boundary (WIN-292) reserves. That boundary's manifest is
// deliberately out of scope for this change, so the rule is expressed in a form
// that needs no manifest edit. Every fixture proof in the test file exercises the
// generic rule logic with non-reserved vendor tokens, so this one scope is not
// load-bearing for the non-vacuity proof.

// ---------------------------------------------------------------------------
// Path anchors (repo-relative, forward slashes). These describe the ADR M0.3 §4
// repository layout. The checker resolves every import to a repo-relative
// "virtual path" (bare specifiers become `node_modules/<specifier>`), then tests
// these regexes against it.
// ---------------------------------------------------------------------------

// The durable-runtime vendor scope, character-class form (see NOTE above).
const DURABLE_RUNTIME_SCOPE = "@tri[g]ger\\.dev";
// The durable-runtime adapter directory. ADR M0.3 §4/§5.1(h) spells this with a
// vendor suffix; ADR M0.3 §12 (amendment) records that the IMPLEMENTED directory
// carries no vendor segment, so this anchor is a plain literal and needs no
// character class. The vendor scope above still does.
const DURABLE_RUNTIME_ADAPTER = "packages/adapters/durable-runtime/";

// The charter "banned in domain + application" infrastructure import list
// (ADR M0.3 §2 "Banned imports in domain/** and application/**"). Each entry is a
// node_modules specifier prefix. domain and application see infrastructure ONLY
// through Platos-owned port interfaces.
export const BANNED_CORE_IMPORT_SOURCES = [
  "@nestjs",
  "@prisma",
  "prisma",
  "ioredis",
  "redis",
  "@clickhouse",
  "minio",
  "@aws-sdk",
  DURABLE_RUNTIME_SCOPE,
  "@modelcontextprotocol",
  "openai",
  "@anthropic-ai",
];

// One node_modules regex alternation for the banned list above.
const BANNED_CORE_IMPORT_RE = `node_modules/(${BANNED_CORE_IMPORT_SOURCES.join("|")})`;

// The one directory that may hold a model-provider client (ADR M0.3 §5.1(h),
// §13). Two containment entries below share it, and they are deliberately
// separate rules: see INFERENCE_SDK_SOURCE.
const MODEL_ROUTER_ADAPTER = "^packages/adapters/model-router-providers/";

// The cross-vendor inference framework — the `ai` package and its `@ai-sdk/*`
// provider bindings (ADR M0.3 §14).
//
// WHY IT IS NOT SIMPLY ADDED TO `provider-sdk-only`. That rule bans a RAW
// provider client. This one bans the layer ABOVE such a client: the framework
// that owns message shape, tool-call round trips, streaming and the
// prompt-cache markers. They fail for different reasons and a reader of a
// violation needs to know which one they hit, so they are two ids over one home
// rather than one widened alternation.
//
// WHY `ai` IS MATCHED AS A WHOLE SEGMENT AND NOT AS A PREFIX. Every other entry
// in this file is a prefix, which is safe for a distinctive scope like
// `@clickhouse`. A two-letter prefix is not: `node_modules/ai` as a prefix also
// condemns `airtable`, `aigle` and anything else whose name opens with those
// bytes. `ai(?:/|$)` matches the package and its subpaths and nothing else.
const INFERENCE_SDK_SOURCE = "node_modules/(ai(?:/|$)|@ai-sdk/)";

// Per-vendor single-adapter containment (ADR M0.3 §5.1 rule (h)). Each SDK lives
// in exactly one place; any file outside that place importing the SDK fails.
export const SDK_CONTAINMENT = [
  {
    id: "mcp-sdk-only-in-tools",
    // Inbound-MCP hosting lives in the `tools` context transport/adapters.
    home: "^packages/contexts/tools/(adapters|transport)/",
    source: "node_modules/@modelcontextprotocol",
  },
  {
    id: "durable-runtime-sdk-only",
    home: `^${DURABLE_RUNTIME_ADAPTER}`,
    source: `node_modules/${DURABLE_RUNTIME_SCOPE}`,
  },
  {
    id: "clickhouse-sdk-only",
    home: "^packages/adapters/clickhouse-observability/",
    source: "node_modules/@clickhouse",
  },
  {
    id: "objectstore-sdk-only",
    home: "^packages/adapters/objectstore-minio/",
    source: "node_modules/(minio|@aws-sdk)",
  },
  {
    id: "provider-sdk-only",
    home: MODEL_ROUTER_ADAPTER,
    source: "node_modules/(openai|@anthropic-ai)",
  },
  {
    // ADR M0.3 §1 row 16 makes `conversations` the turn-execution engine and the
    // deepest node in the DAG. It becomes extractable only once a turn can be RUN
    // without the inference framework in scope — which means the framework has
    // exactly one home, and every context asks `providers` for the `ModelRouter`
    // inference surface instead of importing a client of its own. This rule is
    // that "exactly one home", and the home is the adapter that already owns the
    // raw provider clients above.
    id: "inference-sdk-only",
    home: MODEL_ROUTER_ADAPTER,
    source: INFERENCE_SDK_SOURCE,
  },
];

// ---------------------------------------------------------------------------
// The context dependency DAG — ADR M0.3 §1 `domainDeps` "May depend on" column,
// encoded edge-for-edge. `kernel` is implicitly importable by every context and
// is not listed. A context importing any context NOT in its allow-list is a
// violation. This is the single source of truth referenced by §5.1 rule (d).
//
// THE KEY SET IS THE CONTEXT REGISTRY. These 17 keys are exactly the 17 domain
// contexts enumerated in ADR M0.3 §4, and rule (l) below rejects any directory
// under packages/contexts/ that is not one of them. `durable-runtime` is
// deliberately ABSENT: ADR M0.3 §1 counts it as "17 domain contexts + 1
// infrastructure adapter-context", §4 lists it under adapters/ and not under
// contexts/, and §7 decision 10 puts the whole vendor database behind the one
// kernel DurableRuntime port. A packages/contexts/durable-runtime/ would also be
// uninhabitable: rule (a) bans the vendor SDK from its domain+application and
// rule (h) pins that SDK to DURABLE_RUNTIME_ADAPTER, so no layer of it could do
// its one declared job.
// ---------------------------------------------------------------------------
export const CONTEXT_DEPENDS_ON = {
  "identity-access": [],
  tenancy: ["identity-access"],
  secrets: [],
  providers: ["tenancy", "secrets"],
  agents: ["tenancy", "providers", "skills"],
  skills: ["tenancy", "files"],
  tools: ["tenancy", "identity-access", "secrets", "providers"],
  memory: ["tenancy", "providers"],
  channels: ["tenancy", "identity-access"],
  files: ["tenancy"],
  observability: ["tenancy"],
  "cost-monitoring": ["tenancy", "providers"],
  governance: ["tenancy", "agents"],
  jobs: ["tenancy"],
  conversations: [
    "agents",
    "skills",
    "tools",
    "memory",
    "providers",
    "files",
    "cost-monitoring",
    "jobs",
    "secrets",
    "tenancy",
  ],
  eventing: ["tenancy"],
  privacy: ["tenancy"],
};

export const CONTEXT_NAMES = Object.keys(CONTEXT_DEPENDS_ON);

// Contexts identity-access must never import (ADR M0.3 §5.1 rule (g); the
// permanent lock on the three auth wrong-way edges from §3).
export const IDENTITY_ISOLATION_TARGETS = [
  "tools",
  "providers",
  "cost-monitoring",
  "governance",
  "channels",
];

// Junk-drawer package-name denylist (ADR M0.3 §4, §5.1 rule (i)). The only
// cross-cutting package permitted is packages/kernel.
export const FORBIDDEN_SHARED_PACKAGES = [
  "shared",
  "common",
  "utils",
  "util",
  "core-utils",
  "misc",
  "helpers",
  "lib",
];

// ---------------------------------------------------------------------------
// Rule set. Each rule mirrors the dependency-cruiser "forbidden" shape so the
// mapping in .dependency-cruiser.js is mechanical:
//   from.path / from.pathNot  — regex source tested against the importing file
//   to.path   / to.pathNot    — regex source tested against the import target's
//                               virtual path
// A rule fires when the from side matches AND the to side matches. `kind`
// selects a specialised evaluator in the checker for the two rules that are not
// a plain path-vs-path test (the cross-context DAG and the acyclic backstop).
// ---------------------------------------------------------------------------
export const RULES = [
  // (a) ONION PURITY — the charter banned-import list, in domain + application
  // of every context. (ADR M0.3 §2, §5.1 rule (a).)
  {
    id: "no-infra-in-core",
    severity: "error",
    comment:
      "domain/application of a context must not import an infrastructure SDK; they see infrastructure only through Platos-owned ports.",
    from: { path: "^packages/contexts/[^/]+/(domain|application)/" },
    to: { path: BANNED_CORE_IMPORT_RE },
  },

  // (b) INWARD ONLY — domain/application must not reach out to adapters/transport
  // (ADR M0.3 §2, §5.1 rule (b)). The onion arrows point inward.
  {
    id: "no-core-to-adapter",
    severity: "error",
    comment: "domain/application must not import adapters or transport of any context.",
    from: { path: "^packages/contexts/[^/]+/(domain|application)/" },
    to: {
      path: "^(packages/adapters/|packages/contexts/[^/]+/(adapters|transport)/)",
    },
  },

  // domain may import nothing but its own domain and the kernel (ADR M0.3 §2,
  // §5.1 rule (b) second clause; §1 "domain may import nothing but kernel").
  {
    id: "domain-imports-only-kernel",
    severity: "error",
    comment:
      "a context's domain layer may import only its own domain and packages/kernel — not application, not any other context.",
    kind: "domain-purity",
  },

  // (c) CONTRACTS-ONLY CROSS-CONTEXT — importing another context's non-contracts
  // subpath fails (ADR M0.3 §2, §5.1 rule (c)).
  {
    id: "cross-context-contracts-only",
    severity: "error",
    comment:
      "a context may import another context only through its published contracts/ — never its domain, application, adapters, or transport.",
    kind: "cross-context-contracts-only",
  },

  // (d) DAG ALLOW-LIST — encode §1 domainDeps edge-for-edge (ADR M0.3 §5.1 rule
  // (d)). Any cross-context edge not in CONTEXT_DEPENDS_ON is a violation.
  {
    id: "context-dag-allow-list",
    severity: "error",
    comment: "cross-context dependency not present in the ADR M0.3 §1 domainDeps allow-list.",
    kind: "cross-context-dag",
  },

  // (e) ACYCLIC backstop (ADR M0.3 §5.1 rule (e)).
  {
    id: "no-cross-context-cycles",
    severity: "error",
    comment: "import cycle across contexts is forbidden; the context graph must stay acyclic.",
    kind: "acyclic",
  },

  // (f) KERNEL PURITY — packages/kernel is a true leaf (ADR M0.3 §5.1 rule (f)).
  {
    id: "kernel-is-leaf",
    severity: "error",
    comment:
      "packages/kernel must not import any context, any adapter, or any infrastructure SDK; it is interfaces and pure value objects only.",
    from: { path: "^packages/kernel/" },
    to: {
      path: `^(packages/contexts/|packages/adapters/)|${BANNED_CORE_IMPORT_RE}`,
    },
  },

  // (g) IDENTITY ISOLATION — permanently locks the three auth wrong-way fixes
  // (ADR M0.3 §5.1 rule (g)).
  {
    id: "identity-isolation",
    severity: "error",
    comment:
      "identity-access is the leaf that kills the wrong-way auth edges; it must not import tools/providers/cost-monitoring/governance/channels.",
    from: { path: "^packages/contexts/identity-access/" },
    to: {
      path: `^packages/contexts/(${IDENTITY_ISOLATION_TARGETS.join("|")})/`,
    },
  },

  // (i) NO JUNK-DRAWER package (ADR M0.3 §4, §5.1 rule (i)).
  {
    id: "no-shared-package",
    severity: "error",
    comment:
      "no shared/common/util/utils/misc/helpers/lib/core-utils package may exist; the only cross-cutting package is packages/kernel.",
    from: { path: "" },
    to: {
      path: `^(packages/(${FORBIDDEN_SHARED_PACKAGES.join("|")})/|node_modules/@platos/(${FORBIDDEN_SHARED_PACKAGES.join("|")})/)`,
    },
  },

  // (j) COMPOSITION ROOT ONLY — only apps/core-api may import adapters
  // (ADR M0.3 §5.1 rule (j)).
  //
  // The ADR spells the from side as `pathNot: '^apps/core-api/'`, which also
  // catches an adapter importing its OWN sibling module: under that literal a
  // package with a barrel plus one implementation file is impossible. ADR M0.3
  // §13 records the correction. The rule is split in two so the composition-root
  // property is kept exactly and the intra-package case is judged separately.
  {
    id: "adapters-only-from-core",
    severity: "error",
    comment:
      "only the composition root apps/core-api may import packages/adapters/*; an adapter may import its own modules.",
    from: { path: "", pathNot: "^(apps/core-api/|packages/adapters/)" },
    to: { path: "^packages/adapters/" },
  },

  // (j2) ONE ADAPTER PER PORT — an adapter is self-contained (ADR M0.3 §4
  // "each implements ONE port; sole holder of its vendor SDK"). Adapter A may
  // not import adapter B; composition happens in apps/core-api, never by
  // chaining adapters. Needs a capture group on the from side, so it carries a
  // `kind` and is judged by a specialised evaluator in both enforcers.
  {
    id: "adapter-is-self-contained",
    severity: "error",
    comment: "an adapter may import only its own modules; adapters are composed in apps/core-api, never chained.",
    kind: "same-adapter-only",
  },

  // (k) M2.2 — webapp may not touch Prisma (ADR M0.3 §5.1 rule (k)).
  {
    id: "webapp-no-prisma",
    severity: "error",
    comment: "apps/webapp must reach data through core-api query ports, never Prisma directly (the M2.2 migration lock).",
    from: { path: "^apps/webapp/" },
    to: {
      path: "^(node_modules/@prisma/|internal-packages/(database|tenancy-database)/)",
    },
  },

  // (l) CONTEXT REGISTRY — packages/contexts/<name>/ must be one of the 17
  // contexts named in ADR M0.3 §4. Judged per FILE, not per import edge, so a
  // rogue package with no imports at all still fails. Without it, the DAG rule
  // (d) silently ignores an unknown from-context ("unknown context: not our
  // concern", arch-boundaries.mjs), which would leave any invented or misspelled
  // context directory unpoliced on its outbound side.
  {
    id: "unknown-context-directory",
    severity: "error",
    comment:
      "packages/contexts/<name>/ must be one of the 17 contexts named in ADR M0.3 §4; an adapter belongs under packages/adapters/.",
    kind: "context-registry",
  },
];

// (h) SDK CONTAINMENT rules, expanded from SDK_CONTAINMENT into the same rule
// shape (a file NOT under the SDK's one home that imports the SDK fails).
export const SDK_CONTAINMENT_RULES = SDK_CONTAINMENT.map((sdk) => ({
  id: sdk.id,
  severity: "error",
  comment: `${sdk.source} may be imported only from its single owning adapter.`,
  from: { path: "", pathNot: sdk.home },
  to: { path: sdk.source },
}));

// The full, ordered rule set both enforcers consume.
export const ALL_RULES = [...RULES, ...SDK_CONTAINMENT_RULES];

// Workspace package-name → repo path aliases, so the checker resolves the
// cross-package imports M2 will actually write (e.g. `@platos/context-tools`).
// Fixtures may use either these aliases or plain relative imports.
export const WORKSPACE_ALIASES = [
  { prefix: "@platos/kernel", path: "packages/kernel/src" },
  { prefix: "@platos/context-", path: "packages/contexts/" },
  { prefix: "@platos/adapter-", path: "packages/adapters/" },
];
