# WIN-123 external Trigger writer fence

This contract prepares an authorized maintenance-window cutover. Repository
scripts are dry-run only: they generate plans and verification commands but do
not call Trigger, pause production work, deploy, promote, restore, or release a
fence.

## Runtime boundary

External Trigger registrations must not connect to Platos PostgreSQL.
`apps/agent/src/trigger-tasks/deployment-boundary-manifest.json` lists every
emitted registration source and forbidden database imports/environment names.
The executable manifest test walks transitive runtime imports. The Trigger
deploy workflow runs it before deployment.

`platos-custom-task` now calls the Platos-owned internal execution endpoint. Its
Trigger payload contains only task ID, canonical scope, invocation metadata,
and operator input. The internal auth token is an HTTP header; handler source,
`DATABASE_URL`, Prisma configuration, and callback failure bodies never enter
Trigger payloads, logs, metadata, or failure output.

The callback endpoint contract is:

- `POST /api/v1/agent/internal/platos-tasks/execute`;
- `X-Platos-Internal-Auth` authenticated;
- request body fields: `taskRowId`, `payload`, `scope`, `invokedBy`, optional
  `agentId`;
- maximum external wait: 590 seconds;
- success body: `{ "status": "completed", "result": ... }`;
- any non-completed or malformed response maps to a stable Trigger-side error.

External Trigger Sessions remain registered as `platos.chat.session`; this
writer fence does not alter Session IDs, turn payloads, or streaming behavior.

## Immutable deployment versions

`.github/workflows/trigger-deploy.yml` always deploys with `--skip-promotion`.
The deploy job exposes `deployment_version` and uploads
`trigger-deployment-contract.json` containing:

- source-compatible deployment version (required for manual dispatch);
- newly emitted target-compatible deployment version;
- repository commit SHA;
- whether explicit target promotion was requested.

A manual promotion promotes exactly the deploy job's output. A push build never
promotes. Preserve the workflow artifact with the signed cutover report and
verify that both versions remain available before maintenance starts.

## Generate the dry-run plan

```bash
node apps/agent/scripts/trigger-cutover-plan.mjs \
  --source-version 20260817.1 \
  --target-version 20260817.2 \
  --trigger-db-role legacy_trigger_writer \
  --agent-base-url https://agent.internal.example \
  --output /secure/cutover/trigger-plan.json
```

The output file is mode `0600`, contains no token values, and has a SHA-256
contract checksum. `trigger-cutover-adapter` entries are an interface for the
operator's Trigger Cloud/self-hosted automation. The adapter must read tokens
from its environment, never command-line arguments, and implement idempotent:

- `verify-version`;
- `pause-schedules`;
- `pause-queues` (or reject new enqueue when a provider has no queue pause);
- `drain-runs --cancel-after-seconds N`;
- `verify-no-active-runs`;
- `promote-version`;
- `callback-smoke`.

Adapter output must contain only deployment/run IDs, counts, timestamps, and
stable result codes. It must never print request headers, payload bodies,
provider credentials, or error response bodies.

## Maintenance gate order

An authorized operator, not repository automation, performs these actions:

1. Record and verify source and target versions.
2. Pause schedules and queues/reject new enqueue.
3. Drain active runs; cancel only according to the approved timeout policy.
4. Prove no active runs remain.
5. Continuously run the PostgreSQL session assertion and revoke/firewall the
   legacy Trigger DB role.
6. Keep maintenance mode and the Trigger writer fence active through database
   cutover.
7. Promote the target Trigger version.
8. Run a real Session/task callback smoke against the target-compatible stack.
9. Release the fence and resume queues/schedules only after every acceptance
   gate is recorded as passing.

The generated PostgreSQL command maps `DATABASE_URL` to psql's `PGDATABASE`
without rendering the URL and uses
`apps/agent/scripts/verify-no-trigger-db-sessions.sql`. It fails closed if
`pg_stat_activity` contains the exact legacy role or a Trigger-like application
name. Continuous sampling and database/network revocation are required; a
single zero-session sample is not a durable fence.

## Late-acceptance rollback

If target deployment succeeds and a later acceptance gate fails:

1. Keep schedules/queues paused and preserve DB role/network revocation.
2. Restore PostgreSQL backup/PITR and coordinated ClickHouse state; reconcile
   object-store writes newer than the restoration point.
3. Re-promote the recorded source-compatible Trigger version.
4. Only then start the recorded source-compatible Platos images.
5. Run a real callback smoke against the restored stack.
6. Release the Trigger database fence and resume work only after that smoke is
   recorded as passing.

`trigger-cutover-plan.test.mjs` pins this order with a transition contract and
rejects source-stack start before source re-promotion or fence release before
restored callback acceptance.

## Focused verification

```bash
pnpm --dir apps/agent exec vitest run \
  src/trigger-tasks/platos-custom-task.test.ts \
  src/trigger-tasks/deployment-boundary-manifest.test.ts \
  src/trigger-tasks/registration-manifest.test.ts

node --test apps/agent/scripts/trigger-cutover-plan.test.mjs
```

These tests are fixture-only and perform no production Trigger or database
operation.
