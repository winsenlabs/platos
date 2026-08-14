# Prisma model disposition

The current schema contains **125 models: 54 Platos-owned and 71 inherited**. The clean-slate schema includes no inherited model by default. Every inherited model below has one final disposition; none is TBD.

`Keep` means retaining an inherited model unchanged. **No inherited model qualifies.** Platos concepts are re-homed under Platos-owned names and shapes; Trigger application-shell and run-engine concepts are dropped.

## Summary

| Disposition | Count |
| --- | ---: |
| Re-home: tenancy/authentication | 13 |
| Re-home: retained Platos capability | 12 |
| Drop: Trigger run engine | 31 |
| Drop: inherited shell/dashboard capability | 15 |
| Keep unchanged | 0 |
| **Total inherited models** | **71** |

## Re-home: tenancy and authentication — 13

These concepts survive, but their inherited Trigger tables do not. Their replacements follow the Platos tenancy and credential designs.

| Inherited model | Platos replacement | Decision |
| --- | --- | --- |
| `User` | `User` | Re-author as the global authenticated operator identity; authority comes only from memberships. |
| `MfaBackupCode` | `MfaRecoveryCode` | Re-home under Platos-native user authentication with hashed single-use codes. |
| `InvitationCode` | `OrganizationInvitation` | Merge generic invitation-code behavior into one expiring organization invitation. |
| `AuthorizationCode` | `OAuthAuthorizationCode` | Re-home into Platos OAuth with hashed, short-lived, single-use authorization codes. |
| `PersonalAccessToken` | `Credential` | Replace Trigger PATs with a unified Platos control-plane credential and explicit permissions. |
| `OrganizationAccessToken` | `Credential` | Replace with an organization-scoped machine credential in the same system. |
| `Organization` | `Organization` | Re-author as Platos's tenant, membership, billing, and policy root. |
| `OrgMember` | `OrganizationMembership` | Re-author with explicit owner/admin/member roles. |
| `OrgMemberInvite` | `OrganizationInvitation` | Merge with the invitation-code model and bind the intended role. |
| `RuntimeEnvironment` | `Environment` | Re-author as a project-owned credential/data/traffic isolation boundary, not a code stage. |
| `Project` | `Project` | Re-author as the operator access and resource namespace boundary. |
| `RuntimeEnvironmentSession` | `EnvironmentSession` | Re-home only the Platos session concept; no Trigger development-session semantics survive. |
| `ImpersonationAuditLog` | `ImpersonationAuditEvent` | Preserve immutable operator impersonation evidence under Platos-native identity and tenancy. |

## Re-home: retained Platos capabilities — 12

These inherited tables currently back active Platos features. Each receives a Platos-owned replacement instead of carrying Trigger's shape forward.

| Inherited model | Platos replacement | Decision |
| --- | --- | --- |
| `SecretReference` | `Credential` | Merge secret metadata/reference into one credential record with encrypted material stored behind a provider boundary. |
| `SecretStore` | `Credential` | Merge encrypted BYOK and service-secret material into the unified credential system. |
| `EnvironmentVariable` | `EnvironmentConfiguration` | Re-home project-defined configuration keys independent of Trigger deployments. |
| `EnvironmentVariableValue` | `EnvironmentConfigurationValue` | Re-home environment-specific values and credential references. |
| `ProjectAlertChannel` | `AlertChannel` | Preserve email/Slack/webhook destinations without Trigger project/run coupling. |
| `ProjectAlert` | `Alert` | Preserve alert lifecycle using Platos event types and resource IDs. |
| `ProjectAlertStorage` | `AlertDeliveryState` | Preserve provider delivery/checkpoint state with explicit idempotency. |
| `LlmModel` | `ModelCatalogEntry` | Preserve the model catalogue as Platos's single model source of truth. |
| `LlmPricingTier` | `ModelPriceTier` | Preserve time/range pricing tiers without Trigger naming. |
| `LlmPrice` | `ModelPrice` | Preserve immutable provider/model unit rates used by the billing ledger. |
| `PlatformNotification` | `Announcement` | Preserve operator product announcements under Platos users and tenancy. |
| `PlatformNotificationInteraction` | `AnnouncementReceipt` | Preserve per-user seen/dismissed/clicked state for announcements. |

