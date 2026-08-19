import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifestJson from "../control-plane/operation-manifest.generated.json";
import openApiJson from "../openapi/openapi.generated.json";
import { buildPlatformToolHandlers } from "./tools";
import { MacroRecordingState } from "./tools/macros";
import { compileSchema } from "./schema-validator";
import { McpRouter, RPC_ERRORS, type McpToolHandler } from "./mcp-router";
import type { VerifiedToken } from "./token.service";

interface ManifestTool {
  name: string;
  namespace: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresAdminTier: boolean;
  category: string;
  aliases: string[];
}

interface ManifestRestOperation {
  id: string;
  method: string;
  path: string;
  classification: string;
  mcpTools: string[];
  mappingRationale: string | null;
}

const manifest = manifestJson as unknown as {
  manifestVersion: string;
  tenancyAuthority: string[];
  toolNamePolicy: { syntax: string; baseline: string };
  inventories: {
    mcpTools: ManifestTool[];
    restOperations: ManifestRestOperation[];
  };
  summary: {
    mcpTools: number;
    restOperations: number;
    adminTierTools: number;
  };
};

function inertDependency(): any {
  const callable = () => undefined;
  return new Proxy(callable, {
    get: () => inertDependency(),
    apply: () => undefined,
  });
}

function runtimeHandlers(overrides: Record<string, unknown> = {}): McpToolHandler[] {
  let router: McpRouter | null = null;
  const fixed = {
    macroState: new MacroRecordingState(),
    getRouter: () => router as McpRouter,
  };
  const deps = new Proxy(fixed as Record<string, unknown>, {
    get(target, property) {
      if (property in target) return target[property as string];
      const override = overrides[property as string];
      if (override !== undefined) return override;
      return inertDependency();
    },
  });
  const handlers = buildPlatformToolHandlers(deps as never);
  router = new McpRouter(
    { buildScope: (token) => ({ ...token.scope, userId: token.mintedByUserId }) },
    { resolve: async () => ({ state: "auto_allow", tier: 4, reason: "test" }) } as any
  );
  router.registerAll(handlers);
  return handlers;
}

const REPRESENTATIVE_REAL_TOOLS: Record<string, string> = {
  agents: "agents.canary.promote",
  alert_channels: "alert_channels.create",
  approvals: "approvals.get",
  artifacts: "artifacts.list",
  audit: "audit.safety_events.query",
  budgets: "budgets.delete",
  channel_apps: "channel_apps.bind_installation",
  channels: "channels.create",
  clusters: "clusters.add_agent",
  end_users: "end_users.bind_external_id",
  entities: "entities.regenerate_secret",
  environments: "environments.create",
  evals: "evals.get",
  events: "events.recent",
  gdpr: "gdpr.export",
  health: "health.check",
  kg: "kg.create_node",
  macros: "macros.delete",
  mcp: "mcp.list_clients",
  memories: "memories.archive",
  messages: "messages.list",
  monitoring: "monitoring.cost.daily",
  notifications: "notifications.delete",
  oauth: "oauth.create_client",
  org: "org.add_member",
  platos_tasks: "platos_tasks.create",
  platos: "platos.diff_agents",
  projects: "projects.list_all",
  providers: "providers.add_key",
  runs: "runs.get_trace",
  scopes: "scopes.bootstrap_demo_data",
  skills: "skills.disable",
  threads: "threads.create",
  traces: "traces.get",
  trigger: "trigger.batches.get",
};

const AUTHORITY = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "user-a",
  principal: "operator" as const,
};

// These representative handlers do not pass the complete Environment tuple to
// one dependency call: macros are token-local in-memory state, while the mcp
// inventory adapter uses an existing project-scoped AuthService contract, and
// projects.list_all is intentionally membership-scoped across the caller's
// organizations. They are covered by router scope pinning/schema rejection
// here, not claimed as full downstream database-tuple coverage.
const ROUTER_PINNED_NAMESPACES = new Set([
  "alert_channels",
  "macros",
  "mcp",
  "oauth",
  "org",
  "projects",
  "trigger",
]);

