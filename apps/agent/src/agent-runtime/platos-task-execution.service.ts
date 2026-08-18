import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type Redis from "ioredis";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { env } from "../shared/env";
import { REDIS_TOKEN } from "../shared/redis.provider";

const INVOCATION_TYPES = ["agent", "manual", "schedule", "webhook"] as const;
const REQUEST_KEYS = new Set([
  "requestId",
  "taskRowId",
  "payload",
  "scope",
  "invokedBy",
  "agentId",
]);
const SCOPE_KEYS = new Set(["organizationId", "projectId", "environmentId", "userId"]);
const SENSITIVE_KEY_NAMES = new Set([
  "proto",
  "constructor",
  "prototype",
  "secret",
  "password",
  "token",
  "authorization",
  "credential",
  "handler",
  "source",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "privatekey",
  "databaseurl",
  "connectionstring",
]);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REGISTERED_TASK_ID_RE = /^[a-z0-9-]{1,64}$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 100;
const MAX_STRING_LENGTH = 8192;
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TASK_TIMEOUT_MS = 580_000;

type InvocationType = (typeof INVOCATION_TYPES)[number];
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PlatosTaskExecutionRequest {
  requestId: string;
  taskRowId: string;
  payload: Record<string, JsonValue>;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId?: string;
  };
  invokedBy: InvocationType;
  agentId?: string;
}

export type PlatosTaskExecutionErrorCode =
  | "INVALID_REQUEST"
  | "TASK_NOT_FOUND_OR_INACTIVE"
  | "TASK_NOT_AUTHORIZED"
  | "TASK_NOT_REGISTERED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_UNAVAILABLE"
  | "TASK_SERVICE_UNAVAILABLE"
  | "TASK_TIMEOUT"
  | "TASK_EXECUTION_FAILED"
  | "TASK_RESULT_REJECTED";

export type PlatosTaskExecutionBody =
  | { status: "completed"; result?: JsonValue; replayed?: true }
  | { status: "failed"; error: { code: PlatosTaskExecutionErrorCode } };

export interface PlatosTaskExecutionHttpResult {
  httpStatus: number;
  body: PlatosTaskExecutionBody;
}

interface IdempotencyRecord {
  hash: string;
  state: "running" | "completed" | "failed";
  result?: JsonValue;
  code?: PlatosTaskExecutionErrorCode;
  httpStatus?: number;
}

class TaskTimeoutError extends Error {}
class TaskResultRejectedError extends Error {}

function registeredTaskWorkerMain(): void {
  const { parentPort, workerData } =
    require("node:worker_threads") as typeof import("node:worker_threads");
  const { createContext, runInContext } = require("node:vm") as typeof import("node:vm");
  const data = workerData as {
    contextName: string;
    filename: string;
    payloadJson: string;
    source: string;
    timeoutMs: number;
  };
  const post = (message: unknown): void => parentPort!.postMessage(message);

  void (async () => {
    try {
      const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, {
        __platosPayloadJson: data.payloadJson,
      });
      const context = createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        name: data.contextName,
      });
      const helpers = runInContext(
        `(() => {
          const payloadJson = globalThis.__platosPayloadJson;
          delete globalThis.__platosPayloadJson;
          const parse = JSON.parse.bind(JSON);
          const stringify = JSON.stringify.bind(JSON);
          let outputWasSet = false;
          let outputValue;
          const noOp = () => undefined;

          globalThis.payload = parse(payloadJson);
          globalThis.ctx = Object.freeze({
            logger: Object.freeze({ info: noOp, warn: noOp, error: noOp }),
            metadata: Object.freeze({ set: async () => undefined }),
            output: Object.freeze({
              set: (value) => {
                outputWasSet = true;
                outputValue = value;
              },
            }),
          });
          globalThis.console = Object.freeze({ log: noOp, warn: noOp, error: noOp });

          return Object.freeze({
            serializeOutput: (returned) => {
              const output = outputWasSet ? outputValue : returned;
              if (output === undefined) return undefined;
              const serialized = stringify(output);
              if (typeof serialized !== "string") throw new Error("task result is not JSON");
              return serialized;
            },
          });
        })()`,
        context,
        { timeout: 1_000, displayErrors: false }
      ) as { serializeOutput: (returned: unknown) => string | undefined };
      const wrappedSource = `
        (async function __platosTaskWrapper__(payload, ctx) {
          ${data.source}
          if (typeof run !== "function") throw new Error("invalid registered handler");
          return await run(payload, ctx);
        })(payload, ctx)
      `;
      const returned = await runInContext(wrappedSource, context, {
        timeout: data.timeoutMs,
        displayErrors: false,
        filename: data.filename,
      });
      let serialized: string | undefined;
      try {
        serialized = helpers.serializeOutput(returned);
      } catch {
        post({ ok: false, kind: "result" });
        return;
      }
      post({ ok: true, serialized });
    } catch (error: unknown) {
      post({
        ok: false,
        kind:
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
            ? "timeout"
            : "execution",
      });
    }
  })();
}

