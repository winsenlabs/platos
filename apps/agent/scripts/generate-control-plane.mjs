#!/usr/bin/env node

/**
 * WIN-129 control-plane contract generator.
 *
 * Canonical policy = the committed operation manifest produced from:
 *   1. every runtime-shaped Platform MCP handler in src/mcp-platform/tools;
 *   2. every Nest controller route decorator in src; and
 *   3. the compact, reviewable mapping/classification policy below.
 *
 * Do not hand-edit generated outputs. Run `pnpm generate:control-plane`.
 */

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRestContract } from "./rest-schema-derivation.mjs";
import { validateOpenApiDocument } from "./openapi-meta-schema.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(scriptDir, "..");
const repoDir = resolve(agentDir, "../..");
const srcDir = join(agentDir, "src");
const coreApiSrcDir = join(repoDir, "apps", "core-api", "src");
const coreApiTransportsDir = join(coreApiSrcDir, "transports");
const toolsDir = join(srcDir, "mcp-platform", "tools");
const manifestPath = join(srcDir, "control-plane", "operation-manifest.generated.json");
const reportPath = join(repoDir, "docs", "control-plane-parity.generated.md");
const openApiOutputPath = join(srcDir, "openapi", "openapi.generated.json");
const errorTaxonomyPath = join(repoDir, "docs", "error-taxonomy.json");
const checkOnly = process.argv.includes("--check");

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const PRODUCTION_MOUNTED_CONTROLLERS = {
  AgentController: "agent-runtime/agent-runtime.module.ts",
  AttachmentUploadController: "agent-runtime/agent-runtime.module.ts",
  ChatStreamController: "agent-runtime/agent-runtime.module.ts",
  ChannelAppsController: "agent-runtime/agent-runtime.module.ts",
  ChannelsController: "agent-runtime/agent-runtime.module.ts",
  JobExecutionController: "agent-runtime/agent-runtime.module.ts",
  JobsController: "agent-runtime/agent-runtime.module.ts",
  PublicGuestTokenController: "auth/auth.module.ts",
  SessionTokenController: "auth/auth.module.ts",
  ChannelAppEventsController: "channels/channels.module.ts",
  ChannelAppOAuthController: "channels/channels.module.ts",
  ChannelLinkController: "channels/channels.module.ts",
  ChannelsInboundController: "channels/channels.module.ts",
  FilesController: "files/files.module.ts",
  HealthController: "health/health.module.ts",
  DocsMcpController: "mcp-docs/docs-mcp.module.ts",
  McpEntityController: "mcp-platform/mcp-platform.module.ts",
  McpPlatformController: "mcp-platform/mcp-platform.module.ts",
  MemoryController: "memory/memory.module.ts",
  MemoryFeedbackAdminController: "memory/memory.module.ts",
  MetricsController: "monitoring/monitoring.module.ts",
  OAuthController: "oauth/oauth.module.ts",
  OpenApiController: "openapi/openapi.module.ts",
  PerformanceEvidenceController: "performance-evidence/performance-evidence.module.ts",
  ErasureController: "privacy/privacy.module.ts",
  ProvidersController: "providers/providers.module.ts",
  SkillsController: "skills/skills.module.ts",
  InternalExecuteToolController: "trigger-bridge/trigger-bridge.module.ts",
};

/**
 * The V1 core-api transport controllers, mounted the same way and held to a
 * STRICTER rule than the agent's.
 *
 * WIN-267 (M4.1). Until this generator had a second scan root it walked
 * `apps/agent/src` and nothing else, so a route added under `apps/core-api`
 * never reached the manifest — and every gate downstream of the manifest
 * (capability matrix, differential coverage, route parity) was therefore
 * enumerating a surface that had stopped being the whole surface.
 *
 * WHAT IS IN IT (WIN-267 R1). The allowlist was EMPTY, paired with
 * `assertNoUnregisteredCoreApiControllers` below, so that the first transport
 * controller to land could not be silently omitted: the agent root SKIPS a
 * controller that is not on its allowlist (there are non-mounted controllers in
 * that tree by design), whereas the core-api root REFUSES generation for one.
 * R1 is that first landing — the identity and tenancy REST surface — and every
 * class it added is registered here.
 *
 * ALL FIVE RESOLVE TO ONE MODULE FILE, and that is a routing fact rather than a
 * filing convenience. Nest reads `[...static decorator metadata, ...dynamic
 * module metadata]` for a module's controllers and Express matches in
 * registration order, so a business controller has to be in the DECORATOR's
 * array on the root module to be registered ahead of `NotFoundController`'s
 * `@All("{*path}")`. `http/http.module.ts` says the same thing from the other
 * side.
 *
 * Keys are class names; values are the module file, relative to
 * `apps/core-api/src`, whose `controllers: [...]` array must list the class.
 *
 * `src/http/health.controller.ts` is NOT here and must not be: `/livez`,
 * `/healthz` and `/readyz` are the PROCESS edge, deliberately unversioned per
 * ADR M0.4 §2, and the manifest is the business-surface contract. That exclusion
 * carries its own tripwire in `scripts/rest-census-independent.mjs`.
 */
const CORE_API_MOUNTED_CONTROLLERS = {
  IdentitySessionController: "http/http.module.ts",
  OrganizationsController: "http/http.module.ts",
  ProjectsController: "http/http.module.ts",
  EnvironmentEndUsersController: "http/http.module.ts",
  BffSessionController: "http/http.module.ts",
  // WIN-268 (M4.2) P1 — the two MCP token mints. Listed here for the same
  // reason as their five REST siblings: this root is STRICT, so a controller
  // under `apps/core-api/src/transports` that is not in this allowlist fails
  // generation by name rather than quietly leaving the census.
  McpPlatformTokensController: "http/http.module.ts",
  McpEntityTokensController: "http/http.module.ts",
  // WIN-272 (M4.6) — the stream lane, and the first entry here that lives outside
  // `transports/rest` and `transports/mcp`. It is listed for the same reason as its
  // seven siblings: this root is STRICT, so a controller under
  // `apps/core-api/src/transports` that is not in this allowlist fails generation
  // by name rather than quietly leaving the census.
  EnvironmentStreamsController: "http/http.module.ts",
};

/**
 * The controller scan roots. `scanDir` is walked for `*.controller.ts`;
 * `moduleDir` resolves the allowlist's module paths; `strict` decides whether a
 * controller found outside the allowlist is skipped or is a hard failure.
 */
const CONTROLLER_SCAN_ROOTS = [
  {
    id: "agent",
    scanDir: srcDir,
    moduleDir: srcDir,
    mounted: PRODUCTION_MOUNTED_CONTROLLERS,
    strict: false,
  },
  {
    id: "core-api-transports",
    scanDir: coreApiTransportsDir,
    moduleDir: coreApiSrcDir,
    mounted: CORE_API_MOUNTED_CONTROLLERS,
    strict: true,
  },
];

/**
 * Explicit REST→MCP equivalence declarations. Everything not listed here is
 * still explicit in the generated manifest as REST_ONLY, INTERNAL,
 * PUBLIC_TRANSPORT, or DEPRECATED. Parameter names may differ between REST and
 * MCP; mappings assert equivalent intent, not wire-shape identity.
 */
