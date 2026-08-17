# Platos database

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
- `src/secrets.ts` is the Platos-native credential boundary. `Credential` is
  Environment-owned safe metadata; immutable `CredentialSecretVersion` rows
  contain versioned HKDF-SHA256/AES-256-GCM envelopes; `ProviderKey` stores a
  same-Environment Credential FK; and `CredentialAudit` is append-only.
- `src/source-model-manifest.ts` accounts exactly once for all 55 legacy
  `Platos*` sources. Those sources map to 59 distinct normalized targets;
  four independent support models add the provider credential envelope and
  typed agent-tool policy boundaries. The final schema therefore has 63
  domain/capability models plus 17 tenancy/auth models, for 80 generated
  control-plane models.
- `src/cutover-ledger.ts` classifies all 124 inherited source models, 130
  physical tables, 44 enums, 458 replayed indexes, the vector extension, and
  Prisma migration history exactly once. It also provides field-addressable
  cryptographic transforms and post-cutover read probes. The companion
  `src/cutover-id.ts` pins UUID mapping version 1, its namespace, split-target
  suffix grammar, and cross-language golden vectors.
- Field-level identity, ownership, bounded JSON normalization,
  required/default, and validation-query descriptors live beside the source
  model manifest. Unlisted or malformed retained JSON is not copied by
  implication; the offline cutover must add a descriptor or block/export it.
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
- `prisma/migrations/00000000000000_initial` is generated from an empty
  PostgreSQL database and is followed only by clean sequential migrations,
  currently `20260817000000_add_upload_reservations`.
- `legacy-prisma` preserves the inherited 124-model schema, migration lock, and
  all 849 inherited migrations as a non-runtime upgrade-test and forensic
  fixture.

Tests start one isolated PostgreSQL testcontainer and pass its connection URL
directly to Prisma. They do not read the repository `DATABASE_URL`.

## Migration safety

`pnpm db:migrate` and `pnpm --filter @platos/database db:migrate:deploy` run a
bounded catalog check before Prisma. The check permits an empty database or a
catalog already owned by this clean migration history. It refuses inherited
catalog markers such as `RuntimeEnvironment`, `TaskRun`, or the inherited
initial migration, so ordinary deploys can never apply the clean baseline on
top of a legacy installation.

An inherited installation uses the explicit operator-gated `db:cutover`
workflow; ordinary migration deploy never redirects to it. `pnpm db:cutover`
defaults to a read-only preflight and emits a checksummed JSON report. Durable
mutation requires `--execute`, versioned execute/irreversible-effect
acceptance values, backup and restore-test references, a capacity record, a
writer-fence record, the well-known advisory lock, and zero non-cutover client
sessions.

Phase 3 currently implements the User/OperatorIdentity, Organization,
OrganizationMembership, Project/ProjectMembership, and Environment data phase,
plus retained-domain Batch 1 for Tool, Agent/AgentBinding, AgentVersion, and
AgentCluster. Every other retained/export/cryptographic/external-store phase is
listed as a machine-readable `INCOMPLETE` blocker, so full `--execute` cannot
reach DDL. The executable path is rehearsal-only and additionally requires
`--core-rehearsal --force-rollback-before-commit`; it creates the clean catalog,
materializes the UUID map, backfills and validates both implemented phases, compares the
application catalog with a fresh clean reference, exports evidence, and always
rolls the transaction back. This is not authorization to run against production.

The Compose `cutover-init` service is behind the opt-in `cutover` profile and
invokes the same package command. It is intentionally fail-closed while the
incomplete phase ledger is non-empty.

Run read-only preflight with `pnpm --filter @platos/database db:cutover`; no
mutation flag is implied. The isolated production-command harness is opt-in:

```bash
RUN_DATABASE_CUTOVER_HARNESS=1 pnpm --filter @platos/database exec vitest run \
  src/cutover-harness.integration.test.ts --no-file-parallelism
```

It starts disposable pgvector PostgreSQL containers, invokes the exact
`db:migrate:deploy` and `db:cutover` scripts, and proves the implemented rehearsal
rolls back before commit. It never reads the repository `DATABASE_URL`.

## Credential operations

- Project ADMIN and Organization OWNER/ADMIN operators may create, rotate,
  rewrap, and revoke credentials. Runtime reads require an authenticated
  Environment authorization. End-user clients have no credential graph.
- Safe selects omit ciphertext, salt, nonce, authentication tag, hashes, and
  root material. Plaintext is returned only as redacting `SecretMaterial` at
  the final runtime boundary and is never cached or serialized.
- Every successful read, rotate, rewrap, revoke, and retired-version purge writes
  a metadata-only audit row with actor, timestamp, credential, action, and
  `SUCCESS` outcome in the same transaction. Audit insertion failure aborts the
  operation; database triggers reject audit UPDATE, DELETE, and TRUNCATE.
- Revocation locks the Credential, retires its active envelope, and gives that
  envelope a 24-hour readability/retention deadline before clearing the active
  pointer. Callers may shorten or extend the deadline up to the hard 30-day
  maximum; invalid retention values fail closed.
- Access-key rotation locks its Environment and the database partial unique
  index independently enforces at most one non-revoked, non-retiring key.
- Provider links store a Credential ID. Compatibility names and MCP
  `credsSecretKey` values are bare same-Environment references, never raw
  secrets. Scoped resolution is dashboard-only with no provider
  `process.env` fallback.
- This remains a clean-slate schema and initial migration. The checked-in
  Phase 1 cutover ledgers are offline contracts only; there is no runtime
  SecretStore dual-write, fallback, or legacy backfill path.

## Credential root-key rotation

Configure `PLATOS_CREDENTIAL_ROOT_KEY_VERSION` as a positive active version and
`PLATOS_CREDENTIAL_ROOT_KEYS` as a JSON object mapping each active/prior positive
version to exactly 64 hexadecimal characters. Generate every root independently with
`openssl rand -hex 32`; never reuse webapp, agent, message, session, magic-link,
or service-auth key material.

For a version 1 to version 2 rotation:

1. Add `"2":"<new-root>"` to `PLATOS_CREDENTIAL_ROOT_KEYS` on webapp, agent,
   and worker while keeping active version `1`; deploy and confirm all services
   accept the overlap ring.
2. Set `PLATOS_CREDENTIAL_ROOT_KEY_VERSION=2` on all three services and deploy. New
   envelopes use root 2; root 1 remains read-only for existing active envelopes.
3. Run `rewrapActive` for every active credential. Rewrapping preserves the
   secret revision, creates a root-2 envelope, retires the old envelope, and
   appends one immutable `REWRAP` audit row.
4. From privileged deployment operations, check `status()` across the entire
   deployment. `unpurgedVersionsByRoot[1]` counts active, retired, and still-
   readable envelopes in every Environment. Rewrap active envelopes and call
   privileged `purgeRetired` with a non-future retention cutoff. The operation
   uses a hard-capped batch, deterministic `createdAt`/ID ordering, and never
   removes active or still-readable versions. Then require
   `canRemoveRoot(..., 1) === true`. Treat any reference or failed check as a
   hard block on removal.
5. Remove the `"1"` entry from `PLATOS_CREDENTIAL_ROOT_KEYS` on all three
   services, deploy, and check status and a representative credential read again.

Provider-secret rotation is separate: `rotateCredential` creates a new secret
revision under the active root. A request that already acquired old
`SecretMaterial` may finish; subsequent reads receive only the replacement.
