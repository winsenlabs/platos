// The STORES section — the four backing stores ADR M0.3 §4 gives an adapter.
//
// FOUR GROUPS, NOT ONE SECTION-WIDE ANCHOR. `postgres`, `redis`, `clickhouse`
// and `objectstore` are four independent decisions an install makes, and folding
// them behind one anchor would mean an install with PostgreSQL and no object
// store either fails startup or silently accepts a half-configured bucket. Each
// group carries its own anchor; see `ConfigGroupSpec` in schema.ts for why an
// anchor is not the same thing as `required`.
//
// WHAT IS DELIBERATELY NOT HERE.
//
//   * PER-TENANT PROVIDER CREDENTIALS. They are rows in the `providers` context's
//     canonical store, encrypted at rest under the security section's key. A
//     process-level variable for them would be a second, unscoped copy of a
//     value the tenancy model says belongs to one organisation.
//   * THE ORM's OWN `DATABASE_URL`. `packages/adapters/postgres-tenancy` is the
//     one home of the client (ADR M0.3 §15, `tenancy-prisma-only`), and its
//     migration tooling reads `DATABASE_URL` because that is the name the ORM's
//     CLI takes. `PLATOS_STORE_POSTGRES_URL` is the CORE-API's view of the same
//     database and is what the composition root will hand the adapter when it
//     constructs one. Naming one variable would not have made them one concern:
//     the CLI's is a tool argument, this is a process input.
//   * A MIGRATION-ON-BOOT SWITCH. Applying schema changes from the serving
//     process is a decision about release order, not a store setting, and the
//     expand/contract rehearsal WIN-258 landed is the surface that owns it.

import type { ConfigFieldSpec, ConfigGroupSpec, ConfigSectionSpec } from "./schema.js";

/** Where a resolved value is read from. Supplied by the section engine. */
export type SectionReader = (name: string) => string | null;

/** Which groups an install actually declared. Supplied by the section engine. */
export type GroupPresence = (id: string) => boolean;

const postgresUrl: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_STORE_POSTGRES_URL",
  kind: "url",
  required: false,
  defaultValue: null,
  // The connection string carries the password. It is never echoed, not even
  // when the failure is "this is not a URL" — a malformed connection string is
  // still a connection string, and a truncated one still leaks its prefix.
  secret: true,
  describe: "the canonical PostgreSQL database this process reads and writes",
  schemes: Object.freeze(["postgres:", "postgresql:"]),
});

const redisUrl: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_STORE_REDIS_URL",
  kind: "url",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the Redis instance behind the cache, rate limiter and event bus",
  schemes: Object.freeze(["redis:", "rediss:"]),
});

const clickhouseUrl: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_STORE_CLICKHOUSE_URL",
  kind: "url",
  required: false,
  defaultValue: null,
  secret: true,
  describe: "the ClickHouse endpoint the observability sink writes spans to",
  schemes: Object.freeze(["http:", "https:"]),
});

const objectEndpoint: ConfigFieldSpec = Object.freeze({
  name: "PLATOS_STORE_OBJECT_ENDPOINT",
  kind: "url",
  required: false,
  defaultValue: null,
  // Not a secret: an endpoint is a hostname, and the credentials beside it are
  // where the sensitivity lives. Marking it secret would hide the ONE value an
  // operator debugging a bucket misconfiguration needs to see echoed back.
  secret: false,
  describe: "the S3-compatible object store endpoint holding attachments and artifacts",
  schemes: Object.freeze(["http:", "https:"]),
});