const REST_TO_MCP = {
  "POST /api/v1/agent/threads": ["threads.create"],
  "GET /api/v1/agent/threads": ["threads.list"],
  "GET /api/v1/agent/threads/:threadId": ["threads.get"],
  "PATCH /api/v1/agent/threads/:threadId": ["threads.update"],
  "DELETE /api/v1/agent/threads/:threadId": ["threads.delete"],
  "POST /api/v1/agent/threads/:threadId/fork": ["threads.fork"],
  "POST /api/v1/agent/threads/:threadId/messages/:messageId/edit-and-rerun": [
    "threads.edit_and_rerun",
  ],
  "GET /api/v1/agent/threads/:threadId/messages": ["messages.list"],
  "POST /api/v1/agent/messages/:messageId/rating": ["messages.rate"],

  "POST /api/v1/agent/agents": ["agents.create"],
  "GET /api/v1/agent/agents": ["agents.list"],
  "GET /api/v1/agent/agents/:agentId": ["agents.get"],
  "PATCH /api/v1/agent/agents/:agentId": ["agents.update"],
  "DELETE /api/v1/agent/agents/:agentId": ["agents.delete"],
  "PATCH /api/v1/agent/agents/:agentId/canary": ["agents.canary.set"],
  "POST /api/v1/agent/agents/:agentId/canary/promote": ["agents.canary.promote"],

  "GET /api/v1/agent/providers": ["providers.list"],
  "POST /api/v1/agent/providers/:provider/link": ["providers.link"],
  "DELETE /api/v1/agent/providers/:provider/link": ["providers.unlink"],
  "GET /api/v1/agent/providers/keys": ["providers.list_keys"],
  "POST /api/v1/agent/providers/keys": ["providers.add_key"],
  "DELETE /api/v1/agent/providers/keys/:id": ["providers.delete_key"],

  "GET /api/v1/agent/entities": ["entities.list"],
  "POST /api/v1/agent/entities": ["entities.register"],
  "GET /api/v1/agent/entities/:entityId": ["entities.get"],
  "PATCH /api/v1/agent/entities/:entityId": ["entities.update"],
  "DELETE /api/v1/agent/entities/:entityId": ["entities.delete"],
  "POST /api/v1/agent/entities/:entityId/refresh-discovery": ["entities.refresh_discovery"],
  "POST /api/v1/agent/entities/:entityId/regenerate-secret": ["entities.regenerate_secret"],
  "POST /api/v1/agent/entities/:entityId/wire-test": ["entities.wire_test"],
  "GET /api/v1/agent/entities/:entityId/test-credentials": ["entities.get_test_credentials"],
  "GET /api/v1/agent/entities/:entityId/mcp/config": ["entities.get_mcp_config"],
  "GET /api/v1/agent/channels": ["channels.list"],
  "POST /api/v1/agent/channels": ["channels.create"],
  "GET /api/v1/agent/channels/:id": ["channels.get"],
  "PATCH /api/v1/agent/channels/:id": ["channels.update"],
  "DELETE /api/v1/agent/channels/:id": ["channels.delete"],
  "POST /api/v1/agent/channels/:id/rotate-secret": ["channels.rotate_webhook_secret"],
  "POST /api/v1/agent/channels/mint": ["channels.mint_from_manifest"],

  "GET /api/v1/agent/channel-apps": ["channel_apps.list"],
  "POST /api/v1/agent/channel-apps": ["channel_apps.create"],
  "GET /api/v1/agent/channel-apps/:id": ["channel_apps.get"],
  "PATCH /api/v1/agent/channel-apps/:id": ["channel_apps.update"],
  "DELETE /api/v1/agent/channel-apps/:id": ["channel_apps.delete"],
  "GET /api/v1/agent/channel-apps/:id/installations": ["channel_apps.list_installations"],
  "GET /api/v1/agent/channel-apps/:id/installations/status": ["channel_apps.installations_status"],
  "POST /api/v1/agent/channel-apps/:id/installations/import": ["channel_apps.import_installation"],
  "POST /api/v1/agent/channel-apps/:id/installations/:installationId/bind": [
    "channel_apps.bind_installation",
  ],
  "DELETE /api/v1/agent/channel-apps/:id/installations/:installationId": [
    "channel_apps.revoke_installation",
  ],

  "GET /api/v1/agent/jobs": ["jobs.list"],
  "POST /api/v1/agent/jobs": ["jobs.create"],
  "GET /api/v1/agent/jobs/:id": ["jobs.get"],
  "PATCH /api/v1/agent/jobs/:id": ["jobs.update"],
  "DELETE /api/v1/agent/jobs/:id": ["jobs.delete"],
  "POST /api/v1/agent/jobs/:id/dispatch": ["jobs.dispatch"],

  "GET /api/v1/agent/skills": ["skills.list"],
  "POST /api/v1/agent/skills/import": ["skills.install"],
  "GET /api/v1/agent/skills/:id": ["skills.get"],
  "DELETE /api/v1/agent/skills/:id": ["skills.uninstall"],
  "POST /api/v1/agent/skills/agent/:agentId/:id": ["skills.enable"],
  "DELETE /api/v1/agent/skills/agent/:agentId/:id": ["skills.disable"],

  "POST /api/v1/memory": ["memories.upsert"],
  "GET /api/v1/memory": ["memories.list"],
  "GET /api/v1/memory/search": ["memories.search"],
  "DELETE /api/v1/memory/:id": ["memories.delete"],
  "POST /api/v1/memory/extract": ["memories.extract_now"],

  "GET /api/v1/agent/monitoring/trace/:threadId": ["traces.get"],
  "GET /api/v1/agent/tool-calls": ["tool_calls.list"],
  "GET /api/v1/agent/monitoring/safety-events": ["audit.safety_events.query"],
  "GET /api/v1/agent/monitoring/approvals": ["approvals.list"],
  "GET /api/v1/agent/monitoring/approvals/:approvalId": ["approvals.get"],
  "POST /api/v1/agent/approvals/:approvalId/resolve": ["approvals.resolve"],

  "GET /api/v1/agent/budgets": ["budgets.list"],
  "POST /api/v1/agent/budgets": ["budgets.upsert"],
  "DELETE /api/v1/agent/budgets/:capId": ["budgets.delete"],

  "POST /api/v1/agent/evals/dispatch": ["evals.dispatch"],
  "GET /api/v1/agent/evals": ["evals.list"],
  "GET /api/v1/agent/evals/:evalId": ["evals.get"],
  "GET /api/v1/agent/clusters": ["clusters.list"],
  "POST /api/v1/agent/clusters": ["clusters.create"],
  "POST /api/v1/agent/clusters/:clusterId/agents": ["clusters.add_agent"],

  "GET /api/v1/agent/threads/:threadId/artifacts": ["artifacts.list"],
};

const MAPPING_DOMAIN_EVIDENCE = {
  agents: "the same scope-pinned AgentCrudService operation",
  approvals: "the same scope-pinned MonitoringApprovalsService operation",
  artifacts: "the same scope-pinned attachment listing operation",
  audit: "the same scope-pinned monitoring audit query",
  budgets: "the same scope-pinned BudgetService cap operation",
  channel_apps: "the same scope-pinned channel-app persistence operation",
  channels: "the same scope-pinned channel persistence operation",
  clusters: "the same scope-pinned AgentClusterService operation",
  entities: "the same canonical Entity control-plane operation",
  evals: "the same scope-pinned EvalService operation",
  memories: "the same scope-pinned MemoryService operation",
  messages: "the same scope-pinned conversation/rating operation",
  jobs: "the same Environment-owned Job operation",
  providers: "the same authorized provider registry/key operation",
  skills: "the same scope-pinned skill registry/import operation",
  threads: "the same scope-pinned ConversationService operation",
  tool_calls: "the same scope-pinned ToolCall query",
  traces: "the same scope-pinned TraceService thread trace operation",
};

function mappingRationale(route, tools) {
  const evidence = [
    ...new Set(
      tools.map((tool) => MAPPING_DOMAIN_EVIDENCE[tool.split(".")[0]]).filter(Boolean)
    ),
  ];
  if (evidence.length === 0) throw new Error(`missing semantic evidence for mapping: ${route}`);
  return `Reviewed behavioral equivalence: the REST adapter and ${tools.join(
    ", "
  )} invoke ${evidence.join(" and ")}; only transport parameters/envelopes differ.`;
}

// ── THE ALIAS CONTRACT, READ FROM THE FILE THE RUNTIME EMITS FROM ───────────
//
// WIN-267 (M4.1). This table used to be four lines here: one id, one
// `startsWith` and one replacement PREFIX. Three things were wrong with it and
// all three are ADR M0.4 §4 requirements.
//
//   The replacement was a PREFIX, so the manifest said "this operation is
//   superseded by /api/v1/memory" for all fifteen of them and named the
//   canonical OPERATION for none. §4.1 wants a non-null replacement that
//   resolves; a prefix does not resolve to an operation.
//
//   There was no sunset and no window, so §4.3's ">= 90 days, and an operation
//   cannot vanish inside v1" was policy nobody could check.
//
//   And the wire carried nothing at all — see `apps/agent/src/http/
//   deprecation-signal.ts`, which is now the ONE declaration of the alias set
//   and the module that stamps `Deprecation`/`Sunset`/`Link` on a response.
//
// This generator reads that file the same way `apiSurface()` reads the version
// out of `api-surface.ts`, and for the same reason: a second copy of the sunset
// date here would be a second opinion about what a client has been told. The
// runtime declares; the manifest and the OpenAPI document derive.
const DEPRECATION_SIGNAL_MODULE = ["http", "deprecation-signal.ts"];

let deprecatedRulesCache = null;

function deprecatedRules() {
  if (deprecatedRulesCache) return deprecatedRulesCache;
  const path = join(srcDir, ...DEPRECATION_SIGNAL_MODULE);
  if (!existsSync(path)) {
    throw new Error(
      `the compatibility-alias table is declared in ${relative(repoDir, path)} and that file is missing; ` +
        "this generator refuses to invent a deprecation window"
    );
  }
  const sf = sourceFile(path);
  let node = null;
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === "DEPRECATED_ROUTE_PREFIXES") {
        node = declaration.initializer ?? null;
      }
    }
  }
  if (node === null) {
    throw new Error("DEPRECATED_ROUTE_PREFIXES must be declared in deprecation-signal.ts");
  }
  const arrayNode = unwrapToArrayLiteral(node);
  if (arrayNode === null) {
    throw new Error("DEPRECATED_ROUTE_PREFIXES must be an array literal in deprecation-signal.ts");
  }
  const required = ["id", "aliasPrefix", "canonicalPrefix", "announcedOn", "sunsetOn"];
  deprecatedRulesCache = arrayNode.elements.map((element) => {
    const object = unwrapToObjectLiteral(element);
    if (object === null) {
      throw new Error("every DEPRECATED_ROUTE_PREFIXES entry must be an object literal");
    }
    const row = {};
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property);
      if (
        !ts.isStringLiteral(property.initializer) &&
        !ts.isNoSubstitutionTemplateLiteral(property.initializer)
      ) {
        throw new Error(`DEPRECATED_ROUTE_PREFIXES.${name} must be a string literal`);
      }
      row[name] = property.initializer.text;
    }
    for (const key of required) {
      if (typeof row[key] !== "string" || row[key].length === 0) {
        throw new Error(`a DEPRECATED_ROUTE_PREFIXES entry is missing ${key}`);
      }
    }
    return {
      ...row,
      // Segment-bounded, exactly like the runtime's `isUnderPathPrefix`. The old
      // bare `startsWith` classified `/api/v1/platos/memoryboard` as an alias of
      // a route that does not exist; no such path is mounted today, so this is a
      // narrowing of the CLASSIFIER with no effect on the operation set, and the
      // unchanged DEPRECATED count is what says so.
      test: (candidate) =>
        candidate === row.aliasPrefix || candidate.startsWith(`${row.aliasPrefix}/`),
    };
  });
  return deprecatedRulesCache;
}

/** ADR M0.4 §4.3's floor, read from the runtime module rather than repeated. */
function deprecationMinimumWindowDays() {
  const path = join(srcDir, ...DEPRECATION_SIGNAL_MODULE);
  const sf = sourceFile(path);
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "DEPRECATION_MINIMUM_WINDOW_DAYS" &&
        declaration.initializer &&
        ts.isNumericLiteral(declaration.initializer)
      ) {
        return Number(declaration.initializer.text);
      }
    }
  }
  throw new Error("DEPRECATION_MINIMUM_WINDOW_DAYS must be a numeric literal in deprecation-signal.ts");
}

const INTERNAL_RULES = [
  { id: "internal-prefix", test: (path) => path === "/internal" || path.startsWith("/internal/") },
  { id: "agent-internal-prefix", test: (path) => path.includes("/internal/") },
  { id: "test-controller", test: (path) => path === "/test" || path.startsWith("/test/") },
];