## Drop: Trigger run engine — 31

All 31 models represent the embedded Trigger execution substrate. Platos calls an external Trigger service when durable execution is configured; it does not persist or serve that runtime's internal domain.

Recorded measured evidence on `test.platos` shows zero rows for `TaskRun`, `BackgroundWorker`, and `TaskEvent`. The other 28 row counts were not re-queried during this non-production audit. They are knowingly discarded on the clean slate because the entire embedded run-engine capability is rejected, regardless of row count.

| Model | Discarded data/capability | Evidence |
| --- | --- | --- |
| `BackgroundWorker` | Trigger worker definitions. | **Verified zero rows** in recorded project evidence. |
| `BackgroundWorkerFile` | Trigger worker source-file inventory. | Row count unknown; knowingly discarded with embedded run engine. |
| `BackgroundWorkerTask` | Trigger deployed task declarations. | Row count unknown; knowingly discarded with embedded run engine. |
| `BatchTaskRun` | Trigger batch-run orchestration. | Row count unknown; knowingly discarded with embedded run engine. |
| `BatchTaskRunError` | Trigger batch failure records. | Row count unknown; knowingly discarded with embedded run engine. |
| `BatchTaskRunItem` | Trigger batch item state. | Row count unknown; knowingly discarded with embedded run engine. |
| `Checkpoint` | Trigger execution checkpoints. | Row count unknown; knowingly discarded with embedded run engine. |
| `CheckpointRestoreEvent` | Trigger checkpoint restore history. | Row count unknown; knowingly discarded with embedded run engine. |
| `IntegrationDeployment` | Deployment linkage to external build integrations. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskEvent` | Trigger task event log. | **Verified zero rows** in recorded project evidence. |
| `TaskEventPartitioned` | Partitioned Trigger task event store. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskQueue` | Trigger task queues and concurrency state. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRun` | Trigger run records. | **Verified zero rows** in recorded project evidence. |
| `TaskRunAttempt` | Trigger retry/attempt records. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunCheckpoint` | Run-to-checkpoint joins. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunCounter` | Trigger run counters. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunDependency` | Trigger run dependency graph. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunExecutionSnapshot` | Trigger execution snapshots. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunNumberCounter` | Per-environment run-number allocation. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunTag` | Trigger run tagging. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunTemplate` | Trigger run templates. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskRunWaitpoint` | Run-to-waitpoint joins. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskSchedule` | Trigger task schedules. | Row count unknown; knowingly discarded with embedded run engine. |
| `TaskScheduleInstance` | Trigger schedule executions. | Row count unknown; knowingly discarded with embedded run engine. |
| `Waitpoint` | Trigger durable waitpoints. | Row count unknown; knowingly discarded with embedded run engine. |
| `WaitpointTag` | Trigger waitpoint tagging. | Row count unknown; knowingly discarded with embedded run engine. |
| `WorkerDeployment` | Trigger worker deployments. | Row count unknown; knowingly discarded with embedded run engine. |
| `WorkerDeploymentPromotion` | Trigger deployment promotions. | Row count unknown; knowingly discarded with embedded run engine. |
| `WorkerGroupToken` | Trigger worker-group credentials. | Row count unknown; knowingly discarded with embedded run engine. |
| `WorkerInstance` | Trigger worker process records. | Row count unknown; knowingly discarded with embedded run engine. |
| `WorkerInstanceGroup` | Trigger worker pools/groups. | Row count unknown; knowingly discarded with embedded run engine. |

External Trigger identifiers may exist as nullable integration metadata on a Platos Turn, Job, or usage event. They do not justify retaining any model above.

## Drop: inherited shell and dashboard capabilities — 15

Row counts for these models are unknown because this audit did not query production. Their contents are knowingly discarded on the clean slate. A future Platos feature with a similar label must be designed against Platos nouns and boundaries rather than copied from these tables.

