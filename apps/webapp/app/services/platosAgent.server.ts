import { env } from "~/env.server";

export type AgentScope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  agentId?: string;
};

export class PlatosAgentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "PlatosAgentApiError";
  }
}

export class UnsafeCredentialResponseError extends Error {
  readonly code = "UNSAFE_CREDENTIAL_RESPONSE";
  constructor() {
    super("The agent returned an unsafe credential payload");
    this.name = "UnsafeCredentialResponseError";
  }
}

type RequestOptions = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal };
type McpManagementOptions = RequestOptions & { method: NonNullable<RequestOptions["method"]> };

export type AgentRequestResult<T> = { status: number; payload: T };

function assertAgentPath(path: string) {
  if (!path.startsWith("/api/v1/agent/") && path !== "/api/v1/agent" && !path.startsWith("/api/v1/memory")) {
    throw new Error("Dashboard API calls must target the canonical agent API");
  }
}

function assertMcpManagementPath(path: string, method: string) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("MCP management calls must use an absolute local path");
  }
  const parsed = new URL(path, "http://platos-agent.local");
  const pathname = parsed.pathname;
  const allowed =
    (pathname === "/mcp/platform/tokens" && (method === "GET" || method === "POST")) ||
    (method === "POST" && /^\/mcp\/platform\/tokens\/[^/]+\/revoke$/.test(pathname)) ||
    (method === "GET" && pathname === "/mcp/platform/catalog") ||
    (method === "GET" && pathname === "/mcp/entity") ||
    ((method === "GET" || method === "PATCH") && /^\/mcp\/entity\/[^/]+\/config$/.test(pathname)) ||
    ((method === "GET" || method === "POST") && /^\/mcp\/entity\/[^/]+\/tokens$/.test(pathname)) ||
    (method === "DELETE" && /^\/mcp\/entity\/[^/]+\/tokens\/[^/]+$/.test(pathname)) ||
    (method === "GET" && /^\/mcp\/entity\/[^/]+\/tool-acl$/.test(pathname)) ||
    (method === "PATCH" && /^\/mcp\/entity\/[^/]+\/tool-acl\/[^/]+$/.test(pathname)) ||
    (method === "POST" && /^\/mcp\/entity\/[^/]+\/tool-acl\/bulk$/.test(pathname)) ||
    (method === "PATCH" && /^\/mcp\/entity\/[^/]+\/(?:branding|identity|enabled|inject-context)$/.test(pathname));
  if (!allowed) {
    throw new Error(`Unsupported MCP management operation: ${method} ${pathname}`);
  }
}

async function parseAgentResponse<T>(response: Response): Promise<AgentRequestResult<T>> {
  const status = response.status;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  }
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new PlatosAgentApiError(
      response.status,
      typeof record.code === "string" ? record.code : "AGENT_API_ERROR",
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : `Agent API request failed (${response.status})`,
      record.details
    );
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const embeddedStatus = typeof record.status === "number" ? record.status : null;
    if (embeddedStatus && embeddedStatus >= 400 && embeddedStatus <= 599 && (record.error !== undefined || record.message !== undefined)) {
      throw new PlatosAgentApiError(
        embeddedStatus,
        typeof record.code === "string" ? record.code : "AGENT_API_ERROR",
        typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : `Agent API request failed (${embeddedStatus})`,
        record.details,
      );
    }
  }
  return { status, payload: payload as T };
}

export async function agentRequestResult<T = unknown>(path: string, scope: AgentScope, options: RequestOptions = {}): Promise<AgentRequestResult<T>> {
  const response = await agentResponse(path, scope, options);
  // Defensive compatibility while older Agent deployments are draining:
  // historical handlers returned `{ error, status }` with HTTP 200. Treat the
  // explicit numeric error status as transport failure rather than rendering
  // it as successful product data.
  return parseAgentResponse<T>(response);
}

export async function agentRequest<T = unknown>(path: string, scope: AgentScope, options: RequestOptions = {}): Promise<T> {
  return (await agentRequestResult<T>(path, scope, options)).payload;
}

