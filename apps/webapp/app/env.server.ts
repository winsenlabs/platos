import { z } from "zod";
import { BoolEnv } from "./utils/boolEnv";
import { isValidDatabaseUrl } from "./utils/db";
import { isValidRegex } from "./utils/regex";
import { isAes256KeyInput } from "./utils/encryptionKey.server";

const DEV_SENTINEL_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ─────────────────────────────────────────────────────────────
// Theme BR — backwards-compat env-var fallback.
//
// When Platos renames a TRIGGER_* env-var to PLATOS_*, we keep the
// old name working for one release cycle. Resolution order:
//   1. Read the PLATOS_* name first (new canonical).
//   2. Fall back to the deprecated TRIGGER_* name.
//   3. Emit a one-shot console.warn on boot when only the deprecated
//      name was set.
//
// Alias resolution runs once, at module load, *before* Zod parses
// process.env. We write the resolved value back into process.env under
// the legacy TRIGGER_* key so the rest of the schema below stays
// unchanged (no schema-shape churn for one-release aliases).
// ─────────────────────────────────────────────────────────────
const PLATOS_BR_ENV_ALIASES: Array<{ new: string; old: string }> = [
  // Platos telemetry opt-out — Platos-specific config (upstream trigger.dev
  // does not read this var).
  { new: "PLATOS_TELEMETRY_DISABLED", old: "TRIGGER_TELEMETRY_DISABLED" },
];

for (const alias of PLATOS_BR_ENV_ALIASES) {
  const newVal = process.env[alias.new];
  const oldVal = process.env[alias.old];
  if (newVal !== undefined && newVal !== "") {
    // New name wins; mirror into the legacy key so downstream reads still work.
    process.env[alias.old] = newVal;
    continue;
  }
  if (oldVal !== undefined && oldVal !== "") {
    // Legacy name was set. Leave both in place.
    // eslint-disable-next-line no-console
    console.warn(
      `[Platos boot] Env var ${alias.old} is deprecated — migrate to ${alias.new} before the next Platos major.`
    );
  }
}

const GithubAppEnvSchema = z.preprocess(
  (val) => {
    const obj = val as any;
    if (!obj || !obj.GITHUB_APP_ENABLED) {
      return { ...obj, GITHUB_APP_ENABLED: "0" };
    }
    return obj;
  },
  z.discriminatedUnion("GITHUB_APP_ENABLED", [
    z.object({
      GITHUB_APP_ENABLED: z.literal("1"),
      GITHUB_APP_ID: z.string(),
      GITHUB_APP_PRIVATE_KEY: z.string(),
      GITHUB_APP_WEBHOOK_SECRET: z.string(),
      GITHUB_APP_SLUG: z.string(),
    }),
    z.object({
      GITHUB_APP_ENABLED: z.literal("0"),
    }),
  ])
);

