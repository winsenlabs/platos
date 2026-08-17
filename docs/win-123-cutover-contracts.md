# WIN-123 Phase 1 cutover contracts

Phase 1 is an executable inventory and contract only. It does not run the
cutover, change runtime reads/writes, or modify either Prisma schema.

## Source and physical-object ownership

`internal-packages/tenancy-database/src/cutover-ledger.ts` owns the exhaustive
source disposition:

- 124 inherited Prisma models, each exactly once as `BACKFILL`, `EXPORT_DROP`,
  or `EPHEMERAL_DROP`;
- 130 physical tables: 124 model tables, five implicit joins, and
  `_prisma_migrations`;
- 44 enums and the `vector` extension;
- 458 indexes from an isolated replay of all 849 inherited migrations;
- zero application-created functions and zero application-created triggers.

`legacy-index-catalog.ts` deliberately records the migration-replay catalog,
not only `prisma migrate diff --from-empty`. The replay has 35 indexes or
historical index names absent from the datamodel diff and lacks 29 names the
current datamodel would generate. The unit gate pins both exact sets so catalog
drift is visible.

`BACKFILL` means at least one source value is consumed by the clean transform;
it does not imply that the source table or its indexes remain after cutover.
`EXPORT_DROP` is included in the signed export before removal.
`EPHEMERAL_DROP` is counted and reported but intentionally not translated.

## Deterministic identifiers

`src/cutover-id.ts` fixes:

- mapping version: `1`;
- UUID namespace: `75803f94-05d5-5eb3-b37d-65774e2aaa6c`;
- algorithm: RFC 9562 UUIDv5 (SHA-1 namespace UUID);
- name bytes: UTF-8 `<source-model>:<source-id>`;
- split bytes: UTF-8 `<source-model>:<source-id>:<stable-suffix>`.

Source IDs are not trimmed or case-folded. Empty IDs, colons in source IDs, and
non-canonical suffixes are rejected. Split child suffixes are fixed in
`sourceIdentityTransformManifest`; repeated message children use zero-based
`step:<ordinal>` and `tool-call:<ordinal>` suffixes. Shared-primary-key MCP
configuration rows reuse the `PlatosConnectedEntity` mapping rather than minting
a second UUID. Checked-in vectors cover ordinary and split mappings and are
intended for every language implementation of the offline cutover.

## Field transformation boundary

`src/source-model-manifest.ts` now includes machine-addressable descriptors for:

- the identity source and target(s) of all 55 retained `Platos*` models;
- canonical ownership/ancestry derivation;
- bounded JSON root normalization and JSON-to-column transforms;
- required identity, timestamp, default, and invalid-data policy;
- parameter-free source count, ID-map count, and collision queries.

Unlisted JSON is not implicitly copied. A later cutover implementation must add
a bounded descriptor or export the unsupported field. Invalid retained JSON and
missing required target values block the cutover.

## Cryptographic field ledger

`cryptographicFieldLedger` records source fields, source encoding, source key
domain, target fields, target key domain, transform, null policy, and required
post-cutover probe for:

- legacy MFA through `SecretReference`/`SecretStore` v1 and v2;
- provider and outbound MCP SecretStore references;
- entity service/test credentials (including the legacy plaintext service
  secret, which is validated and enveloped rather than copied);
- channel connection, app, and installation credentials;
- MCP OIDC access and refresh tokens;
- transitional clean `Credential.encryptedReference` rows;
- message content/thinking, tool-audit, safety, memory, and knowledge-graph
  encrypted material.

A retained encrypted value is never copied as opaque ciphertext between key
domains. It must decrypt under the declared source encoding, validate as the
expected plaintext shape, re-encrypt under the target domain, and pass the
ledger probe. Non-null unreadable material is a preflight blocker.
