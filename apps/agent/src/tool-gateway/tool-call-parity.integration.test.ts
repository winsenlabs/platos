/**
 * WIN-269 (M4.3) — ONE TOOL CALL, FOUR ENTRY POINTS, ONE OUTCOME.
 *
 * THE CLAUSE: tool calls behave identically in direct, durable and channel
 * turns. Every entry point reaches `ToolExecutorService`, and nothing compared
 * them. This suite sends the SAME call through each and requires the same
 * status, result and error, the same `ToolCallAudit` row and the same
 * `ToolHealth` movement, for a call that succeeds and one that fails, on a WIRE
 * entity (HMAC-signed HTTP callback) and on an MCP entity (the pooled SDK client
 * over Streamable HTTP):
 *
 *   (a) EXECUTE-BATCH — the exact call `AgentService`'s `execute_tools` and its
 *       direct tool exposure make: `executeBatch(calls, scope, { source:
 *       "agent_turn", endUserId })`.
 *   (b) INTERNAL-EXECUTE-TOOL — `POST /internal/execute-tool` on a real socket
 *       through Nest and the production `ScopeGuard`, with the HMAC body built
 *       the way the agent-tool-block durable task builds it
 *       (`JSON.stringify(body) + timestamp`). This is the durable callback.
 *   (c) TURN-DISPATCH, DIRECT — `TurnDispatchService.collectTurn`, the channel
 *       runtime's entry, over the REAL `AgentTaskService` and `AgentService`
 *       (neither modified; M3.1 owns them) driven by an OpenAI-compatible model
 *       fixture that asks for the tool through `execute_tools`. What the model is
 *       handed back is what is compared.
 *   (d) TURN-DISPATCH, DURABLE — the same call for an agent whose binding says
 *       `executionMode: "durable"`. `resolveMode` reads that from PostgreSQL and
 *       answers "durable"; the turn then STOPS where D7's gap is. See
 *       `DURABLE_ARM_GAP` below — this arm proves the fallback, not durable
 *       execution, and says so in its own name.
 *
 * WHAT IS REAL: PostgreSQL (every canonical migration, a private schema),
 * Redis, the entities registered by `AuthService.registerEntity` (so the wire
 * entity's ENTITY_SECRET is a real sealed credential), tools registered by
 * `ToolRegistryService.registerTools`, audit rows by `ToolAuditService`, the
 * credential resolver and the MCP connection pool, three listeners on real
 * sockets (the wire backend verifies the HMAC signature it receives; the MCP
 * backend is the SDK's own server; the model is an HTTP fixture).
 *
 * THE ONE SUBSTITUTION, AND ITS CONTROL. `shared/url-validator.ts` refuses every
 * loopback address by design, and a listener in a test cannot have a public one.
 * The mock below admits EXACTLY the origins this suite's two backends bind, and
 * delegates every other URL to the real screen. The last case runs the real
 * screen over a fixture origin and requires it to refuse — so the admission
 * cannot quietly widen into "the screen is off".
 *
 * GATED: `TOOL_CALL_PARITY_REQUIRED=1` turns an absent PostgreSQL or Redis into
 * a failure; the CI job that walks this directory sets it.
 */

import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CredentialKind,
  CredentialRootKeyRing,
  ModelRateSource,
  PlatosSecretStore,
  type PrismaClient,
} from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Admitted loopback origins, filled once the backends have bound their ports.
const admitted = vi.hoisted(() => {
  // The durable arm needs `resolveMode` to READ the binding, which it only does
  // when the external durable runtime is configured at module load. Nothing is ever sent to
  // this address: `driveSession`'s pre-commit gate returns first (see
  // DURABLE_ARM_GAP), and the port is one nothing listens on.
  process.env.TRIGGER_API_URL = "http://127.0.0.1:9";
  process.env.TRIGGER_SECRET_KEY = "tr_parity_suite_not_a_key";
  return new Set<string>();
});

vi.mock("../shared/url-validator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/url-validator")>();
  const { fetch: undiciFetch } = await import("undici");
  const isAdmitted = (raw: string) => {
    try {
      return admitted.has(new URL(raw).origin);
    } catch {
      return false;
    }
  };
  return {
    ...actual,
    validatePublicUrl: async (raw: string, options?: { allowHttp?: boolean }) =>
      isAdmitted(raw) ? { ok: true as const, url: new URL(raw) } : actual.validatePublicUrl(raw, options),
    fetchWithValidatedRedirects: async (raw: string, maxRedirects?: number, init: RequestInit = {}) =>
      isAdmitted(raw)
        ? ((await undiciFetch(raw, { ...(init as object), redirect: "manual" } as never)) as unknown as Response)
        : actual.fetchWithValidatedRedirects(raw, maxRedirects, init),
  };
});