export function agentResponse(path: string, scope: AgentScope, options: RequestOptions = {}): Promise<Response> {
  assertAgentPath(path);
  return fetch(`${env.PLATOS_AGENT_API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
      ...(scope.agentId ? { "X-Platos-Agent-Id": scope.agentId } : {}),
      // The dashboard must not retain a browser-generated AccessKey merely to
      // render its own control-plane routes. This server-only credential
      // distinguishes trusted webapp-to-agent traffic from runtime callers.
      ...(env.PLATOS_INTERNAL_AUTH_TOKEN
        ? { "X-Platos-Internal-Auth": env.PLATOS_INTERNAL_AUTH_TOKEN }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
}

/** Dashboard-only transport for the exact management operations colocated
 * under public MCP protocol prefixes. The method/path allow-list prevents a
 * scoped webapp request from ever becoming a broad /mcp protocol bypass. */
export function mcpManagementResponse(
  path: string,
  scope: AgentScope,
  options: McpManagementOptions,
): Promise<Response> {
  assertMcpManagementPath(path, options.method);
  return fetch(`${env.PLATOS_AGENT_API_URL}${path}`, {
    method: options.method,
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
      ...(env.PLATOS_INTERNAL_AUTH_TOKEN
        ? { "X-Platos-Internal-Auth": env.PLATOS_INTERNAL_AUTH_TOKEN }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
}

export async function mcpManagementRequest<T = unknown>(
  path: string,
  scope: AgentScope,
  options: McpManagementOptions,
): Promise<T> {
  return (await parseAgentResponse<T>(await mcpManagementResponse(path, scope, options))).payload;
}

export async function mcpManagementPanel<T = unknown>(path: string, scope: AgentScope) {
  try {
    return { ok: true as const, data: await mcpManagementRequest<T>(path, scope, { method: "GET" }) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof PlatosAgentApiError
        ? { status: error.status, code: error.code, message: error.message }
        : { status: 503, code: "AGENT_UNAVAILABLE", message: "The agent service is unavailable" },
    };
  }
}

export function publicAgentResponse(path: "/api/v1/public/guest-token", options: RequestOptions & { forwardedFor: string }): Promise<Response> {
  return fetch(`${env.PLATOS_AGENT_API_URL}${path}`, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": options.forwardedFor,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
}

/** Same-origin embed proxy transport for a validated platform session token. */
export function sessionAgentResponse(
  path: string,
  sessionToken: string,
  options: RequestOptions = {},
): Promise<Response> {
  assertAgentPath(path);
  return fetch(`${env.PLATOS_AGENT_API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "X-Platos-Session-Token": sessionToken,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
}

export async function agentPanel<T = unknown>(path: string, scope: AgentScope): Promise<{ ok: true; data: T } | { ok: false; error: { status: number; code: string; message: string } }> {
  try { return { ok: true, data: await agentRequest<T>(path, scope) }; }
  catch (error) {
    return {
      ok: false,
      error: error instanceof PlatosAgentApiError
        ? { status: error.status, code: error.code, message: error.message }
        : { status: 503, code: "AGENT_UNAVAILABLE", message: "The agent service is unavailable" },
    };
  }
}

const FORBIDDEN_CREDENTIAL_FIELDS = /^(?:raw[A-Za-z0-9]*|apiKey|accessKey|keyHash|tokenHash|hash|ciphertext|nonce|authTag|salt|plain(?:text)?(?:Secret|Value|Credential|Material)?|value|secret(?:Material|Value)?|credential(?:Value|Secret|Material)|clientSecret|privateKey|password|token|rootKey|encrypted(?:Value|Secret|Reference)?)$/i;

type CredentialMetadataShape =
  | true
  | readonly [CredentialMetadataShape]
  | { readonly [field: string]: CredentialMetadataShape };

function isCredentialMetadataArray(
  shape: CredentialMetadataShape,
): shape is readonly [CredentialMetadataShape] {
  return Array.isArray(shape);
}

const ACCESS_KEY_METADATA_SHAPE = {
  id: true,
  environmentId: true,
  keyPrefix: true,
  allowedOrigins: [true],
  lastUsedAt: true,
  validUntil: true,
  replacedById: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies CredentialMetadataShape;

const PROVIDER_STATE_SHAPE = {
  id: true,
  displayName: true,
  description: true,
  requiredEnv: [{ name: true, set: true }],
  optionalEnv: [true],
  envReady: true,
  enabled: true,
  linked: true,
  linkedAt: true,
  probeModel: true,
  models: [true],
} as const satisfies CredentialMetadataShape;

const PROVIDER_KEY_SHAPE = {
  id: true,
  environmentId: true,
  credentialId: true,
  provider: true,
  label: true,
  envVarName: true,
  isDefault: true,
  createdBy: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies CredentialMetadataShape;

const PROVIDER_MODEL_SHAPE = {
  provider: true,
  displayName: true,
  models: [true],
} as const satisfies CredentialMetadataShape;

export function assertCredentialSafePayload(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new UnsafeCredentialResponseError();
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertCredentialSafePayload(item, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[-_\s]/g, "");
    if (FORBIDDEN_CREDENTIAL_FIELDS.test(normalizedKey)) throw new UnsafeCredentialResponseError();
    assertCredentialSafePayload(nested, seen);
  }
}

function projectCredentialMetadata(value: unknown, shape: CredentialMetadataShape): unknown {
  if (value === null) return null;
  if (shape === true) {
    if (typeof value === "object") throw new UnsafeCredentialResponseError();
    return value;
  }
  if (isCredentialMetadataArray(shape)) {
    if (!Array.isArray(value)) throw new UnsafeCredentialResponseError();
    return value.map((item) => projectCredentialMetadata(item, shape[0]));
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UnsafeCredentialResponseError();
  }
  const objectShape = shape as { readonly [field: string]: CredentialMetadataShape };
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(objectShape, key)) throw new UnsafeCredentialResponseError();
    result[key] = projectCredentialMetadata(nested, objectShape[key]);
  }
  return result;
}

function projectKnownCredentialEndpoint(path: string, method: string, payload: unknown): unknown {
  const pathname = path.split("?", 1)[0];
  if (pathname === "/api/v1/agent/access-key") {
    if (method === "DELETE") {
      return projectCredentialMetadata(payload, { ok: true });
    }
    if (method === "POST") {
      return projectCredentialMetadata(payload, {
        requestId: true,
        key: ACCESS_KEY_METADATA_SHAPE,
        retiringKey: ACCESS_KEY_METADATA_SHAPE,
      });
    }
    return projectCredentialMetadata(payload, {
      key: ACCESS_KEY_METADATA_SHAPE,
      retiringKey: ACCESS_KEY_METADATA_SHAPE,
    });
  }
  if (pathname === "/api/v1/agent/access-key/origins") {
    return projectCredentialMetadata(payload, { ok: true, origins: [true] });
  }
  if (pathname === "/api/v1/agent/providers") {
    return projectCredentialMetadata(payload, { providers: [PROVIDER_STATE_SHAPE] });
  }
  if (pathname === "/api/v1/agent/providers/keys") {
    if (method === "POST") {
      return projectCredentialMetadata(payload, { key: PROVIDER_KEY_SHAPE });
    }
    return projectCredentialMetadata(payload, { keys: [PROVIDER_KEY_SHAPE] });
  }
  if (
    pathname === "/api/v1/agent/providers/keys/byok" ||
    /^\/api\/v1\/agent\/providers\/keys\/[^/]+\/rotate-secret$/.test(pathname)
  ) {
    return projectCredentialMetadata(payload, { key: PROVIDER_KEY_SHAPE });
  }
  if (/^\/api\/v1\/agent\/providers\/keys\/[^/]+$/.test(pathname)) {
    return projectCredentialMetadata(
      payload,
      method === "DELETE" ? { deleted: true } : { key: PROVIDER_KEY_SHAPE },
    );
  }
  if (pathname === "/api/v1/agent/providers/models") {
    return projectCredentialMetadata(payload, [PROVIDER_MODEL_SHAPE]);
  }
  return payload;
}

export async function credentialRequestResult<T = unknown>(path: string, scope: AgentScope, options: RequestOptions = {}): Promise<AgentRequestResult<T>> {
  const { status, payload } = await agentRequestResult<unknown>(path, scope, options);
  assertCredentialSafePayload(payload);
  return {
    status,
    payload: projectKnownCredentialEndpoint(path, options.method ?? "GET", payload) as T,
  };
}

export async function credentialRequest<T = unknown>(path: string, scope: AgentScope, options: RequestOptions = {}): Promise<T> {
  return (await credentialRequestResult<T>(path, scope, options)).payload;
}

export async function credentialPanel<T = unknown>(path: string, scope: AgentScope): Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }> {
  try {
    return { ok: true, data: await credentialRequest<T>(path, scope) };
  } catch (error) {
    const code = error instanceof PlatosAgentApiError
      ? error.code
      : error instanceof UnsafeCredentialResponseError
        ? error.code
        : "AGENT_UNAVAILABLE";
    return { ok: false, error: { code, message: "Credential metadata is unavailable" } };
  }
}

export function credentialErrorMessage(error: unknown, operation: string): string {
  if (error instanceof PlatosAgentApiError) return `${operation} failed (${error.code})`;
  if (error instanceof UnsafeCredentialResponseError) return `${operation} failed (${error.code})`;
  return `${operation} failed`;
}

export function parseJsonField(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || value.trim() === "") return {};
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object") throw new Error("Payload must be an object or array");
  return parsed;
}
