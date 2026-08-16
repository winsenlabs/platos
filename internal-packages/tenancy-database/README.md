# Platos tenancy database

This package is the clean-slate Prisma boundary for Platos tenancy and domain
data. It does not import, migrate, or modify the inherited database schema.

- `prisma/schema.prisma` is the authoritative control-plane schema.
- `prisma/end-user.prisma` generates a restricted data-plane projection with
  no operator or shared-tenancy relation paths.
- `src/end-user.ts` further removes raw SQL and transaction escape hatches from
  the data-plane client surface.
- `src/auth.ts` is the Platos-owned dashboard-auth boundary: opaque hashed
  operator sessions, magic-link and GitHub/Google identities, encrypted TOTP
  secrets, hashed single-use recovery and invitation codes, database-backed
  rate limits, membership-driven revocation, and audited impersonation.
- `src/source-model-manifest.ts` accounts exactly once for all 55 legacy
  `Platos*` sources. Those sources map to 59 distinct normalized targets;
  `Credential` and `AgentToolPolicy` are independent support models. The final
  schema therefore has 61 domain/capability models plus 16 tenancy/auth models,
  for 77 generated control-plane models.
- `src/json.ts` documents and validates every retained Json field. Values are
  persisted with native object/array roots; only `promptBlocks`,
  `dynamicBlocks`, `modelRoutes`, and `toolsBlockConfig` accept one legacy
  encoded layer, and no field accepts double encoding.
- Agent tool availability is represented by typed `AgentToolPolicy` rows.
  `enabledTools` is rejected at both the helper and database boundaries, while
  `AgentVersion.toolDefaultPolicy` makes zero-row `NONE` and `ALL` behavior
  explicit for tools registered after the version was created.
- Every `Turn` records the selected `AgentVersion`, current/canary bucket,
  cost, and latency. `Step` stores provider usage as typed token counters,
  including cache creation/read and reasoning tokens, with cost and latency.
- Thread compaction uses an Environment-scoped `Turn` cursor, timestamp, and
  `IDLE`/`IN_PROGRESS` state. Conditional state updates are the durable mutex;
  cursor, summary, timestamp, and state are advanced in one transaction.
- `Memory`, `MemoryEntity`, and `MemoryRelationship` are Agent-owned. An
  optional `clusterId` is the only cross-Agent sharing grant, and database
  ancestry requires the owner Agent's binding to belong to that
  Environment-owned `AgentCluster`. Relationship endpoints must share that
  exact cluster before they may cross Agent ownership.
- Memory and entity embeddings use `vector(1536)` with HNSW cosine indexes.
  Extracted memories carry a typed Thread/Turn provenance tuple and extractor
  version; a database unique key makes concurrent extractor retries dedupe.
- `prisma/migrations/00000000000000_initial` is the single migration generated
  from an empty PostgreSQL database, followed by tier and parent-chain checks
  that Prisma cannot express in its schema language.

Tests start one isolated PostgreSQL testcontainer and pass its connection URL
directly to Prisma. They do not read the repository `DATABASE_URL`.
