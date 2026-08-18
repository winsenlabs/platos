/**
 * Registration classification for the declarations in this directory.
 *
 * These manifests are an inventory, not a dispatch table. Trigger's CLI still
 * discovers registrations from source, while the source-discovery test keeps
 * this classification exhaustive without importing task modules at runtime.
 */
type TriggerTaskRegistrationId = `platos${string}`;
type TriggerSessionRegistrationId = `platos.${string}`;

function defineTaskManifest<const T extends readonly TriggerTaskRegistrationId[]>(ids: T): T {
  return ids;
}

function defineSessionManifest<const T extends readonly TriggerSessionRegistrationId[]>(ids: T): T {
  return ids;
}

/** Active Platos tasks whose durable executor is an external Trigger deployment. */
export const EXTERNAL_PLATOS_TASK_MANIFEST = defineTaskManifest([
  "platos-agent-batch",
  "platos-agent-durable-approval-wait",
  "platos-agent-scheduled-run",
  "platos-agent-tool-block",
  "platos-custom-task",
  "platos.agent.employee-run",
  "platos.agent.subrun",
  "platos.approvals.expiry_sweep",
  "platos.attachments.retention",
  "platos.budget.alert",
  "platos.chat.session_reaper",
  "platos.compaction",
  "platos.cost.reconcile",
  "platos.cost.refresh_model_prices",
  "platos.eval.sample",
  "platos.memory.extract",
  "platos.observability.dlq_drain",
  "platos.skill.run",
] as const);

/** Active Platos durable Session registered with the external Trigger service. */
export const EXTERNAL_PLATOS_SESSION_MANIFEST = defineSessionManifest([
  "platos.chat.session",
] as const);

/** Source retained for compatibility, but not an active Platos dispatch target. */
export const DORMANT_TRIGGER_TASK_MANIFEST = defineTaskManifest([
  "platos.agent.durable-turn",
] as const);

export type ExternalPlatosTaskId = (typeof EXTERNAL_PLATOS_TASK_MANIFEST)[number];
export type ExternalPlatosSessionId = (typeof EXTERNAL_PLATOS_SESSION_MANIFEST)[number];
export type DormantTriggerTaskId = (typeof DORMANT_TRIGGER_TASK_MANIFEST)[number];
export type ClassifiedTriggerTaskId = ExternalPlatosTaskId | DormantTriggerTaskId;