import { AgentService, type AgentStreamEvent } from "../agent-runtime/agent.service";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import { TurnDispatchService } from "../agent-runtime/turn-dispatch.service";
import { AuthService } from "../auth/auth.service";
import { ScopeGuard } from "../auth/scope.guard";
import { ConversationService } from "../memory/conversation.service";
import {
  constructorTokenNames,
  openPrivateSchema,
  redisClient,
  unreachable,
  type PrivateSchema,
} from "../mcp-platform/mcp-conformance.test-fixture";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { ModelCatalogService } from "../providers/model-catalog.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { PLATOS_SECRET_STORE_TOKEN, PRISMA_TOKEN } from "../shared/database.provider";
import { env } from "../shared/env";
import { validatePublicUrl as screenedUrl } from "../shared/url-validator";
import { InternalExecuteToolController } from "../trigger-bridge/internal-execute-tool.controller";

/**
 * Where `InternalExecuteToolController` is declared, for its constructor tokens:
 * the ONE file of that name under the agent source, found rather than spelled.
 */
function internalControllerSource(): string {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "internal-execute-tool.controller.ts") found.push(full);
    }
  };
  walk(join(process.cwd(), "src"));
  if (found.length !== 1) throw new Error(`expected one internal-execute-tool controller source, found ${String(found.length)}`);
  return found[0]!;
}
import { McpConnectionPool } from "./mcp-transport/mcp-client-pool.service";
import { McpCredentialService } from "./mcp-transport/mcp-credential.service";
import { ToolExecutorService } from "./tool-executor.service";
import { ToolRegistryService } from "./tool-registry.service";

const baseDatabaseUrl =
  process.env.TOOL_CALL_PARITY_TEST_DATABASE_URL ?? process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;
const redisUrl = process.env.TOOL_CALL_PARITY_TEST_REDIS_URL ?? process.env.PLATOS_TEST_REDIS_URL;

if (process.env.TOOL_CALL_PARITY_REQUIRED === "1" && (!baseDatabaseUrl || !redisUrl)) {
  throw new Error(
    "TOOL_CALL_PARITY_REQUIRED=1 but PLATOS_POSTGRES_INTEGRATION_DATABASE_URL and PLATOS_TEST_REDIS_URL are not both set",
  );
}

const describeWithServices = baseDatabaseUrl && redisUrl ? describe : describe.skip;

/**
 * D7 — WHERE THE DURABLE ARM STOPS, stated once so the case that exercises it
 * and the report that cites it cannot disagree.
 */
export const DURABLE_ARM_GAP =
  "executionMode \"durable\" routes TurnDispatchService.collectTurn to collectSession -> driveSession, which " +
  "needs PLATOS_CHAT_SESSIONS=true, a configured external durable runtime and its sessions service " +
  "(`platos.chat.session`). @platos/adapter-durable-runtime does not adapt that supplier yet (D7), so " +
  "driveSession returns null before any run is dispatched and collectTurn falls back to collectDirect. " +
  "A real durable turn re-enters the agent through /internal/chat/stream-turn (AgentController, M3.1) " +
  "for the chat loop and /internal/execute-tool (arm b) for spawn_job's agent-tool-block; this suite " +
  "proves the fallback and arm b, not a run hosted by the external durable runtime.";

// ---------------------------------------------------------------------------
// THE CALLS

const WIRE_ENTITY = "parity-wire";

/**
 * The end user every arm acts for. A turn RESOLVES it from its thread
 * (`AgentService.resolveOriginEndUserId`); the execute-batch shape and the
 * durable body CARRY the value their parent resolved (`agent-tool-block.task.ts`
 * forwards `endUserId` for exactly that reason). Parity is that the same
 * identity reaches the executor, so arms (a) and (b) carry what (c) resolves —
 * and the audit comparison below would catch an arm that did not.
 */
const END_USER = "parity-end-user";
const MCP_ENTITY = "parity-mcp";

interface ParityCase {
  readonly name: string;
  readonly entity: string;
  readonly tool: string;
  readonly params: Record<string, unknown>;
  readonly expectedStatus: "success" | "failed";
}

