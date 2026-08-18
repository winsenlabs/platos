# Trigger registrations

This directory contains Trigger SDK declarations. Active Platos durable work is
executed by a separate Trigger application (Trigger Cloud or a separately
self-hosted Trigger service selected by deployment configuration). The Platos
agent remains the tenancy and credential authority; task shells call back into
the agent where application work and provider access are required.

`registration-manifest.ts` is the typed ownership/disposition inventory. It is
not a runtime dispatch table and changes no task ID, schedule, queue, retry, or
dispatch behavior. `registration-manifest.test.ts` parses these source files and
requires every declaration to be classified exactly once.

`deployment-boundary-manifest.json` is the emitted-worker security contract.
Its executable test walks every registration's transitive runtime imports and
fails if a task can import Prisma/Platos database clients, `pg`, a database
provider, `DATABASE_URL`, or `DIRECT_URL`. The deploy workflow runs this gate
before building an immutable Trigger version.

## Registration classes

| Manifest                           | Count | Semantics                                                                                                                                   |
| ---------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTERNAL_PLATOS_TASK_MANIFEST`    |    18 | Active Platos task/schedule IDs executed by an external Trigger deployment.                                                                 |
| `EXTERNAL_PLATOS_SESSION_MANIFEST` |     1 | Active external Trigger Session: `platos.chat.session`.                                                                                     |
| `DORMANT_TRIGGER_TASK_MANIFEST`    |     1 | Retained, functional source for `platos.agent.durable-turn`; chat dispatch uses `platos.chat.session` and must not be rewired to this task. |

There are 19 `task`/`schedules.task` declarations plus one
`chat.customAgent` declaration. Trigger CLI source discovery still scans this
directory, so the manifests document classification rather than filtering
files from discovery.

## External deployment

Run the Trigger CLI from `apps/agent`. `trigger.config.ts` deliberately requires
an explicit `TRIGGER_PROJECT_REF`; there is no repository-specific fallback.
Loading ordinary agent runtime modules or running agent unit tests does not load
the deployment config.

Per-tenant credentials stay in Platos and are not copied into Trigger task
payloads. Task callbacks use the agent's internal authentication boundary and
carry only the scope needed by that declaration. Authentication is supplied in
`X-Platos-Internal-Auth`, never in a Trigger payload or result.

`platos-custom-task` is a callback-only shell. It sends task ID, canonical
scope, invocation metadata, and operator input to
`POST /api/v1/agent/internal/platos-tasks/execute` with a 590-second bound. The
Platos-owned endpoint performs scoped lookup, handler execution, and last-run
writes. Trigger receives neither handler source nor database configuration, and
callback failures are mapped to stable codes without response bodies or thrown
transport details. Callback failures throw those stable codes so Trigger marks
the run failed and applies the configured retry policy rather than recording a
successful run whose output merely says `failed`.

Deploys use `--skip-promotion`. The workflow artifact records source and target
versions; promotion, pause/drain, callback acceptance, and rollback ordering are
documented in `docs/win-132-trigger-writer-fence.md`.