function strictScopedDependencies() {
  const canonicalTuples: unknown[] = [];
  const violations: string[] = [];

  function inspect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      "organizationId" in record &&
      "projectId" in record &&
      "environmentId" in record
    ) {
      if (record.organizationId !== AUTHORITY.organizationId)
        violations.push(`organizationId=${String(record.organizationId)}`);
      if (record.projectId !== AUTHORITY.projectId)
        violations.push(`projectId=${String(record.projectId)}`);
      if (record.environmentId !== AUTHORITY.environmentId)
        violations.push(`environmentId=${String(record.environmentId)}`);
      canonicalTuples.push(record);
    }
    for (const key of ["organizationId", "projectId", "environmentId"] as const) {
      const forged = { organizationId: "org-b", projectId: "project-b", environmentId: "env-b" };
      if (record[key] === forged[key]) {
        violations.push(`${key}=${String(record[key])}`);
      }
    }
    Object.values(record).forEach(inspect);
  }

  function dependency(path: string[] = []): any {
    const callable = (...args: unknown[]) => {
      // Audit payloads intentionally retain the caller's rejected/hostile raw
      // arguments for forensics; they are not database authority. Inspect only
      // operational dependency calls when enforcing canonical ancestry.
      if (!(path[0] === "toolAudit" && path.at(-1) === "record")) {
        args.forEach(inspect);
      }
      if (path.at(-1)?.match(/^(list|findMany|query|recent|search)/i)) return [];
      return undefined;
    };
    return new Proxy(callable, {
      get(_target, property) {
        return dependency([...path, String(property)]);
      },
      apply(_target, _thisArg, args) {
        return callable(...args);
      },
    });
  }

  return {
    deps: new Proxy({} as Record<string, unknown>, {
      get(_target, property) {
        return dependency([String(property)]);
      },
    }),
    canonicalTuples,
    violations,
  };
}

function representative(schema: any): unknown {
  if (Array.isArray(schema?.oneOf) && schema.oneOf.length > 0) {
    return representative(schema.oneOf[0]);
  }
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  const type = types.find((candidate: string) => candidate !== "null") ?? "null";
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        out[key] = representative(propertySchema);
      }
      return out;
    }
    case "array": {
      const length = Math.max(Number(schema.minItems ?? 0), schema.items ? 1 : 0);
      return Array.from({ length }, () => representative(schema.items ?? {}));
    }
    case "string": {
      if (schema.format === "email") return "operator@example.com";
      if (schema.format === "date-time") return "2026-08-19T00:00:00.000Z";
      const length = Math.max(1, Number(schema.minLength ?? 1));
      return "x".repeat(Math.min(length, Number(schema.maxLength ?? length)));
    }
    case "integer":
    case "number": {
      const minimum = Number(schema.minimum ?? 0);
      const maximum = Number(schema.maximum ?? minimum);
      return Math.min(Math.max(minimum, 0), maximum);
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return {};
  }
}

function schemaNodes(schema: any): any[] {
  const nodes = [schema];
  for (const property of Object.values(schema?.properties ?? {})) {
    nodes.push(...schemaNodes(property));
  }
  if (schema?.items) nodes.push(...schemaNodes(schema.items));
  for (const branch of schema?.oneOf ?? []) nodes.push(...schemaNodes(branch));
  return nodes;
}

function constraintInvalids(schema: any): Array<{ label: string; value: unknown }> {
  const valid = representative(schema);
  const cases: Array<{ label: string; value: unknown }> = [];
  if (schema.type !== undefined) {
    const accepted = new Set(Array.isArray(schema.type) ? schema.type : [schema.type]);
    const candidates: Array<{ type: string; value: unknown }> = [
      { type: "null", value: null },
      { type: "object", value: {} },
      { type: "array", value: [] },
      { type: "string", value: "x" },
      { type: "number", value: 1.5 },
      { type: "boolean", value: true },
    ];
    const invalidType = candidates.find((candidate) => !accepted.has(candidate.type));
    if (invalidType) cases.push({ label: "type", value: invalidType.value });
  }
  if (Array.isArray(schema.oneOf)) {
    cases.push({ label: "oneOf", value: "matches-no-branch" });
  }
  if (Array.isArray(schema.enum)) {
    cases.push({ label: "enum", value: "__not_in_enum__" });
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const missing = { ...(valid as Record<string, unknown>) };
    delete missing[schema.required[0]];
    cases.push({ label: "required", value: missing });
  }
  if (schema.additionalProperties === false) {
    cases.push({
      label: "additionalProperties",
      value: { ...(valid as Record<string, unknown>), __unknown_property__: true },
    });
  }
  if (typeof schema.minLength === "number") {
    cases.push({ label: "minLength", value: "x".repeat(Math.max(0, schema.minLength - 1)) });
  }
  if (typeof schema.maxLength === "number") {
    cases.push({ label: "maxLength", value: "x".repeat(schema.maxLength + 1) });
  }
  if (typeof schema.minimum === "number") {
    cases.push({ label: "minimum", value: schema.minimum - 1 });
  }
  if (typeof schema.maximum === "number") {
    cases.push({ label: "maximum", value: schema.maximum + 1 });
  }
  if (typeof schema.minItems === "number" && schema.minItems > 0) {
    cases.push({ label: "minItems", value: [] });
  }
  if (typeof schema.maxItems === "number") {
    cases.push({
      label: "maxItems",
      value: Array.from({ length: schema.maxItems + 1 }, () => representative(schema.items ?? {})),
    });
  }
  if (schema.format === "email" || schema.format === "date-time") {
    cases.push({ label: `format:${schema.format}`, value: "invalid" });
  }
  return cases;
}