const PUBLIC_TRANSPORT_RULES = [
  {
    id: "mcp-protocol",
    test: (path, method) =>
      path === "/mcp" ||
      path.startsWith("/mcp/docs") ||
      (path === "/mcp/sse" && method === "GET") ||
      (path === "/mcp/messages" && method === "POST") ||
      (path === "/mcp/platform" && method === "POST") ||
      (path === "/mcp/platform/sse" && method === "GET") ||
      (path === "/mcp/platform/messages" && method === "POST") ||
      (path === "/mcp/platform/events/subscribe" && method === "GET") ||
      (path === "/mcp/entity/:entityId" && method === "POST") ||
      (path === "/mcp/entity/:entityId/sse" && method === "GET") ||
      (path === "/mcp/entity/:entityId/messages" && method === "POST") ||
      (path === "/mcp/entity/:entityId/events/subscribe" && method === "GET"),
  },
  {
    id: "oauth-protocol",
    test: (path) =>
      path === "/oauth" || path.startsWith("/oauth/") || path.startsWith("/.well-known/"),
  },
  {
    id: "public-token-mint",
    test: (path) => path.startsWith("/api/v1/public/") || path.includes("/session-tokens"),
  },
  { id: "channel-webhooks-and-oauth", test: (path) => path.startsWith("/api/v1/channels/") },
  { id: "service-observability", test: (path) => path === "/api/health" || path === "/metrics" },
  {
    id: "generated-api-description",
    test: (path) => path === "/openapi" || path.endsWith("/openapi.json"),
  },
];

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function sourceFile(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function propertyName(node) {
  if (!node?.name) return null;
  if (
    ts.isIdentifier(node.name) ||
    ts.isStringLiteral(node.name) ||
    ts.isNumericLiteral(node.name)
  ) {
    return node.name.text;
  }
  return null;
}

/**
 * Strip the wrappers a frozen `as const` table is written with — `Object.freeze(
 * ... )`, `as const`, parentheses — until the literal underneath is reached.
 *
 * Written once because two constants in `src/http` are declared that way and a
 * second private unwrapper is how one of them ends up accepting a shape the
 * other refuses.
 */
function unwrapWrappers(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      (ts.isCallExpression(current) && current.arguments.length === 1))
  ) {
    current = ts.isCallExpression(current) ? current.arguments[0] : current.expression;
  }
  return current ?? null;
}

function unwrapToArrayLiteral(node) {
  const inner = unwrapWrappers(node);
  return inner && ts.isArrayLiteralExpression(inner) ? inner : null;
}

function unwrapToObjectLiteral(node) {
  const inner = unwrapWrappers(node);
  return inner && ts.isObjectLiteralExpression(inner) ? inner : null;
}

function literal(node, sf) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression?.(node)
  ) {
    node = node.expression;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return -Number(literal(node.operand, sf));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return String(literal(node.left, sf)) + String(literal(node.right, sf));
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => literal(item, sf));
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        throw new Error(`unsupported schema property in ${sf.fileName}: ${prop.getText(sf)}`);
      }
      const key = propertyName(prop);
      if (key === null) throw new Error(`computed schema property in ${sf.fileName}`);
      out[key] = literal(prop.initializer, sf);
    }
    return out;
  }
  throw new Error(`unsupported literal in ${sf.fileName}: ${node.getText(sf)}`);
}

function handlerObject(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const props = new Map();
  for (const prop of node.properties) {
    const key = propertyName(prop);
    if (key) props.set(key, prop);
  }
  if (
    !props.has("name") ||
    !props.has("description") ||
    !props.has("inputSchema") ||
    !props.has("execute")
  ) {
    return null;
  }
  return props;
}

