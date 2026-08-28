/**
 * EOBD.57 — Centralized Zod env validator for the Platos agent.
 * Webapp has env.server.ts; the agent previously read `process.env.X`
 * ad-hoc so missing vars surfaced at first use. Exports:
 *   - `parseEnv()`: strict parse, throws.
 *   - `validateAgentEnv()`: non-throwing, used by main.ts to print every
 *     error at once before exit(1).
 *   - `env`: lazy typed accessor.
 * Scope: validator + main.ts hook only. Service-level sweep is a follow-up.
 */

import { z } from "zod";

// Sentinel values from `.env.example`. Safe for dev; forbidden in prod.
const DEV_SENTINEL_ENCRYPTION_KEY =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const DEV_SENTINEL_MESSAGE_ENCRYPTION_KEY =
  "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe";
const DEV_SENTINEL_SESSION_SECRET = "dev-session-secret-rotate-before-prod";
const DEV_SENTINEL_WEBAPP_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DEV_COMPONENT_AUTH_SECRET = "dev-internal-secret-change-me";
// WIN-293 — the `.env.example` placeholder for the control-plane trust anchor.
// A distinct value (not reused from the encryption-key sentinel) so a copied
// `.env` is recognizable, and rejected in production below: shipping a public
// value here would hand every reader the operator credential.
const DEV_SENTINEL_INTERNAL_AUTH_TOKEN =
  "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
const COMPONENT_AUTH_PLACEHOLDERS = new Set([
  "",
  DEV_COMPONENT_AUTH_SECRET,
  "change-me",
  "changeme",
]);
const LEGACY_COMPONENT_AUTH_KEY = [`TRI${"GGER"}`, "INTERNAL", "SECRET"].join("_");

export const COMPONENT_AUTH_COMPATIBILITY_POLICY = Object.freeze({
  legacyKeyAcceptedThrough: "1.x",
  legacyKeyRemovedIn: "2.0.0",
});

function normalizeAgentEnvSource(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.PLATOS_COMPONENT_AUTH_SECRET?.trim()) return source;
  const legacyValue = source[LEGACY_COMPONENT_AUTH_KEY];
  return legacyValue === undefined
    ? source
    : { ...source, PLATOS_COMPONENT_AUTH_SECRET: legacyValue };
}

// Helpers
const boolLike = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optTrimmedString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined));

const intString = (name: string, opts?: { min?: number; max?: number }) =>
  z
    .string()
    .optional()
    .refine((v) => v === undefined || v === "" || /^\d+$/.test(v), {
      message: `${name} must be a non-negative integer`,
    })
    .transform((v) => (v === undefined || v === "" ? undefined : Number(v)))
    .refine((v) => v === undefined || opts?.min === undefined || v >= opts.min, {
      message: `${name} must be >= ${opts?.min}`,
    })
    .refine((v) => v === undefined || opts?.max === undefined || v <= opts.max, {
      message: `${name} must be <= ${opts?.max}`,
    });

const floatString = (name: string, opts?: { min?: number; max?: number }) =>
  z
    .string()
    .optional()
    .refine((v) => v === undefined || v === "" || /^-?\d+(\.\d+)?$/.test(v), {
      message: `${name} must be a number`,
    })
    .transform((v) => (v === undefined || v === "" ? undefined : Number(v)))
    .refine((v) => v === undefined || opts?.min === undefined || v >= opts.min, {
      message: `${name} must be >= ${opts?.min}`,
    })
    .refine((v) => v === undefined || opts?.max === undefined || v <= opts.max, {
      message: `${name} must be <= ${opts?.max}`,
    });

const hex64 = (name: string) =>
  z.string().regex(/^[0-9a-fA-F]{64}$/, {
    message: `${name} must be 64 hex chars (32 bytes)`,
  });

const webappEncryptionKey = z
  .string()
  .refine((value) => /^[0-9a-fA-F]{64}$/.test(value) || Buffer.byteLength(value, "utf8") === 32, {
    message: "ENCRYPTION_KEY must be 64 hex chars or an existing 32-byte UTF-8 key",
  });