// eventually we can make all S2 env vars required once the S2 OSS version is out
const S2EnvSchema = z.preprocess(
  (val) => {
    const obj = val as any;
    if (!obj || !obj.S2_ENABLED) {
      return { ...obj, S2_ENABLED: "0" };
    }
    return obj;
  },
  z.discriminatedUnion("S2_ENABLED", [
    z.object({
      S2_ENABLED: z.literal("1"),
      S2_ACCESS_TOKEN: z.string(),
      S2_DEPLOYMENT_LOGS_BASIN_NAME: z.string(),
      S2_DEPLOYMENT_STREAMS_LOCAL: z.string().default("0"),
    }),
    z.object({
      S2_ENABLED: z.literal("0"),
    }),
  ])
);

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.union([z.literal("development"), z.literal("production"), z.literal("test")]),
    DATABASE_URL: z
      .string()
      .refine(
        isValidDatabaseUrl,
        "DATABASE_URL is invalid, for details please check the additional output above this message."
      ),
    DATABASE_CONNECTION_LIMIT: z.coerce.number().int().default(10),
    DATABASE_POOL_TIMEOUT: z.coerce.number().int().default(60),
    DATABASE_CONNECTION_TIMEOUT: z.coerce.number().int().default(20),
    DIRECT_URL: z
      .string()
      .refine(
        isValidDatabaseUrl,
        "DIRECT_URL is invalid, for details please check the additional output above this message."
      ),
    DATABASE_READ_REPLICA_URL: z.string().optional(),
    SESSION_SECRET: z.string(),
    MAGIC_LINK_SECRET: z.string(),
    // New deployments use 64 hex chars. Exact historical 32-byte UTF-8 keys
    // remain valid so existing ciphertext stays decryptable.
    ENCRYPTION_KEY: z
      .string()
      .refine(
        isAes256KeyInput,
        "ENCRYPTION_KEY must be 64 hex chars or an existing 32-byte UTF-8 key."
      ),
    WHITELISTED_EMAILS: z
      .string()
      .refine(isValidRegex, "WHITELISTED_EMAILS must be a valid regex.")
      .optional(),
    ADMIN_EMAILS: z.string().refine(isValidRegex, "ADMIN_EMAILS must be a valid regex.").optional(),
    REMIX_APP_PORT: z.string().optional(),
    LOGIN_ORIGIN: z.string().default("http://localhost:3030"),
    LOGIN_RATE_LIMITS_ENABLED: BoolEnv.default(true),
    APP_ORIGIN: z.string().default("http://localhost:3030"),
    API_ORIGIN: z.string().optional(),
    STREAM_ORIGIN: z.string().optional(),
    ELECTRIC_ORIGIN: z.string().default("http://localhost:3060"),
    // A comma separated list of electric origins to shard into different electric instances by environmentId
    // example: "http://localhost:3060,http://localhost:3061,http://localhost:3062"
    ELECTRIC_ORIGIN_SHARDS: z.string().optional(),
    APP_ENV: z.string().default(process.env.NODE_ENV),
    SERVICE_NAME: z.string().default("platos webapp"),
    POSTHOG_PROJECT_KEY: z.string().default("phc_usXWiCDcvzriZFHHc2vVCV8J2h9ozCxkASCEz6a7pw3U"),
    POSTHOG_API_HOST: z.string().default("https://us.i.posthog.com"),
    TRIGGER_TELEMETRY_DISABLED: z.string().optional(),
    AUTH_GITHUB_CLIENT_ID: z.string().optional(),
    AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
    AUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    AUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
    EMAIL_TRANSPORT: z.enum(["resend", "smtp", "aws-ses"]).optional(),
    FROM_EMAIL: z.string().optional(),
    REPLY_TO_EMAIL: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_SECURE: BoolEnv.optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),

    PLAIN_API_KEY: z.string().optional(),
    WORKER_SCHEMA: z.string().default("graphile_worker"),
    WORKER_CONCURRENCY: z.coerce.number().int().default(10),
    WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
    WORKER_ENABLED: z.string().default("true"),
    GRACEFUL_SHUTDOWN_TIMEOUT: z.coerce.number().int().default(60000),
    DISABLE_SSE: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),

    // Redis options
    REDIS_HOST: z.string().optional(),
    REDIS_READER_HOST: z.string().optional(),
    REDIS_READER_PORT: z.coerce.number().optional(),
    REDIS_PORT: z.coerce.number().optional(),
    REDIS_USERNAME: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    REDIS_TLS_DISABLED: z.string().optional(),

    RATE_LIMIT_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    RATE_LIMIT_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    RATE_LIMIT_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    RATE_LIMIT_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    RATE_LIMIT_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    RATE_LIMIT_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    RATE_LIMIT_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
    RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    CACHE_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    CACHE_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    CACHE_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    CACHE_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    CACHE_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    CACHE_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    CACHE_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
    CACHE_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    REALTIME_STREAMS_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    REALTIME_STREAMS_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    REALTIME_STREAMS_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    REALTIME_STREAMS_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    REALTIME_STREAMS_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    REALTIME_STREAMS_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    REALTIME_STREAMS_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),
    REALTIME_STREAMS_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),
    REALTIME_STREAMS_INACTIVITY_TIMEOUT_MS: z.coerce.number().int().default(60000), // 1 minute

    REALTIME_MAXIMUM_CREATED_AT_FILTER_AGE_IN_MS: z.coerce
      .number()
      .int()
      .default(24 * 60 * 60 * 1000), // 1 day in milliseconds

    PUBSUB_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    PUBSUB_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    PUBSUB_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    PUBSUB_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    PUBSUB_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    PUBSUB_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    PUBSUB_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
    PUBSUB_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT: z.coerce.number().int().default(100),
    DEFAULT_ENV_EXECUTION_CONCURRENCY_BURST_FACTOR: z.coerce.number().default(1.0),
    DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT: z.coerce.number().int().default(300),
    DEFAULT_DEV_ENV_EXECUTION_ATTEMPTS: z.coerce.number().int().positive().default(1),

    //API Rate limiting
    /**
     * @example "60s"
     * @example "1m"
     * @example "1h"
     * @example "1d"
     * @example "1000ms"
     * @example "1000s"
     */
    API_RATE_LIMIT_REFILL_INTERVAL: z.string().default("10s"), // refill 250 tokens every 10 seconds
    API_RATE_LIMIT_MAX: z.coerce.number().int().default(750), // allow bursts of 750 requests
    API_RATE_LIMIT_REFILL_RATE: z.coerce.number().int().default(250), // refix 250 tokens every 10 seconds
    API_RATE_LIMIT_REQUEST_LOGS_ENABLED: z.string().default("0"),
    API_RATE_LIMIT_REJECTION_LOGS_ENABLED: z.string().default("1"),
    API_RATE_LIMIT_LIMITER_LOGS_ENABLED: z.string().default("0"),

    API_RATE_LIMIT_JWT_WINDOW: z.string().default("1m"),
    API_RATE_LIMIT_JWT_TOKENS: z.coerce.number().int().default(60),

    // Public docs API (/api/v1/public/*). Has to absorb a marketing-site
    // SSG that fans out ~250 requests from one Vercel build IP — the old
    // 60/min default 429'd the build reliably.
    PUBLIC_DOCS_RATE_LIMIT_WINDOW: z.string().default("60 s"),
    PUBLIC_DOCS_RATE_LIMIT_TOKENS: z.coerce.number().int().default(600),

    //v3
    PROVIDER_SECRET: z.string().default("provider-secret"),
    COORDINATOR_SECRET: z.string().default("coordinator-secret"),
    DEPOT_TOKEN: z.string().optional(),
    DEPOT_ORG_ID: z.string().optional(),
    DEPOT_REGION: z.string().default("us-east-1"),

    // Deployment registry (v3)
    DEPLOY_REGISTRY_HOST: z.string().min(1),
    DEPLOY_REGISTRY_USERNAME: z.string().optional(),
    DEPLOY_REGISTRY_PASSWORD: z.string().optional(),
    DEPLOY_REGISTRY_NAMESPACE: z.string().min(1).default("trigger"),
    DEPLOY_REGISTRY_ECR_TAGS: z.string().optional(), // csv, for example: "key1=value1,key2=value2"
    DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: z.string().optional(),
    DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: z.string().optional(),

    // Deployment registry (v4) - falls back to v3 registry if not specified
    V4_DEPLOY_REGISTRY_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_HOST)
      .pipe(z.string().min(1)), // Ensure final type is required string
    V4_DEPLOY_REGISTRY_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_USERNAME),
    V4_DEPLOY_REGISTRY_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_PASSWORD),
    V4_DEPLOY_REGISTRY_NAMESPACE: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_NAMESPACE)
      .pipe(z.string().min(1).default("trigger")), // Ensure final type is required string
    V4_DEPLOY_REGISTRY_ECR_TAGS: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_ECR_TAGS),
    V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_ARN),
    V4_DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.DEPLOY_REGISTRY_ECR_ASSUME_ROLE_EXTERNAL_ID),

    // Compute gateway (template creation during deploy finalize)
    COMPUTE_GATEWAY_URL: z.string().optional(),
    COMPUTE_GATEWAY_AUTH_TOKEN: z.string().optional(),
    COMPUTE_TEMPLATE_SHADOW_ROLLOUT_PCT: z.string().optional(),

    DEPLOY_IMAGE_PLATFORM: z.string().default("linux/amd64"),
    DEPLOY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .default(60 * 1000 * 8), // 8 minutes
    DEPLOY_QUEUE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .default(60 * 1000 * 15), // 15 minutes

    OBJECT_STORE_BASE_URL: z.string().optional(),
    OBJECT_STORE_BUCKET: z.string().optional(),
    OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
    OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
    OBJECT_STORE_REGION: z.string().optional(),
    OBJECT_STORE_SERVICE: z.string().default("s3"),

    // ─────────────────────────────────────────────────────────────
    // Platos Theme D — multimodal attachments (MinIO / S3-compatible)
    // ─────────────────────────────────────────────────────────────
    // In-container endpoint for `new S3Client()` inside the webapp.
    MINIO_ENDPOINT: z.string().default("http://minio:9000"),
    // Browser-facing endpoint for presigned URLs; defaults to the same
    // value for single-host dev. In prod override to the public hostname.
    MINIO_PUBLIC_ENDPOINT: z.string().default("http://localhost:9001"),
    MINIO_ACCESS_KEY: z.string().default("platos-minio-admin"),
    MINIO_SECRET_KEY: z.string().default("platos-minio-password"),
    MINIO_BUCKET: z.string().default("platos-media"),
    MINIO_REGION: z.string().default("us-east-1"),
    // Per-upload byte cap (default 100MB). Rejects larger uploads before
    // a presigned URL is minted.
    PLATOS_ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(100 * 1024 * 1024),
    // Per-org quota in bytes (default 10GB). Summed across every row in
    // the org on every upload request.
    PLATOS_ATTACHMENT_ORG_QUOTA_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024 * 1024),
    // Days before an unattached (transient) upload is hard-deleted.
    PLATOS_ATTACHMENT_GRACE_DAYS: z.coerce.number().int().positive().default(7),
    // Days before an attached upload expires.
    PLATOS_ATTACHMENT_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Presigned URL TTL, in seconds. Short-lived — default 15 minutes.
    PLATOS_ATTACHMENT_PRESIGN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    // Shared secret used by trusted admin jobs (e.g. the daily attachment
    // retention task) to call internal admin endpoints.
    PLATOS_INTERNAL_AUTH_TOKEN: z.string().optional(),
    // EOBD.66 — comma-separated userIds that are on legal hold and
    // cannot be deleted via DELETE /api/v1/admin/users/:userId/data.
    PLATOS_LEGAL_HOLD_USER_IDS: z.string().optional(),
    // Platform-issued Platos session tokens use the required SESSION_SECRET
    // declared above. The same deployment input must be shared with the agent.
    // OSS launch: hard cap on members per organization. The hosted
    // demo enforces 2; self-hosters can bump to whatever fits their
    // team. Counts active members + pending invites against the cap.
    // Set to a very large value to effectively disable the cap.
    PLATOS_MAX_PROJECT_MEMBERS: z.coerce.number().int().positive().default(2),

    // Phase 3 — content root for the public docs API. Resolved relative
    // to `process.cwd()` when unset; in dev that's `apps/webapp` so we
    // step up two levels. In prod containers we set the absolute path
    // (`/app/content`) explicitly so the search path is unambiguous.
    PLATOS_DOCS_CONTENT_ROOT: z.string().optional(),

    // Protocol to use for new uploads (e.g., "s3", "r2"). Data without protocol uses default provider above.
    // If specified, you must configure the corresponding provider using OBJECT_STORE_{PROTOCOL}_* env vars.
    // Example: OBJECT_STORE_DEFAULT_PROTOCOL=s3 requires OBJECT_STORE_S3_BASE_URL, OBJECT_STORE_S3_ACCESS_KEY_ID, etc.
    // Enables zero-downtime migration between providers (old data keeps working, new data uses new provider).
    OBJECT_STORE_DEFAULT_PROTOCOL: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .optional(),

    ARTIFACTS_OBJECT_STORE_BUCKET: z.string().optional(),
    ARTIFACTS_OBJECT_STORE_BASE_URL: z.string().optional(),
    ARTIFACTS_OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
    ARTIFACTS_OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
    ARTIFACTS_OBJECT_STORE_REGION: z.string().optional(),
    EVENTS_BATCH_SIZE: z.coerce.number().int().default(100),
    EVENTS_BATCH_INTERVAL: z.coerce.number().int().default(1000),
    EVENTS_DEFAULT_LOG_RETENTION: z.coerce.number().int().default(7),
    EVENTS_MIN_CONCURRENCY: z.coerce.number().int().default(1),
    EVENTS_MAX_CONCURRENCY: z.coerce.number().int().default(10),
    EVENTS_MAX_BATCH_SIZE: z.coerce.number().int().default(500),
    EVENTS_MEMORY_PRESSURE_THRESHOLD: z.coerce.number().int().default(5000),
    EVENTS_LOAD_SHEDDING_THRESHOLD: z.coerce.number().int().default(100000),
    EVENTS_LOAD_SHEDDING_ENABLED: z.string().default("1"),
    SHARED_QUEUE_CONSUMER_POOL_SIZE: z.coerce.number().int().default(10),
    SHARED_QUEUE_CONSUMER_INTERVAL_MS: z.coerce.number().int().default(100),
    SHARED_QUEUE_CONSUMER_NEXT_TICK_INTERVAL_MS: z.coerce.number().int().default(100),
    SHARED_QUEUE_CONSUMER_EMIT_RESUME_DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().default(1000),
    SHARED_QUEUE_CONSUMER_RESOLVE_PAYLOADS_BATCH_SIZE: z.coerce.number().int().default(25),

    // EOBD.52 — required in all environments. Drops the prior
    // `.default("managed-secret")` silent fallback so webapp bootstraps
    // fail loudly when the shared worker secret is missing.
    // Generate: `openssl rand -hex 32`.
    MANAGED_WORKER_SECRET: z.string().min(16),

    // Development OTEL environment variables
    DEV_OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    DEV_OTEL_METRICS_ENDPOINT: z.string().optional(),
    // If this is set to 1, then the below variables are used to configure the batch processor for spans and logs
    DEV_OTEL_BATCH_PROCESSING_ENABLED: z.string().default("0"),
    DEV_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
    DEV_OTEL_SPAN_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
    DEV_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
    DEV_OTEL_SPAN_MAX_QUEUE_SIZE: z.string().default("512"),
    DEV_OTEL_LOG_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
    DEV_OTEL_LOG_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
    DEV_OTEL_LOG_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
    DEV_OTEL_LOG_MAX_QUEUE_SIZE: z.string().default("512"),
    DEV_OTEL_METRICS_EXPORT_INTERVAL_MILLIS: z.string().optional(),
    DEV_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS: z.string().optional(),
    DEV_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS: z.string().optional(),

    PROD_OTEL_BATCH_PROCESSING_ENABLED: z.string().default("0"),
    PROD_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
    PROD_OTEL_SPAN_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
    PROD_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
    PROD_OTEL_SPAN_MAX_QUEUE_SIZE: z.string().default("512"),
    PROD_OTEL_LOG_MAX_EXPORT_BATCH_SIZE: z.string().default("64"),
    PROD_OTEL_LOG_SCHEDULED_DELAY_MILLIS: z.string().default("200"),
    PROD_OTEL_LOG_EXPORT_TIMEOUT_MILLIS: z.string().default("30000"),
    PROD_OTEL_LOG_MAX_QUEUE_SIZE: z.string().default("512"),
    PROD_OTEL_METRICS_EXPORT_INTERVAL_MILLIS: z.string().optional(),
    PROD_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS: z.string().optional(),
    PROD_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS: z.string().optional(),

    TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: z.string().default("1024"),
    TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT: z.string().default("1024"),
    TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: z.string().default("131072"),
    TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT: z.string().default("131072"),
    TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT: z.string().default("10"),
    TRIGGER_OTEL_LINK_COUNT_LIMIT: z.string().default("2"),
    TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT: z.string().default("10"),
    TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT: z.string().default("10"),

    CHECKPOINT_THRESHOLD_IN_MS: z.coerce.number().int().default(30000),

    // Internal OTEL environment variables
    INTERNAL_OTEL_TRACE_EXPORTER_URL: z.string().optional(),
    INTERNAL_OTEL_TRACE_EXPORTER_AUTH_HEADERS: z.string().optional(),
    INTERNAL_OTEL_TRACE_LOGGING_ENABLED: z.string().default("1"),
    // this means 1/20 traces or 5% of traces will be sampled (sampled = recorded)
    INTERNAL_OTEL_TRACE_SAMPLING_RATE: z.string().default("20"),
    INTERNAL_OTEL_TRACE_INSTRUMENT_PRISMA_ENABLED: z.string().default("0"),
    INTERNAL_OTEL_TRACE_DISABLED: z.string().default("0"),

    INTERNAL_OTEL_LOG_EXPORTER_URL: z.string().optional(),
    INTERNAL_OTEL_METRIC_EXPORTER_URL: z.string().optional(),
    INTERNAL_OTEL_METRIC_EXPORTER_AUTH_HEADERS: z.string().optional(),
    INTERNAL_OTEL_METRIC_EXPORTER_ENABLED: z.string().default("0"),
    INTERNAL_OTEL_METRIC_EXPORTER_INTERVAL_MS: z.coerce.number().int().default(30_000),
    INTERNAL_OTEL_HOST_METRICS_ENABLED: BoolEnv.default(true),
    INTERNAL_OTEL_NODEJS_METRICS_ENABLED: BoolEnv.default(true),
    INTERNAL_OTEL_ADDITIONAL_DETECTORS_ENABLED: BoolEnv.default(true),

    ORG_SLACK_INTEGRATION_CLIENT_ID: z.string().optional(),
    ORG_SLACK_INTEGRATION_CLIENT_SECRET: z.string().optional(),

    /** Vercel integration OAuth credentials */
    VERCEL_INTEGRATION_CLIENT_ID: z.string().optional(),
    VERCEL_INTEGRATION_CLIENT_SECRET: z.string().optional(),
    VERCEL_INTEGRATION_APP_SLUG: z.string().optional(),

    /** These enable the alerts feature in v3 */
    ALERT_EMAIL_TRANSPORT: z.enum(["resend", "smtp", "aws-ses"]).optional(),
    ALERT_FROM_EMAIL: z.string().optional(),
    ALERT_REPLY_TO_EMAIL: z.string().optional(),
    ALERT_RESEND_API_KEY: z.string().optional(),
    ALERT_SMTP_HOST: z.string().optional(),
    ALERT_SMTP_PORT: z.coerce.number().optional(),
    ALERT_SMTP_SECURE: BoolEnv.optional(),
    ALERT_SMTP_USER: z.string().optional(),
    ALERT_SMTP_PASSWORD: z.string().optional(),
    ALERT_RATE_LIMITER_EMISSION_INTERVAL: z.coerce.number().int().default(2_500),
    ALERT_RATE_LIMITER_BURST_TOLERANCE: z.coerce.number().int().default(10_000),
    ALERT_RATE_LIMITER_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    ALERT_RATE_LIMITER_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    ALERT_RATE_LIMITER_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    ALERT_RATE_LIMITER_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    ALERT_RATE_LIMITER_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    ALERT_RATE_LIMITER_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    ALERT_RATE_LIMITER_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),
    ALERT_RATE_LIMITER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    LOOPS_API_KEY: z.string().optional(),
    MARQS_DISABLE_REBALANCING: BoolEnv.default(false),
    MARQS_VISIBILITY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .default(60 * 1000 * 15),
    MARQS_SHARED_QUEUE_LIMIT: z.coerce.number().int().default(1000),
    MARQS_MAXIMUM_QUEUE_PER_ENV_COUNT: z.coerce.number().int().default(50),
    MARQS_DEV_QUEUE_LIMIT: z.coerce.number().int().default(1000),
    MARQS_MAXIMUM_NACK_COUNT: z.coerce.number().int().default(64),
    MARQS_CONCURRENCY_LIMIT_BIAS: z.coerce.number().default(0.75),
    MARQS_AVAILABLE_CAPACITY_BIAS: z.coerce.number().default(0.3),
    MARQS_QUEUE_AGE_RANDOMIZATION_BIAS: z.coerce.number().default(0.25),
    MARQS_REUSE_SNAPSHOT_COUNT: z.coerce.number().int().default(0),
    MARQS_MAXIMUM_ENV_COUNT: z.coerce.number().int().optional(),
    MARQS_SHARED_WORKER_QUEUE_CONSUMER_INTERVAL_MS: z.coerce.number().int().default(250),
    MARQS_SHARED_WORKER_QUEUE_MAX_MESSAGE_COUNT: z.coerce.number().int().default(10),

    MARQS_SHARED_WORKER_QUEUE_EAGER_DEQUEUE_ENABLED: z.string().default("0"),
    MARQS_WORKER_ENABLED: z.string().default("0"),
    MARQS_WORKER_COUNT: z.coerce.number().int().default(2),
    MARQS_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
    MARQS_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(5),
    MARQS_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().default(100),
    MARQS_WORKER_IMMEDIATE_POLL_INTERVAL_MS: z.coerce.number().int().default(100),
    MARQS_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    MARQS_SHARED_WORKER_QUEUE_COOLOFF_COUNT_THRESHOLD: z.coerce.number().int().default(10),
    MARQS_SHARED_WORKER_QUEUE_COOLOFF_PERIOD_MS: z.coerce.number().int().default(5_000),

    PROD_TASK_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().optional(),

    VERBOSE_GRAPHILE_LOGGING: z.string().default("false"),
    V2_MARQS_ENABLED: z.string().default("0"),
    V2_MARQS_CONSUMER_POOL_ENABLED: z.string().default("0"),
    V2_MARQS_CONSUMER_POOL_SIZE: z.coerce.number().int().default(10),
    V2_MARQS_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().default(1000),
    V2_MARQS_QUEUE_SELECTION_COUNT: z.coerce.number().int().default(36),
    V2_MARQS_VISIBILITY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .default(60 * 1000 * 15),
    V2_MARQS_DEFAULT_ENV_CONCURRENCY: z.coerce.number().int().default(100),
    V2_MARQS_VERBOSE: z.string().default("0"),
    V3_MARQS_CONCURRENCY_MONITOR_ENABLED: z.string().default("0"),
    V2_MARQS_CONCURRENCY_MONITOR_ENABLED: z.string().default("0"),
    /* Usage settings */
    USAGE_EVENT_URL: z.string().optional(),
    PROD_USAGE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().optional(),

    CENTS_PER_RUN: z.coerce.number().default(0),

    EVENT_LOOP_MONITOR_ENABLED: z.string().default("1"),
    RESOURCE_MONITOR_ENABLED: z.string().default("0"),
    MAXIMUM_LIVE_RELOADING_EVENTS: z.coerce.number().int().default(1000),
    MAXIMUM_TRACE_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(25_000),
    MAXIMUM_TRACE_DETAILED_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(10_000),
    TASK_PAYLOAD_OFFLOAD_THRESHOLD: z.coerce.number().int().default(524_288), // 512KB
    BATCH_PAYLOAD_OFFLOAD_THRESHOLD: z.coerce.number().int().optional(), // Defaults to TASK_PAYLOAD_OFFLOAD_THRESHOLD if not set
    TASK_PAYLOAD_MAXIMUM_SIZE: z.coerce.number().int().default(3_145_728), // 3MB
    BATCH_TASK_PAYLOAD_MAXIMUM_SIZE: z.coerce.number().int().default(1_000_000), // 1MB
    TASK_RUN_METADATA_MAXIMUM_SIZE: z.coerce.number().int().default(262_144), // 256KB

    MAXIMUM_DEV_QUEUE_SIZE: z.coerce.number().int().optional(),
    MAXIMUM_DEPLOYED_QUEUE_SIZE: z.coerce.number().int().optional(),
    QUEUE_SIZE_CACHE_TTL_MS: z.coerce.number().int().optional().default(1_000), // 1 second
    QUEUE_SIZE_CACHE_MAX_SIZE: z.coerce.number().int().optional().default(5_000),
    QUEUE_SIZE_CACHE_ENABLED: z.coerce.number().int().optional().default(1),
    MAX_BATCH_V2_TRIGGER_ITEMS: z.coerce.number().int().default(500),
    MAX_BATCH_AND_WAIT_V2_TRIGGER_ITEMS: z.coerce.number().int().default(500),

    // 2-phase batch API settings
    STREAMING_BATCH_MAX_ITEMS: z.coerce.number().int().default(1_000), // Max items in streaming batch
    STREAMING_BATCH_ITEM_MAXIMUM_SIZE: z.coerce.number().int().default(3_145_728),
    BATCH_RATE_LIMIT_REFILL_RATE: z.coerce.number().int().default(100),
    BATCH_RATE_LIMIT_MAX: z.coerce.number().int().default(1200),
    BATCH_RATE_LIMIT_REFILL_INTERVAL: z.string().default("10s"),
    BATCH_CONCURRENCY_LIMIT_DEFAULT: z.coerce.number().int().default(5),

    REALTIME_STREAM_VERSION: z.enum(["v1", "v2"]).default("v1"),
    REALTIME_STREAM_MAX_LENGTH: z.coerce.number().int().default(1000),
    REALTIME_STREAM_TTL: z.coerce
      .number()
      .int()
      .default(60 * 60 * 24), // 1 day in seconds
    BATCH_METADATA_OPERATIONS_FLUSH_INTERVAL_MS: z.coerce.number().int().default(1000),
    BATCH_METADATA_OPERATIONS_FLUSH_ENABLED: z.string().default("1"),
    BATCH_METADATA_OPERATIONS_FLUSH_LOGGING_ENABLED: z.string().default("1"),

    // Run Engine 2.0
    RUN_ENGINE_WORKER_COUNT: z.coerce.number().int().default(4),
    RUN_ENGINE_TASKS_PER_WORKER: z.coerce.number().int().default(10),
    RUN_ENGINE_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(10),
    RUN_ENGINE_WORKER_POLL_INTERVAL: z.coerce.number().int().default(100),
    RUN_ENGINE_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(100),
    RUN_ENGINE_TIMEOUT_PENDING_EXECUTING: z.coerce.number().int().default(60_000),
    RUN_ENGINE_TIMEOUT_PENDING_CANCEL: z.coerce.number().int().default(60_000),
    RUN_ENGINE_TIMEOUT_EXECUTING: z.coerce.number().int().default(300_000), // 5 minutes
    RUN_ENGINE_TIMEOUT_EXECUTING_WITH_WAITPOINTS: z.coerce.number().int().default(300_000), // 5 minutes
    RUN_ENGINE_TIMEOUT_SUSPENDED: z.coerce
      .number()
      .int()
      .default(60_000 * 10),
    RUN_ENGINE_DEBUG_WORKER_NOTIFICATIONS: BoolEnv.default(false),
    RUN_ENGINE_PARENT_QUEUE_LIMIT: z.coerce.number().int().default(1000),
    RUN_ENGINE_CONCURRENCY_LIMIT_BIAS: z.coerce.number().default(0.75),
    RUN_ENGINE_AVAILABLE_CAPACITY_BIAS: z.coerce.number().default(0.3),
    RUN_ENGINE_QUEUE_AGE_RANDOMIZATION_BIAS: z.coerce.number().default(0.25),
    RUN_ENGINE_REUSE_SNAPSHOT_COUNT: z.coerce.number().int().default(0),
    RUN_ENGINE_MAXIMUM_ENV_COUNT: z.coerce.number().int().optional(),
    RUN_ENGINE_RUN_QUEUE_SHARD_COUNT: z.coerce.number().int().default(4),
    RUN_ENGINE_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    RUN_ENGINE_RETRY_WARM_START_THRESHOLD_MS: z.coerce.number().int().default(30_000),
    RUN_ENGINE_PROCESS_WORKER_QUEUE_DEBOUNCE_MS: z.coerce.number().int().default(200),
    RUN_ENGINE_DEQUEUE_BLOCKING_TIMEOUT_SECONDS: z.coerce.number().int().default(10),
    RUN_ENGINE_MASTER_QUEUE_CONSUMERS_INTERVAL_MS: z.coerce.number().int().default(1000),
    RUN_ENGINE_MASTER_QUEUE_COOLOFF_PERIOD_MS: z.coerce.number().int().default(10_000),
    RUN_ENGINE_MASTER_QUEUE_COOLOFF_COUNT_THRESHOLD: z.coerce.number().int().default(10),
    RUN_ENGINE_MASTER_QUEUE_CONSUMER_DEQUEUE_COUNT: z.coerce.number().int().default(10),
    RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_SCHEDULE: z.string().optional(),
    RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_SCHEDULE: z.string().optional(),
    RUN_ENGINE_CONCURRENCY_SWEEPER_SCAN_JITTER_IN_MS: z.coerce.number().int().optional(),
    RUN_ENGINE_CONCURRENCY_SWEEPER_PROCESS_MARKED_JITTER_IN_MS: z.coerce.number().int().optional(),

    // TTL System settings for automatic run expiration
    RUN_ENGINE_TTL_SYSTEM_DISABLED: BoolEnv.default(false),
    RUN_ENGINE_TTL_SYSTEM_SHARD_COUNT: z.coerce.number().int().optional(),
    RUN_ENGINE_TTL_SYSTEM_POLL_INTERVAL_MS: z.coerce.number().int().default(1_000),
    RUN_ENGINE_TTL_SYSTEM_BATCH_SIZE: z.coerce.number().int().default(100),
    RUN_ENGINE_TTL_WORKER_CONCURRENCY: z.coerce.number().int().default(1),
    RUN_ENGINE_TTL_WORKER_BATCH_MAX_SIZE: z.coerce.number().int().default(50),
    RUN_ENGINE_TTL_CONSUMERS_DISABLED: BoolEnv.default(false),
    RUN_ENGINE_TTL_WORKER_BATCH_MAX_WAIT_MS: z.coerce.number().int().default(5_000),

    /** Optional maximum TTL for all runs (e.g. "14d"). If set, runs without an explicit TTL
     *  will use this as their TTL, and runs with a TTL larger than this will be clamped. */
    RUN_ENGINE_DEFAULT_MAX_TTL: z.string().optional(),

    RUN_ENGINE_RUN_LOCK_DURATION: z.coerce.number().int().default(5000),
    RUN_ENGINE_RUN_LOCK_AUTOMATIC_EXTENSION_THRESHOLD: z.coerce.number().int().default(1000),
    RUN_ENGINE_RUN_LOCK_MAX_RETRIES: z.coerce.number().int().default(10),
    RUN_ENGINE_RUN_LOCK_BASE_DELAY: z.coerce.number().int().default(100),
    RUN_ENGINE_RUN_LOCK_MAX_DELAY: z.coerce.number().int().default(3000),
    RUN_ENGINE_RUN_LOCK_BACKOFF_MULTIPLIER: z.coerce.number().default(1.8),
    RUN_ENGINE_RUN_LOCK_JITTER_FACTOR: z.coerce.number().default(0.15),
    RUN_ENGINE_RUN_LOCK_MAX_TOTAL_WAIT_TIME: z.coerce.number().int().default(15000),

    RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_MAX_COUNT: z.coerce.number().int().default(12),
    RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .default(60_000 * 60 * 6),
    RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_INITIAL_DELAY_MS: z.coerce
      .number()
      .int()
      .default(60_000),
    RUN_ENGINE_SUSPENDED_HEARTBEAT_RETRIES_FACTOR: z.coerce.number().default(2),

    /** Maximum duration in milliseconds that a run can be debounced. Default: 1 hour (3,600,000ms) */
    RUN_ENGINE_MAXIMUM_DEBOUNCE_DURATION_MS: z.coerce
      .number()
      .int()
      .default(60_000 * 60), // 1 hour

    RUN_ENGINE_WORKER_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    RUN_ENGINE_WORKER_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    RUN_ENGINE_WORKER_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    RUN_ENGINE_WORKER_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    RUN_ENGINE_WORKER_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    RUN_ENGINE_WORKER_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    RUN_ENGINE_WORKER_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),

    RUN_ENGINE_RUN_QUEUE_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    RUN_ENGINE_RUN_QUEUE_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    RUN_ENGINE_RUN_QUEUE_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    RUN_ENGINE_RUN_QUEUE_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    RUN_ENGINE_RUN_QUEUE_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    RUN_ENGINE_RUN_QUEUE_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    RUN_ENGINE_RUN_QUEUE_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),

    RUN_ENGINE_RUN_LOCK_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    RUN_ENGINE_RUN_LOCK_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    RUN_ENGINE_RUN_LOCK_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    RUN_ENGINE_RUN_LOCK_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    RUN_ENGINE_RUN_LOCK_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    RUN_ENGINE_RUN_LOCK_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    RUN_ENGINE_RUN_LOCK_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),

    RUN_ENGINE_DEV_PRESENCE_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    RUN_ENGINE_DEV_PRESENCE_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    RUN_ENGINE_DEV_PRESENCE_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    RUN_ENGINE_DEV_PRESENCE_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    RUN_ENGINE_DEV_PRESENCE_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    RUN_ENGINE_DEV_PRESENCE_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    RUN_ENGINE_DEV_PRESENCE_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),

    //API Rate limiting
    /**
     * @example "60s"
     * @example "1m"
     * @example "1h"
     * @example "1d"
     * @example "1000ms"
     * @example "1000s"
     */
    RUN_ENGINE_RATE_LIMIT_REFILL_INTERVAL: z.string().default("10s"), // refill 250 tokens every 10 seconds
    RUN_ENGINE_RATE_LIMIT_MAX: z.coerce.number().int().default(1200), // allow bursts of 750 requests
    RUN_ENGINE_RATE_LIMIT_REFILL_RATE: z.coerce.number().int().default(400), // refix 250 tokens every 10 seconds
    RUN_ENGINE_RATE_LIMIT_REQUEST_LOGS_ENABLED: z.string().default("0"),
    RUN_ENGINE_RATE_LIMIT_REJECTION_LOGS_ENABLED: z.string().default("1"),
    RUN_ENGINE_RATE_LIMIT_LIMITER_LOGS_ENABLED: z.string().default("0"),

    RUN_ENGINE_RELEASE_CONCURRENCY_ENABLED: z.string().default("0"),
    RUN_ENGINE_RELEASE_CONCURRENCY_DISABLE_CONSUMERS: z.string().default("0"),
    RUN_ENGINE_RELEASE_CONCURRENCY_MAX_TOKENS_RATIO: z.coerce.number().default(1),
    RUN_ENGINE_RELEASE_CONCURRENCY_RELEASINGS_MAX_AGE: z.coerce
      .number()
      .int()
      .default(60_000 * 30),
    RUN_ENGINE_RELEASE_CONCURRENCY_RELEASINGS_POLL_INTERVAL: z.coerce
      .number()
      .int()
      .default(60_000),
    RUN_ENGINE_RELEASE_CONCURRENCY_MAX_RETRIES: z.coerce.number().int().default(3),
    RUN_ENGINE_RELEASE_CONCURRENCY_CONSUMERS_COUNT: z.coerce.number().int().default(1),
    RUN_ENGINE_RELEASE_CONCURRENCY_POLL_INTERVAL: z.coerce.number().int().default(500),
    RUN_ENGINE_RELEASE_CONCURRENCY_BATCH_SIZE: z.coerce.number().int().default(10),

    RUN_ENGINE_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
    RUN_ENGINE_RUN_QUEUE_LOG_LEVEL: z
      .enum(["log", "error", "warn", "info", "debug"])
      .default("info"),
    RUN_ENGINE_TREAT_PRODUCTION_EXECUTION_STALLS_AS_OOM: z.string().default("0"),

    /** How long should the presence ttl last */
    DEV_PRESENCE_SSE_TIMEOUT: z.coerce.number().int().default(30_000),
    DEV_PRESENCE_TTL_MS: z.coerce.number().int().default(5_000),
    DEV_PRESENCE_POLL_MS: z.coerce.number().int().default(1_000),
    /** How many ms to wait until dequeuing again, if there was a run last time */
    DEV_DEQUEUE_INTERVAL_WITH_RUN: z.coerce.number().int().default(250),
    /** How many ms to wait until dequeuing again, if there was no run last time */
    DEV_DEQUEUE_INTERVAL_WITHOUT_RUN: z.coerce.number().int().default(1_000),
    /** The max number of runs per API call that we'll dequeue in DEV */
    DEV_DEQUEUE_MAX_RUNS_PER_PULL: z.coerce.number().int().default(10),

    /** The maximum concurrent local run processes executing at once in dev. This is a hard limit */
    DEV_MAX_CONCURRENT_RUNS: z.coerce.number().int().optional(),

    /** The CLI should connect to this for dev runs */
    DEV_ENGINE_URL: z.string().default(process.env.APP_ORIGIN ?? "http://localhost:3030"),

    COMMON_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
    COMMON_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
    COMMON_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
    COMMON_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
    COMMON_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
    COMMON_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
    COMMON_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    COMMON_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

    COMMON_WORKER_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    COMMON_WORKER_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    COMMON_WORKER_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    COMMON_WORKER_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    COMMON_WORKER_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    COMMON_WORKER_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    COMMON_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
    COMMON_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    BATCH_TRIGGER_PROCESS_JOB_VISIBILITY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .default(60_000 * 5), // 5 minutes

    BATCH_TRIGGER_CACHED_RUNS_CHECK_ENABLED: BoolEnv.default(false),

    BATCH_TRIGGER_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
    BATCH_TRIGGER_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
    BATCH_TRIGGER_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
    BATCH_TRIGGER_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
    BATCH_TRIGGER_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
    BATCH_TRIGGER_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(20),
    BATCH_TRIGGER_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    BATCH_TRIGGER_WORKER_LOG_LEVEL: z
      .enum(["log", "error", "warn", "info", "debug"])
      .default("info"),

    BATCH_TRIGGER_WORKER_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    BATCH_TRIGGER_WORKER_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    BATCH_TRIGGER_WORKER_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    BATCH_TRIGGER_WORKER_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    BATCH_TRIGGER_WORKER_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    BATCH_TRIGGER_WORKER_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    BATCH_TRIGGER_WORKER_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),
    BATCH_TRIGGER_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    // BatchQueue DRR settings (Run Engine v2)
    BATCH_QUEUE_DRR_QUANTUM: z.coerce.number().int().default(25),
    BATCH_QUEUE_MAX_DEFICIT: z.coerce.number().int().default(100),
    BATCH_QUEUE_CONSUMER_COUNT: z.coerce.number().int().default(3),
    BATCH_QUEUE_CONSUMER_INTERVAL_MS: z.coerce.number().int().default(50),
    BATCH_QUEUE_WORKER_ENABLED: BoolEnv.default(true),
    // Number of master queue shards for horizontal scaling
    BATCH_QUEUE_SHARD_COUNT: z.coerce.number().int().default(1),
    // Maximum queues to fetch from master queue per iteration
    BATCH_QUEUE_MASTER_QUEUE_LIMIT: z.coerce.number().int().default(1000),
    // Enable worker queue for two-stage processing (claim messages, push to worker queue, process from worker queue)
    BATCH_QUEUE_WORKER_QUEUE_ENABLED: BoolEnv.default(true),
    // Worker queue blocking timeout in seconds (for two-stage processing, only used when BATCH_QUEUE_WORKER_QUEUE_ENABLED is true)
    BATCH_QUEUE_WORKER_QUEUE_TIMEOUT_SECONDS: z.coerce.number().int().default(10),
    // Global rate limit: max items processed per second across all consumers
    // If not set, no global rate limiting is applied
    BATCH_QUEUE_GLOBAL_RATE_LIMIT: z.coerce.number().int().positive().optional(),
    // Max items in the worker queue before claiming pauses (protects visibility timeouts)
    // If not set, no depth limit is applied
    BATCH_QUEUE_WORKER_QUEUE_MAX_DEPTH: z.coerce.number().int().positive().optional(),

    ADMIN_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
    ADMIN_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
    ADMIN_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
    ADMIN_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
    ADMIN_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(50),
    ADMIN_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(20),
    ADMIN_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    ADMIN_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

    ADMIN_WORKER_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    ADMIN_WORKER_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    ADMIN_WORKER_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    ADMIN_WORKER_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    ADMIN_WORKER_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    ADMIN_WORKER_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    ADMIN_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
    ADMIN_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    ALERTS_WORKER_ENABLED: z.string().default(process.env.WORKER_ENABLED ?? "true"),
    ALERTS_WORKER_CONCURRENCY_WORKERS: z.coerce.number().int().default(2),
    ALERTS_WORKER_CONCURRENCY_TASKS_PER_WORKER: z.coerce.number().int().default(10),
    ALERTS_WORKER_POLL_INTERVAL: z.coerce.number().int().default(1000),
    ALERTS_WORKER_IMMEDIATE_POLL_INTERVAL: z.coerce.number().int().default(100),
    ALERTS_WORKER_CONCURRENCY_LIMIT: z.coerce.number().int().default(50),
    ALERTS_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
    ALERTS_WORKER_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),

    ALERTS_WORKER_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    ALERTS_WORKER_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    ALERTS_WORKER_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    ALERTS_WORKER_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    ALERTS_WORKER_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    ALERTS_WORKER_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    ALERTS_WORKER_REDIS_TLS_DISABLED: z.string().default(process.env.REDIS_TLS_DISABLED ?? "false"),
    ALERTS_WORKER_REDIS_CLUSTER_MODE_ENABLED: z.string().default("0"),

    TASK_EVENT_PARTITIONING_ENABLED: z.string().default("0"),
    TASK_EVENT_PARTITIONED_WINDOW_IN_SECONDS: z.coerce.number().int().default(60), // 1 minute

    DEPLOYMENTS_AUTORELOAD_POLL_INTERVAL_MS: z.coerce.number().int().default(5_000),
    BULK_ACTION_AUTORELOAD_POLL_INTERVAL_MS: z.coerce.number().int().default(1_000),
    QUEUES_AUTORELOAD_POLL_INTERVAL_MS: z.coerce.number().int().default(5_000),

    SLACK_BOT_TOKEN: z.string().optional(),
    SLACK_SIGNUP_REASON_CHANNEL_ID: z.string().optional(),

    // kapa.ai
    KAPA_AI_WEBSITE_ID: z.string().optional(),

    // BetterStack
    BETTERSTACK_API_KEY: z.string().optional(),
    BETTERSTACK_STATUS_PAGE_ID: z.string().optional(),

    RUN_REPLICATION_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    RUN_REPLICATION_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    RUN_REPLICATION_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    RUN_REPLICATION_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    RUN_REPLICATION_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    RUN_REPLICATION_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    RUN_REPLICATION_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),

    RUN_REPLICATION_CLICKHOUSE_URL: z.string().optional(),
    RUN_REPLICATION_ENABLED: z.string().default("0"),
    RUN_REPLICATION_SLOT_NAME: z.string().default("task_runs_to_clickhouse_v1"),
    RUN_REPLICATION_PUBLICATION_NAME: z.string().default("task_runs_to_clickhouse_v1_publication"),
    RUN_REPLICATION_MAX_FLUSH_CONCURRENCY: z.coerce.number().int().default(2),
    RUN_REPLICATION_FLUSH_INTERVAL_MS: z.coerce.number().int().default(1000),
    RUN_REPLICATION_FLUSH_BATCH_SIZE: z.coerce.number().int().default(100),
    RUN_REPLICATION_LEADER_LOCK_TIMEOUT_MS: z.coerce.number().int().default(30_000),
    RUN_REPLICATION_LEADER_LOCK_EXTEND_INTERVAL_MS: z.coerce.number().int().default(10_000),
    RUN_REPLICATION_ACK_INTERVAL_SECONDS: z.coerce.number().int().default(10),
    RUN_REPLICATION_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
    RUN_REPLICATION_CLICKHOUSE_LOG_LEVEL: z
      .enum(["log", "error", "warn", "info", "debug"])
      .default("info"),
    RUN_REPLICATION_LEADER_LOCK_ADDITIONAL_TIME_MS: z.coerce.number().int().default(10_000),
    RUN_REPLICATION_LEADER_LOCK_RETRY_INTERVAL_MS: z.coerce.number().int().default(500),
    RUN_REPLICATION_WAIT_FOR_ASYNC_INSERT: z.string().default("0"),
    RUN_REPLICATION_KEEP_ALIVE_ENABLED: z.string().default("0"),
    RUN_REPLICATION_KEEP_ALIVE_IDLE_SOCKET_TTL_MS: z.coerce.number().int().optional(),
    RUN_REPLICATION_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(10),
    // Retry configuration for insert operations
    RUN_REPLICATION_INSERT_MAX_RETRIES: z.coerce.number().int().default(3),
    RUN_REPLICATION_INSERT_BASE_DELAY_MS: z.coerce.number().int().default(100),
    RUN_REPLICATION_INSERT_MAX_DELAY_MS: z.coerce.number().int().default(2000),
    RUN_REPLICATION_INSERT_STRATEGY: z.enum(["insert", "insert_async"]).default("insert"),
    RUN_REPLICATION_DISABLE_PAYLOAD_INSERT: z.string().default("0"),
    RUN_REPLICATION_DISABLE_ERROR_FINGERPRINTING: z.string().default("0"),

    // Clickhouse
    CLICKHOUSE_URL: z.string(),
    CLICKHOUSE_KEEP_ALIVE_ENABLED: z.string().default("1"),
    CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS: z.coerce.number().int().optional(),
    CLICKHOUSE_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(10),
    CLICKHOUSE_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
    CLICKHOUSE_COMPRESSION_REQUEST: z.string().default("1"),

    // Logs Query Settings
    CLICKHOUSE_LOGS_LIST_MAX_MEMORY_USAGE: z.coerce.number().int().default(1_000_000_000),
    CLICKHOUSE_LOGS_LIST_MAX_BYTES_BEFORE_EXTERNAL_SORT: z.coerce
      .number()
      .int()
      .default(256_000_000),
    CLICKHOUSE_LOGS_LIST_MAX_THREADS: z.coerce.number().int().default(2),
    CLICKHOUSE_LOGS_LIST_MAX_ROWS_TO_READ: z.coerce.number().int().default(10_000_000),
    CLICKHOUSE_LOGS_LIST_MAX_EXECUTION_TIME: z.coerce.number().int().default(120),

    // Query feature flag
    QUERY_FEATURE_ENABLED: z.string().default("1"),

    // AI features (Prompts, Models, AI Metrics sidebar section)
    AI_FEATURES_ENABLED: z.string().default("0"),

    // Logs page ClickHouse URL (for logs queries)
    LOGS_CLICKHOUSE_URL: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.CLICKHOUSE_URL),

    // Query page ClickHouse limits (for TSQL queries)
    QUERY_CLICKHOUSE_URL: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.CLICKHOUSE_URL),
    QUERY_CLICKHOUSE_MAX_EXECUTION_TIME: z.coerce.number().int().default(10),
    QUERY_CLICKHOUSE_MAX_MEMORY_USAGE: z.coerce.number().int().default(1_073_741_824), // 1GB in bytes
    QUERY_CLICKHOUSE_MAX_AST_ELEMENTS: z.coerce.number().int().default(4_000_000),
    QUERY_CLICKHOUSE_MAX_EXPANDED_AST_ELEMENTS: z.coerce.number().int().default(4_000_000),
    QUERY_CLICKHOUSE_MAX_BYTES_BEFORE_EXTERNAL_GROUP_BY: z.coerce.number().int().default(0),
    QUERY_CLICKHOUSE_MAX_RETURNED_ROWS: z.coerce.number().int().default(10_000),

    // Query page concurrency limits
    QUERY_DEFAULT_ORG_CONCURRENCY_LIMIT: z.coerce.number().int().default(3),
    QUERY_GLOBAL_CONCURRENCY_LIMIT: z.coerce.number().int().default(100),

    // Metric widget concurrency limits
    METRIC_WIDGET_DEFAULT_ORG_CONCURRENCY_LIMIT: z.coerce.number().int().default(30),

    // Admin ClickHouse URL (for admin dashboard queries like missing models)
    ADMIN_CLICKHOUSE_URL: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.CLICKHOUSE_URL),

    EVENTS_CLICKHOUSE_URL: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.CLICKHOUSE_URL),
    EVENTS_CLICKHOUSE_KEEP_ALIVE_ENABLED: z.string().default("1"),
    EVENTS_CLICKHOUSE_KEEP_ALIVE_IDLE_SOCKET_TTL_MS: z.coerce.number().int().optional(),
    EVENTS_CLICKHOUSE_MAX_OPEN_CONNECTIONS: z.coerce.number().int().default(10),
    EVENTS_CLICKHOUSE_LOG_LEVEL: z.enum(["log", "error", "warn", "info", "debug"]).default("info"),
    EVENTS_CLICKHOUSE_COMPRESSION_REQUEST: z.string().default("1"),
    EVENTS_CLICKHOUSE_BATCH_SIZE: z.coerce.number().int().default(1000),
    EVENTS_CLICKHOUSE_FLUSH_INTERVAL_MS: z.coerce.number().int().default(1000),
    METRICS_CLICKHOUSE_BATCH_SIZE: z.coerce.number().int().default(10000),
    METRICS_CLICKHOUSE_FLUSH_INTERVAL_MS: z.coerce.number().int().default(1000),
    METRICS_CLICKHOUSE_MAX_CONCURRENCY: z.coerce.number().int().default(3),
    EVENTS_CLICKHOUSE_INSERT_STRATEGY: z.enum(["insert", "insert_async"]).default("insert"),
    EVENTS_CLICKHOUSE_WAIT_FOR_ASYNC_INSERT: z.string().default("1"),
    EVENTS_CLICKHOUSE_ASYNC_INSERT_MAX_DATA_SIZE: z.coerce.number().int().default(10485760),
    EVENTS_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS: z.coerce.number().int().default(5000),
    EVENTS_CLICKHOUSE_START_TIME_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .default(60_000 * 5), // 5 minutes
    EVENT_REPOSITORY_DEFAULT_STORE: z
      .enum(["postgres", "clickhouse", "clickhouse_v2"])
      .default("postgres"),
    EVENT_REPOSITORY_DEBUG_LOGS_DISABLED: BoolEnv.default(false),
    EVENTS_CLICKHOUSE_MAX_TRACE_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(25_000),
    EVENTS_CLICKHOUSE_MAX_TRACE_DETAILED_SUMMARY_VIEW_COUNT: z.coerce.number().int().default(5_000),
    EVENTS_CLICKHOUSE_MAX_LIVE_RELOADING_SETTING: z.coerce.number().int().default(2000),

    // LLM cost tracking
    LLM_COST_TRACKING_ENABLED: BoolEnv.default(true),
    LLM_PRICING_RELOAD_INTERVAL_MS: z.coerce
      .number()
      .int()
      .default(5 * 60 * 1000), // 5 minutes
    LLM_PRICING_SEED_ON_STARTUP: BoolEnv.default(false),
    LLM_PRICING_READY_TIMEOUT_MS: z.coerce.number().int().default(500),
    LLM_METRICS_BATCH_SIZE: z.coerce.number().int().default(5000),
    LLM_METRICS_FLUSH_INTERVAL_MS: z.coerce.number().int().default(2000),
    LLM_METRICS_MAX_BATCH_SIZE: z.coerce.number().int().default(10000),
    LLM_METRICS_MAX_CONCURRENCY: z.coerce.number().int().default(2),

    // Machine presets
    MACHINE_PRESETS_OVERRIDE_PATH: z.string().optional(),

    // CLI package tag (e.g. "latest", "v4-beta", "4.0.0") - used for setup commands
    TRIGGER_CLI_TAG: z.string().default("latest"),

    HEALTHCHECK_DATABASE_DISABLED: z.string().default("0"),

    REQUEST_IDEMPOTENCY_REDIS_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_HOST),
    REQUEST_IDEMPOTENCY_REDIS_READER_HOST: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_READER_HOST),
    REQUEST_IDEMPOTENCY_REDIS_READER_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) =>
          v ?? (process.env.REDIS_READER_PORT ? parseInt(process.env.REDIS_READER_PORT) : undefined)
      ),
    REQUEST_IDEMPOTENCY_REDIS_PORT: z.coerce
      .number()
      .optional()
      .transform(
        (v) => v ?? (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined)
      ),
    REQUEST_IDEMPOTENCY_REDIS_USERNAME: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_USERNAME),
    REQUEST_IDEMPOTENCY_REDIS_PASSWORD: z
      .string()
      .optional()
      .transform((v) => v ?? process.env.REDIS_PASSWORD),
    REQUEST_IDEMPOTENCY_REDIS_TLS_DISABLED: z
      .string()
      .default(process.env.REDIS_TLS_DISABLED ?? "false"),

    REQUEST_IDEMPOTENCY_LOG_LEVEL: z
      .enum(["log", "error", "warn", "info", "debug"])
      .default("info"),

    REQUEST_IDEMPOTENCY_TTL_IN_MS: z.coerce
      .number()
      .int()
      .default(60_000 * 60 * 24),

    // Bulk action
    BULK_ACTION_BATCH_SIZE: z.coerce.number().int().default(100),
    BULK_ACTION_BATCH_DELAY_MS: z.coerce.number().int().default(200),
    BULK_ACTION_SUBBATCH_CONCURRENCY: z.coerce.number().int().default(5),

    // AI Run Filter
    AI_RUN_FILTER_MODEL: z.string().optional(),

    EVENT_LOOP_MONITOR_THRESHOLD_MS: z.coerce.number().int().default(100),
    EVENT_LOOP_MONITOR_UTILIZATION_INTERVAL_MS: z.coerce.number().int().default(1000),
    EVENT_LOOP_MONITOR_UTILIZATION_SAMPLE_RATE: z.coerce.number().default(0.05),
    EVENT_LOOP_MONITOR_NOTIFY_ENABLED: z.string().default("0"),

    VERY_SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().optional(),

    REALTIME_STREAMS_S2_BASIN: z.string().optional(),
    REALTIME_STREAMS_S2_ACCESS_TOKEN: z.string().optional(),
    REALTIME_STREAMS_S2_ENDPOINT: z.string().optional(),
    REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS: z.enum(["true", "false"]).default("false"),
    REALTIME_STREAMS_S2_ACCESS_TOKEN_EXPIRATION_IN_MS: z.coerce
      .number()
      .int()
      .default(60_000 * 60 * 24), // 1 day
    REALTIME_STREAMS_S2_LOG_LEVEL: z
      .enum(["log", "error", "warn", "info", "debug"])
      .default("info"),
    REALTIME_STREAMS_S2_FLUSH_INTERVAL_MS: z.coerce.number().int().default(100),
    REALTIME_STREAMS_S2_MAX_RETRIES: z.coerce.number().int().default(10),
    REALTIME_STREAMS_S2_WAIT_SECONDS: z.coerce.number().int().default(60),
    REALTIME_STREAMS_DEFAULT_VERSION: z.enum(["v1", "v2"]).default("v1"),
    WAIT_UNTIL_TIMEOUT_MS: z.coerce.number().int().default(600_000),

    // Private connections
    PRIVATE_CONNECTIONS_ENABLED: z.string().optional(),
    PRIVATE_CONNECTIONS_AWS_ACCOUNT_IDS: z.string().optional(),
  })
  .and(GithubAppEnvSchema)
  .and(S2EnvSchema)
  // SECURITY (audit H14) — the webapp MINTS the login cookie (also the API JWT
  // secret) + magic-link tokens; a self-host that copies `.env.example` boots
  // prod with the repo's public placeholder → forgeable session/magic-link for
  // any user. The agent already guards SESSION_SECRET (.min + prod
  // sentinel); mirror it here for the actual minter. Prod-gated so local dev
  // (which copies `.env.example`) still boots.
  .superRefine((val, ctx) => {
    if (val.NODE_ENV !== "production") return;
    const placeholder = /replace-with-real|change-?me|placeholder|^abcdef1234/i;
    for (const key of ["SESSION_SECRET", "MAGIC_LINK_SECRET"] as const) {
      const v = (val as Record<string, unknown>)[key];
      if (typeof v !== "string" || v.length < 16 || placeholder.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be a strong random value (≥16 chars, not a placeholder) in production. Generate one with: openssl rand -hex 32`,
        });
      }
    }
    if (val.ENCRYPTION_KEY.toLowerCase() === DEV_SENTINEL_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENCRYPTION_KEY"],
        message:
          "ENCRYPTION_KEY is the .env.example sentinel value — rotate before going to production",
      });
    }
  });

export type Environment = z.infer<typeof EnvironmentSchema>;
export const env = EnvironmentSchema.parse(process.env);

// PPR-8 — fatal prod-mode check for ship-hostile MinIO defaults.
// docker-compose.platos.yml + .env.example ship dev-sentinel values
// for MinIO root creds so local `docker compose up` works zero-config.
// If a prod deploy forgets to override, the object store is trivially
// compromisable with publicly-known creds. Refuse to boot instead.
if (env.NODE_ENV === "production") {
  const hostileMinioDefaults: Array<{ name: string; value: string; sentinel: string }> = [
    {
      name: "MINIO_ACCESS_KEY",
      value: env.MINIO_ACCESS_KEY,
      sentinel: "platos-minio-admin",
    },
    {
      name: "MINIO_SECRET_KEY",
      value: env.MINIO_SECRET_KEY,
      sentinel: "platos-minio-password",
    },
  ];
  const failing = hostileMinioDefaults.filter((v) => v.value === v.sentinel);
  if (failing.length > 0) {
    const names = failing.map((v) => v.name).join(", ");
    throw new Error(
      `[Platos boot] Refusing to start in production with default MinIO creds (${names}). ` +
        `Override MINIO_ROOT_USER + MINIO_ROOT_PASSWORD in your .env and redeploy. ` +
        `See docs/env-vars.md#core.`
    );
  }

  // Also warn (not fatal) when MINIO_PUBLIC_ENDPOINT is still localhost in
  // prod — presigned URLs will point at the operator's machine, breaking
  // attachments. We can't know the deploy topology at boot, so log-only.
  if (env.MINIO_PUBLIC_ENDPOINT.startsWith("http://localhost")) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Platos boot] WARNING: MINIO_PUBLIC_ENDPOINT=${env.MINIO_PUBLIC_ENDPOINT} in production. ` +
        `Browsers reaching this stack externally will get unreachable URLs in presigned responses. ` +
        `Override to your public MinIO/S3 URL.`
    );
  }

  // EOBD.49 follow-up — harder guard: fail-fast when APP_ORIGIN isn't
  // localhost AND MINIO_PUBLIC_ENDPOINT is. Previously log-only; that
  // catches attention at first scrape but operators routinely miss
  // startup warnings. This converts the worst misconfiguration (public
  // deploy pointing at localhost presigned URLs) into a boot failure.
  const appOriginIsLocal =
    env.APP_ORIGIN.startsWith("http://localhost") || env.APP_ORIGIN.startsWith("http://127.0.0.1");
  const minioIsLocal =
    env.MINIO_PUBLIC_ENDPOINT.startsWith("http://localhost") ||
    env.MINIO_PUBLIC_ENDPOINT.startsWith("http://127.0.0.1");
  if (!appOriginIsLocal && minioIsLocal) {
    throw new Error(
      `[Platos boot] Refusing to start in production: APP_ORIGIN=${env.APP_ORIGIN} ` +
        `but MINIO_PUBLIC_ENDPOINT=${env.MINIO_PUBLIC_ENDPOINT}. ` +
        `Browsers hitting the public webapp will be handed presigned URLs pointing ` +
        `at the operator's localhost. Override MINIO_PUBLIC_ENDPOINT to a public URL ` +
        `(e.g. https://minio.example.com) and redeploy. See docs/self-hosting.md.`
    );
  }
}