function extractMcpSourceProvenance() {
  const sources = new Map();
  for (const path of walk(toolsDir).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts")
  )) {
    const sf = sourceFile(path);
    const visit = (node) => {
      const props = handlerObject(node);
      if (props) {
        const nameProp = props.get("name");
        if (!ts.isPropertyAssignment(nameProp))
          throw new Error(`tool name must use a property assignment in ${path}`);
        const name = literal(nameProp.initializer, sf);
        if (sources.has(name)) throw new Error(`duplicate MCP source declaration: ${name}`);
        sources.set(name, relative(repoDir, path).replaceAll("\\", "/"));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sources;
}

/**
 * WIN-268 P1 — the Platos MCP contract, read out of the RUNNING servers.
 *
 * Set by `extractMcpTools()` from the same helper run that produces the tool
 * inventory, so the version block and the catalog it digests can never come from
 * two different reads of the tree.
 */
let mcpContract = null;

function extractMcpTools() {
  const helper = join(scriptDir, "runtime-mcp-catalog.ts");
  const tsx = join(repoDir, "node_modules", ".bin", "tsx");
  const catalog = JSON.parse(
    execFileSync(tsx, [helper], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  );
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("runtime MCP catalog helper returned a non-object");
  }
  const runtimeTools = catalog.tools;
  if (!Array.isArray(runtimeTools)) throw new Error("runtime MCP catalog helper returned non-array tools");
  if (catalog.contract === null || typeof catalog.contract !== "object") {
    throw new Error("runtime MCP catalog helper returned no contract block");
  }
  // THE TWO DIGESTS MUST AGREE. One is taken by the router over what it actually
  // registered, the other over the handler list the builder returned. They differ
  // only if registration dropped or duplicated a handler — a defect that would
  // otherwise show up as a client seeing fewer tools than the manifest declares.
  if (catalog.contract.catalogDigest !== catalog.handlerCatalogDigest) {
    throw new Error(
      `MCP catalog digest disagrees between the router (${String(catalog.contract.catalogDigest)}) ` +
        `and the handler list (${String(catalog.handlerCatalogDigest)})`
    );
  }
  mcpContract = catalog.contract;

  const sources = extractMcpSourceProvenance();
  const tools = runtimeTools.map((tool) => ({
    ...tool,
    namespace: tool.name.split(".")[0],
    aliases: [],
    source: sources.get(tool.name),
  }));
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`invalid M0.1 tool name: ${tool.name}`);
    if (names.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`);
    if (!tool.source) throw new Error(`runtime MCP tool has no source provenance: ${tool.name}`);
    names.add(tool.name);
  }
  for (const name of sources.keys()) {
    if (!names.has(name)) throw new Error(`source MCP declaration missing at runtime: ${name}`);
  }
  return tools;
}

function decoratorCall(node, sf, name) {
  return (ts.getDecorators(node) ?? [])
    .map((decorator) => decorator.expression)
    .find(
      (expression) => ts.isCallExpression(expression) && expression.expression.getText(sf) === name
    );
}

function decoratorPaths(call, sf) {
  if (!call || call.arguments.length === 0) return [""];
  let arg = call.arguments[0];
  // WIN-267 T1 — `@Controller({ path, version })`. The class-level version has
  // to travel in the options object because Nest 11's standalone `@Version` is
  // method-only: it dereferences `descriptor.value` unconditionally
  // (`@nestjs/common/decorators/core/version.decorator.js`), so applying it to
  // a class throws at import. `@Controller({ version })` writes the same
  // `VERSION_METADATA` key, so this is the same mechanism spelt for a class.
  if (ts.isObjectLiteralExpression(arg)) {
    const pathProperty = arg.properties.find(
      (property) => ts.isPropertyAssignment(property) && propertyName(property) === "path"
    );
    // `@Controller({ version })` with no `path` is Nest's own default: the
    // controller contributes nothing and every route path comes off the method.
    if (!pathProperty) return [""];
    arg = pathProperty.initializer;
  }
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text];
  // WIN-268 P1 — a path declared by the MCP surface constant rather than typed.
  // Resolved by READING that file, the same way the version is: the alternative
  // is a controller spelling `mcp/platform` a second time, which is the
  // divergence the constant exists to prevent.
  if (ts.isIdentifier(arg) && mcpSurface().paths.has(arg.text)) {
    return [mcpSurface().paths.get(arg.text)];
  }
  if (ts.isArrayLiteralExpression(arg)) {
    return arg.elements.map((entry) => {
      if (!ts.isStringLiteral(entry) && !ts.isNoSubstitutionTemplateLiteral(entry)) {
        throw new Error(`controller path must be a string literal in ${sf.fileName}`);
      }
      return entry.text;
    });
  }
  throw new Error(`controller path must be a string literal in ${sf.fileName}`);
}

function joinRoute(base, child) {
  return `/${[base, child].filter(Boolean).join("/")}`.replaceAll(/\/{2,}/g, "/");
}

// ── THE VERSION EXPRESSION, READ FROM THE FILE THE RUNTIME USES ─────────────
//
// WIN-267 (M4.1) T1. Until this milestone every controller spelled `api/v1` in
// its own decorator, so composing a route here was `@Controller` path +
// `@Get` path and nothing else. The version now lives in ONE place —
// `apps/agent/src/http/api-surface.ts` — and Nest assembles the wire path out
// of three parts at boot: `setGlobalPrefix("api")`, the URI-versioning segment
// `/v1`, and the controller's own path.
//
// This generator has to model that composition, and there is exactly one way to
// do it that is not a second private opinion about the version: READ THE SAME
// FILE. `apiSurface()` AST-parses `api-surface.ts` for its four exported
// constants. If someone renames the prefix, moves the major, or adds an
// unversioned root, this generator changes with the runtime and the manifest
// diff shows it — it cannot quietly keep emitting the old paths.
//
// The manifest is then checked against a THIRD mechanism that shares nothing
// with either: `apps/agent/src/http/api-surface.test.ts` boots a real Nest
// application over these same controllers, calls the same `applyApiSurface`,
// and reads the route table back out of Express. The generator's arithmetic and
// Nest's router have to agree, and both have to agree with the frozen
// `origin/main` manifest.
const VERSION_NEUTRAL_SENTINEL = Symbol("VERSION_NEUTRAL");

let apiSurfaceCache = null;

function apiSurface() {
  if (apiSurfaceCache) return apiSurfaceCache;
  const path = join(srcDir, "http", "api-surface.ts");
  if (!existsSync(path)) {
    throw new Error(
      `the version expression is declared in ${relative(repoDir, path)} and that file is missing; ` +
        "this generator refuses to guess a URL prefix"
    );
  }
  const sf = sourceFile(path);
  const values = new Map();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      values.set(declaration.name.text, declaration.initializer);
    }
  }
  const stringConstant = (name) => {
    const node = values.get(name);
    if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      throw new Error(`${name} must be an exported string literal in api-surface.ts`);
    }
    return node.text;
  };
  // `UNVERSIONED_ROOT_SEGMENTS` is written as `Object.freeze([...] as const)`;
  // unwrap to the array literal and require every element to be a plain string.
  const arrayNode = unwrapToArrayLiteral(values.get("UNVERSIONED_ROOT_SEGMENTS"));
  if (arrayNode === null) {
    throw new Error("UNVERSIONED_ROOT_SEGMENTS must be an array literal in api-surface.ts");
  }
  const unversionedRoots = arrayNode.elements.map((element) => {
    if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
      throw new Error("UNVERSIONED_ROOT_SEGMENTS entries must be string literals");
    }
    return element.text;
  });
  apiSurfaceCache = {
    globalPrefix: stringConstant("API_GLOBAL_PREFIX"),
    versionPrefix: stringConstant("API_VERSION_PREFIX"),
    version: stringConstant("API_VERSION"),
    unversionedRoots: new Set(unversionedRoots),
  };
  return apiSurfaceCache;
}

// ── THE MCP SURFACE EXPRESSION, READ THE SAME WAY ──────────────────────────
//
// WIN-268 (M4.2) P1. `apps/core-api/src/transports/mcp/mcp-surface.ts` is to the
// MCP transport what `api-surface.ts` is to REST: the one place the root
// segment, the two sub-paths and the decision NOT to put a version in the URL
// are written. Its controllers therefore pass CONSTANTS to `@Controller`, and a
// generator that demanded string literals would force the surface to be spelled
// a second time in exactly the place the constant exists to prevent.
//
// So it is READ, by the same mechanism and with the same refusal: a form this
// cannot resolve THROWS rather than defaulting, because a path this generator
// guessed wrong is a route it mounts in the census and nowhere else.
let mcpSurfaceCache = null;

function mcpSurface() {
  if (mcpSurfaceCache) return mcpSurfaceCache;
  const path = join(coreApiTransportsDir, "mcp", "mcp-surface.ts");
  if (!existsSync(path)) {
    throw new Error(
      `the MCP surface expression is declared in ${relative(repoDir, path)} and that file is missing; ` +
        "this generator refuses to guess an MCP path"
    );
  }
  const sf = sourceFile(path);
  const initializers = new Map();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  // Resolve in declaration order so `MCP_PLATFORM_PATH` can be a template
  // literal over `MCP_ROOT_SEGMENT`. Only two forms are accepted — a string
  // literal, and a template whose every substitution is an already-resolved
  // constant from THIS file — because anything else is an expression whose value
  // depends on something outside the surface declaration.
  const values = new Map();
  for (const [name, node] of initializers) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.set(name, node.text);
      continue;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      let resolvable = true;
      for (const span of node.templateSpans) {
        if (!ts.isIdentifier(span.expression) || !values.has(span.expression.text)) {
          resolvable = false;
          break;
        }
        text += values.get(span.expression.text) + span.literal.text;
      }
      if (resolvable) values.set(name, text);
    }
  }
  const stringConstant = (name) => {
    const value = values.get(name);
    if (typeof value !== "string") {
      throw new Error(`${name} must resolve to a string in ${relative(repoDir, path)}`);
    }
    return value;
  };
  mcpSurfaceCache = {
    rootSegment: stringConstant("MCP_ROOT_SEGMENT"),
    paths: new Map([
      ["MCP_PLATFORM_PATH", stringConstant("MCP_PLATFORM_PATH")],
      ["MCP_ENTITY_PATH", stringConstant("MCP_ENTITY_PATH")],
    ]),
  };
  return mcpSurfaceCache;
}

/**
 * Resolve a version expression to a string version or the neutral sentinel.
 *
 * Only three forms are accepted, and an unrecognised one THROWS rather than
 * defaulting: a version this generator cannot read is a route it would silently
 * mount on the wrong path, which is precisely the failure T1 exists to prevent.
 */
function resolveVersionExpression(arg, sf) {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isIdentifier(arg) && arg.text === "VERSION_NEUTRAL") return VERSION_NEUTRAL_SENTINEL;
  if (ts.isIdentifier(arg) && arg.text === "API_VERSION") return apiSurface().version;
  // WIN-268 P1 — the MCP surface's own opt-out. It is `VERSION_NEUTRAL` behind a
  // named constant, so that ADR M0.4 §2's "MCP paths stay unversioned" is a
  // DECISION a reader can find rather than a symbol repeated in two controllers.
  if (ts.isIdentifier(arg) && arg.text === "MCP_ROUTE_VERSION") return VERSION_NEUTRAL_SENTINEL;
  throw new Error(
    `version expression ${arg.getText(sf)} in ${relative(repoDir, sf.fileName)} is not a form this generator ` +
      "can resolve; use a string literal, API_VERSION, MCP_ROUTE_VERSION, or VERSION_NEUTRAL"
  );
}

/**
 * The version a CLASS declares through `@Controller({ version })`, or `null`
 * when it declares none and therefore inherits `defaultVersion`.
 */
function controllerDeclaredVersion(call, sf) {
  if (!call || call.arguments.length === 0) return null;
  const arg = call.arguments[0];
  if (!ts.isObjectLiteralExpression(arg)) return null;
  const versionProperty = arg.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property) === "version"
  );
  if (!versionProperty) return null;
  return resolveVersionExpression(versionProperty.initializer, sf);
}

/**
 * The version a METHOD declares through `@Version(...)`, or `null`.
 */
function methodDeclaredVersion(node, sf) {
  const call = decoratorCall(node, sf, "Version");
  if (!call) return null;
  const arg = call.arguments[0];
  if (!arg) throw new Error(`@Version() needs an argument in ${relative(repoDir, sf.fileName)}`);
  return resolveVersionExpression(arg, sf);
}

/**
 * Compose the wire path exactly as `RoutePathFactory.create` does: the URI
 * version segment first, then the controller and method paths, then the global
 * prefix unless the route is excluded from it.
 *
 * The exclusion here is by ROOT SEGMENT, where Nest's is by a path-to-regexp
 * pattern; `api-surface.ts` derives its `exclude` patterns from the same
 * segment list so the two are two readings of one declaration, and the
 * route-identity test is what proves the readings agree on every real route.
 */
function applyVersionExpression(routePath, version) {
  const surface = apiSurface();
  const versioned =
    version === VERSION_NEUTRAL_SENTINEL
      ? routePath
      : joinRoute(`${surface.versionPrefix}${version}`, routePath);
  const firstSegment = routePath.split("/").filter(Boolean)[0];
  if (firstSegment !== undefined && surface.unversionedRoots.has(firstSegment)) return versioned;
  return joinRoute(surface.globalPrefix, versioned);
}

function moduleControllers(modulePath) {
  const sf = sourceFile(modulePath);
  for (const statement of sf.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const moduleCall = decoratorCall(statement, sf, "Module");
    const metadata = moduleCall?.arguments[0];
    if (!metadata || !ts.isObjectLiteralExpression(metadata)) continue;
    const controllers = metadata.properties.find(
      (property) => ts.isPropertyAssignment(property) && propertyName(property) === "controllers"
    );
    if (!controllers || !ts.isPropertyAssignment(controllers)) return [];
    if (!ts.isArrayLiteralExpression(controllers.initializer)) {
      throw new Error(`module controllers must be an inline array in ${modulePath}`);
    }
    return controllers.initializer.elements.map((element) => element.getText(sf));
  }
  throw new Error(`no @Module class found in ${modulePath}`);
}

function assertMountedControllerPolicy() {
  const byModule = new Map();
  const seen = new Map();
  for (const root of CONTROLLER_SCAN_ROOTS) {
    if (!existsSync(root.scanDir)) {
      throw new Error(
        `controller scan root ${root.id} points at ${relative(repoDir, root.scanDir)}, which does not exist; a declared root that is not on disk enumerates nothing`
      );
    }
    for (const [controller, relativeModulePath] of Object.entries(root.mounted)) {
      const previous = seen.get(controller);
      if (previous !== undefined) {
        throw new Error(
          `controller class ${controller} is registered by two scan roots (${previous} and ${root.id}); the manifest keys route implementations by class name and cannot tell them apart`
        );
      }
      seen.set(controller, root.id);
      const modulePath = join(root.moduleDir, relativeModulePath);
      const controllers = byModule.get(modulePath) ?? moduleControllers(modulePath);
      byModule.set(modulePath, controllers);
      if (!controllers.includes(controller)) {
        throw new Error(`${controller} is not registered by ${relativeModulePath}`);
      }
    }
  }
  // THE OTHER DIRECTION, AND IT WAS MISSING. Everything above asks "is every
  // controller in the policy really registered by the module it names". Nothing
  // asked the reverse, and the agent root is `strict: false` precisely so that it
  // may hold controllers this policy omits — that skip is what separates
  // production controllers from the ones that are not mounted. The consequence
  // nobody had noticed is that a controller registered in a module the policy
  // ALREADY NAMES, and therefore mounted in production, is skipped in silence:
  // its routes reach no manifest, no OpenAPI document, no capability matrix and
  // no census, and every gate downstream stays green while the surface has grown.
  //
  // M4 finish hit this for real. `ChatStreamController` was added to
  // `agent-runtime.module.ts` — a module five other controllers in this policy
  // already name — and `--check` PASSED with the route invisible. So the reverse
  // is now an error, scoped to the modules the policy itself names, which is what
  // makes it a claim about production rather than about the whole tree: a module
  // this policy does not name is still free to register whatever it likes, and
  // that is how `TestController` stays out.
  //
  // MEASURED before it was enforced: sixteen modules, and every controller
  // registered by them was already listed. This refuses a new hole; it forgives
  // no existing one.
  for (const root of CONTROLLER_SCAN_ROOTS) {
    const modulePaths = new Set(
      Object.values(root.mounted).map((relativeModulePath) => join(root.moduleDir, relativeModulePath))
    );
    for (const modulePath of modulePaths) {
      const controllers = byModule.get(modulePath) ?? moduleControllers(modulePath);
      byModule.set(modulePath, controllers);
      for (const controller of controllers) {
        if (Object.hasOwn(root.mounted, controller)) continue;
        throw new Error(
          `${controller} is registered by ${relative(repoDir, modulePath).split("\\").join("/")}, a module the ${root.id} mounted-controller policy names, but is absent from that policy; its routes would reach no manifest, no OpenAPI document and no census. Add it, or move it to a module the policy does not name.`
        );
      }
    }
  }
  if (Object.hasOwn(PRODUCTION_MOUNTED_CONTROLLERS, "TestController")) {
    throw new Error("TestController must not be present in the production mounted-controller policy");
  }
}

/**
 * A strict scan root may not hold a controller its allowlist omits.
 *
 * The agent root deliberately skips unlisted controllers — that tree carries
 * controllers that are not mounted in production, and the allowlist is what
 * separates them. `apps/core-api/src/transports` carries no such class and never
 * should: everything under it is the V1 business surface. Skipping there would
 * reintroduce exactly the invisibility this second scan root was added to remove,
 * so the omission is a generation failure rather than a silent `continue`.
 */
function assertStrictRootsHaveNoUnregisteredControllers() {
  for (const root of CONTROLLER_SCAN_ROOTS) {
    if (!root.strict) continue;
    for (const path of walk(root.scanDir).filter((file) => file.endsWith(".controller.ts"))) {
      const sf = sourceFile(path);
      for (const statement of sf.statements) {
        if (!ts.isClassDeclaration(statement) || !statement.name) continue;
        if (!decoratorCall(statement, sf, "Controller")) continue;
        if (Object.hasOwn(root.mounted, statement.name.text)) continue;
        throw new Error(
          `${statement.name.text} in ${relative(repoDir, path).split("\\").join("/")} carries @Controller but is not registered in the ${root.id} mounted-controller policy; register it (and its module) so its routes reach the manifest`
        );
      }
    }
  }
}

function classifyRest(method, path) {
  const key = `${method} ${path}`;
  if (REST_TO_MCP[key]) {
    return {
      classification: "MAPPED",
      policyRule: "explicit-rest-to-mcp",
      mcpTools: REST_TO_MCP[key],
      mappingRationale: mappingRationale(key, REST_TO_MCP[key]),
    };
  }
  for (const rule of deprecatedRules()) {
    if (rule.test(path)) {
      return {
        classification: "DEPRECATED",
        policyRule: rule.id,
        mcpTools: [],
        mappingRationale: null,
        // ADR M0.4 §4.1's "non-null replacement/supersededBy — never inferred",
        // as the canonical OPERATION rather than the prefix it lives under. The
        // id is the manifest's own join key, so `validateAliasContract` below can
        // resolve it and refuse an alias whose canonical does not exist.
        replacement: `${method} ${rule.canonicalPrefix}${path.slice(rule.aliasPrefix.length)}`,
        deprecation: {
          announcedOn: rule.announcedOn,
          sunsetOn: rule.sunsetOn,
          wireSignal: "Deprecation: true + Sunset (RFC 8594) + Link rel=successor-version",
        },
      };
    }
  }
  for (const rule of INTERNAL_RULES) {
    if (rule.test(path))
      return {
        classification: "INTERNAL",
        policyRule: rule.id,
        mcpTools: [],
        mappingRationale: null,
      };
  }
  for (const rule of PUBLIC_TRANSPORT_RULES) {
    if (rule.test(path, method))
      return {
        classification: "PUBLIC_TRANSPORT",
        policyRule: rule.id,
        mcpTools: [],
        mappingRationale: null,
      };
  }
  return {
    classification: "REST_ONLY",
    policyRule: "explicit-default-rest-only",
    mcpTools: [],
    mappingRationale: null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function implementationKeys(operation) {
  return (operation.implementations ?? [])
    .map(({ controller, handler, source }) => `${source}#${controller}.${handler}`)
    .sort();
}

/**
 * ADR M0.4 §4.1 AND §5.3, ENFORCED AT GENERATION TIME.
 *
 * §5.3 asks for an "alias fan-in" check: "every DEPRECATED/alias op has non-null
 * replacement AND resolves to the same `controller.handler` as its canonical".
 * Nothing in the repository did that. Generation now refuses:
 *
 *   * a DEPRECATED operation whose replacement names an operation that is not in
 *     this manifest — the failure mode a prefix-shaped replacement HID, because
 *     a prefix can never be looked up and so can never be found missing;
 *   * an alias whose implementation set differs from its canonical's, which is
 *     the "no independent implementation" half and the case a second controller
 *     serving the old path would land in;
 *   * a canonical operation sitting under an alias prefix, which would mean the
 *     prefix swap resolves an alias onto another alias;
 *   * a window shorter than §4.3's ninety days;
 *   * a declared alias row that matches no operation (dead policy), and a
 *     DEPRECATED operation matched by no row (undeclared alias).
 *
 * WHAT IT CANNOT ENFORCE, NAMED RATHER THAN SILENTLY EXCLUDED. Two operations in
 * this tree are served by BOTH deployables — the MCP platform and entity token
 * mints — and their two implementations are genuinely independent classes in two
 * processes, so they cannot satisfy fan-in and are not aliases: they are one
 * route mid-migration. They are listed below with that reason, and a THIRD such
 * operation fails generation rather than joining a list nobody re-reads.
 */
const FORKED_OPERATIONS_WITHOUT_ONE_HANDLER = Object.freeze({
  "POST /mcp/platform/tokens":
    "mid-migration: apps/agent has served this mint since before V1 and apps/core-api now serves it on the V1 chassis, because that is the process the Idempotency-Key gate runs in. Two independent classes, one wire path — not an alias, and it cannot satisfy §4.1 fan-in until the legacy handler is withdrawn.",
  "POST /mcp/entity/:entityId/tokens":
    "mid-migration, for the reason given for the platform mint above; the entity mint moved on the same tranche and has the same two-implementation shape.",
});

function validateAliasContract(restOperations) {
  const rules = deprecatedRules();
  const minimumWindowDays = deprecationMinimumWindowDays();
  const byId = new Map(restOperations.map((operation) => [operation.id, operation]));
  const deprecated = restOperations.filter((operation) => operation.classification === "DEPRECATED");

  for (const rule of rules) {
    const announced = Date.parse(`${rule.announcedOn}T00:00:00.000Z`);
    const sunset = Date.parse(`${rule.sunsetOn}T00:00:00.000Z`);
    if (Number.isNaN(announced) || Number.isNaN(sunset)) {
      throw new Error(`alias ${rule.id} carries a date that is not an ISO calendar date`);
    }
    const windowDays = Math.round((sunset - announced) / DAY_MS);
    if (windowDays < minimumWindowDays) {
      throw new Error(
        `alias ${rule.id} declares a ${windowDays}-day window; ADR M0.4 §4.3 requires at least ${minimumWindowDays}`
      );
    }
    if (!deprecated.some((operation) => rule.test(operation.path))) {
      throw new Error(`alias ${rule.id} matches no DEPRECATED operation`);
    }
  }

  for (const operation of restOperations) {
    const rule = rules.find((candidate) => candidate.test(operation.path));
    if (rule && operation.classification !== "DEPRECATED") {
      throw new Error(
        `${operation.id} sits under alias prefix ${rule.aliasPrefix} but classifies ${operation.classification}`
      );
    }
    if (!rule && operation.classification === "DEPRECATED") {
      throw new Error(`${operation.id} is DEPRECATED but no alias row declares it`);
    }
    if (!rule) continue;

    const canonical = byId.get(operation.replacement);
    if (!canonical) {
      throw new Error(
        `${operation.id} names replacement ${operation.replacement}, which is not an operation in this manifest`
      );
    }
    if (canonical.classification === "DEPRECATED") {
      throw new Error(`${operation.id} names a replacement that is itself DEPRECATED`);
    }
    const aliasHandlers = implementationKeys(operation);
    const canonicalHandlers = implementationKeys(canonical);
    if (JSON.stringify(aliasHandlers) !== JSON.stringify(canonicalHandlers)) {
      throw new Error(
        `alias fan-in broken: ${operation.id} is served by ${aliasHandlers.join(", ")} and its canonical ${canonical.id} by ${canonicalHandlers.join(", ")}`
      );
    }
  }

  const forked = restOperations.filter((operation) => {
    const roots = new Set(
      (operation.implementations ?? []).map((implementation) =>
        implementation.source.startsWith("apps/core-api/") ? "core-api" : "agent"
      )
    );
    return operation.implementations.length > 1 && roots.size > 1;
  });
  for (const operation of forked) {
    if (!FORKED_OPERATIONS_WITHOUT_ONE_HANDLER[operation.id]) {
      throw new Error(
        `${operation.id} is served by two deployables and is not declared in FORKED_OPERATIONS_WITHOUT_ONE_HANDLER with a reason`
      );
    }
  }
  for (const id of Object.keys(FORKED_OPERATIONS_WITHOUT_ONE_HANDLER)) {
    if (!forked.some((operation) => operation.id === id)) {
      throw new Error(`${id} is declared as a cross-deployable fork but is no longer one`);
    }
  }
}

/** The alias contract AS DATA, so a consumer can read the window off the manifest. */
function deprecationPolicy(restOperations) {
  const rules = deprecatedRules();
  return {
    source: "docs/adr/M0.4-contract-versioning.md §4",
    declaredIn: `apps/agent/src/${DEPRECATION_SIGNAL_MODULE.join("/")}`,
    minimumWindowDays: deprecationMinimumWindowDays(),
    wireSignal: ["Deprecation", "Sunset", "Link"],
    catalogSignal: [
      "deprecated",
      "x-platos-classification",
      "x-platos-superseded-by",
      "x-platos-sunset",
    ],
    aliases: rules.map((rule) => ({
      id: rule.id,
      aliasPrefix: rule.aliasPrefix,
      canonicalPrefix: rule.canonicalPrefix,
      announcedOn: rule.announcedOn,
      sunsetOn: rule.sunsetOn,
      windowDays: Math.round(
        (Date.parse(`${rule.sunsetOn}T00:00:00.000Z`) -
          Date.parse(`${rule.announcedOn}T00:00:00.000Z`)) /
          DAY_MS
      ),
      operations: restOperations.filter((operation) => rule.test(operation.path)).length,
      fanIn: "same-controller-multi-path",
    })),
    forksWithoutOneHandler: Object.entries(FORKED_OPERATIONS_WITHOUT_ONE_HANDLER)
      .map(([id, reason]) => ({ id, reason }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * The call shapes that ARE an operator check, across both scan roots.
 *
 * WIN-267 R1 ADDED THE THIRD, AND WITHOUT IT THE MANIFEST WOULD HAVE LIED. The
 * V1 surface does not call `requireOperator`: `apps/core-api/src/transports/rest/
 * operator.ts` is its one authentication seam and it is named
 * `authenticateOperator`, so seven routes that verify an operator session against
 * a composed `identity-access` would have been recorded `requiresOperator: false`
 * — and `docs/audits/M0.8-operator-operations.md`, which is generated from that
 * field and exists to make operator protection "auditable at a glance", would
 * have under-reported them.
 *
 * IT IS NOT A BLANKET. `DELETE /api/v1/bff/session` deliberately authenticates
 * nobody — a browser holding a dead cookie is the browser that most needs it
 * cleared — and stays `false`, which is what makes this recognition a
 * measurement rather than a decoration.
 *
 * The name is unambiguous across the agent tree: it appears in NO controller
 * under `apps/agent/src`, so adding it changes not one V0 row.
 */
/*
 * WIN-268 (M4.2) P1 ADDED THE FOURTH, for the same reason R1 added the third.
 * The two MCP token mints do not call `authenticateOperator` directly: they call
 * `mintingOperator`, which IS that seam plus one refusal only a transport can
 * make — an impersonated session may not mint a durable credential, because the
 * credential would outlive the impersonation and `McpToken`'s single actor
 * column cannot record both humans. A route that authenticates an operator
 * MORE strictly must not be recorded as authenticating none, which is what
 * omitting the name would have done.
 *
 * It is not a blanket either: the name appears in no other controller in either
 * tree, so adding it changes exactly the two rows it was added for.
 */
const OPERATOR_SCOPE_CALLS = [
  "requireOperator(",
  "getOperatorScope(",
  "authenticateOperator(",
  "mintingOperator(",
];

/**
 * A route enforces operator scope when its body makes one of those calls
 * directly, OR when it delegates to a same-class helper method whose own body
 * makes one (e.g. `this.operatorScope(req)` in providers.controller.ts).
 * `operatorHelpers` is the set of such helper method names collected from the
 * enclosing controller class. The trailing `(` guards against a helper name being
 * a prefix of an unrelated method call.
 */
function enforcesOperatorScope(memberText, operatorHelpers) {
  if (OPERATOR_SCOPE_CALLS.some((call) => memberText.includes(call))) {
    return true;
  }
  for (const helper of operatorHelpers) {
    if (memberText.includes(`this.${helper}(`)) return true;
  }
  return false;
}

function extractRestOperations() {
  assertMountedControllerPolicy();
  assertStrictRootsHaveNoUnregisteredControllers();
  const implementations = [];
  const verbs = new Map([
    ["Get", "GET"],
    ["Post", "POST"],
    ["Put", "PUT"],
    ["Patch", "PATCH"],
    ["Delete", "DELETE"],
    ["Options", "OPTIONS"],
    ["Head", "HEAD"],
  ]);
  const controllerFiles = CONTROLLER_SCAN_ROOTS.flatMap((root) =>
    walk(root.scanDir)
      .filter((file) => file.endsWith(".controller.ts"))
      .map((file) => ({ file, root }))
  );
  for (const { file: path, root } of controllerFiles) {
    const sf = sourceFile(path);
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const controller = decoratorCall(statement, sf, "Controller");
      if (!controller) continue;
      if (!Object.hasOwn(root.mounted, statement.name.text)) continue;
      const bases = decoratorPaths(controller, sf);
      // `defaultVersion` is the floor: a controller that declares nothing is v1.
      const controllerVersion = controllerDeclaredVersion(controller, sf) ?? apiSurface().version;
      // Collect same-class helper methods that themselves enforce operator scope
      // so a route delegating to one (e.g. `this.operatorScope(req)`) is not read
      // as unguarded. See enforcesOperatorScope.
      const operatorHelpers = new Set();
      for (const candidate of statement.members) {
        if (!ts.isMethodDeclaration(candidate) || !candidate.name) continue;
        const text = candidate.getText(sf);
        if (OPERATOR_SCOPE_CALLS.some((call) => text.includes(call))) {
          operatorHelpers.add(candidate.name.getText(sf));
        }
      }
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        for (const [decorator, method] of verbs) {
          const route = decoratorCall(member, sf, decorator);
          if (!route) continue;
          const children = decoratorPaths(route, sf);
          // A method-level `@Version` wins over the controller's, which is how
          // `OpenApiController` serves the versioned machine document and the
          // unversioned human alias from one class.
          const version = methodDeclaredVersion(member, sf) ?? controllerVersion;
          for (const base of bases) {
            for (const child of children) {
              implementations.push({
                method,
                path: applyVersionExpression(joinRoute(base, child), version),
                controller: statement.name.text,
                handler: member.name.getText(sf),
                source: relative(repoDir, path).replaceAll("\\", "/"),
                requiresOperator: enforcesOperatorScope(
                  member.getText(sf),
                  operatorHelpers,
                ),
              });
            }
          }
        }
      }
    }
  }

  const byRoute = new Map();
  for (const implementation of implementations) {
    const key = `${implementation.method} ${implementation.path}`;
    const list = byRoute.get(key) ?? [];
    list.push({
      controller: implementation.controller,
      handler: implementation.handler,
      source: implementation.source,
      requiresOperator: implementation.requiresOperator,
    });
    byRoute.set(key, list);
  }

  return [...byRoute.entries()]
    .map(([key, routeImplementations]) => {
      const separator = key.indexOf(" ");
      const method = key.slice(0, separator);
      const path = key.slice(separator + 1);
      return {
        id: key,
        method,
        path,
        ...classifyRest(method, path),
        implementations: routeImplementations.sort(
          (a, b) => a.source.localeCompare(b.source) || a.handler.localeCompare(b.handler)
        ),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function countBy(items, key) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item[key]))]
      .sort()
      .map((value) => [value, items.filter((item) => item[key] === value).length])
  );
}

function buildManifest() {
  const mcpTools = extractMcpTools();
  const restOperations = extractRestOperations();
  const toolNames = new Set(mcpTools.map((tool) => tool.name));
  for (const [route, mappings] of Object.entries(REST_TO_MCP)) {
    if (!restOperations.some((operation) => operation.id === route)) {
      throw new Error(`REST mapping references missing operation: ${route}`);
    }
    for (const tool of mappings) {
      if (!toolNames.has(tool))
        throw new Error(`REST mapping references missing MCP tool: ${route} -> ${tool}`);
    }
    if (!mappingRationale(route, mappings).trim()) {
      throw new Error(`REST mapping lacks semantic rationale: ${route}`);
    }
  }

  const restMappingsByTool = new Map();
  for (const operation of restOperations) {
    for (const tool of operation.mcpTools) {
      const routes = restMappingsByTool.get(tool) ?? [];
      routes.push(operation.id);
      restMappingsByTool.set(tool, routes);
    }
  }
  for (const tool of mcpTools) {
    tool.restMappings = (restMappingsByTool.get(tool.name) ?? []).sort();
    tool.classification = tool.restMappings.length > 0 ? "MAPPED" : "MCP_ONLY";
  }

  if (mcpContract === null) throw new Error("MCP contract block was never extracted");

  // WIN-267 (M4.1) — refuse to EMIT a manifest whose aliases do not satisfy the
  // ADR, rather than emit one and check it downstream. A generator that can only
  // produce a valid artifact is a stronger guarantee than a gate that notices an
  // invalid one, and the operation set is already assembled at this point.
  validateAliasContract(restOperations);

  return {
    manifestVersion: "M0.1",
    canonicalPolicy: "explicit-operation-manifest",
    deprecationPolicy: deprecationPolicy(restOperations),
    tenancyAuthority: ["organizationId", "projectId", "environmentId", "userId"],
    /**
     * WIN-268 P1 — ADR M0.4 §2's MCP row, as DATA.
     *
     * The row fixes two independent axes: a spec-negotiated `protocolVersion`
     * date and a Platos contract semver whose MAJOR is the break axis. Both are
     * read out of `apps/agent/src/http/mcp-surface.ts` by the runtime helper, so
     * this block is what a client is actually told rather than a second
     * declaration of it. `--check` byte-compares, so moving the const without
     * regenerating fails, and editing this block without moving the const fails
     * the same way.
     *
     * `catalogDigest` is `sha256` over every registered platform tool's name,
     * `schemaHash` and admin flag, sorted by name. It moves when a tool is added,
     * removed, renamed, made admin-only, or given a different input schema —
     * which is the list of changes ADR M0.4 §2 calls breaking, plus the additive
     * ones. Entity tools are excluded by §5 because they are discovered
     * downstream.
     */
    mcpContract,
    toolNamePolicy: {
      baseline: "canonical-dotted-202",
      syntax: TOOL_NAME_PATTERN.source,
      aliasesMustBeExplicit: true,
    },
    inventories: {
      mcpTools,
      restOperations,
    },
    summary: {
      mcpTools: mcpTools.length,
      mcpNamespaces: new Set(mcpTools.map((tool) => tool.namespace)).size,
      adminTierTools: mcpTools.filter((tool) => tool.requiresAdminTier).length,
      mcpClassifications: countBy(mcpTools, "classification"),
      restOperations: restOperations.length,
      restRouteBindings: restOperations.reduce(
        (sum, operation) => sum + operation.implementations.length,
        0
      ),
      ambiguousRestOperations: restOperations.filter(
        (operation) => operation.implementations.length > 1
      ).length,
      /**
       * WIN-268 (M4.2) P1 — HOW MANY OF THE AMBIGUOUS ONES ARE THE MIGRATION.
       *
       * `ambiguousRestOperations` counts every method/path pair with more than
       * one handler, and until this tranche it was ZERO. It is now two, and the
       * distinction this figure draws is the one an integrator needs: two
       * handlers in ONE deployable is a defect — the router picks whichever was
       * registered first and nobody can tell which — while one handler in EACH
       * deployable is the state of a route mid-migration, which is what the two
       * MCP token mints are. `apps/agent` has served them since before V1;
       * `apps/core-api` now serves them too, because that is the process the
       * `Idempotency-Key` gate runs in.
       *
       * When the two counts are EQUAL, every ambiguity is cross-deployable and
       * nothing is racing inside one router. A gap between them is the defect.
       */
      crossDeployableRestOperations: restOperations.filter((operation) => {
        const roots = new Set(
          (operation.implementations ?? []).map((implementation) =>
            implementation.source.startsWith("apps/core-api/") ? "core-api" : "agent"
          )
        );
        return operation.implementations.length > 1 && roots.size > 1;
      }).length,
      restClassifications: countBy(restOperations, "classification"),
      // WIN-267 — WHICH TREE EACH OPERATION CAME FROM.
      //
      // Recorded because the generator now walks more than one, and a total that
      // does not say what it is a total OF is how a second application ends up
      // ungoverned without anybody editing a number. Counts are derived from the
      // route implementations' own source paths, so a root cannot claim an
      // operation it did not produce. `scripts/rest-census-independent.mjs`
      // re-derives the same split by globbing and fails if the two disagree.
      restScanRoots: CONTROLLER_SCAN_ROOTS.map((root) => {
        const dir = relative(repoDir, root.scanDir).split("\\").join("/");
        const operations = restOperations.filter((operation) =>
          (operation.implementations ?? []).some(
            (implementation) =>
              implementation.source === dir || implementation.source.startsWith(`${dir}/`)
          )
        );
        return {
          id: root.id,
          dir,
          strict: root.strict,
          registeredControllers: Object.keys(root.mounted).length,
          operations: operations.length,
          routeBindings: operations.reduce(
            (sum, operation) =>
              sum +
              (operation.implementations ?? []).filter(
                (implementation) =>
                  implementation.source === dir || implementation.source.startsWith(`${dir}/`)
              ).length,
            0
          ),
        };
      }),
    },
  };
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

// The line break inside a Markdown table cell, written MDX-legally.
//
// WHY THIS IS A CONSTANT AND WHY IT IS SELF-CLOSING. `docs/` is validated by
// `pnpm audit:docs-build` -> `mintlify validate`, which parses these tables as
// MDX rather than as CommonMark. MDX has no void elements: a bare `<br>` is an
// unclosed JSX tag, and validation fails with "Expected a closing tag for
// `<br>` ... before the end of `tableData`".
//
// Both call sites join a LIST into one cell, so before an operation had two
// implementations every join produced a single element and the separator was
// never emitted. The two MCP token mints are the first operations served by
// BOTH deployables, which is what first put a separator on the page and turned
// `audit:docs-build` red. The MCP-tool table below has the same latent shape:
// it stays single-valued today, so it never printed one either. Naming the
// separator once means the next multi-valued cell — from either table — cannot
// reintroduce the bare tag.
const CELL_BREAK = "<br />";

function buildReport(manifest) {
  const { mcpTools, restOperations } = manifest.inventories;
  const lines = [
    "# Platos control-plane parity report (generated)",
    "",
    "> Deterministic WIN-129 artifact. Do not edit by hand; run `pnpm --filter platos-agent generate:control-plane`.",
    "",
    "The **explicit operation manifest** is canonical. Platform MCP metadata is seeded from the 206 runtime-shaped handler declarations; REST metadata is derived from Nest controller decorators. Compact policy rules classify every operation. MCP schemas are authoritative for MCP calls. WIN-267 W2: the generated OpenAPI now carries request and response schemas for the V1 core-api operations, derived from the TypeScript types of their handlers and validated against the published OpenAPI 3.1 meta-schema; agent operations declare no wire DTO and carry no invented schema.",
    "",
    "## Summary",
    "",
    `- MCP tools: **${manifest.summary.mcpTools}** across **${manifest.summary.mcpNamespaces}** namespaces (${manifest.summary.adminTierTools} admin-tier).`,
    `- MCP contract: **v${manifest.mcpContract.version}** (major **${manifest.mcpContract.major}**), MCP protocol \`${manifest.mcpContract.protocolVersion}\`, catalog digest \`${manifest.mcpContract.catalogDigest.slice(0, 16)}\`.`,
    `- REST operations: **${manifest.summary.restOperations}** unique method/path pairs from **${manifest.summary.restRouteBindings}** route bindings.`,
    `- Ambiguous duplicate REST method/path pairs: **${manifest.summary.ambiguousRestOperations}**, of which **${manifest.summary.crossDeployableRestOperations}** are one handler in EACH deployable (a route mid-migration) rather than two in one router (a defect).`,
    `- MCP classifications: ${Object.entries(manifest.summary.mcpClassifications)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}.`,
    `- REST classifications: ${Object.entries(manifest.summary.restClassifications)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}.`,
    "",
    "## REST inventory",
    "",
    "| REST operation | Classification | MCP mapping | Semantic rationale / policy | Implementation(s) |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const operation of restOperations) {
    lines.push(
      `| \`${escapeCell(operation.id)}\` | ${operation.classification} | ${
        operation.mcpTools.map((tool) => `\`${tool}\``).join(", ") || "—"
      } | ${
        operation.mappingRationale
          ? escapeCell(operation.mappingRationale)
          : operation.deprecation
            ? `\`${operation.policyRule}\` — superseded by \`${escapeCell(
                operation.replacement
              )}\`, sunset ${operation.deprecation.sunsetOn}`
            : `\`${operation.policyRule}\``
      } | ${operation.implementations
        .map((implementation) => `\`${implementation.source}#${implementation.handler}\``)
        .join(CELL_BREAK)} |`
    );
  }
  lines.push(
    "",
    "## MCP inventory",
    "",
    "| MCP tool | Classification | REST mapping | Tier | Source |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const tool of mcpTools) {
    lines.push(
      `| \`${tool.name}\` | ${tool.classification} | ${
        tool.restMappings.map((route) => `\`${escapeCell(route)}\``).join(CELL_BREAK) || "—"
      } | ${tool.requiresAdminTier ? "admin" : "scope"} | \`${tool.source}\` |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function openApiPath(path) {
  return path.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationId(operation) {
  return `${operation.method.toLowerCase()}_${operation.path}`
    .replaceAll(/:([A-Za-z0-9_]+)/g, "by_$1")
    .replaceAll(/[^A-Za-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
}

function operationAuth(operation) {
  const { path, classification, implementations } = operation;
  if (
    path === "/api/health" ||
    path === "/metrics" ||
    path === "/openapi" ||
    path.endsWith("/openapi.json") ||
    path === "/mcp" ||
    path.startsWith("/mcp/docs")
  ) {
    return { authClass: "PUBLIC", security: [] };
  }
  if (classification === "INTERNAL") {
    return { authClass: "INTERNAL_SHARED_SECRET", security: [{ internalAuth: [] }] };
  }
  if (path.startsWith("/api/v1/agent/admin/privacy")) {
    return { authClass: "OPERATOR_ADMIN_BEARER", security: [{ platformMcpBearer: [] }] };
  }
  if (classification === "PUBLIC_TRANSPORT" && path.startsWith("/mcp/platform")) {
    return { authClass: "PLATFORM_MCP_BEARER", security: [{ platformMcpBearer: [] }] };
  }
  if (classification === "PUBLIC_TRANSPORT" && path.startsWith("/mcp/entity/")) {
    return { authClass: "ENTITY_OAUTH_BEARER", security: [{ oauthBearer: [] }] };
  }
  if (path.startsWith("/.well-known/")) {
    return { authClass: "PUBLIC_PROTOCOL_METADATA", security: [] };
  }
  if (path === "/oauth/authorize/callback") {
    return {
      authClass: "OAUTH_CONSENT_HMAC",
      security: [{ consentSignature: [] }],
    };
  }
  if (implementations.some((implementation) => implementation.requiresOperator)) {
    return {
      authClass: "OPERATOR",
      security: [{ sessionToken: [] }, { directHeaders: [] }],
    };
  }
  if (
    path === "/oauth/token" ||
    path === "/oauth/introspect" ||
    path === "/oauth/revoke" ||
    path.endsWith("/token") ||
    path.endsWith("/revoke")
  ) {
    return {
      authClass: "OAUTH_CLIENT_BODY_OR_BASIC",
      // Public clients authenticate with client_id in the request body; a
      // confidential client may instead use HTTP Basic. OpenAPI cannot express
      // that conditional body-level protocol rule as a security scheme.
      security: [],
    };
  }
  if (path === "/oauth" || path.startsWith("/oauth/")) {
    return { authClass: "PUBLIC_OAUTH_PROTOCOL", security: [] };
  }
  if (path.includes("/session-tokens")) {
    return { authClass: "ENTITY_BEARER", security: [{ entityBearer: [] }] };
  }
  if (path.startsWith("/api/v1/public/")) {
    return { authClass: "PUBLIC_RATE_LIMITED", security: [] };
  }
  if (path.startsWith("/api/v1/channels/inbound/")) {
    return {
      authClass: "CHANNEL_PROVIDER_SIGNATURE",
      security: [{ channelProviderSignature: [] }],
    };
  }
  if (path.startsWith("/api/v1/channels/oauth/") || path.startsWith("/api/v1/channels/link/")) {
    return { authClass: "CHANNEL_OAUTH_NONCE", security: [{ channelFlowNonce: [] }] };
  }
  if (path.startsWith("/api/v1/channels/apps/")) {
    return {
      authClass: "CHANNEL_PROVIDER_SIGNATURE",
      security: [{ channelProviderSignature: [] }],
    };
  }
  return {
    authClass: "SCOPED_USER",
    security: [{ sessionToken: [] }, { directHeaders: [] }],
  };
}

/**
 * The canonical failure codes, read off `docs/error-taxonomy.json`.
 *
 * A JOIN, NOT A LIST. `scripts/error-taxonomy.mjs` already reconciles that file
 * against the seventeen contexts' mint sites, `transports/error-status.ts` and
 * the kernel's `ErrorCategory` union, so enumerating it here binds the published
 * document to a set nothing in this generator decides. A code minted anywhere
 * without a taxonomy row fails that gate; a code added to the taxonomy shows up
 * here as generated drift on the next run.
 */
function canonicalErrorCodes() {
  const taxonomy = JSON.parse(readFileSync(errorTaxonomyPath, "utf8"));
  const codes = Object.keys(taxonomy.codes ?? {}).sort();
  if (codes.length === 0) throw new Error("docs/error-taxonomy.json declares no codes");
  return codes;
}

/**
 * Why an operation carries no derived schema.
 *
 * The agent tree's controllers answer Prisma rows, framework objects and
 * hand-built literals; none of them declares a wire DTO, and inventing one from
 * a handler body would be exactly the invention the previous generator declined
 * to make. WIN-267 W2 derives the V1 core-api surface, which does declare them,
 * and says plainly that it derived nothing else. `{}` would have been the
 * dishonest alternative: a schema that admits everything, in a document that
 * looks finished.
 */
const UNDECLARED_SCHEMA_REASON =
  "apps/agent controller; no declared wire DTO to derive from (WIN-267 W2 derives apps/core-api only)";

/** The failure envelope every V1 operation can answer with. */
function errorResponse(errorComponent) {
  return {
    description:
      "Failure. Every non-2xx answer from the V1 surface uses ADR M0.4 section 2's envelope. " +
      "Which codes a given route can mint is not derivable from the transport and is not claimed " +
      "here; `error.code` is drawn from the canonical taxonomy enumerated on the schema.",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${errorComponent}` } } },
  };
}