const CASES: readonly ParityCase[] = [
  { name: "wire entity, success", entity: WIRE_ENTITY, tool: "ledger.lookup", params: { account: "acme", limit: 2 }, expectedStatus: "success" },
  { name: "wire entity, backend failure", entity: WIRE_ENTITY, tool: "ledger.explode", params: { account: "acme" }, expectedStatus: "failed" },
  { name: "MCP entity, success", entity: MCP_ENTITY, tool: "notes.search", params: { query: "invoices" }, expectedStatus: "success" },
  { name: "MCP entity, tool-reported error", entity: MCP_ENTITY, tool: "notes.fail", params: { query: "invoices" }, expectedStatus: "failed" },
];

interface Outcome {
  readonly tool: string;
  readonly status: string;
  readonly result?: unknown;
  readonly error?: string;
}

/** The fields an entry point promises its caller, without timing and row ids. */
function outcome(value: { tool?: string; status: string; result?: unknown; error?: string }, tool: string): Outcome {
  return {
    tool: value.tool ?? tool,
    status: value.status,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

// ---------------------------------------------------------------------------
// LISTENERS

const servers: Server[] = [];

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => resolveBody(body));
  });
}

describeWithServices("tool-call parity across execute-batch, internal-execute-tool and turn dispatch", () => {
  let schema: PrivateSchema;
  let prisma: PrismaClient;
  let redis: ReturnType<typeof redisClient>;
  let executor: ToolExecutorService;
  let registry: ToolRegistryService;
  let pool: McpConnectionPool;
  let conversation: ConversationService;
  let turnDispatch: TurnDispatchService;
  let internalApp: NestExpressApplication;
  let internalUrl: string;
  let wireUrl: string;
  let wireSecret: string;
  const wireCalls: Array<{ tool: string; signatureValid: boolean }> = [];
  const ids = {} as {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    directAgentId: string;
    durableAgentId: string;
  };
  const model = {
    calls: [] as Array<{ tool: string; params: Record<string, unknown> }>,
    toolResults: [] as string[],
    requests: 0,
  };

  beforeAll(async () => {
    // THE WIRE BACKEND verifies what it receives, with the secret the entity was
    // registered with — a signature the executor got wrong is a 401 here, not a
    // pass.
    wireUrl = await listen((request, response) => {
      void readBody(request).then((body) => {
        const timestamp = String(request.headers["x-platos-timestamp"] ?? "");
        const nonce = String(request.headers["x-platos-nonce"] ?? "");
        const expected = createHmac("sha256", wireSecret).update(`${timestamp}.${nonce}.${body}`).digest("hex");
        const signatureValid = expected === request.headers["x-platos-signature"];
        const parsed = JSON.parse(body) as { params: { name: string; arguments: Record<string, unknown> } };
        wireCalls.push({ tool: parsed.params.name, signatureValid });
        if (!signatureValid) return void response.writeHead(401).end("bad signature");
        if (parsed.params.name === "ledger.explode") {
          response.writeHead(500, { "content-type": "text/plain" });
          return void response.end("ledger backend exploded");
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ entries: ["2026-09-01 +120", "2026-09-02 -40"], echoed: parsed.params.arguments }));
      });
    });

    // THE MCP BACKEND is the SDK's own server, stateless, one per request.
    const mcpBase = await listen((request, response) => {
      void readBody(request).then(async (body) => {
        const server = new McpServer({ name: "parity-notes", version: "1.0.0" });
        server.registerTool("notes.search", { description: "search notes", inputSchema: { query: z.string() } }, async (args: { query: string }) => ({
          content: [{ type: "text" as const, text: `found 3 notes for ${args.query}` }],
        }));
        server.registerTool("notes.fail", { description: "always fails", inputSchema: { query: z.string() } }, async () => ({
          isError: true,
          content: [{ type: "text" as const, text: "notes backend refused the query" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => void transport.close());
        await server.connect(transport);
        await transport.handleRequest(request, response, body === "" ? undefined : JSON.parse(body));
      });
    });

    // THE MODEL: first request of a turn asks for `execute_tools` with the queued
    // call; the request that carries the tool result gets a final answer, and
    // the tool result is recorded as the model received it.
    const modelBase = await listen((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        return void response.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }));
      }
      void readBody(request).then((raw) => {
        model.requests += 1;
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }> };
        const last = body.messages[body.messages.length - 1];
        const created = Math.floor(Date.now() / 1000);
        const frame = (choice: unknown, usage?: unknown) =>
          `data: ${JSON.stringify({ id: `chatcmpl-parity-${String(model.requests)}`, object: "chat.completion.chunk", created, model: "fixture-model", choices: [choice], ...(usage ? { usage } : {}) })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (last?.role === "tool") {
          model.toolResults.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
          response.write(frame({ index: 0, delta: { role: "assistant", content: "parity turn complete" }, finish_reason: null }));
          response.write(frame({ index: 0, delta: {}, finish_reason: "stop" }, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }));
        } else {
          const args = JSON.stringify({ calls: model.calls });
          response.write(frame({ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_parity_${String(model.requests)}`, type: "function", function: { name: "execute_tools", arguments: "" } }] }, finish_reason: null }));
          response.write(frame({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }));
          response.write(frame({ index: 0, delta: {}, finish_reason: "tool_calls" }, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    admitted.add(new URL(wireUrl).origin);
    admitted.add(new URL(mcpBase).origin);

    schema = await openPrivateSchema(baseDatabaseUrl!, "toolparity");
    prisma = schema.prisma;
    redis = redisClient(redisUrl!);

    const user = await prisma.user.create({ data: { email: `${schema.schemaName}@parity.test.invalid`, displayName: "Parity operator" } });
    const organization = await prisma.organization.create({ data: { slug: schema.schemaName.replaceAll("_", "-"), name: "Parity org" } });
    await prisma.organizationMembership.create({ data: { organizationId: organization.id, userId: user.id, role: "OWNER" } });
    const project = await prisma.project.create({ data: { organizationId: organization.id, slug: "parity", name: "Parity" } });
    const environment = await prisma.environment.create({ data: { projectId: project.id, slug: "development", name: "Development" } });
    Object.assign(ids, { organizationId: organization.id, projectId: project.id, environmentId: environment.id, userId: user.id });

    const secretStore = new PlatosSecretStore(prisma, new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: "55".repeat(32) } }));
    registry = new ToolRegistryService(prisma, redis);
    const auth = new AuthService(prisma, redis, registry, secretStore);
    const operatorScope = { organizationId: organization.id, projectId: project.id, environmentId: environment.id, userId: user.id, principal: "operator" as const };
    const wire = await auth.registerEntity(
      { organizationId: organization.id, projectId: project.id, environmentId: environment.id, entityId: WIRE_ENTITY, displayName: "Parity ledger", mcpUrls: [], serviceSecret: "auto", connectionKind: "wire" },
      operatorScope,
    );
    wireSecret = wire.plaintextSecret as string;
    const mcp = await auth.registerEntity(
      { organizationId: organization.id, projectId: project.id, environmentId: environment.id, entityId: MCP_ENTITY, displayName: "Parity notes", mcpUrls: [], serviceSecret: "", connectionKind: "mcp", mcpClient: { transport: "remote-http", url: `${mcpBase}/mcp` } },
      operatorScope,
    );
    const scopeTuple = { organizationId: organization.id, projectId: project.id, environmentId: environment.id };
    await registry.registerTools({ ...scopeTuple, entityPk: wire.id, sourceEntityId: WIRE_ENTITY }, [
      { name: "ledger.lookup", description: "Look up ledger entries", paramSchema: { type: "object", properties: { account: { type: "string" }, limit: { type: "integer" } } }, category: "ledger" },
      { name: "ledger.explode", description: "A ledger call the backend refuses", paramSchema: { type: "object", properties: { account: { type: "string" } } }, category: "ledger" },
    ], `${wireUrl}/tools`);
    await registry.registerTools({ ...scopeTuple, entityPk: mcp.id, sourceEntityId: MCP_ENTITY }, [
      { name: "notes.search", description: "search notes", paramSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, category: "notes" },
      { name: "notes.fail", description: "always fails", paramSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, category: "notes" },
    ], null);

    // TWO AGENTS, identical but for `executionMode`, both allowed every tool.
    const makeAgent = async (slug: string, executionMode: "direct" | "durable") => {
      const agent = await prisma.agent.create({ data: { projectId: project.id, slug, name: slug } });
      const version = await prisma.agentVersion.create({
        data: {
          agentId: agent.id, versionNumber: 1, model: "openai:fixture-model", systemPrompt: "Use tools when asked.",
          promptBlocks: [], dynamicBlocks: [], toolsBlockConfig: {}, modelRoutes: [], toolDefaultPolicy: "ALL",
          memoryConfig: { __runtime: { executionMode, agentRetryConfig: { rules: [] }, metaTools: {} } },
          maxSteps: 3, contextLimit: 20, createdBy: user.id,
        },
      });
      await prisma.agentBinding.create({ data: { environmentId: environment.id, agentId: agent.id, activeAgentVersionId: version.id } });
      return agent.id;
    };
    ids.directAgentId = await makeAgent("parity-direct", "direct");
    ids.durableAgentId = await makeAgent("parity-durable", "durable");
    await registry.rebuildIndex();

    // THE MODEL PROVIDER, wired as `direct-provider-runtime.integration.test.ts` wires it.
    await prisma.environmentProvider.create({ data: { environmentId: environment.id, providerId: "openai", enabled: true } });
    const observedAt = new Date("2026-08-20T00:00:00.000Z");
    const canonicalModel = await prisma.model.create({ data: { key: "openai/fixture-model", provider: "openai", name: "fixture-model", sourceUpdatedAt: observedAt } });
    const rate = { usdPerToken: 1e-7, source: ModelRateSource.LITELLM, observedAt, sourceRef: "fixture" };
    const canonicalPrice = await prisma.modelPrice.create({
      data: {
        modelId: canonicalModel.id, effectiveFrom: observedAt, inputRate: 1e-7, outputRate: 1e-7, cacheReadRate: 1e-7, cacheWriteRate: 1e-7,
        inputSource: ModelRateSource.LITELLM, outputSource: ModelRateSource.LITELLM, cacheReadSource: ModelRateSource.LITELLM, cacheWriteSource: ModelRateSource.LITELLM,
        inputObservedAt: observedAt, outputObservedAt: observedAt, cacheReadObservedAt: observedAt, cacheWriteObservedAt: observedAt,
        inputSourceRef: "fixture", outputSourceRef: "fixture", cacheReadSourceRef: "fixture", cacheWriteSourceRef: "fixture",
      },
    });
    const secretAuthorization = await auth.authorizeEnvironmentOperatorScope(operatorScope, "secret:mutate");
    const keyCredential = await secretStore.create({ authorization: secretAuthorization, kind: CredentialKind.SERVICE_CREDENTIAL, name: "OPENAI_API_KEY", provider: "openai", plaintext: "fixture-key" });
    await secretStore.create({ authorization: secretAuthorization, kind: CredentialKind.SECRET_REFERENCE, name: "OPENAI_BASE_URL", provider: "openai", plaintext: modelBase });
    await secretStore.linkProviderKey({ authorization: secretAuthorization, provider: "openai", label: "fixture", envVarName: keyCredential.name, isDefault: true });

    // THE EXECUTOR — the real one, with the audit service, the credential
    // resolver and the connection pool its module provides.
    const scopedEnv = new ScopedEnvService(prisma as never, secretStore);
    const credentials = new McpCredentialService(scopedEnv);
    pool = new McpConnectionPool(credentials);
    executor = new ToolExecutorService(
      prisma, registry, undefined, undefined, new ToolAuditService(prisma), undefined, undefined, undefined, undefined, undefined, redis, credentials, pool,
    );

    // THE TURN — the real AgentTaskService and AgentService. The doubles are the
    // ones `direct-provider-runtime.integration.test.ts` uses for cost, spans,
    // budget and safety, none of which a tool call reads.
    const cost = {
      beginReservation: vi.fn(), settleReservation: vi.fn().mockResolvedValue(undefined), calculateCost: vi.fn().mockResolvedValue(0),
      calculateCostWithCache: vi.fn().mockResolvedValue(0), recordUsage: vi.fn(), recordAuxiliaryCost: vi.fn(),
      resolvePrice: vi.fn().mockResolvedValue({
        modelPriceId: canonicalPrice.id, modelId: canonicalModel.id, modelKey: "openai/fixture-model", provider: "openai", modelName: "fixture-model",
        effectiveFrom: observedAt, input: rate, output: rate, cacheRead: rate, cacheWrite: rate,
      }),
      priceUsageFromSnapshot: vi.fn((_model: unknown, price: unknown) => ({ price, costCents: 0 })),
    };
    const spans = { startTrace: () => ({ traceId: "a".repeat(32), rootSpanId: "b".repeat(16) }), nextSpanId: () => "c".repeat(16), record: vi.fn() };
    const catalog = new ModelCatalogService(scopedEnv);
    const providers = new ProviderRegistryService(prisma as never, scopedEnv, catalog);
    const agentService = new AgentService(redis as never, prisma, scopedEnv, { get: () => null } as never, registry, executor, undefined, undefined, cost as never, undefined, providers);
    conversation = new ConversationService(prisma as never);
    const agentTask = new AgentTaskService(
      agentService, conversation,
      { checkText: () => ({ passed: true, flags: [] }), checkGroundedness: () => ({ grounded: true, unsupportedClaims: [] }) } as never,
      cost as never, spans as never, {} as never, executor,
      { resolveAttachments: vi.fn().mockResolvedValue([]), markAttachedToMessage: vi.fn() } as never,
      { evaluate: vi.fn().mockResolvedValue({ blocked: false, caps: [] }), recordUserSpend: vi.fn(), detectThresholdCrossings: vi.fn().mockResolvedValue([]) } as never,
      { checkUserMessage: vi.fn().mockResolvedValue({ allowed: true }) } as never,
      { record: vi.fn() } as never,
      redis as never,
    );
    turnDispatch = new TurnDispatchService(prisma, agentTask, conversation, redis as never);

    // THE DURABLE CALLBACK on a real socket, mounted by Nest with the production guard.
    // The controller's source, located from the module the import above resolved.
    const controllerFile = internalControllerSource();
    const tokens = new Map<string, unknown>([
      ["ToolExecutorService", ToolExecutorService],
      ["ScopedEnvService", ScopedEnvService],
      ["AgentTaskService", AgentTaskService],
      ["ConversationService", ConversationService],
    ]);
    Reflect.defineMetadata(
      "design:paramtypes",
      constructorTokenNames(controllerFile, "InternalExecuteToolController").map((name) => {
        if (!tokens.has(name)) throw new Error(`no token for ${name}`);
        return tokens.get(name);
      }),
      InternalExecuteToolController,
    );
    @Module({
      controllers: [InternalExecuteToolController],
      providers: [
        { provide: ToolExecutorService, useValue: executor },
        { provide: ScopedEnvService, useValue: scopedEnv },
        { provide: AgentTaskService, useValue: unreachable("AgentTaskService") },
        { provide: ConversationService, useValue: unreachable("ConversationService") },
        { provide: PRISMA_TOKEN, useValue: prisma },
        { provide: PLATOS_SECRET_STORE_TOKEN, useValue: secretStore },
        { provide: APP_GUARD, useValue: new ScopeGuard() },
      ],
    })
    class InternalModule {}
    internalApp = await NestFactory.create<NestExpressApplication>(InternalModule, { bodyParser: false, logger: false });
    internalApp.useBodyParser("json", { limit: "15mb" });
    await internalApp.listen(0, "127.0.0.1");
    internalUrl = `http://127.0.0.1:${String((internalApp.getHttpServer().address() as AddressInfo).port)}`;
  }, 300_000);

  afterAll(async () => {
    await internalApp?.close().catch(() => undefined);
    pool?.onModuleDestroy();
    await registry?.onModuleDestroy().catch(() => undefined);
    redis?.disconnect();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
    }
    await schema?.drop();
  }, 60_000);

  // -------------------------------------------------------------------------
  // THE FOUR ARMS

  async function freshThread(agentId: string): Promise<string> {
    const thread = await conversation.createThread(
      { organizationId: ids.organizationId, projectId: ids.projectId, environmentId: ids.environmentId, userId: END_USER, agentId } as never,
      agentId,
    );
    return thread.id;
  }

  async function viaExecuteBatch(testCase: ParityCase): Promise<Outcome & { threadId: string }> {
    const threadId = await freshThread(ids.directAgentId);
    const [result] = await executor.executeBatch(
      [{ tool: testCase.tool, params: { ...testCase.params } }],
      { organizationId: ids.organizationId, projectId: ids.projectId, environmentId: ids.environmentId, userId: END_USER, agentId: ids.directAgentId, sessionId: threadId },
      { source: "agent_turn", endUserId: END_USER },
    );
    return { ...outcome(result!, testCase.tool), threadId };
  }

  async function viaInternalExecuteTool(testCase: ParityCase): Promise<Outcome & { threadId: string; httpStatus: number }> {
    const threadId = await freshThread(ids.directAgentId);
    // THE BODY `agent-tool-block.task.ts` SENDS, field for field and in its order.
    const body = {
      organizationId: ids.organizationId, projectId: ids.projectId, environmentId: ids.environmentId, userId: END_USER,
      agentId: ids.directAgentId, tool: testCase.tool, params: { ...testCase.params }, endUserId: END_USER, purpose: "durable",
      scopeExtras: { sessionId: threadId, userToken: undefined, entityId: undefined, traceId: undefined, parentSpanId: undefined },
      origin: { agentId: ids.directAgentId, threadId, callId: `parity-${testCase.tool}` },
    };
    const bodyText = JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const signature = createHmac("sha256", env.PLATOS_COMPONENT_AUTH_SECRET || "dev-internal-secret-change-me").update(bodyText + timestamp).digest("hex");
    const response = await fetch(`${internalUrl}/internal/execute-tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-platos-signature": signature, "x-platos-timestamp": timestamp },
      body: bodyText,
    });
    const json = (await response.json()) as { status: string; result?: unknown; error?: string };
    return { ...outcome(json, testCase.tool), threadId, httpStatus: response.status };
  }

  async function viaTurnDispatch(testCase: ParityCase, agentId: string): Promise<Outcome & { threadId: string; events: AgentStreamEvent[] }> {
    model.calls = [{ tool: testCase.tool, params: { ...testCase.params } }];
    const before = model.toolResults.length;
    // WHICH BRANCH RAN, observed rather than assumed: the durable arm must enter
    // the session driver and get nothing back (the D7 gap), the direct arm must
    // never enter it.
    const sessions = vi.spyOn(turnDispatch, "collectSession");
    const collected = await turnDispatch.collectTurn(agentId, {
      scope: { organizationId: ids.organizationId, projectId: ids.projectId, environmentId: ids.environmentId, userId: END_USER, agentId } as never,
      message: `call ${testCase.tool}`,
    });
    const sessionCalls = sessions.mock.results.length;
    const sessionResults = await Promise.all(sessions.mock.results.map((entry) => entry.value));
    sessions.mockRestore();
    expect(sessionCalls).toBe(agentId === ids.durableAgentId ? 1 : 0);
    expect(sessionResults).toEqual(agentId === ids.durableAgentId ? [null] : []);
    expect(model.toolResults.length, "the model was never handed a tool result").toBe(before + 1);
    const handedBack = JSON.parse(model.toolResults[before]!) as { results: Array<{ tool: string; status: string; result?: unknown; error?: string }> } | { type: string; value: { results: Array<{ tool: string; status: string; result?: unknown; error?: string }> } };
    const results = "results" in handedBack ? handedBack.results : handedBack.value.results;
    expect(results).toHaveLength(1);
    return { ...outcome(results[0]!, testCase.tool), threadId: collected.threadId, events: collected.events ?? [] };
  }

  async function auditRow(threadId: string, tool: string) {
    const rows = await prisma.toolCallAudit.findMany({ where: { threadId, toolName: tool } });
    expect(rows, `exactly one audit row for ${tool} on thread ${threadId}`).toHaveLength(1);
    const row = rows[0]!;
    const args = row.arguments as { __platosAudit: Record<string, unknown>; value: unknown };
    return {
      environmentId: row.environmentId,
      toolId: row.toolId,
      toolName: row.toolName,
      status: row.status,
      error: row.error,
      result: row.result,
      arguments: args.value,
      entityId: args.__platosAudit["entityId"],
      entityPk: args.__platosAudit["entityPk"],
      source: args.__platosAudit["source"],
      endUserId: args.__platosAudit["endUserId"],
      outcomeStatus: args.__platosAudit["status"],
    };
  }

  async function health(tool: string, entity: string) {
    const toolRow = await prisma.tool.findFirstOrThrow({ where: { name: tool }, select: { id: true } });
    const row = await prisma.toolHealth.findUnique({
      where: { environmentId_toolId_entityExternalId: { environmentId: ids.environmentId, toolId: toolRow.id, entityExternalId: entity } },
    });
    return { totalCalls: row?.totalCalls ?? 0, totalFailures: row?.totalFailures ?? 0, lastStatus: row?.lastStatus ?? null };
  }

  for (const testCase of CASES) {
    it(`${testCase.name}: every entry point returns the same outcome, writes the same audit row and moves ToolHealth by one`, async () => {
      const arms: Array<{ arm: string; run: () => Promise<Outcome & { threadId: string }> }> = [
        { arm: "execute-batch", run: () => viaExecuteBatch(testCase) },
        { arm: "internal-execute-tool", run: () => viaInternalExecuteTool(testCase) },
        { arm: "turn-dispatch direct", run: () => viaTurnDispatch(testCase, ids.directAgentId) },
        { arm: "turn-dispatch durable (fallback, see DURABLE_ARM_GAP)", run: () => viaTurnDispatch(testCase, ids.durableAgentId) },
      ];
      const outcomes: Array<{ arm: string; value: Outcome }> = [];
      const audits: Array<{ arm: string; value: Awaited<ReturnType<typeof auditRow>> }> = [];
      for (const { arm, run } of arms) {
        const before = await health(testCase.tool, testCase.entity);
        const value = await run();
        const after = await health(testCase.tool, testCase.entity);
        // ONE ToolHealth sample per dispatch, whatever the entry point.
        expect({ arm, calls: after.totalCalls - before.totalCalls, failures: after.totalFailures - before.totalFailures, lastStatus: after.lastStatus }).toEqual({
          arm, calls: 1, failures: testCase.expectedStatus === "failed" ? 1 : 0, lastStatus: testCase.expectedStatus,
        });
        outcomes.push({ arm, value });
        audits.push({ arm, value: await auditRow(value.threadId, testCase.tool) });
      }

      expect(outcomes[0]!.value.status).toBe(testCase.expectedStatus);
      const reference = outcomes[0]!.value;
      for (const { arm, value } of outcomes.slice(1)) {
        const comparable = arm === "internal-execute-tool" && reference.status !== "success"
          // RECORDED — see the RECORDED_PARITY_GAPS case: the durable callback
          // drops `result` on every non-success, so the tool's own error content
          // does not reach a durable task.
          ? { ...reference, result: undefined }
          : reference;
        expect({ arm, ...value, threadId: undefined, events: undefined, httpStatus: undefined }).toEqual({ arm, ...JSON.parse(JSON.stringify(comparable)), threadId: undefined, events: undefined, httpStatus: undefined });
      }
      const referenceAudit = audits[0]!.value;
      expect(referenceAudit.source).toBe("agent_turn");
      expect(referenceAudit.entityId).toBe(testCase.entity);
      for (const { arm, value } of audits.slice(1)) {
        expect({ arm, ...value }).toEqual({ arm, ...referenceAudit });
      }
      if (testCase.entity === WIRE_ENTITY) {
        const signed = wireCalls.filter((call) => call.tool === testCase.tool);
        expect(signed.length).toBeGreaterThanOrEqual(arms.length);
        expect(signed.every((call) => call.signatureValid)).toBe(true);
      }
    }, 120_000);
  }

  it("the two turn-dispatch arms really are two modes: resolveMode reads direct and durable from the bindings", async () => {
    const scope = { organizationId: ids.organizationId, projectId: ids.projectId, environmentId: ids.environmentId } as never;
    await expect(turnDispatch.resolveMode(ids.directAgentId, scope)).resolves.toBe("direct");
    await expect(turnDispatch.resolveMode(ids.durableAgentId, scope)).resolves.toBe("durable");
    expect(process.env.PLATOS_CHAT_SESSIONS).not.toBe("true");
    expect(DURABLE_ARM_GAP).toContain("D7");
  });

  it("RECORDED_PARITY_GAPS: internal-execute-tool drops `result` on a failed call that the executor returned with one", async () => {
    const failing = CASES.find((testCase) => testCase.tool === "notes.fail")!;
    const batch = await viaExecuteBatch(failing);
    const internal = await viaInternalExecuteTool(failing);
    expect(batch.status).toBe("failed");
    expect(batch.result).toMatchObject({ isError: true });
    expect(internal.status).toBe("failed");
    expect(internal.error).toBe(batch.error);
    expect(internal.result).toBeUndefined();
  }, 60_000);

  it("CONTROL: the real SSRF screen refuses the fixture backends the mock admits", async () => {
    const actual = await vi.importActual<typeof import("../shared/url-validator")>("../shared/url-validator");
    for (const origin of admitted) {
      const refused = await actual.validatePublicUrl(`${origin}/tools`, { allowHttp: true });
      expect(refused.ok).toBe(false);
    }
    expect(admitted.size).toBe(2);
    // …and the imported binding IS the admitting mock, so every arm above used it.
    const viaMock = await screenedUrl(`${[...admitted][0]!}/tools`);
    expect(viaMock.ok).toBe(true);
    // Nothing outside the admitted origins is admitted.
    const outside = await screenedUrl("http://127.0.0.1:1/tools", { allowHttp: true });
    expect(outside.ok).toBe(false);
    // …including the IPv4-MAPPED IPv6 spelling of an admitted backend, which is a
    // different origin that connects to the same socket. The real screen let that
    // spelling through until this lane: the URL parser turns
    // `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]` before the screen sees it, and
    // the screen read only the dotted form. Cloud metadata in the same spelling,
    // and the IPv4-compatible form, are refused; a PUBLIC address in the mapped
    // spelling is still admitted, so the refusal is about the address.
    const port = new URL([...admitted][0]!).port;
    for (const spelled of [
      `http://[::ffff:127.0.0.1]:${port}/tools`,
      `http://[::ffff:7f00:1]:${port}/tools`,
      `http://[0:0:0:0:0:ffff:7f00:0001]:${port}/tools`,
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[::a9fe:a9fe]/latest/meta-data/",
      "http://[::ffff:10.1.2.3]/",
    ]) {
      const refused = await actual.validatePublicUrl(spelled, { allowHttp: true });
      expect({ spelled, ok: refused.ok }).toEqual({ spelled, ok: false });
    }
    await expect(actual.validatePublicUrl("http://[::ffff:8.8.8.8]/", { allowHttp: true })).resolves.toMatchObject({ ok: true });
  });
});
