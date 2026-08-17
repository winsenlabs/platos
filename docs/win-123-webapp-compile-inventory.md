# WIN-123 webapp compile-error inventory

Captured after promoting the clean client to `@platos/database` and rewiring the
WIN-123 credential service. This is the input queue for the general legacy
webapp migration; it is not a request to reintroduce an inherited client or
compatibility facade.

## Reproduce

```sh
pnpm --filter @platos/database build
pnpm --filter webapp typecheck
pnpm audit:webapp-database-cutover
```

The typecheck reaches source diagnostics (the webapp TypeScript config is pinned
to the repository's TypeScript 5.5 deprecation level). On 2026-08-17 it reports
**1,546 diagnostics across 378 files**. The deterministic cutover audit reports
**921 findings**: 670 legacy delegates, 161 database imports, 25 legacy raw-table
references, 23 local-engine routes, 30 local-engine modules, and 12 local-worker
surfaces.

An exploratory build of the deferred Trigger compatibility closure in
`@platos/core` stops on **8 diagnostics across 3 files**: one exhausted-union
error plus seven missing inherited database enums (`RuntimeEnvironmentType`,
`TaskRunExecutionStatus`, `TaskRunStatus`, `WaitpointType`, `WaitpointStatus`,
and `TaskRunCheckpointType`). The agent does not import the local SDK package,
so its production build graph no longer compiles that unrelated closure. These
core diagnostics belong with the deferred compatibility queue, not with agent
runtime imports.

`@internal/zod-worker` exposes the same deferred boundary after its database
alias is removed: 10 diagnostics, including its two inherited client helper
types (`PrismaClientOrTransaction`, `PrismaReplicaClient`), the six run-engine
enums above, `RuntimeEnvironmentType`, and one pre-existing module-resolution
diagnostic for `eventsource-parser/stream`. Do not restore a source alias to hide
these package-entrypoint failures.

## Diagnostic codes

| Code | Count | Primary meaning in this queue |
| --- | ---: | --- |
| TS2339 | 564 | inherited delegate or field is absent from the clean client |
| TS7006 | 236 | contextual typing disappeared after an inherited type/delegate failed |
| TS2305 | 213 | inherited generated type/enum is not exported by the clean package |
| TS2353 | 174 | inherited create/update field is not in the clean input type |
| TS2345 | 101 | downstream argument no longer matches the clean type |
| TS2551 | 84 | inherited member is absent and TypeScript suggests a clean member |
| TS18046 | 55 | downstream value became `unknown` |
| TS2322 | 41 | assignment no longer matches the clean type |
| TS2724 | 37 | inherited generated export is absent (occasionally with a clean suggestion) |
| TS2344 | 11 | inherited key does not satisfy a clean generated constraint |
| TS2769 | 8 | no overload matches after clean-client promotion |
| TS2694 | 6 | inherited Prisma namespace member is absent |
| TS2739 | 5 | object is missing required fields |
| TS2741 | 4 | object is missing one required field |
| TS2366 | 2 | return path became incomplete |
| TS2740 | 2 | object is missing multiple required fields |
| TS2352 | 2 | unsafe conversion between inherited and clean shapes |
| TS1360 | 1 | object does not satisfy the clean shape |

## Highest-volume files

| Diagnostics | File |
| ---: | --- |
| 34 | `app/v3/environmentVariables/environmentVariablesRepository.server.ts` |
| 28 | `app/services/mfa/multiFactorAuthentication.server.ts` |
| 25 | `app/presenters/v3/EnvironmentVariablesPresenter.server.ts` |
| 24 | `app/models/member.server.ts` |
| 23 | `app/services/platformNotifications.server.ts` |
| 23 | `prisma/populate.ts` |
| 20 | `app/routes/api.v1.admin.users.$userId.data.ts` |
| 19 | `app/presenters/v3/VercelSettingsPresenter.server.ts` |
| 19 | `app/v3/services/deployment.server.ts` |
| 17 | `app/services/vercelIntegration.server.ts` |
| 17 | `app/v3/runEngineHandlers.server.ts` |
| 16 | `app/presenters/OrganizationsPresenter.server.ts` |
| 16 | `app/routes/admin.llm-models.$modelId.tsx` |
| 16 | `app/v3/services/alerts/deliverAlert.server.ts` |
| 16 | `app/v3/taskEventStore.server.ts` |

## Most common missing delegates and fields

The most frequent TS2339 members are:

- `runtimeEnvironment` (50)
- `admin` (46)
- `taskRun` (30)
- `organization` (29)
- `environments` (21)
- `llmModel` (21)
- `organizationProjectIntegration` (18)
- `featureFlags` (14)
- `workerDeployment` (14)
- `externalRef` (13)
- `id` (13)
- `title` (12)
- `orgMemberInvite` (11)
- `organizationIntegration` (11)
- `connectedGithubRepository` (11)
- `platosMessageAttachment` (11)

The most frequent missing generated exports are:

- `RuntimeEnvironmentType` (26)
- `PrismaClientOrTransaction` (21)
- `RuntimeEnvironment` (17)
- `TaskRunStatus` (15)
- `TaskRun` (14)
- `TaskEventCreateManyInput` (13)
- `TaskTriggerSource` (7)
- `ProjectAlertChannel` (6)
- `WorkerDeployment` (6)
- `BatchTaskRunStatus`, `BulkActionType`, `TaskQueue`, `RunEngineVersion`,
  `WorkerInstanceGroupType`, and `BackgroundWorker` (5 each)

## Scope boundary

Do not address this queue by restoring the retired tenancy workspace, pointing
ordinary migrate deploy at `legacy-prisma`, or adding a broad compatibility
export layer. Migrate call sites by product area to clean models and explicit
ancestry. The WIN-123 credential service and its serialization tests already use
the clean package and pass independently.