function v1OperationEntry(entry, derived, contract) {
  const responses = {};
  if (derived.responseSchema === null) {
    responses[derived.successStatus] = { description: "No content." };
  } else {
    responses[derived.successStatus] = {
      description: "Success.",
      content: { "application/json": { schema: derived.responseSchema } },
    };
  }
  responses.default = errorResponse(contract.errorComponent);
  const parameters = derived.pathParameters.map((parameter) => ({
    name: parameter.name,
    in: "path",
    required: true,
    schema: parameter.schema,
  }));
  const patched = {
    ...entry,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(derived.requestBody === null
      ? {}
      : {
          requestBody: {
            required: true,
            content: { "application/json": { schema: derived.requestBody } },
          },
        }),
    responses,
    "x-platos-schema-source": "typescript-dto",
    "x-platos-query-parameters": derived.queryParameters.source,
  };
  if (derived.queryParameters.source === "not-derived") {
    patched["x-platos-query-not-derived-reason"] = derived.queryParameters.reason;
    patched["x-platos-query-not-derived-detail"] = derived.queryParameters.detail;
  }
  return patched;
}

function buildOpenApi(manifest, contract) {
  const paths = {};
  const coverage = { derived: 0, undeclared: 0, queryNotDerived: [] };
  const usedHandlerKeys = new Set();
  for (const operation of manifest.inventories.restOperations) {
    const path = openApiPath(operation.path);
    const parameters = [...operation.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    // WIN-268 (M4.2) P1 — WHICH IMPLEMENTATION THE V1 DOCUMENT DESCRIBES.
    //
    // Until this tranche every operation had exactly one, so `[0]` was the only
    // one. The two MCP token mints are the first operations SERVED BY BOTH
    // deployables: `apps/agent` has carried them since before V1 and
    // `apps/core-api` now serves them on the T2 chassis, because that is the
    // process the `Idempotency-Key` gate runs in and the gate was binding two
    // operations nothing there answered.
    //
    // The V1 OpenAPI document describes the V1 deployable, so when a core-api
    // implementation exists it is the one described — and it is the only one
    // whose request and response schemas can be DERIVED, because the derivation
    // walks `apps/core-api/src/transports`. Taking `[0]` would publish the
    // legacy handler's signature under a schema block derived from the new one,
    // or (as it did) leave the derived handler orphaned and fail generation.
    const primary =
      operation.implementations.find((implementation) =>
        implementation.source.startsWith("apps/core-api/"),
      ) ?? operation.implementations[0];
    const auth = operationAuth(operation);
    const entry = {
      operationId: operationId(operation),
      summary: `${primary.controller}.${primary.handler}`,
      tags: [operation.classification.toLowerCase()],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        200: {
          description:
            "Operation response. REST payload schemas are intentionally omitted until a source schema is available.",
        },
      },
      ...(operation.classification === "DEPRECATED" ? { deprecated: true } : {}),
      security: auth.security,
      "x-platos-classification": operation.classification,
      "x-platos-auth-class": auth.authClass,
      "x-platos-policy-rule": operation.policyRule,
      "x-platos-mcp-tools": operation.mcpTools,
      // WIN-267 (M4.1) — ADR M0.4 §4.2's STATIC channel. The row asks for
      // "OpenAPI `deprecated:true` + `x-platos-classification:DEPRECATED` +
      // `x-platos-superseded-by` + `x-platos-sunset`"; the first two were already
      // emitted and the last two were not, so a client reading the published
      // document could see THAT an operation was deprecated and never what
      // replaced it or when it goes away. Both are taken from the manifest row,
      // which took them from the runtime table, so the document and the wire
      // cannot disagree. Adding a response header and two specification
      // extensions is additive-in-major under §1.3, which is what the OpenAPI
      // ratchet is asked to confirm rather than asked to allow.
      ...(operation.deprecation
        ? {
            "x-platos-superseded-by": operation.replacement,
            "x-platos-sunset": operation.deprecation.sunsetOn,
          }
        : {}),
    };
    // THE JOIN KEY IS THE MANIFEST'S OWN `controller`.`handler`, not a route
    // path recomputed here. Two computations of one path are two answers that
    // can disagree, and the manifest already made this one.
    const handlerKey = `${primary.controller}.${primary.handler}`;
    const derived = primary.source.startsWith("apps/core-api/")
      ? contract.handlers.get(handlerKey)
      : undefined;
    let finalEntry;
    if (derived === undefined) {
      finalEntry = {
        ...entry,
        "x-platos-schema-source": "undeclared",
        "x-platos-schema-undeclared-reason": primary.source.startsWith("apps/core-api/")
          ? `core-api handler ${handlerKey} was not reached by the derivation`
          : UNDECLARED_SCHEMA_REASON,
      };
      coverage.undeclared += 1;
    } else {
      usedHandlerKeys.add(handlerKey);
      finalEntry = v1OperationEntry(entry, derived, contract);
      coverage.derived += 1;
      if (derived.queryParameters.source === "not-derived") {
        coverage.queryNotDerived.push({
          operation: operation.id,
          handler: handlerKey,
          reason: derived.queryParameters.reason,
        });
      }
      if (derived.verb !== operation.method.toLowerCase()) {
        throw new Error(
          `derived verb ${derived.verb} disagrees with manifest method ${operation.method} for ${handlerKey}`,
        );
      }
    }
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = finalEntry;
  }
  // A DERIVED HANDLER THAT REACHED NO OPERATION IS A ROUTE THE MANIFEST LOST.
  // The derivation walks the controllers and the manifest walks the decorators;
  // when they disagree the surface has a hole, and a generator that shrugged
  // would publish the smaller of the two.
  const orphaned = [...contract.handlers.keys()].filter((key) => !usedHandlerKeys.has(key));
  if (orphaned.length > 0) {
    throw new Error(`derived core-api handlers absent from the manifest: ${orphaned.join(", ")}`);
  }
  const schemas = { ...contract.components };
  const wireError = schemas.WireError;
  if (wireError === undefined) throw new Error("the derivation produced no WireError component");
  schemas.WireError = {
    ...wireError,
    properties: {
      ...wireError.properties,
      code: { ...wireError.properties.code, enum: canonicalErrorCodes() },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Platos Agent operation inventory",
      version: manifest.manifestVersion,
      description:
        "Generated from the canonical WIN-129 operation manifest. This document inventories Nest REST method/path bindings and their parity classification. WIN-267 W2: the V1 core-api operations additionally carry request and response schemas DERIVED FROM THE TYPESCRIPT TYPES of their handlers by scripts/rest-schema-derivation.mjs -- never from a hand-written table -- and every failure answers the ADR M0.4 section 2 envelope described by the ErrorEnvelope schema. Operations marked `x-platos-schema-source: undeclared` declare no wire DTO and carry no invented schema; see `x-platos-schema-coverage`. Mapped MCP JSON Schemas remain authoritative for MCP tools/list and tools/call.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    components: {
      schemas,
      securitySchemes: {
        sessionToken: {
          type: "apiKey",
          in: "header",
          name: "X-Platos-Session-Token",
          description: "Platform-issued scoped session token.",
        },
        directHeaders: {
          type: "apiKey",
          in: "header",
          name: "X-Platos-Organization-Id",
          description:
            "Trusted internal direct-header mode. Also requires X-Platos-Project-Id, X-Platos-Environment-Id, and X-Platos-User-Id and is rejected through the public proxy.",
        },
        platformMcpBearer: {
          type: "http",
          scheme: "bearer",
          description: "Persisted plt_mcp_ Platform MCP token (admin tier where required).",
        },
        entityBearer: {
          type: "http",
          scheme: "bearer",
          description: "Entity bearer used to mint a scoped session token.",
        },
        oauthBearer: {
          type: "http",
          scheme: "bearer",
          description: "OAuth 2.1 access token issued by this service.",
        },
        oauthClient: {
          type: "http",
          scheme: "basic",
          description: "OAuth client authentication where required by the protocol operation.",
        },
        consentSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Platos-Consent-Signature",
          description: "HMAC signature from the authenticated webapp consent action.",
        },
        internalAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Platos-Internal-Auth",
          description: "Deployment-managed internal callback credential or route-specific HMAC.",
        },
        channelProviderSignature: {
          type: "apiKey",
          in: "header",
          name: "X-Slack-Signature",
          description:
            "Provider signature (header varies by provider) plus the route's secret/credential checks.",
        },
        channelFlowNonce: {
          type: "apiKey",
          in: "query",
          name: "state",
          description: "Single-use OAuth/account-link state or nonce validated by the controller.",
        },
      },
    },
    paths,
    "x-platos-manifest-version": manifest.manifestVersion,
    "x-platos-rest-operation-count": manifest.summary.restOperations,
    "x-platos-mcp-tool-count": manifest.summary.mcpTools,
    "x-platos-schema-coverage": {
      derivedOperations: coverage.derived,
      undeclaredOperations: coverage.undeclared,
      undeclaredReason: UNDECLARED_SCHEMA_REASON,
      derivedFrom: "apps/core-api TypeScript handler types, via apps/agent/scripts/rest-schema-derivation.mjs",
      componentSchemas: Object.keys(schemas).length,
      canonicalErrorCodes: schemas.WireError.properties.code.enum.length,
      queryParametersNotDerived: coverage.queryNotDerived,
    },
  };
}

