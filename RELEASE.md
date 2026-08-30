# Platos release process

A merge is source integration only. It does not authorize image publication,
Trigger deployment, test deployment, production promotion, or rollback. Each
operational action has its own immutable inputs, evidence record, and approval.
This process governs OCI and environment operations only. It does not authorize
npm publication; a Changesets entry records package version intent and nothing
in this document grants package-registry write authority.

## 1. Review and merge

- Require the normal CI checks and `persisted-state-completion` on the exact PR
  head.
- Merge only after review. Record the landed `main` SHA; PR-head evidence is not
  post-merge evidence when the landed SHA differs.
- A `main` push builds and gates OCI candidates but has no package-write or
  external-deployment authority.
- Candidate archives are build evidence, not publication or environment mutation.

## 2. Build and gate the landed SHA

`.github/workflows/build-images.yml` builds Agent, webapp, and migrations OCI
archives exactly once. It runs the legacy-upgrade rehearsal, persisted-state
checks, enforced performance budgets, authenticated browser matrix, completion
audit, and immutable identity verification without registry authentication.

Retain the successful run ID, run attempt, landed SHA, candidate archive
checksums, `candidate-images.json`, and persisted-state evidence.

## 3. Authorize image publication

Dispatch `.github/workflows/publish-images.yml` with the successful landed-main
build run ID. The `image-publication` environment must require an authorized
reviewer and prevent self-review.

The publication workflow:

- verifies that the source was a successful `push` run of `build-images.yml` on
  `main`;
- proves the source SHA remains in `main` history;
- downloads the exact source-run OCI and persisted-state artifacts;
- re-verifies archive checksums, manifest digests, OCI revision labels, and the
  passing candidate identity record;
- publishes immutable `sha-<landed-sha>` tags without rebuilding or writing a
  mutable `latest` tag.

Publication approval does not authorize deployment.

## 4. Authorize Trigger deployment

A `main` push to `.github/workflows/trigger-deploy.yml` validates the Trigger
boundary only. It cannot call Trigger APIs.

An explicit workflow dispatch plus `trigger-deployment` environment approval may
create one immutable Trigger deployment with `--skip-promotion`. Promotion is a
separate job behind the distinct `trigger-promotion` environment and targets
only the deployment version emitted by the approved deploy job.

Trigger deployment and promotion do not authorize Platos application deployment.

## 5. Authorize test deployment

Before changing `test.platos.dev`:

- approve the `test-platos` environment action separately;
- record current application digests and database/store recovery checkpoints;
- restore-test the recovery point;
- review the content-redacted Memory profile dry-run and record its exact plan
  SHA-256;
- supply only published immutable image digests from the same landed SHA.

Run `scripts/deploy-platos.sh` with the reviewed Memory plan digest. It stops and
verifies application writers, runs Prisma migrations, re-runs the Memory dry-run
and requires the approved digest, applies and verifies that exact plan, runs
ClickHouse migrations, and only then restarts the application pair. Any failure
after shutdown leaves applications stopped.

See `docs/deployment/persisted-state-release-gate.md` and
`docs/deployment/memory-profile-migration.md`.

## 6. Accept and promote

Test-environment acceptance requires immutable runtime identity, migration logs,
Agent/webapp health, authenticated browser completion, representative persisted
mutation read-back, and bounded recent logs. A login-page HTTP 200 is not enough.

Production promotion requires a separate approval and must consume the same
accepted immutable identities. Do not rebuild between test acceptance and
production promotion.

## 7. Roll back

Rollback is separately authorized. Restore the recorded prior application
images only when old-binary compatibility with the migrated schema was proven.
When schema or data compatibility is not proven, keep writers stopped and use
the coordinated PostgreSQL, ClickHouse, and object-store recovery procedure
before restoring prior binaries. Never mix old binaries with incompatible state.

## Completion boundary

Do not mark release issues Done from PR or pre-merge evidence. Completion
requires the authorized deployment and acceptance records for the intended
environment. Preserve all action run IDs, approvers, immutable identities,
recovery evidence, migration evidence, and rollback identities in the release
record.

No OCI publication, environment mutation, promotion, acceptance, or rollback approval in
this process authorizes npm publication. Package publication requires a separate
owner decision and mechanism outside this repository; none is currently
provided here.
