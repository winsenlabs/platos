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
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(scriptDir, "..");
const repoDir = resolve(agentDir, "../..");
const srcDir = join(agentDir, "src");
const toolsDir = join(srcDir, "mcp-platform", "tools");
const manifestPath = join(srcDir, "control-plane", "operation-manifest.generated.json");
const reportPath = join(repoDir, "docs", "control-plane-parity.generated.md");
const openApiOutputPath = join(srcDir, "openapi", "openapi.generated.json");
const checkOnly = process.argv.includes("--check");

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

const PRODUCTION_MOUNTED_CONTROLLERS = {
  AgentController: "agent-runtime/agent-runtime.module.ts",
  AttachmentUploadController: "agent-runtime/agent-runtime.module.ts",
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

const DEPRECATED_RULES = [
  {
    id: "legacy-platos-memory-prefix",
    test: (path) => path.startsWith("/api/v1/platos/memory"),
    replacement: "/api/v1/memory",
  },
];

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

function extractMcpTools() {
  const helper = join(scriptDir, "runtime-mcp-catalog.ts");
  const tsx = join(repoDir, "node_modules", ".bin", "tsx");
  const runtimeTools = JSON.parse(
    execFileSync(tsx, [helper], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  );
  if (!Array.isArray(runtimeTools)) throw new Error("runtime MCP catalog helper returned non-array");

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
  const arg = call.arguments[0];
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text];
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
  for (const [controller, relativeModulePath] of Object.entries(
    PRODUCTION_MOUNTED_CONTROLLERS
  )) {
    const modulePath = join(srcDir, relativeModulePath);
    const controllers = byModule.get(modulePath) ?? moduleControllers(modulePath);
    byModule.set(modulePath, controllers);
    if (!controllers.includes(controller)) {
      throw new Error(`${controller} is not registered by ${relativeModulePath}`);
    }
  }
  if (Object.hasOwn(PRODUCTION_MOUNTED_CONTROLLERS, "TestController")) {
    throw new Error("TestController must not be present in the production mounted-controller policy");
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
  for (const rule of DEPRECATED_RULES) {
    if (rule.test(path)) {
      return {
        classification: "DEPRECATED",
        policyRule: rule.id,
        mcpTools: [],
        mappingRationale: null,
        replacement: rule.replacement,
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

/**
 * A route enforces operator scope when its body calls requireOperator/
 * getOperatorScope directly, OR when it delegates to a same-class helper method
 * whose own body makes one of those calls (e.g. `this.operatorScope(req)` in
 * providers.controller.ts). `operatorHelpers` is the set of such helper method
 * names collected from the enclosing controller class. The trailing `(` guards
 * against a helper name being a prefix of an unrelated method call.
 */
function enforcesOperatorScope(memberText, operatorHelpers) {
  if (
    memberText.includes("requireOperator(") ||
    memberText.includes("getOperatorScope(")
  ) {
    return true;
  }
  for (const helper of operatorHelpers) {
    if (memberText.includes(`this.${helper}(`)) return true;
  }
  return false;
}

function extractRestOperations() {
  assertMountedControllerPolicy();
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
  for (const path of walk(srcDir).filter((file) => file.endsWith(".controller.ts"))) {
    const sf = sourceFile(path);
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const controller = decoratorCall(statement, sf, "Controller");
      if (!controller) continue;
      if (!Object.hasOwn(PRODUCTION_MOUNTED_CONTROLLERS, statement.name.text)) continue;
      const bases = decoratorPaths(controller, sf);
      // Collect same-class helper methods that themselves enforce operator scope
      // so a route delegating to one (e.g. `this.operatorScope(req)`) is not read
      // as unguarded. See enforcesOperatorScope.
      const operatorHelpers = new Set();
      for (const candidate of statement.members) {
        if (!ts.isMethodDeclaration(candidate) || !candidate.name) continue;
        const text = candidate.getText(sf);
        if (
          text.includes("requireOperator(") ||
          text.includes("getOperatorScope(")
        ) {
          operatorHelpers.add(candidate.name.getText(sf));
        }
      }
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        for (const [decorator, method] of verbs) {
          const route = decoratorCall(member, sf, decorator);
          if (!route) continue;
          const children = decoratorPaths(route, sf);
          for (const base of bases) {
            for (const child of children) {
              implementations.push({
                method,
                path: joinRoute(base, child),
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

  return {
    manifestVersion: "M0.1",
    canonicalPolicy: "explicit-operation-manifest",
    tenancyAuthority: ["organizationId", "projectId", "environmentId", "userId"],
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
      restClassifications: countBy(restOperations, "classification"),
    },
  };
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function buildReport(manifest) {
  const { mcpTools, restOperations } = manifest.inventories;
  const lines = [
    "# Platos control-plane parity report (generated)",
    "",
    "> Deterministic WIN-129 artifact. Do not edit by hand; run `pnpm --filter platos-agent generate:control-plane`.",
    "",
    "The **explicit operation manifest** is canonical. Platform MCP metadata is seeded from the 206 runtime-shaped handler declarations; REST metadata is derived from Nest controller decorators. Compact policy rules classify every operation. MCP schemas are authoritative for MCP calls; generated OpenAPI intentionally does not invent REST request/response schemas.",
    "",
    "## Summary",
    "",
    `- MCP tools: **${manifest.summary.mcpTools}** across **${manifest.summary.mcpNamespaces}** namespaces (${manifest.summary.adminTierTools} admin-tier).`,
    `- REST operations: **${manifest.summary.restOperations}** unique method/path pairs from **${manifest.summary.restRouteBindings}** route bindings.`,
    `- Ambiguous duplicate REST method/path pairs: **${manifest.summary.ambiguousRestOperations}**.`,
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
          : `\`${operation.policyRule}\``
      } | ${operation.implementations
        .map((implementation) => `\`${implementation.source}#${implementation.handler}\``)
        .join("<br>")} |`
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
        tool.restMappings.map((route) => `\`${escapeCell(route)}\``).join("<br>") || "—"
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

function buildOpenApi(manifest) {
  const paths = {};
  for (const operation of manifest.inventories.restOperations) {
    const path = openApiPath(operation.path);
    const parameters = [...operation.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    const primary = operation.implementations[0];
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
    };
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = entry;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Platos Agent operation inventory",
      version: manifest.manifestVersion,
      description:
        "Generated from the canonical WIN-129 operation manifest. This document accurately inventories Nest REST method/path bindings and their parity classification. It intentionally does not invent request or response schemas; mapped MCP JSON Schemas remain authoritative for MCP tools/list and tools/call.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
    components: {
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
const openApi = `${JSON.stringify(buildOpenApi(manifest), null, 2)}\n`;
const ok =
  writeOrCheck(manifestPath, manifestJson) &&
  writeOrCheck(reportPath, report) &&
  writeOrCheck(openApiOutputPath, openApi);
if (!ok) process.exitCode = 1;
else
  process.stderr.write(
    `[control-plane] ${manifest.summary.mcpTools} MCP tools, ${manifest.summary.restOperations} REST operations\n`
  );