function writeOrCheck(path, content) {
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // Missing generated output is drift.
  }
  if (current === content) return true;
  if (checkOnly) {
    process.stderr.write(`[control-plane] generated artifact drift: ${relative(repoDir, path)}\n`);
    return false;
  }
  writeFileSync(path, content);
  process.stderr.write(`[control-plane] wrote ${relative(repoDir, path)}\n`);
  return true;
}

const manifest = buildManifest();
const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
const report = `${buildReport(manifest).trimEnd()}\n`;
const restContract = deriveRestContract({ repoDir });
const openApiDocument = buildOpenApi(manifest, restContract);
// THE DOCUMENT IS CHECKED BY AN AUTHORITY THIS REPOSITORY DID NOT WRITE before
// it is written. See `openapi-meta-schema.mjs`: a generator that also decided
// whether its own output was well-formed would be the assertion LESSON 1 names.
const validation = validateOpenApiDocument(openApiDocument);
if (!validation.valid) {
  process.stderr.write(
    `[control-plane] generated OpenAPI does not validate against the OpenAPI 3.1 meta-schema:\n${JSON.stringify(validation.errors, null, 2)}\n`,
  );
  process.exit(1);
}
const openApi = `${JSON.stringify(openApiDocument, null, 2)}\n`;
const ok =
  writeOrCheck(manifestPath, manifestJson) &&
  writeOrCheck(reportPath, report) &&
  writeOrCheck(openApiOutputPath, openApi);
if (!ok) process.exitCode = 1;
else
  process.stderr.write(
    `[control-plane] ${manifest.summary.mcpTools} MCP tools, ${manifest.summary.restOperations} REST operations\n`
  );