// EOBD.58 — EMAIL_TRANSPORT cross-field validation.
//
// Before: EMAIL_TRANSPORT was optional and RESEND_API_KEY / SMTP_* were
// each independently optional. EMAIL_TRANSPORT=resend + RESEND_API_KEY
// empty made the webapp parse cleanly but magic-link send failed at
// runtime. Same hazard for SMTP / SES.
//
// Keeping the existing shape (vs. switching to discriminatedUnion,
// which would break every downstream reader of env.EMAIL_TRANSPORT,
// env.RESEND_API_KEY, etc.) but adding a hard cross-field check at
// boot. Matches the shape/spirit of the hostileMinioDefaults block
// above.
if (env.EMAIL_TRANSPORT === "resend" && !env.RESEND_API_KEY) {
  throw new Error(
    `[Platos boot] EMAIL_TRANSPORT=resend requires RESEND_API_KEY. ` +
      `Set RESEND_API_KEY, OR unset EMAIL_TRANSPORT to fall through to the ` +
      `NullMailTransport (magic-link codes printed to webapp logs).`
  );
}
if (env.EMAIL_TRANSPORT === "smtp") {
  const missing: string[] = [];
  if (!env.SMTP_HOST) missing.push("SMTP_HOST");
  if (!env.SMTP_PORT) missing.push("SMTP_PORT");
  if (!env.SMTP_USER) missing.push("SMTP_USER");
  if (!env.SMTP_PASSWORD) missing.push("SMTP_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `[Platos boot] EMAIL_TRANSPORT=smtp requires: ${missing.join(", ")}. ` +
        `See docs/env-vars.md#email.`
    );
  }
}
if (env.EMAIL_TRANSPORT === "aws-ses") {
  // AWS SES uses the ambient AWS credential chain (env / instance role /
  // profile). Require an explicit FROM_EMAIL at minimum so the delivery
  // isn't silently rejected by SES for a missing sender domain identity.
  if (!env.FROM_EMAIL) {
    throw new Error(
      `[Platos boot] EMAIL_TRANSPORT=aws-ses requires FROM_EMAIL ` +
        `(the verified SES sender identity).`
    );
  }
}
