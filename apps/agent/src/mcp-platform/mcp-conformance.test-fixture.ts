/**
 * WIN-268 (M4.2) — THE THREE PLATOS MCP SERVERS, ON A REAL SOCKET, OVER A REAL
 * DATABASE AND A REAL REDIS, WITH NOTHING UNDER TEST REPLACED.
 *
 * Shared by `mcp-protocol-conformance.integration.test.ts` (in-process) and by
 * `mcp-sse-node.test-fixture.ts` (the child process the two-node suite starts
 * twice). `*.test-fixture.ts` is excluded from `tsconfig.build.json`, so none of
 * this reaches the agent image.
 *
 * WHAT IS REAL. The three controllers (`McpPlatformController`,
 * `McpEntityController`, `DocsMcpController`) mounted by Nest itself, so the
 * route table, `@HttpCode`, the body parser and the exception filter are the
 * framework's and not a reading of it; the production `ScopeGuard` as the
 * global guard, so a transport it would refuse is refused here too; the version
 * expression from `http/api-surface.ts`; and every service the PROTOCOL path
 * reads — token verification, the permission gateway, OAuth and PAT
 * revalidation, the per-entity ACL, the tool registry and router, the docs
 * repository — constructed over a PostgreSQL schema built by the canonical
 * migrations and an ioredis client configured exactly as `redis.provider.ts`.
 *
 * WHAT IS NOT, AND WHY IT CANNOT LIE. `McpPlatformController` takes forty
 * constructor arguments because its ~200 tool handlers close over them. The
 * services only a TOOL BODY reaches are supplied as `unreachable(name)`: a proxy
 * that THROWS on first use. A double that answered would be a double that could
 * make a conformance case pass; one that throws can only make it fail, and
 * loudly, naming the service the protocol path was not supposed to need.
 *
 * WHY THE INJECTION TOKENS ARE READ OUT OF THE CONTROLLER SOURCE. Vitest and
 * tsx compile with esbuild, which does not emit `design:paramtypes`, so Nest
 * cannot see a constructor's types. Writing the forty tokens down here would be
 * a second copy of the constructor that could drift out of order and still
 * boot — two services swapped is not an error Nest can detect. So the tokens are
 * READ from each controller's constructor with the TypeScript compiler, and a
 * token the table below cannot resolve is a thrown error rather than a guess.
 */

import "reflect-metadata";

