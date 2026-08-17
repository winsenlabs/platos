# WIN-123 Phase 1 cutover contracts

Phase 1 is an executable inventory and contract only. It does not run the
cutover, change runtime reads/writes, or modify either Prisma schema.

## Ordinary migration versus cutover

`pnpm db:migrate` is only for an empty database or one already initialized by
the clean `@platos/database` migration history. Its catalog guard refuses known
inherited tables and migration IDs before `prisma migrate deploy` runs. Never
baseline the clean initial migration over a legacy catalog and never point this
command at `legacy-prisma`.

Existing installations require a future, explicitly operator-gated
`db:cutover` workflow that executes the contracts below. That command does not
exist yet. Until it is implemented and reviewed, the guard's refusal is the
required behavior; reset, manual migration-history edits, and ordinary migrate
deploy are not substitutes.

## Source and physical-object ownership

`internal-packages/database/src/cutover-ledger.ts` owns the exhaustive
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

`src/source-model-manifest.ts` and `src/source-field-manifest.ts` include
machine-addressable descriptors for:

- the identity source and target(s) of all 55 retained `Platos*` models;
- every scalar field of all 64 `BACKFILL` sources, including `User`,
  `Organization`, `OrgMember`, `OrgMemberInvite`, `RuntimeEnvironment`,
  `Project`, `SecretReference`, `SecretStore`, and `ImpersonationAuditLog`;
- exactly one decision for each of 899 inherited scalar fields: 304
  `TRANSFORM`, 335 `COPY`, 259 `EXPORT`, and one `DROP`, including explicit
  transforms for `User.avatarUrl` and `User.dashboardPreferences`;
- all 561 required scalar target fields, with one or more source transforms or
  an explicit deterministic cutover default;
- canonical ownership/ancestry derivation;
- bounded JSON root normalization and JSON-to-column transforms;
- required identity, timestamp, default, and invalid-data policy.

The sole field-level `DROP` is `User.mfaLastUsedCode`: the legacy code hash
cannot derive a TOTP counter and is replaced by the cutover-timestep replay
barrier. The field audit reports missing and duplicate source dispositions
separately from missing and unsatisfied target requirements. Unlisted JSON is not
implicitly copied. Invalid retained JSON and missing required target values
block the cutover.

## Row conservation and omitted identities

`sourceValidationManifest` is generated from the 64 explicit `BACKFILL` ledger
entries. Each descriptor counts rows from its quoted physical source table,
counts distinct mapped source identities, and returns every omitted
`source_model`/`source_id` through a source-to-`cutover_id_map` anti-join. It
does not infer row counts from `information_schema`, and a missing mapping row
cannot disappear inside an aggregate count.

`cutoverConservationEquations` provides executable linear equations over named
count queries. Contracts cover one-to-one rows, one-source-to-several-target
splits, and joined-source merges. Every equation reports source count, target
count, and signed delta so non-conservation is visible before commit.

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

`aggregateCredentialPayloadContracts` groups fields that feed one target
Credential into canonical JSON payloads. Each component declares its payload
key, `SET_IF_ABSENT` merge rule, and requiredness. This covers entity
service/test material, channel connection credentials/webhook secret, channel
app client/signing secrets, installation bot/refresh tokens, and MCP OIDC
access/refresh tokens. Duplicate payload keys and missing required components
block cutover rather than overwriting or dropping a value. An OIDC session with
no access or refresh token emits no empty Credential and leaves its nullable FK
unset. Project-owned entity credentials deterministically fan out to each
project Environment because the clean Credential owner is Environment and bind
through the declared deterministic Credential-name lookup; the other aggregate
payloads bind through their declared clean foreign key.

Historical message fields explicitly support mixed plaintext and envelopes.
For version-column messages, a present version requires successful base64
envelope decryption; only an absent version denotes plaintext. For JSON-marker
families, the exact `__platos_enc` marker denotes an envelope and all other
values are plaintext/plain JSON. Once an envelope is recognized, decryption
failure blocks cutover and never falls back to plaintext. Every message probe
must exercise both envelope and plaintext variants and return source-equivalent
semantics through the target reader.