| Model | Discarded data/capability | Why it does not survive |
| --- | --- | --- |
| `DataMigration` | Trigger application-level data-migration bookkeeping. | Fresh schema migration history replaces it; no historical data is preserved. |
| `Prompt` | Trigger standalone deployed-worker prompt registry. | Agent prompt configuration belongs to `AgentVersion`; this model is scoped to Trigger runtime environments. |
| `PromptVersion` | Trigger prompt revisions/overrides and worker linkage. | `workerId` links directly to `BackgroundWorker`; Platos versions the whole Agent configuration atomically. |
| `FeatureFlag` | Trigger global untyped key/value feature flags. | Platos uses typed platform flags and versioned Agent feature configuration; retaining this table creates a second control plane. |
| `GithubAppInstallation` | Trigger GitHub App installation inventory. | Current use supports source repositories, workers, and deployment workflows, not Platos Entities. |
| `GithubRepository` | Trigger GitHub repository inventory. | Repository-as-deployment-source is not a Platos product concept. GitHub tools connect through an Entity if needed. |
| `ConnectedGithubRepository` | Trigger project branch tracking and preview deployments. | Code-deployment stages and preview deployment wiring do not exist in Platos. |
| `OrganizationIntegration` | Trigger Slack/Vercel organization integration and token reference. | Current paths support Trigger deploy/alert shell features; Platos external providers use Entity, Channel, AlertChannel, and Credential models. |
| `OrganizationProjectIntegration` | Trigger project binding to Vercel/Slack external entities. | Deployment-oriented external project linkage is not retained. |
| `BulkActionGroup` | Bulk cancel/replay groups over Trigger runs. | Platos has no Trigger Run collection to bulk mutate. |
| `BulkActionItem` | Items in bulk Trigger run actions. | Parent capability is dropped. |
| `RealtimeStreamChunk` | Trigger realtime run stream chunks. | Platos Turn/session streaming has its own transport and durable Thread/Turn records. |
| `ErrorGroupState` | Per-task Trigger error acknowledgement state. | It keys on `taskIdentifier` and Trigger error occurrences; Platos observability uses Turn/Step/Tool Call errors. |
| `CustomerQuery` | TSQL query history and metering over Trigger observability tables. | The inherited query schema is task/run/queue-shaped; a future Platos analytics query feature requires a new scoped design. |
| `MetricsDashboard` | Configurable dashboards over Trigger telemetry. | The inherited widgets query run-shaped tables; Platos monitoring screens are rebuilt against the turn-shaped model. |

## Ambiguous decisions

### Prompt and PromptVersion

Drop both. They are not Platos's agent prompts: `PromptVersion` links to `BackgroundWorker`, and prompt creation is part of worker deployment. The clean-slate `AgentVersion` snapshots system prompt, prompt blocks, tools, model, memory, and policy as one coherent configuration. A second independently promotable prompt registry would permit invalid combinations and repeat Trigger's deployment model.

### FeatureFlag

Drop it. A global JSON value with no tenant, type, owner, or rollout contract is not an acceptable Platos platform control. Platform flags use a typed registry; tenant/agent behavior is versioned configuration. New flags must choose one boundary explicitly.

### GitHub and integration models

Drop all five GitHub/organization integration models. Their current branch, preview, Vercel, worker-deployment, and Trigger alert semantics exist because the application shell is Trigger's. A GitHub capability exposed to an Agent is a connected Entity/Tool. A Slack channel is a Channel. An alert destination is an AlertChannel. Credentials use Credential. Those Platos concepts do not need a shared Trigger integration hierarchy.

### Platform notifications

Re-home as Announcement/AnnouncementReceipt. Product announcements are independently useful and not tied to Trigger execution semantics; only their identity/tenancy ownership must change.

### Error grouping, query history, and metrics dashboards

Drop all three inherited models. Each is designed around Trigger's run/event ClickHouse schema. The new observability design provides Turn, Step, Tool Call, and usage facts; future error grouping or saved analytics must be designed against those facts rather than preserving task identifiers and run queries.

### Model catalogue and pricing

Re-home all three pricing models. Model selection, cost attribution, budget enforcement, and invoices require one Platos-owned catalogue. Every usage event records the exact immutable unit rates and catalogue version used, so a later price change cannot rewrite history.

## Verification contract

The disposition is complete only when a schema parser proves:

1. all 125 current models are accounted for;
2. all 54 `Platos*` models are outside this inherited-model table and proceed to the Platos-domain redesign;
3. all 71 inherited models appear exactly once above;
4. the four disposition groups total 71; and
5. no row contains `TBD`.