import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { Module, type INestApplication, type Type } from "@nestjs/common";
import { APP_GUARD, ModuleRef, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { CredentialRootKeyRing, PlatosSecretStore, PrismaClient } from "@platos/tenancy-database";
import Redis from "ioredis";
import ts from "typescript";

import { AgentClusterService } from "../agent-runtime/agent-cluster.service";
import { AgentCrudService } from "../agent-runtime/agent-crud.service";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import { EnvironmentService } from "../admin/environment.service";
import { OrganizationService } from "../admin/organization.service";
import { AuthService } from "../auth/auth.service";
import { ProviderHealthService } from "../auth/provider-health.service";
import { ScopeGuard } from "../auth/scope.guard";
import { ChannelPersistenceService } from "../channels/channel-persistence.service";
import { EvalService } from "../evals/eval.service";
import { GoldenSetService } from "../evals/golden-set.service";
import { RatingService } from "../evals/rating.service";
import { ConversationService } from "../memory/conversation.service";
import { KnowledgeGraphService } from "../memory/knowledge-graph.service";
import { MemoryExtractionService } from "../memory/memory-extraction.service";
import { MemoryImportService } from "../memory/memory-import.service";
import { MemoryService } from "../memory/memory.service";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { BudgetService } from "../monitoring/budget.service";
import { CostService } from "../monitoring/cost.service";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { SpansService } from "../monitoring/spans.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { TraceService } from "../monitoring/trace.service";
import { ProviderKeyService } from "../providers/provider-key.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { SkillImporterService } from "../skills/skill-importer.service";
import { SkillRegistryService } from "../skills/skill-registry.service";
import { EntityMcpDiscoveryService } from "../tool-gateway/mcp-transport/entity-mcp-discovery.service";
import { McpEventsService } from "./events.service";
import { applyApiSurface } from "../http/api-surface";
import { DocsMcpController } from "../mcp-docs/docs-mcp.controller";
import { DocsMcpService } from "../mcp-docs/docs-mcp.service";
import { OAuthService } from "../oauth/oauth.service";
import { PLATOS_SECRET_STORE_TOKEN, PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import { ToolRouterService } from "../tool-gateway/tool-router.service";
import { McpIdentityResolverService } from "./identity-resolver.service";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import { McpEntityController } from "./mcp-entity.controller";
import { McpPlatformController } from "./mcp-platform.controller";
import { McpToolAclService } from "./mcp-tool-acl.service";
import { MCPPermissionGatewayService } from "./permission-gateway.service";
import { PlatosMCPTokenService } from "./token.service";

// ---------------------------------------------------------------------------
// LOCATIONS, resolved from the agent package root the way the sibling
// PostgreSQL suites do (vitest runs with that directory as its cwd; the child
// process is started with it too).

export function agentRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith("apps/agent") ? cwd : resolve(cwd, "apps/agent");
}

const MIGRATIONS_ROOT = () =>
  resolve(agentRoot(), "../../internal-packages/tenancy-database/prisma/migrations");

// ---------------------------------------------------------------------------
// DATABASE — one private schema per suite, built by EVERY canonical migration,
// dropped afterwards. The same construction the forged-scope suite uses.

export interface PrivateSchema {
  readonly schemaName: string;
  readonly url: string;
  readonly prisma: PrismaClient;
  drop(): Promise<void>;
}

export async function openPrivateSchema(baseUrl: string, label: string): Promise<PrivateSchema> {
  const { Client } = require("pg") as { Client: new (options: unknown) => any };
  const schemaName = `${label}_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  const migrations = readdirSync(MIGRATIONS_ROOT(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const migration of migrations) {
    await admin.query(
      readFileSync(resolve(MIGRATIONS_ROOT(), migration, "migration.sql"), "utf8").replaceAll(
        '"public"',
        `"${schemaName}"`,
      ),
    );
  }
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schemaName);
  const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  return {
    schemaName,
    url: url.toString(),
    prisma,
    async drop() {
      await prisma.$disconnect().catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    },
  };
}

/** An existing private schema, reopened by a second process. */
export function attachPrivateSchema(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

// ---------------------------------------------------------------------------
// REDIS — configured as `shared/redis.provider.ts` configures it. The suite
// reads that file and requires the prefix below to be the one it spells, so a
// changed prefix fails a named case instead of silently testing another shape.

export const REDIS_KEY_PREFIX = "platos:";

export function redisClient(url: string): Redis {
  const parsed = new URL(url);
  return new Redis({
    host: parsed.hostname,
    port: Number.parseInt(parsed.port || "6379", 10),
    password: parsed.password || undefined,
    keyPrefix: REDIS_KEY_PREFIX,
    retryStrategy: (times: number) => Math.min(times * 50, 1000),
    maxRetriesPerRequest: 20,
  });
}

// ---------------------------------------------------------------------------
// SEEDING — one tenant with an operator, a platform MCP token, and one entity
// exposing one tool through a PAT. Every row is written by the service that owns
// it in production where one exists.

export interface SeededTenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly userId: string;
  readonly platformToken: string;
  readonly entity: {
    readonly entityPk: string;
    readonly entityId: string;
    readonly pat: string;
    readonly exposedTool: string;
    readonly hiddenTool: string;
  };
}

export const CONFORMANCE_ENTITY_ID = "conformance-backend";
export const CONFORMANCE_EXPOSED_TOOL = "invoices.list";
export const CONFORMANCE_HIDDEN_TOOL = "invoices.void";

export async function seedTenant(prisma: PrismaClient, label: string): Promise<SeededTenant> {
  const user = await prisma.user.create({
    data: { email: `${label}@conformance.test.invalid`, displayName: `${label} operator` },
  });
  const organization = await prisma.organization.create({
    data: { slug: label.replaceAll("_", "-"), name: `${label} org` },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: "OWNER" },
  });
  const project = await prisma.project.create({
    data: { organizationId: organization.id, slug: label.replaceAll("_", "-"), name: `${label} project` },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, slug: "development", name: "Development" },
  });

  const minted = await new PlatosMCPTokenService(prisma).mint({
    scope: {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      userId: user.id,
    },
    name: "conformance",
    permissions: ["*"],
    ttlSeconds: 3600,
  });

  const entity = await prisma.entity.create({
    data: {
      projectId: project.id,
      externalId: CONFORMANCE_ENTITY_ID,
      displayName: "Conformance backend",
      connectionStatus: "disconnected",
      connectionKind: "wire",
    },
  });
  await prisma.entityMcpConfig.create({
    data: { entityId: entity.id, enabled: true, identityMode: "bearer", rateLimitPerMinute: 1000 },
  });
  const registry = new ToolRegistryService(prisma);
  await registry.registerTools(
    {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      entityPk: entity.id,
      sourceEntityId: CONFORMANCE_ENTITY_ID,
    },
    [
      {
        name: CONFORMANCE_EXPOSED_TOOL,
        description: "List invoices",
        paramSchema: {
          type: "object",
          properties: { limit: { type: "integer" } },
          additionalProperties: false,
        },
        category: "billing",
      },
      {
        name: CONFORMANCE_HIDDEN_TOOL,
        description: "Void an invoice",
        paramSchema: { type: "object", properties: { id: { type: "string" } } },
        category: "billing",
      },
    ],
    // No entity signing credential is seeded, so the executor resolves this
    // route and refuses to dispatch it before any socket is opened. That refusal
    // is the tool-failure shape the conformance suite reads off the entity
    // server; the callback is never contacted.
    "http://127.0.0.1:9/conformance-callback",
  );
  const exposed = await prisma.tool.findFirstOrThrow({
    where: { name: CONFORMANCE_EXPOSED_TOOL },
    select: { id: true },
  });
  await new McpToolAclService(prisma).upsert(
    entity.id,
    environment.id,
    exposed.id,
    CONFORMANCE_EXPOSED_TOOL,
    user.id,
    { exposed: true },
  );
  const pat = await new McpBearerTokenService(prisma).generate(
    entity.id,
    environment.id,
    "conformance",
    user.id,
  );

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    userId: user.id,
    platformToken: minted.token,
    entity: {
      entityPk: entity.id,
      entityId: CONFORMANCE_ENTITY_ID,
      pat: pat.raw,
      exposedTool: CONFORMANCE_EXPOSED_TOOL,
      hiddenTool: CONFORMANCE_HIDDEN_TOOL,
    },
  };
}

// ---------------------------------------------------------------------------
// THE UNREACHABLE SERVICE

const INTROSPECTED_BY_THE_FRAMEWORK = new Set<string>([
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
  "then",
  "constructor",
  "toJSON",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
  "inspect",
]);

export function unreachable(name: string): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || INTROSPECTED_BY_THE_FRAMEWORK.has(property)) return undefined;
        throw new Error(
          `conformance harness: ${name}.${property} was reached. Only a tool body needs ${name}; ` +
            "the protocol path under test must not.",
        );
      },
    },
  );
}

// ---------------------------------------------------------------------------
// CONSTRUCTOR TOKENS, READ FROM SOURCE

/**
 * The injection token of every constructor parameter of `className` in `file`,
 * in order: the argument of `@Inject(X)` where one is written, the parameter's
 * type name otherwise.
 */
export function constructorTokenNames(file: string, className: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  let names: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      const constructor = node.members.find(ts.isConstructorDeclaration);
      if (!constructor) throw new Error(`${className} in ${file} has no constructor`);
      names = constructor.parameters.map((parameter) => {
        for (const decorator of ts.getDecorators(parameter) ?? []) {
          const call = decorator.expression;
          if (
            ts.isCallExpression(call) &&
            ts.isIdentifier(call.expression) &&
            call.expression.text === "Inject" &&
            call.arguments[0]
          ) {
            return call.arguments[0].getText(source);
          }
        }
        const type = parameter.type;
        if (type && ts.isTypeReferenceNode(type)) return type.typeName.getText(source);
        throw new Error(`${className} parameter ${parameter.name.getText(source)} has no injectable token`);
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (names === null) throw new Error(`class ${className} not found in ${file}`);
  return names;
}

function bindConstructorTokens(
  controller: Type<unknown>,
  file: string,
  table: ReadonlyMap<string, unknown>,
): string[] {
  const names = constructorTokenNames(file, controller.name);
  if (names.length !== controller.length) {
    throw new Error(
      `${controller.name}: source declares ${String(names.length)} parameters, the class ${String(controller.length)}`,
    );
  }
  const tokens = names.map((name) => {
    if (!table.has(name)) throw new Error(`${controller.name}: no provider token for ${name}`);
    return table.get(name);
  });
  Reflect.defineMetadata("design:paramtypes", tokens, controller);
  return names;
}

/**
 * The services only a TOOL BODY reaches. `ChannelPersistenceService` is here
 * because `McpPlatformController.getRouter()` resolves it through `ModuleRef`
 * with `strict: false`, which throws when the container has no such provider.
 */
const TOOL_BODY_SERVICES: readonly Type<unknown>[] = [
  AgentClusterService,
  AgentCrudService,
  AgentTaskService,
  AuthService,
  BudgetService,
  ChannelPersistenceService,
  ConversationService,
  CostService,
  EntityMcpDiscoveryService,
  EnvironmentService,
  EvalService,
  GoldenSetService,
  KnowledgeGraphService,
  McpEventsService,
  MemoryExtractionService,
  MemoryImportService,
  MemoryService,
  MessageCryptoService,
  MonitoringApprovalsService,
  OrganizationService,
  ProviderHealthService,
  ProviderKeyService,
  ProviderRegistryService,
  RatingService,
  SafetyEventService,
  ScopedEnvService,
  SkillImporterService,
  SkillRegistryService,
  SpansService,
  ToolAuditService,
  TraceService,
];

// ---------------------------------------------------------------------------
// THE SERVERS

export interface McpServersOptions {
  readonly prisma: PrismaClient;
  readonly redisUrl: string;
  /** Called before every `PUBLISH` the servers send, in send order. */
  readonly onPublish?: (channel: string, message: string) => void;
}

export interface RunningMcpServers {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly redis: Redis;
  readonly registry: ToolRegistryService;
  /** Every constructor token the harness bound, per controller, for the suite to pin. */
  readonly boundTokens: Readonly<Record<string, readonly string[]>>;
  close(): Promise<void>;
}

export async function startMcpServers(options: McpServersOptions): Promise<RunningMcpServers> {
  const { prisma } = options;
  const redis = redisClient(options.redisUrl);
  if (options.onPublish) {
    const publish = redis.publish.bind(redis) as (channel: string, message: string) => Promise<number>;
    (redis as unknown as { publish: typeof publish }).publish = (channel: string, message: string) => {
      options.onPublish?.(channel, message);
      return publish(channel, message);
    };
  }

  const secretStore = new PlatosSecretStore(
    prisma,
    new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: "44".repeat(32) } }),
  );
  const registry = new ToolRegistryService(prisma, redis);
  await registry.rebuildIndex();
  const bearerTokens = new McpBearerTokenService(prisma);
  const real = new Map<unknown, unknown>([
    [PlatosMCPTokenService, new PlatosMCPTokenService(prisma)],
    [MCPPermissionGatewayService, new MCPPermissionGatewayService(prisma)],
    [OAuthService, new OAuthService(prisma)],
    [McpBearerTokenService, bearerTokens],
    [McpIdentityResolverService, new McpIdentityResolverService(prisma, bearerTokens)],
    [McpToolAclService, new McpToolAclService(prisma)],
    [ToolRegistryService, registry],
    [ToolRouterService, new ToolRouterService(registry)],
    [ToolExecutorService, new ToolExecutorService(prisma, registry)],
    [DocsMcpService, new DocsMcpService(redis)],
    [PRISMA_TOKEN, prisma],
    [PLATOS_SECRET_STORE_TOKEN, secretStore],
    [REDIS_TOKEN, redis],
  ]);

  const agentSource = resolve(agentRoot(), "src");
  const tokenTable = new Map<string, unknown>([
    ["ModuleRef", ModuleRef],
    ["PRISMA_TOKEN", PRISMA_TOKEN],
    ["PLATOS_SECRET_STORE_TOKEN", PLATOS_SECRET_STORE_TOKEN],
    ["REDIS_TOKEN", REDIS_TOKEN],
    ...[...real.keys()]
      .filter((key): key is Type<unknown> => typeof key === "function")
      .map((key) => [key.name, key] as [string, unknown]),
    ...TOOL_BODY_SERVICES.map((service) => [service.name, service] as [string, unknown]),
  ]);
  const boundTokens = {
    McpPlatformController: bindConstructorTokens(
      McpPlatformController,
      resolve(agentSource, "mcp-platform/mcp-platform.controller.ts"),
      tokenTable,
    ),
    McpEntityController: bindConstructorTokens(
      McpEntityController,
      resolve(agentSource, "mcp-platform/mcp-entity.controller.ts"),
      tokenTable,
    ),
    DocsMcpController: bindConstructorTokens(
      DocsMcpController,
      resolve(agentSource, "mcp-docs/docs-mcp.controller.ts"),
      tokenTable,
    ),
  };

  const providers = [
    ...[...real.entries()].map(([provide, useValue]) => ({ provide: provide as never, useValue })),
    // Tool bodies only. See `unreachable`.
    ...TOOL_BODY_SERVICES.filter((service) => !real.has(service)).map((service) => ({
      provide: service,
      useValue: unreachable(service.name),
    })),
    { provide: APP_GUARD, useValue: new ScopeGuard() },
  ];

  @Module({
    controllers: [McpPlatformController, McpEntityController, DocsMcpController],
    providers,
  })
  class ConformanceModule {}

  const app = await NestFactory.create<NestExpressApplication>(ConformanceModule, {
    bodyParser: false,
    rawBody: true,
    logger: false,
  });
  // `main.ts` order: the version expression, then the parsers.
  applyApiSurface(app);
  app.useBodyParser("json", { limit: "15mb" });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;

  return {
    app,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    redis,
    registry,
    boundTokens,
    async close() {
      const server = app.getHttpServer() as { closeAllConnections?: () => void };
      server.closeAllConnections?.();
      await app.close().catch(() => undefined);
      await registry.onModuleDestroy().catch(() => undefined);
      redis.disconnect();
    },
  };
}