const credentialRootKeys = z.string().transform((raw, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PLATOS_CREDENTIAL_ROOT_KEYS must be a JSON object mapping positive versions to 64-hex keys",
    });
    return z.NEVER;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PLATOS_CREDENTIAL_ROOT_KEYS must be a JSON object mapping positive versions to 64-hex keys",
    });
    return z.NEVER;
  }
  const keys: Record<number, string> = {};
  for (const [rawVersion, rawKey] of Object.entries(parsed)) {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version <= 0 || typeof rawKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PLATOS_CREDENTIAL_ROOT_KEYS must map positive integer versions to 64-hex keys",
      });
      return z.NEVER;
    }
    keys[version] = rawKey;
  }
  if (Object.keys(keys).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PLATOS_CREDENTIAL_ROOT_KEYS must contain at least one key",
    });
    return z.NEVER;
  }
  return keys;
});

function normalizedEncryptionKey(value: string): string {
  return (
    /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "utf8")
  ).toString("hex");
}

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────

export const AgentEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Core infra — required in every environment
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // Secrets
    PLATOS_ENCRYPTION_KEY: hex64("PLATOS_ENCRYPTION_KEY"),
    // Environment credential envelope key ring. The active version must be
    // present in the JSON map; prior versions remain during staged rotation.
    PLATOS_CREDENTIAL_ROOT_KEY_VERSION: intString("PLATOS_CREDENTIAL_ROOT_KEY_VERSION", {
      min: 1,
    }).pipe(z.number()),
    PLATOS_CREDENTIAL_ROOT_KEYS: credentialRootKeys,
    SESSION_SECRET: z.string().min(16, {
      message: "SESSION_SECRET must be at least 16 chars",
    }),
    // Webapp/operator-TOTP AES key. New values use canonical 64-hex transport;
    // exact historical 32-byte UTF-8 values remain valid for ciphertext reads.
    // Optional on the agent so existing deployments boot without forcing
    // an env change; downstream consumers handle absence by disabling
    // scoped env-var decryption.
    ENCRYPTION_KEY: webappEncryptionKey.optional(),

    // Message encryption. Development may omit it for legacy plaintext
    // fixtures; production requires it and fails closed below.
    PLATOS_MESSAGE_ENCRYPTION_KEY: hex64("PLATOS_MESSAGE_ENCRYPTION_KEY").optional(),
    PLATOS_MESSAGE_ENCRYPTION_KEY_V: intString("PLATOS_MESSAGE_ENCRYPTION_KEY_V", {
      min: 1,
    }),

    // CORS — required in production unless PLATOS_CORS_UNIVERSAL=true
    // (see EOBD.11 + the universal-CORS hosted-demo escape hatch in main.ts).
    PLATOS_CORS_ORIGIN: z.string().optional(),
    // Hosted-demo escape hatch. When `true` in production, the CORS layer
    // accepts ANY origin (with credentials disabled so cookies never leak
    // across origins). The per-entity allowedOrigins check still gates
    // which entity any given origin can talk to. Use this for a public
    // playground (e.g. play.platos.dev) where third-party integrators
    // need to test embeds from arbitrary domains. Self-hosters keep it
    // off and supply an explicit allowlist via PLATOS_CORS_ORIGIN.
    PLATOS_CORS_UNIVERSAL: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((v) => v === "true"),

    // External Trigger integration
    TRIGGER_API_URL: z.string().url().optional(),
    TRIGGER_SECRET_KEY: optTrimmedString,
    // Platos-owned HMAC key for authenticated component callbacks. The
    // external Trigger adapter is one consumer, not the owner of this key.
    PLATOS_COMPONENT_AUTH_SECRET: optTrimmedString,
    PLATOS_TRIGGER_API_URL: z.string().url().optional(),
    PLATOS_TRIGGER_API_KEY: optTrimmedString,
    PLATOS_TRIGGER_PROJECT_REF: optTrimmedString,

    // Worker scaling — concurrency limits for each task queue.
    // All optional; task files use parseInt(process.env.X ?? "default") directly.
    // Declared here so typecheck + validateAgentEnv() can surface bad values.
    PLATOS_WORKER_CONCURRENCY: intString("PLATOS_WORKER_CONCURRENCY", { min: 1 }),
    PLATOS_BATCH_CONCURRENCY: intString("PLATOS_BATCH_CONCURRENCY", { min: 1 }),
    PLATOS_CUSTOM_TASK_CONCURRENCY: intString("PLATOS_CUSTOM_TASK_CONCURRENCY", { min: 1 }),
    PLATOS_PER_ORG_CONCURRENCY: intString("PLATOS_PER_ORG_CONCURRENCY", { min: 1 }),
    PLATOS_PER_ORG_BATCH_CONCURRENCY: intString("PLATOS_PER_ORG_BATCH_CONCURRENCY", { min: 1 }),
    PLATOS_BATCH_ITEM_CONCURRENCY: intString("PLATOS_BATCH_ITEM_CONCURRENCY", { min: 1 }),

    // Model provider keys — all optional at boot. At least one is required
    // at runtime, but we don't enforce here (operators may link keys via
    // the scoped provider UI instead of env vars).
    ANTHROPIC_API_KEY: optTrimmedString,
    OPENAI_API_KEY: optTrimmedString,
    GOOGLE_GENERATIVE_AI_API_KEY: optTrimmedString,
    // Voyage AI embeddings (alternative to OpenAI). Used by
    // EmbeddingService when PLATOS_EMBEDDING_PROVIDER=voyage. Scope-linked
    // key wins over env (same pattern as OPENAI_API_KEY).
    VOYAGE_API_KEY: optTrimmedString,

    // MinIO / attachments (THEME D). All 5 are all-or-nothing.
    MINIO_ENDPOINT: optTrimmedString,
    MINIO_PUBLIC_ENDPOINT: z.string().url().optional(),
    MINIO_ACCESS_KEY: optTrimmedString,
    MINIO_SECRET_KEY: optTrimmedString,
    MINIO_BUCKET: optTrimmedString,
    MINIO_REGION: optTrimmedString,

    // App / HTTP
    PLATOS_AGENT_PORT: intString("PLATOS_AGENT_PORT", { min: 1, max: 65535 }),
    PLATOS_AGENT_API_URL: z.string().url().optional(),
    PLATOS_AGENT_HTTP_URL: z.string().url().optional(),
    PLATOS_AGENT_WS_URL: z.string().url().optional(),
    APP_ORIGIN: z.string().url().optional(),
    PLATOS_WEBAPP_ADMIN_URL: z.string().url().optional(),
    PLATOS_INTERNAL_AUTH_TOKEN: optTrimmedString,
    // WIN-296 — narrow, one-use first-install secret. When set, it authorizes
    // exactly one `POST /api/v1/agent/access-key` per Environment over the
    // trusted direct-header channel, gated on a genuine zero-key state and
    // consumed atomically. Leave UNSET after the first key exists; the
    // AccessKey lifecycle otherwise requires PLATOS_INTERNAL_AUTH_TOKEN.
    // (Read via process.env directly in AuthService so the guard and service
    // observe the same value in lightweight test harnesses.)
    PLATOS_BOOTSTRAP_TOKEN: optTrimmedString,
    // Optional ISO-8601 expiry that time-limits the install secret above.
    PLATOS_BOOTSTRAP_TOKEN_EXPIRES_AT: optTrimmedString,
    PLATOS_ERASURE_HASH_SALT: z.string().min(32).optional(),

    // Test mode (EOBD.4). Belt-and-braces production guard below.
    PLATOS_TEST_MODE: boolLike,

    // Models + memory
    PLATOS_DEFAULT_MODEL: optTrimmedString,
    PLATOS_EMBEDDING_MODEL: optTrimmedString,
    // Embedding provider selector. Default "openai" preserves existing
    // behaviour. "voyage" routes embed calls to Voyage AI's endpoint
    // (https://api.voyageai.com/v1/embeddings); default Voyage model is
    // `voyage-large-2` because it returns 1536-dim vectors that fit the
    // existing `PlatosMemory.embedding vector(1536)` column without a
    // schema migration.
    PLATOS_EMBEDDING_PROVIDER: z.enum(["openai", "voyage"]).optional().default("openai"),
    PLATOS_MEMORY_EXTRACTION_MODEL: optTrimmedString,
    PLATOS_MEMORY_INJECT_BUDGET_TOKENS: intString("PLATOS_MEMORY_INJECT_BUDGET_TOKENS", { min: 0 }),
    // Hard ceiling on the embedding-provider HTTP call (ms). A bare
    // `await fetch` to Voyage/OpenAI with no timeout will hang a whole
    // turn if the provider is slow/rate-limited (observed: 64s pre-LLM
    // stall on a cold key). Default 8s. Consumed in EmbeddingService.
    PLATOS_EMBEDDING_TIMEOUT_MS: intString("PLATOS_EMBEDDING_TIMEOUT_MS", {
      min: 500,
    }),
    // Ceiling on the inline pre-LLM memory-injection semanticSearch (ms).
    // Memory enrichment is best-effort; it must never block the response.
    // If it doesn't return in time we skip the block and call the LLM.
    // Default 5s. Consumed in AgentService.stream.
    PLATOS_MEMORY_INJECT_TIMEOUT_MS: intString("PLATOS_MEMORY_INJECT_TIMEOUT_MS", { min: 250 }),
    PLATOS_WORKING_MEMORY_TTL: intString("PLATOS_WORKING_MEMORY_TTL", {
      min: 0,
    }),

    // Theme M.4 — PLATOS_PROFILE_UNIFIED retired. Profiles now live
    // exclusively in PlatosMemory (kind="profile"). Any .env still
    // setting this var is ignored harmlessly by the passthrough().

    // Attachments / sizes / limits
    PLATOS_ATTACHMENT_TTL_DAYS: intString("PLATOS_ATTACHMENT_TTL_DAYS", {
      min: 1,
    }),
    PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS: intString("PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS", {
      min: 60,
      max: 3600,
    }),
    PLATOS_ATTACHMENT_GRACE_DAYS: intString("PLATOS_ATTACHMENT_GRACE_DAYS", {
      min: 1,
    }),
    PLATOS_ATTACHMENT_ORG_QUOTA_BYTES: intString("PLATOS_ATTACHMENT_ORG_QUOTA_BYTES", {
      min: 1,
    }),
    PLATOS_MAX_ATTACHMENT_BYTES: intString("PLATOS_MAX_ATTACHMENT_BYTES", {
      min: 1,
    }),
    PLATOS_MAX_TURN_ATTACHMENT_TOTAL_BYTES: intString("PLATOS_MAX_TURN_ATTACHMENT_TOTAL_BYTES", {
      min: 1,
    }),
    PLATOS_WS_MAX_PAYLOAD_BYTES: intString("PLATOS_WS_MAX_PAYLOAD_BYTES", {
      min: 1,
    }),
    PLATOS_TOOL_RESULT_MAX_BYTES: intString("PLATOS_TOOL_RESULT_MAX_BYTES", {
      min: 1,
    }),
    PLATOS_TURN_MAX_MS: intString("PLATOS_TURN_MAX_MS", { min: 1000 }),
    PLATOS_MAX_JOBS_PER_TURN: intString("PLATOS_MAX_JOBS_PER_TURN", { min: 0 }),
    // OSS launch member cap — hard limit on org members + pending invites.
    // Default mirrors the webapp default (2). Self-hosters bump as needed.
    // Enforced inside `OrganizationService.addMemberInvite` so the cap
    // applies consistently across REST + MCP `org.add_member` + webapp.
    PLATOS_MAX_PROJECT_MEMBERS: intString("PLATOS_MAX_PROJECT_MEMBERS", {
      min: 1,
    }),
    // EOBD.89 + EOBD.106 — vars added for public-guest mint + SSE heartbeat.
    PLATOS_PUBLIC_GUEST_IP_LIMIT: intString("PLATOS_PUBLIC_GUEST_IP_LIMIT", {
      min: 0,
    }),
    PLATOS_PUBLIC_GUEST_AGENT_LIMIT: intString("PLATOS_PUBLIC_GUEST_AGENT_LIMIT", { min: 0 }),
    PLATOS_PUBLIC_GUEST_TOKEN_TTL_SECONDS: intString("PLATOS_PUBLIC_GUEST_TOKEN_TTL_SECONDS", {
      min: 60,
    }),
    PLATOS_STREAM_HEARTBEAT_MS: intString("PLATOS_STREAM_HEARTBEAT_MS", {
      min: 1000,
    }),

    // Rate limits
    PLATOS_RATE_LIMIT_PER_MIN: intString("PLATOS_RATE_LIMIT_PER_MIN", { min: 0 }),
    PLATOS_RATE_LIMIT_PER_DAY: intString("PLATOS_RATE_LIMIT_PER_DAY", { min: 0 }),
    PLATOS_RATE_LIMIT_USER_PER_MIN: intString("PLATOS_RATE_LIMIT_USER_PER_MIN", { min: 0 }),
    PLATOS_USER_RATE_PER_MIN: intString("PLATOS_USER_RATE_PER_MIN", { min: 0 }),
    PLATOS_USER_RATE_PER_HOUR: intString("PLATOS_USER_RATE_PER_HOUR", { min: 0 }),
    PLATOS_USER_RATE_PER_DAY: intString("PLATOS_USER_RATE_PER_DAY", { min: 0 }),
    PLATOS_AGENT_USER_TOOL_RATE_PER_MIN: intString("PLATOS_AGENT_USER_TOOL_RATE_PER_MIN", {
      min: 0,
    }),
    /**
     * PRELAUNCH-A3-10 — when true, rate-limit guard rejects requests with no
     * scope.userId (401). Default false preserves single-tenant + early-OSS
     * use cases where every turn is implicitly attributed to one operator.
     * Multi-tenant deployments should set this true so per-user wildcard caps
     * are enforceable.
     */
    PLATOS_REQUIRE_USER_ID: boolLike,
    /**
     * PRELAUNCH-A3-11 — per-(agent,user) cap on approval-events emitted per
     * hour. Defaults to 20. Prevents a misbehaving agent from firing
     * unlimited approval modals at a single user.
     */
    PLATOS_AGENT_USER_APPROVAL_PER_HOUR: intString("PLATOS_AGENT_USER_APPROVAL_PER_HOUR", {
      min: 0,
    }),

    // Observability
    // Optional; compose passes empty-string when unset so treat "" as
    // "not set" via the preprocess shim. `.url()` then enforces shape
    // only when the operator actually supplied one.
    PLATOS_SENTRY_DSN: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().url().optional()
    ),
    SENTRY_DSN: z.string().url().optional(),
    PLATOS_SENTRY_TRACES_SAMPLE_RATE: floatString("PLATOS_SENTRY_TRACES_SAMPLE_RATE", {
      min: 0,
      max: 1,
    }),
    PLATOS_OTEL_CLICKHOUSE_URL: z.string().url().optional(),
    PLATOS_TELEMETRY_DATABASE: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
        message: "PLATOS_TELEMETRY_DATABASE must be a valid unquoted ClickHouse identifier",
      })
      .default("platos_telemetry"),
    PLATOS_OTEL_SAMPLE_RATE: floatString("PLATOS_OTEL_SAMPLE_RATE", {
      min: 0,
      max: 1,
    }),
    PLATOS_OTEL_STDOUT: boolLike,

    // WIN-133 — the turn-shaped analytical projection (platos_observability).
    // Declared here so the schema stays a complete inventory of what the
    // process reads; the sink itself re-reads process.env per call so a
    // rotated credential does not need a restart. Compose passes an unset
    // variable as "", so the same preprocess shim the Sentry DSN uses applies.
    PLATOS_OBSERVABILITY_CLICKHOUSE_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().url().optional()
    ),
    /** Fail startup when a configured sink cannot accept a write. Off by default. */
    PLATOS_OBSERVABILITY_REQUIRE_SINK: boolLike,
    PLATOS_OBSERVABILITY_BATCH_SIZE: optTrimmedString,
    PLATOS_OBSERVABILITY_DRAIN_BATCH_SIZE: optTrimmedString,
    PLATOS_OBSERVABILITY_MAX_RETRIES: optTrimmedString,

    // Misc
    PLATOS_ALLOW_HTTP_WEBHOOKS: boolLike,
    PLATOS_SECRETS_TMP_DIR: optTrimmedString,
    PLATOS_VERSION: optTrimmedString,
    PLATOS_RELEASE: optTrimmedString,
    GIT_COMMIT: optTrimmedString,

    // MCP approval queue — opt-in. When `true`, the Platform MCP router
    // creates a real `PlatosAgentApproval` row for every
    // `require_approval` call and returns -32002 AWAITING_APPROVAL with
    // the approval id; the operator approves in the dashboard, then the
    // client retries with `X-Platos-Approval-Id`. When unset/false the
    // legacy auto-approve path stays.
    MCP_INTERACTIVE_APPROVALS: boolLike,
    // Optional SLA window for MCP approvals (seconds). Default 1h.
    MCP_APPROVAL_TTL_SECONDS: intString("MCP_APPROVAL_TTL_SECONDS", { min: 60 }),

    // ── MCP consumption (Surface 2) — official-SDK client-pool knobs ──
    // Idle window before a pooled MCP client connection is closed + dropped
    // (ms). Default 300000 (5 min). Consumed in McpConnectionPool.
    MCP_POOL_IDLE_MS: intString("MCP_POOL_IDLE_MS", { min: 1000 }),
    // Max live pooled MCP client connections; the least-recently-used entry is
    // evicted (and its Client closed) on overflow. Default 32.
    MCP_POOL_SIZE: intString("MCP_POOL_SIZE", { min: 1 }),
    // Per tools/call request timeout (ms). Default 30000. Consumed in
    // McpToolExecutorService.
    MCP_CALL_TIMEOUT_MS: intString("MCP_CALL_TIMEOUT_MS", { min: 1000 }),
    // Discovery timeout — tools/list + the connect() handshake (ms).
    // Default 15000. Consumed in McpServerRegistryService + McpConnectionPool.
    MCP_DISCOVERY_TIMEOUT_MS: intString("MCP_DISCOVERY_TIMEOUT_MS", { min: 1000 }),
    // Periodic MCP-entity discovery refresh interval (seconds). The sweep
    // re-discovers connectionKind="mcp" entities whose lastDiscoveryAt is older
    // than this window (design Commit 5 / §5). Default 300 (5 min). Consumed in
    // EntityMcpDiscoverySchedulerService (used as the staleness threshold; the
    // cron cadence itself is fixed at 1-min ticks).
    PLATOS_MCP_DISCOVERY_INTERVAL_SEC: intString("PLATOS_MCP_DISCOVERY_INTERVAL_SEC", { min: 30 }),
  })
  .passthrough() // Don't choke on unrelated env vars (PATH, HOME, etc.)
  .superRefine((data, ctx) => {
    // EOBD.3 — sentinel check. Never boot with known-public dev values
    // under NODE_ENV=production.
    if (data.NODE_ENV === "production") {
      if (!data.PLATOS_ERASURE_HASH_SALT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_ERASURE_HASH_SALT"],
          message: "PLATOS_ERASURE_HASH_SALT is required in production",
        });
      }
      if (data.PLATOS_ENCRYPTION_KEY === DEV_SENTINEL_ENCRYPTION_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_ENCRYPTION_KEY"],
          message:
            "PLATOS_ENCRYPTION_KEY is the .env.example sentinel value — rotate before going to production",
        });
      }
      if (data.PLATOS_MESSAGE_ENCRYPTION_KEY === DEV_SENTINEL_MESSAGE_ENCRYPTION_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_MESSAGE_ENCRYPTION_KEY"],
          message:
            "PLATOS_MESSAGE_ENCRYPTION_KEY is the .env.example sentinel value — rotate before going to production",
        });
      }
      if (!data.PLATOS_MESSAGE_ENCRYPTION_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_MESSAGE_ENCRYPTION_KEY"],
          message: "PLATOS_MESSAGE_ENCRYPTION_KEY is required in production",
        });
      }
      if (data.SESSION_SECRET === DEV_SENTINEL_SESSION_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SESSION_SECRET"],
          message:
            "SESSION_SECRET is the .env.example sentinel value — rotate before going to production",
        });
      }
      if (data.ENCRYPTION_KEY === DEV_SENTINEL_WEBAPP_ENCRYPTION_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ENCRYPTION_KEY"],
          message:
            "ENCRYPTION_KEY is the .env.example sentinel value — rotate before going to production",
        });
      }
      if (COMPONENT_AUTH_PLACEHOLDERS.has(data.PLATOS_COMPONENT_AUTH_SECRET ?? "")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_COMPONENT_AUTH_SECRET"],
          message:
            "PLATOS_COMPONENT_AUTH_SECRET must be set to a strong random value in production",
        });
      }
      // WIN-293 — the control-plane trust anchor is the ONLY credential that
      // grants the operator tier over the direct-header channel. It must be
      // present and must not be the public `.env.example` placeholder, or the
      // fail-closed guard is defeated by a well-known token.
      if (!data.PLATOS_INTERNAL_AUTH_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_INTERNAL_AUTH_TOKEN"],
          message: "PLATOS_INTERNAL_AUTH_TOKEN is required in production",
        });
      }
      if (data.PLATOS_INTERNAL_AUTH_TOKEN === DEV_SENTINEL_INTERNAL_AUTH_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_INTERNAL_AUTH_TOKEN"],
          message:
            "PLATOS_INTERNAL_AUTH_TOKEN is the .env.example sentinel value — rotate before going to production",
        });
      }
    }

    // Compare normalized key bytes in every environment
    // so a copied key cannot collapse the three intentional trust domains.
    const encryptionDomains = [
      ["ENCRYPTION_KEY", data.ENCRYPTION_KEY],
      ["PLATOS_ENCRYPTION_KEY", data.PLATOS_ENCRYPTION_KEY],
      ["PLATOS_MESSAGE_ENCRYPTION_KEY", data.PLATOS_MESSAGE_ENCRYPTION_KEY],
      ...Object.entries(data.PLATOS_CREDENTIAL_ROOT_KEYS).map(
        ([version, key]) => [`PLATOS_CREDENTIAL_ROOT_KEYS[${version}]`, key] as const,
      ),
    ] as const;
    for (let i = 0; i < encryptionDomains.length; i += 1) {
      for (let j = i + 1; j < encryptionDomains.length; j += 1) {
        const [leftName, leftValue] = encryptionDomains[i];
        const [rightName, rightValue] = encryptionDomains[j];
        if (
          !leftValue ||
          !rightValue ||
          normalizedEncryptionKey(leftValue) !== normalizedEncryptionKey(rightValue)
        ) {
          continue;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [rightName],
          message: `${rightName} must differ from ${leftName} — use separate keys for each encryption domain`,
        });
      }
    }

    if (!(data.PLATOS_CREDENTIAL_ROOT_KEY_VERSION in data.PLATOS_CREDENTIAL_ROOT_KEYS)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PLATOS_CREDENTIAL_ROOT_KEY_VERSION"],
        message: "PLATOS_CREDENTIAL_ROOT_KEY_VERSION must identify a key in PLATOS_CREDENTIAL_ROOT_KEYS",
      });
    }

    if (data.NODE_ENV === "production") {
      // EOBD.11 — CORS must be explicit in production unless the
      // operator opted into universal CORS via PLATOS_CORS_UNIVERSAL=true
      // (typically the hosted-demo case where third-party integrators
      // embed from arbitrary domains).
      const cors = (data.PLATOS_CORS_ORIGIN || "").trim();
      const universal = data.PLATOS_CORS_UNIVERSAL === true;
      if (!universal && (!cors || cors === "*")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PLATOS_CORS_ORIGIN"],
          message:
            "PLATOS_CORS_ORIGIN is required in production and must not be `*` — supply an explicit comma-separated origin list, or set PLATOS_CORS_UNIVERSAL=true to accept any origin (per-entity allowedOrigins still gates per-entity access).",
        });
      }
    }

    // EOBD.4 — belt-and-braces. main.ts also guards this; duplicate here
    // so the structured error surface includes it.
    if (data.NODE_ENV === "production" && data.PLATOS_TEST_MODE === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PLATOS_TEST_MODE"],
        message:
          "PLATOS_TEST_MODE=true is forbidden when NODE_ENV=production — it unlocks auth-bypass test endpoints",
      });
    }

    // MinIO — all-or-nothing. Either all 5 present, or none.
    const minioKeys = [
      "MINIO_ENDPOINT",
      "MINIO_ACCESS_KEY",
      "MINIO_SECRET_KEY",
      "MINIO_BUCKET",
      "MINIO_REGION",
    ] as const;
    const set = minioKeys.filter((k) => data[k] !== undefined && data[k] !== "");
    if (set.length > 0 && set.length < minioKeys.length) {
      const missing = minioKeys.filter((k) => !set.includes(k));
      for (const k of missing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [k],
          message: `${k} is required when any other MINIO_* var is set (missing: ${missing.join(
            ", "
          )})`,
        });
      }
    }
  });

export type AgentEnv = z.infer<typeof AgentEnvSchema>;

/** Strict parse. Throws a ZodError on failure. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AgentEnv {
  return AgentEnvSchema.parse(normalizeAgentEnvSource(source));
}

/** Non-throwing variant for main.ts. Returns structured errors. */
export function validateAgentEnv(
  source: NodeJS.ProcessEnv = process.env
): { ok: true; env: AgentEnv } | { ok: false; errors: string[] } {
  const result = AgentEnvSchema.safeParse(normalizeAgentEnvSource(source));
  if (result.success) {
    return { ok: true, env: result.data };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}

// Lazy typed accessor. Evaluates on first use — safe to import at the
  // top of a file without starting validation before main.ts runs.
let _env: AgentEnv | undefined;
export const env: AgentEnv = new Proxy({} as AgentEnv, {
  get(_target, prop) {
    if (!_env) {
      _env = parseEnv();
    }
    return (_env as unknown as Record<string | symbol, unknown>)[prop];
  },
}) as AgentEnv;
