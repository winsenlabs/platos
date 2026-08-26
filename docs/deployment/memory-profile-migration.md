# Memory profile migration

The Memory `profileKey` transition is an explicit deployment migration. Agent
startup never decrypts or scans Memory rows, deduplicates profiles, rewrites
relationships, or creates indexes. Startup performs only a bounded, read-only
catalog check and refuses to listen until the exact contract exists.

## Immutable-image commands

The tested migrations image exposes four commands:

- `memory-profile-bootstrap-empty` is the only command used by default Compose.
  It creates the exact indexes only when no profile rows exist, accepts an
  already-complete exact catalog without mutation, and otherwise fails with
  `MEMORY_PROFILE_MIGRATION_REVIEW_REQUIRED`. It never derives and applies an
  existing-data migration plan.

- `memory-profile-dry-run` reads at most the configured profile-row and
  profile-relationship bounds, decrypts metadata in process, and emits
  deterministic content-redacted JSON containing inventory counts and a
  SHA-256 plan digest. The digest binds the canonical IDs and source Memory IDs
  of every relationship that apply could remap.
- `memory-profile-apply --digest <sha256>` takes a serializable advisory lock,
  recomputes the plan, rejects any digest mismatch before mutation, remaps
  relationships, removes deterministic losers, normalizes winners, creates the
  two exact partial unique indexes, and verifies before commit.
- `memory-profile-verify` performs a read-only data and catalog verification.

The image preserves the Agent message-encryption key semantics. Supply the
active `PLATOS_MESSAGE_ENCRYPTION_KEY`, its positive
`PLATOS_MESSAGE_ENCRYPTION_KEY_V`, and every bounded historical
`PLATOS_MESSAGE_ENCRYPTION_KEY_V<N>` needed by persisted envelopes. Never print
or attach these values to migration evidence.

## Required deployment order

Use `scripts/deploy-platos.sh`. It enforces this sequence:

1. Verify the reviewed checkout, immutable Agent/webapp/migration image
   digests, image revision labels, compatibility attestation, named recovery
   point, and successful isolated restore-test identifier.
2. Pull images without recreating services.
3. Stop `agent` and `webapp`; these are the complete compose-managed writer set.
   Verify neither service is running or restarting.
4. Run image-bundled Prisma migrations.
5. Capture `memory-profile-dry-run.json`, extract exactly one lowercase 64-hex
   digest, and pass that exact digest to apply.
6. Capture apply and verify output.
7. Run ClickHouse migrations.
8. Recreate only Agent and webapp, then require both health checks to pass.

The default evidence directory is
`artifacts/deploy/$PLATOS_RELEASE_COMMIT_SHA`; override it with
`PLATOS_DEPLOY_EVIDENCE_DIR`. All three records declare
`contentRedacted: true`. They contain counts, key-version numbers, status, and
digests—not profile keys, metadata, row IDs, ciphertext, or plaintext.

## Fail-closed behavior

After writer shutdown, any Prisma, dry-run, digest extraction, apply, verify,
ClickHouse, recreate, or health failure triggers a best-effort second stop of
Agent and webapp. The script exits nonzero and leaves applications stopped.
Do not manually restart them to "see if it works."

Stable migration failures identify the next action:

- `MEMORY_PROFILE_MIGRATION_DECRYPT_UNAVAILABLE`: restore the required message
  key version, then repeat dry-run. Do not rotate or rewrite ciphertext as part
  of this migration.
- `MEMORY_PROFILE_MIGRATION_REVIEW_REQUIRED`: default Compose found existing
  profile data without the completed index contract. Do not retry ordinary
  `docker compose up` as a migration mechanism. Use the protected deployment
  procedure with the immutable migrations image, stopped writers, captured
  dry-run evidence, and the separately reviewed
  `PLATOS_MEMORY_PROFILE_PLAN_SHA256`.
- `MEMORY_PROFILE_MIGRATION_DIGEST_MISMATCH`: database state changed after
  dry-run. Keep writers stopped, capture a new dry-run, review it, and apply only
  the new digest.
- `MEMORY_PROFILE_MIGRATION_LIMIT_EXCEEDED` or
  `MEMORY_PROFILE_MIGRATION_RELATIONSHIP_LIMIT_EXCEEDED`: a bounded inventory
  limit was exceeded. Review capacity and explicitly increase
  `MEMORY_PROFILE_MIGRATION_MAX_PROFILES` or
  `MEMORY_PROFILE_MIGRATION_MAX_RELATIONSHIPS` before rerunning; do not remove
  either bound. Defaults are 100,000 profiles and 1,000,000 relationships;
  their hard maxima are 1,000,000 and 5,000,000 respectively.
- `MEMORY_PROFILE_MIGRATION_CATALOG_CONFLICT` or
  `MEMORY_PROFILE_MIGRATION_CONTRACT_INCOMPLETE`: do not drop or recreate
  indexes ad hoc. Preserve evidence and investigate catalog drift.

Apply is transactional and idempotent. If apply completed but the deploy lost
its connection before observing success, rerun verify, then capture and review
a new dry-run digest for the already-applied state. Applying that exact digest
reports `already_applied` without mutation; an old or arbitrary digest is never
accepted.

## Recovery

The deployment script requires `PLATOS_RECOVERY_POINT_ID` and
`PLATOS_RECOVERY_RESTORE_TEST_ID` before it touches services. These identifiers
must refer to the pre-migration Postgres/ClickHouse recovery point and its
successful isolated restore test. If compatibility was not proven, restore the
tested recovery point before starting the preserved old image pair. Never use
an image-only rollback to reverse incompatible data or schema changes.