const REGISTERED_TASK_WORKER_SOURCE = `(${registeredTaskWorkerMain.toString()})()`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEY_NAMES.has(normalized) ||
    /(?:secret|password|authorization|credential|token|apikey|privatekey|databaseurl|connectionstring|handlersource|compiledhandler)$/.test(
      normalized
    )
  );
}

function stringContainsSensitiveMaterial(
  value: string,
  configuredSecrets: readonly string[]
): boolean {
  if (configuredSecrets.some((secret) => secret.length > 0 && value.includes(secret))) return true;
  return (
    /(?:postgres(?:ql)?|mysql|redis):\/\/[^\s/:@]+:[^\s/@]+@/i.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value) ||
    /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i.test(
      value
    )
  );
}

function validateJsonValue(
  value: unknown,
  configuredSecrets: readonly string[],
  depth = 0
): value is JsonValue {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return (
      value.length <= MAX_STRING_LENGTH &&
      !stringContainsSensitiveMaterial(value, configuredSecrets)
    );
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_COLLECTION_ITEMS &&
      value.every((item) => validateJsonValue(item, configuredSecrets, depth + 1))
    );
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_COLLECTION_ITEMS &&
    entries.every(
      ([key, item]) =>
        key.length > 0 &&
        key.length <= 128 &&
        !isSensitiveKey(key) &&
        validateJsonValue(item, configuredSecrets, depth + 1)
    )
  );
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function configuredSensitiveValues(): string[] {
  return [env.PLATOS_INTERNAL_AUTH_TOKEN, env.DATABASE_URL].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

export function parsePlatosTaskExecutionRequest(input: unknown): PlatosTaskExecutionRequest | null {
  if (!isPlainObject(input) || !exactKeys(input, REQUEST_KEYS)) return null;
  if (!IDENTIFIER_RE.test(String(input.requestId ?? ""))) return null;
  if (!IDENTIFIER_RE.test(String(input.taskRowId ?? ""))) return null;
  if (!isPlainObject(input.scope) || !exactKeys(input.scope, SCOPE_KEYS)) return null;

  const organizationId = input.scope.organizationId;
  const projectId = input.scope.projectId;
  const environmentId = input.scope.environmentId;
  const userId = input.scope.userId;
  if (
    typeof organizationId !== "string" ||
    !IDENTIFIER_RE.test(organizationId) ||
    typeof projectId !== "string" ||
    !IDENTIFIER_RE.test(projectId) ||
    typeof environmentId !== "string" ||
    !IDENTIFIER_RE.test(environmentId) ||
    (userId !== undefined && (typeof userId !== "string" || !IDENTIFIER_RE.test(userId)))
  ) {
    return null;
  }

  if (!INVOCATION_TYPES.includes(input.invokedBy as InvocationType)) return null;
  const invokedBy = input.invokedBy as InvocationType;
  const agentId = input.agentId;
  if (
    (agentId !== undefined && (typeof agentId !== "string" || !IDENTIFIER_RE.test(agentId))) ||
    (invokedBy === "agent" && typeof agentId !== "string") ||
    (invokedBy !== "agent" && agentId !== undefined)
  ) {
    return null;
  }

  const payload = input.payload ?? {};
  const sensitiveValues = configuredSensitiveValues();
  if (!isPlainObject(payload) || !validateJsonValue(payload, sensitiveValues)) return null;
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_JSON_BYTES) return null;

  return {
    requestId: String(input.requestId),
    taskRowId: String(input.taskRowId),
    payload: payload as Record<string, JsonValue>,
    scope: {
      organizationId,
      projectId,
      environmentId,
      ...(typeof userId === "string" ? { userId } : {}),
    },
    invokedBy,
    ...(typeof agentId === "string" ? { agentId } : {}),
  };
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

function requestHash(request: PlatosTaskExecutionRequest): string {
  return createHash("sha256")
    .update(
      stableJson({
        requestId: request.requestId,
        taskRowId: request.taskRowId,
        payload: request.payload,
        scope: request.scope,
        invokedBy: request.invokedBy,
        ...(request.agentId ? { agentId: request.agentId } : {}),
      })
    )
    .digest("hex");
}

function failure(
  httpStatus: number,
  code: PlatosTaskExecutionErrorCode
): PlatosTaskExecutionHttpResult {
  return { httpStatus, body: { status: "failed", error: { code } } };
}

@Injectable()
export class PlatosTaskExecutionService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Inject(REDIS_TOKEN) private readonly redis: Redis
  ) {}

  async execute(request: PlatosTaskExecutionRequest): Promise<PlatosTaskExecutionHttpResult> {
    let task: {
      externalId: string | null;
      handler: string;
      timeoutSeconds: number;
      triggerType: string;
      allowedAgentIds: string[];
    } | null;
    try {
      task = await this.prisma.job.findFirst({
        where: {
          id: request.taskRowId,
          status: "ACTIVE",
          ...environmentScopeWhere(request.scope),
        },
        select: {
          externalId: true,
          handler: true,
          timeoutSeconds: true,
          triggerType: true,
          allowedAgentIds: true,
        },
      });
    } catch {
      return failure(503, "TASK_SERVICE_UNAVAILABLE");
    }
    if (!task) return failure(404, "TASK_NOT_FOUND_OR_INACTIVE");
    if (!task.externalId || !REGISTERED_TASK_ID_RE.test(task.externalId) || !task.handler.trim()) {
      return failure(422, "TASK_NOT_REGISTERED");
    }
    if (
      task.triggerType !== request.invokedBy &&
      !(request.invokedBy === "agent" && task.triggerType === "agent-spawn")
    ) {
      return failure(403, "TASK_NOT_AUTHORIZED");
    }
    if (
      request.invokedBy === "agent" &&
      task.allowedAgentIds.length > 0 &&
      !task.allowedAgentIds.includes(request.agentId!)
    ) {
      return failure(403, "TASK_NOT_AUTHORIZED");
    }

    const hash = requestHash(request);
    const key = `internal-task-execution:${createHash("sha256")
      .update(`${request.scope.environmentId}:${request.requestId}`)
      .digest("hex")}`;
    const running: IdempotencyRecord = { hash, state: "running" };
    let reserved: string | null;
    try {
      reserved = await this.redis.set(
        key,
        JSON.stringify(running),
        "EX",
        IDEMPOTENCY_TTL_SECONDS,
        "NX"
      );
    } catch {
      return failure(503, "IDEMPOTENCY_UNAVAILABLE");
    }

    if (reserved !== "OK") {
      let existing: IdempotencyRecord | null = null;
      try {
        const raw = await this.redis.get(key);
        existing = raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
      } catch {
        return failure(503, "IDEMPOTENCY_UNAVAILABLE");
      }
      if (!existing || existing.hash !== hash) return failure(409, "IDEMPOTENCY_CONFLICT");
      if (existing.state === "completed") {
        return {
          httpStatus: 200,
          body: { status: "completed", result: existing.result, replayed: true },
        };
      }
      if (existing.state === "failed" && existing.code && existing.httpStatus) {
        return failure(existing.httpStatus, existing.code);
      }
      return failure(409, "IDEMPOTENCY_IN_PROGRESS");
    }

    let result: PlatosTaskExecutionHttpResult;
    try {
      const output = await this.runRegisteredHandler(
        task.handler,
        task.externalId,
        task.timeoutSeconds,
        request.payload
      );
      await this.prisma.job
        .updateMany({
          where: {
            id: request.taskRowId,
            status: "ACTIVE",
            ...environmentScopeWhere(request.scope),
          },
          data: { lastStartedAt: new Date() },
        })
        .catch(() => undefined);
      result = { httpStatus: 200, body: { status: "completed", result: output } };
    } catch (error: unknown) {
      if (error instanceof TaskTimeoutError) result = failure(504, "TASK_TIMEOUT");
      else if (error instanceof TaskResultRejectedError)
        result = failure(422, "TASK_RESULT_REJECTED");
      else result = failure(500, "TASK_EXECUTION_FAILED");
    }

    const record: IdempotencyRecord =
      result.body.status === "completed"
        ? { hash, state: "completed", result: result.body.result }
        : {
            hash,
            state: "failed",
            code: result.body.error.code,
            httpStatus: result.httpStatus,
          };
    try {
      await this.redis.set(key, JSON.stringify(record), "EX", IDEMPOTENCY_TTL_SECONDS, "XX");
    } catch {
      // The original running reservation remains fail-closed until expiry.
    }
    return result;
  }

  private async runRegisteredHandler(
    source: string,
    taskId: string,
    timeoutSeconds: number,
    payload: Record<string, JsonValue>
  ): Promise<JsonValue | undefined> {
    const timeoutMs = Math.min(Math.max(timeoutSeconds, 1) * 1000, MAX_TASK_TIMEOUT_MS);
    const taskHash = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
    const worker = new Worker(REGISTERED_TASK_WORKER_SOURCE, {
      eval: true,
      env: {},
      argv: [],
      execArgv: [],
      name: `platos-task-${taskHash}`,
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
      workerData: {
        contextName: `platos-task-${taskHash}`,
        filename: `platos-task-${taskHash}.js`,
        payloadJson: JSON.stringify(payload),
        source,
        timeoutMs,
      },
    });

    const serialized = await new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const finish = async (error?: Error, value?: string): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        await worker.terminate().catch(() => undefined);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        void finish(new TaskTimeoutError());
      }, timeoutMs);

      worker.once("message", (message: unknown) => {
        if (!isPlainObject(message) || typeof message.ok !== "boolean") {
          void finish(new Error("registered task execution failed"));
          return;
        }
        if (message.ok) {
          if (message.serialized !== undefined && typeof message.serialized !== "string") {
            void finish(new TaskResultRejectedError());
            return;
          }
          void finish(undefined, message.serialized as string | undefined);
          return;
        }
        if (message.kind === "timeout") void finish(new TaskTimeoutError());
        else if (message.kind === "result") void finish(new TaskResultRejectedError());
        else void finish(new Error("registered task execution failed"));
      });
      worker.once("error", () => {
        void finish(new Error("registered task execution failed"));
      });
      worker.once("exit", (code) => {
        if (!settled && code !== 0) void finish(new Error("registered task execution failed"));
      });
    });

    if (serialized === undefined) return undefined;
    let normalized: unknown;
    try {
      normalized = JSON.parse(serialized) as unknown;
    } catch {
      throw new TaskResultRejectedError();
    }
    const sensitiveValues = configuredSensitiveValues();
    if (!validateJsonValue(normalized, sensitiveValues)) throw new TaskResultRejectedError();
    if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
      throw new TaskResultRejectedError();
    }
    return normalized as JsonValue;
  }
}