function targetedInvalid(schema: any): unknown {
  const valid = representative(schema) as Record<string, unknown>;
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    const invalid = { ...valid };
    delete invalid[schema.required[0]];
    return invalid;
  }
  if (schema.additionalProperties === false) {
    return { ...valid, __unknown_property__: true };
  }
  // Every Platform MCP input schema declares an object root. This exercises
  // that constraint when there is no narrower required/additional-property one.
  return [];
}

function token(
  tier: "scope" | "admin",
  scope = { organizationId: "org-a", projectId: "project-a", environmentId: "env-a" }
): VerifiedToken {
  return {
    id: `token-${tier}`,
    scope,
    permissions: ["*"],
    mintedByUserId: "user-a",
    expiresAt: null,
    tier,
  };
}

function testRouter(): McpRouter {
  return new McpRouter(
    {
      buildScope: (verified, userId) => ({
        organizationId: verified.scope.organizationId,
        projectId: verified.scope.projectId,
        environmentId: verified.scope.environmentId,
        userId: userId ?? verified.mintedByUserId,
      }),
    },
    { resolve: async () => ({ state: "auto_allow", tier: 4, reason: "test" }) } as any
  );
}

describe("WIN-129 canonical control-plane contract", () => {
  it("matches the exact runtime Platform MCP inventory and M0.1 names", () => {
    const handlers = runtimeHandlers().sort((a, b) => a.name.localeCompare(b.name));
    const generated = manifest.inventories.mcpTools;

    expect(handlers).toHaveLength(206);
    expect(manifest.summary.mcpTools).toBe(206);
    expect(new Set(handlers.map((handler) => handler.name)).size).toBe(206);
    expect(handlers.map((handler) => handler.name)).toEqual(generated.map((tool) => tool.name));

    for (let index = 0; index < handlers.length; index++) {
      const handler = handlers[index]!;
      const tool = generated[index]!;
      expect(handler.description, tool.name).toBe(tool.description);
      expect(handler.inputSchema, tool.name).toEqual(tool.inputSchema);
      expect(handler.requiresAdminTier === true, tool.name).toBe(tool.requiresAdminTier);
      expect(handler.category, tool.name).toBe(tool.category);
      expect(tool.aliases, tool.name).toEqual([]);
    }

    const namePattern = new RegExp(manifest.toolNamePolicy.syntax);
    expect(manifest.toolNamePolicy.baseline).toBe("existing-dotted-206");
    expect(generated.every((tool) => namePattern.test(tool.name))).toBe(true);
  });

  it("accepts representative valid input and rejects invalid input for every tool schema", () => {
    for (const tool of manifest.inventories.mcpTools) {
      const validate = compileSchema(tool.inputSchema);
      const valid = representative(tool.inputSchema);
      expect(validate(valid), `${tool.name} valid representative`).toEqual({
        valid: true,
        errors: [],
      });
      expect(
        validate(targetedInvalid(tool.inputSchema)).valid,
        `${tool.name} invalid representative`
      ).toBe(false);

      // Exercise every emitted constraint, including constraints nested under
      // optional properties. Compiling each node uses the same validator code
      // the router precompiles for the complete tool schema.
      for (const node of schemaNodes(tool.inputSchema)) {
        const validateNode = compileSchema(node);
        expect(validateNode(representative(node)).valid, `${tool.name} nested valid`).toBe(true);
        for (const invalid of constraintInvalids(node)) {
          expect(validateNode(invalid.value).valid, `${tool.name} ${invalid.label}`).toBe(false);
        }
      }
    }
  });

  it("exercises representative real handlers and records downstream scope isolation by namespace", async () => {
    const namespaces = [...new Set(manifest.inventories.mcpTools.map((tool) => tool.namespace))].sort();
    expect(namespaces).toHaveLength(35);
    expect(Object.keys(REPRESENTATIVE_REAL_TOOLS).sort()).toEqual(namespaces);

    for (const namespace of namespaces) {
      const toolName = REPRESENTATIVE_REAL_TOOLS[namespace]!;
      const manifestTool = manifest.inventories.mcpTools.find((tool) => tool.name === toolName)!;
      const strict = strictScopedDependencies();
      const handlers = runtimeHandlers(strict.deps);
      const handler = handlers.find((candidate) => candidate.name === toolName)!;
      const forgedArguments = {
        ...(representative(manifestTool.inputSchema) as Record<string, unknown>),
        organizationId: "org-b",
        projectId: "project-b",
        environmentId: "env-b",
        userId: "user-b",
      };

      // Call the actual handler with hostile transport-like ancestry keys.
      // Real router schema validation rejects unknown keys first; this direct
      // call additionally proves handlers pass the separate token-pinned scope
      // to dependencies rather than treating argument ancestry as authority.
      await handler
        .execute(
          forgedArguments,
          AUTHORITY,
          token(manifestTool.requiresAdminTier ? "admin" : "scope")
        )
        .catch(() => undefined);
      expect(strict.violations, `${namespace}:${toolName}`).toEqual([]);
      if (!ROUTER_PINNED_NAMESPACES.has(namespace)) {
        expect(strict.canonicalTuples.length, `${namespace}:${toolName}`).toBeGreaterThan(0);
      }
    }
    expect(manifest.tenancyAuthority).toEqual([
      "organizationId",
      "projectId",
      "environmentId",
      "userId",
    ]);
  });

  it("hides and rejects every generated admin-tier tool for scope-tier tokens", async () => {
    const router = testRouter();
    const executed = new Set<string>();
    for (const tool of manifest.inventories.mcpTools) {
      router.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresAdminTier: tool.requiresAdminTier,
        async execute() {
          executed.add(tool.name);
          return { ok: true };
        },
      });
    }

    const adminTools = manifest.inventories.mcpTools.filter((tool) => tool.requiresAdminTier);
    expect(adminTools).toHaveLength(24);
    expect(manifest.summary.adminTierTools).toBe(24);

    const listed = await router.handle(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      token("scope")
    );
    const listedNames = new Set(
      (listed.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
    );
    for (const tool of adminTools) {
      expect(listedNames.has(tool.name), tool.name).toBe(false);
      const response = await router.handle(
        {
          jsonrpc: "2.0",
          id: tool.name,
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: representative(tool.inputSchema) as Record<string, unknown>,
          },
        },
        token("scope")
      );
      expect(response.error?.code, tool.name).toBe(RPC_ERRORS.PERMISSION_DENIED);
    }
    expect(executed.size).toBe(0);
  });

  it("keeps the generated manifest, parity report, and OpenAPI inventory drift-free", () => {
    execFileSync(
      process.execPath,
      [resolve(__dirname, "../../scripts/generate-control-plane.mjs"), "--check"],
      {
        cwd: resolve(__dirname, "../../../.."),
        stdio: "pipe",
      }
    );

    const openApi = openApiJson as unknown as { paths: Record<string, Record<string, unknown>> };
    const operationCount = Object.values(openApi.paths).reduce(
      (count, pathItem) => count + Object.keys(pathItem).length,
      0
    );
    expect(operationCount).toBe(manifest.summary.restOperations);
    expect(manifest.inventories.restOperations).toHaveLength(manifest.summary.restOperations);
    expect(manifest.inventories.restOperations.some((operation) => operation.path.startsWith("/test"))).toBe(false);
    for (const operation of manifest.inventories.restOperations) {
      const path = operation.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      expect(openApi.paths[path]?.[operation.method.toLowerCase()], operation.id).toBeDefined();
      expect(["MAPPED", "REST_ONLY", "INTERNAL", "PUBLIC_TRANSPORT", "DEPRECATED"]).toContain(
        operation.classification
      );
      if (operation.classification === "MAPPED") {
        expect(operation.mappingRationale?.trim(), operation.id).toBeTruthy();
      }
      const openApiOperation = openApi.paths[path]?.[operation.method.toLowerCase()] as
        | Record<string, unknown>
        | undefined;
      expect(openApiOperation?.["security"], `${operation.id} security`).toBeDefined();
      expect(openApiOperation?.["x-platos-auth-class"], `${operation.id} auth`).toBeDefined();
      expect(openApiOperation?.["x-platos-implementations"], operation.id).toBeUndefined();
    }

    const falseEquivalences = [
      "GET /api/health",
      "GET /api/v1/agent/budgets/status",
      "GET /api/v1/agent/monitoring/cost",
      "GET /api/v1/agent/monitoring/cost/skills/daily",
      "GET /api/v1/agent/monitoring/cost/skills/range",
      "POST /api/v1/agent/golden-sets/:goldenSetId/run",
      "GET /api/v1/agent/providers/:provider/health",
      "POST /api/v1/agent/admin/privacy/erasures",
      "GET /api/v1/agent/admin/privacy/subjects/:externalUserId/inventory",
      "POST /api/v1/agent/skills",
      "POST /api/v1/memory/:id",
      "PATCH /api/v1/agent/entities/:entityId/mcp/config",
      "GET /api/v1/agent/files/threads/:threadId/attachments",
    ];
    for (const id of falseEquivalences) {
      expect(manifest.inventories.restOperations.find((operation) => operation.id === id)?.mcpTools, id).toEqual([]);
    }
  });
});