export const STORES_SECTION: ConfigSectionSpec = Object.freeze({
  id: "stores",
  describe: "the backing stores this process reads and writes",
  groups: Object.freeze([
    Object.freeze({
      id: "postgres",
      describe: "the canonical PostgreSQL store",
      anchor: postgresUrl,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_STORE_POSTGRES_POOL_MAX",
          kind: "integer",
          required: false,
          // Ten, matching the `connection_limit=30` the compose stack sets for
          // the legacy process across three workers. A default of one would
          // serialise every request behind a single connection and look like a
          // latency problem; a default of a hundred would exhaust the server's
          // own limit the first time two instances start.
          defaultValue: "10",
          secret: false,
          describe: "how many pooled connections this process may hold open",
          minimum: 1,
          maximum: 1000,
        }),
        Object.freeze({
          name: "PLATOS_STORE_POSTGRES_STATEMENT_TIMEOUT_MS",
          kind: "integer",
          required: false,
          defaultValue: "15000",
          secret: false,
          describe: "how long one statement may run before the server cancels it",
          minimum: 1,
          maximum: 600000,
        }),
        Object.freeze({
          name: "PLATOS_STORE_POSTGRES_SCHEMA",
          kind: "string",
          required: false,
          defaultValue: "public",
          secret: false,
          describe: "the schema the canonical tables live in",
          minimumLength: 1,
        }),
      ]),
    }),
    Object.freeze({
      id: "redis",
      describe: "the Redis instance behind cache, rate limiting and streams",
      anchor: redisUrl,
      requiredWithAnchor: Object.freeze([]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_STORE_REDIS_KEY_PREFIX",
          kind: "string",
          required: false,
          // Three adapters share one instance. Without a prefix, two installs
          // pointed at the same Redis silently share a rate-limit counter, which
          // is a cross-tenant leak that no test of either install would show.
          defaultValue: "platos",
          secret: false,
          describe: "the key prefix that keeps two installs on one instance apart",
          minimumLength: 1,
        }),
        Object.freeze({
          name: "PLATOS_STORE_REDIS_TLS",
          kind: "boolean",
          required: false,
          defaultValue: "false",
          secret: false,
          describe: "whether to negotiate TLS on the connection",
        }),
      ]),
    }),
    Object.freeze({
      id: "clickhouse",
      describe: "the ClickHouse span store",
      anchor: clickhouseUrl,
      requiredWithAnchor: Object.freeze([
        Object.freeze({
          name: "PLATOS_STORE_CLICKHOUSE_DATABASE",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: false,
          // Required WITH the anchor and given no default on purpose. A default
          // of `default` is what the vendor image ships, so a typo in the real
          // database name would write every span into a database that exists,
          // accepts them, and is not the one anybody queries.
          describe: "the database name spans are written into",
          minimumLength: 1,
        }),
      ]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_STORE_CLICKHOUSE_TIMEOUT_MS",
          kind: "integer",
          required: false,
          defaultValue: "5000",
          secret: false,
          describe: "how long a span write may take before it is abandoned",
          minimum: 1,
          maximum: 120000,
        }),
      ]),
    }),
    Object.freeze({
      id: "objectstore",
      describe: "the S3-compatible object store",
      anchor: objectEndpoint,
      requiredWithAnchor: Object.freeze([
        Object.freeze({
          name: "PLATOS_STORE_OBJECT_BUCKET",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: false,
          describe: "the bucket attachments and artifacts are stored in",
          minimumLength: 1,
        }),
        Object.freeze({
          name: "PLATOS_STORE_OBJECT_ACCESS_KEY_ID",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: true,
          describe: "the access key identifying this process to the object store",
          minimumLength: 3,
        }),
        Object.freeze({
          name: "PLATOS_STORE_OBJECT_SECRET_ACCESS_KEY",
          kind: "string",
          required: false,
          defaultValue: null,
          secret: true,
          describe: "the secret paired with the access key",
          minimumLength: 8,
        }),
      ]),
      optional: Object.freeze([
        Object.freeze({
          name: "PLATOS_STORE_OBJECT_REGION",
          kind: "string",
          required: false,
          defaultValue: "us-east-1",
          secret: false,
          describe: "the region the signing algorithm uses",
          minimumLength: 1,
        }),
      ]),
    }),
  ]),
});

export interface PostgresStoreConfiguration {
  readonly url: string;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly schema: string;
}

export interface RedisStoreConfiguration {
  readonly url: string;
  readonly keyPrefix: string;
  readonly tls: boolean;
}

export interface ClickHouseStoreConfiguration {
  readonly url: string;
  readonly database: string;
  readonly timeoutMs: number;
}

export interface ObjectStoreConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

/**
 * The typed result.
 *
 * A group an install did not declare is `null`, not a default-filled object.
 * The difference is the whole point: `null` is the only value the composition
 * root can read as "do not construct this adapter", and a defaulted object would
 * make an unwired store indistinguishable from one pointed at localhost.
 */
export interface StoresConfiguration {
  readonly postgres: PostgresStoreConfiguration | null;
  readonly redis: RedisStoreConfiguration | null;
  readonly clickhouse: ClickHouseStoreConfiguration | null;
  readonly objectstore: ObjectStoreConfiguration | null;
}

export function assembleStores(read: SectionReader, declared: GroupPresence): StoresConfiguration {
  return Object.freeze({
    postgres: !declared("postgres")
      ? null
      : Object.freeze({
          url: read("PLATOS_STORE_POSTGRES_URL") ?? "",
          poolMax: Number(read("PLATOS_STORE_POSTGRES_POOL_MAX")),
          statementTimeoutMs: Number(read("PLATOS_STORE_POSTGRES_STATEMENT_TIMEOUT_MS")),
          schema: read("PLATOS_STORE_POSTGRES_SCHEMA") ?? "",
        }),
    redis: !declared("redis")
      ? null
      : Object.freeze({
          url: read("PLATOS_STORE_REDIS_URL") ?? "",
          keyPrefix: read("PLATOS_STORE_REDIS_KEY_PREFIX") ?? "",
          tls: read("PLATOS_STORE_REDIS_TLS") === "true",
        }),
    clickhouse: !declared("clickhouse")
      ? null
      : Object.freeze({
          url: read("PLATOS_STORE_CLICKHOUSE_URL") ?? "",
          database: read("PLATOS_STORE_CLICKHOUSE_DATABASE") ?? "",
          timeoutMs: Number(read("PLATOS_STORE_CLICKHOUSE_TIMEOUT_MS")),
        }),
    objectstore: !declared("objectstore")
      ? null
      : Object.freeze({
          endpoint: read("PLATOS_STORE_OBJECT_ENDPOINT") ?? "",
          bucket: read("PLATOS_STORE_OBJECT_BUCKET") ?? "",
          accessKeyId: read("PLATOS_STORE_OBJECT_ACCESS_KEY_ID") ?? "",
          secretAccessKey: read("PLATOS_STORE_OBJECT_SECRET_ACCESS_KEY") ?? "",
          region: read("PLATOS_STORE_OBJECT_REGION") ?? "",
        }),
  });
}
