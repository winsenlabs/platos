export { agentToolBlock } from "./agent-tool-block.task";
export type { AgentToolBlockPayload, AgentToolBlockOutput } from "./agent-tool-block.task";

export { agentBatchOp } from "./agent-batch-op.task";
export type { AgentBatchOpPayload, AgentBatchOpOutput } from "./agent-batch-op.task";

// W.1 — durable `agent_batch` meta-tool executor. Runs an LLM turn per
// item in a supplied list with a restricted tool subset, streams per-item
// progress back to the spawning thread via RunsBridgeService.
export { agentBatch } from "./agent-batch.task";
export type {
  AgentBatchPayload,
  AgentBatchOutput,
  AgentBatchItemResult,
} from "./agent-batch.task";

export { agentScheduledRun } from "./agent-scheduled-run.task";

export { litellmCostRefresh } from "./litellm-cost-refresh.task";
export type { LiteLLMCatalog, LiteLLMModelEntry } from "./litellm-cost-refresh.task";

export { attachmentRetention } from "./attachment-retention.task";

// PPR-24 — nightly cost hash reconcile (Postgres -> Redis).
export { costReconcile } from "./cost-reconcile.task";

// PPR-67 — every-5-minutes approvals expiry sweep.
export { approvalsExpirySweep } from "./approvals-expiry-sweep.task";

// EOBD.100 — every-2-min ClickHouse DLQ drain. Retries dual-write
// failures so transient CH outages don't lose telemetry.
export { observabilityDlqDrain } from "./observability-dlq-drain.task";

// PPR-51 — durable HITL approval waitpoint.
export { agentDurableApprovalWait } from "./agent-durable-approval-wait.task";
export type {
  AgentDurableApprovalPayload,
  AgentDurableApprovalOutput,
} from "./agent-durable-approval-wait.task";

// Theme H.7 — budget alert webhook + email delivery.
export { budgetAlert } from "./budget-alert.task";
export type { BudgetAlertPayload } from "./budget-alert.task";

// Theme J.4 — periodic judge-LLM eval sampler (placeholder until Theme H).
export { evalSample } from "./eval-sample.task";

// Theme O.1 — hourly memory-extraction sweep.
export { memoryExtraction } from "./memory-extraction.task";

// PIFSP-12 — operator-authored custom task executor (vm sandbox).
export { platosCustomTask } from "./platos-custom-task";

// LAUNCH-11 — durable conversation compaction. Replaces the
// fire-and-forget Promise that was spawned at the end of every turn.
export { platosCompaction } from "./compaction.task";
export type { CompactionTaskPayload, CompactionTaskOutput } from "./compaction.task";

// REFACTOR (control-plane + trigger substrate) — new durable-execution tasks.
// The `durable` half of per-agent executionMode + AI-employee + skill-as-task.
// Thin-shell variant (A): call back into the agent's /internal/* endpoints
// (added in the callbacks step). Sessions/chat.agent variant (B) lands with
// the @trigger.dev/sdk swap. See docs/refactor/platos-trigger-refactor.md.
export { durableTurn } from "./durable-turn.task";
export type { DurableTurnPayload, DurableTurnOutput } from "./durable-turn.task";

export { employeeRun } from "./employee-run.task";
export type { EmployeeRunPayload, EmployeeRunOutput } from "./employee-run.task";

export { skillRun } from "./skill-run.task";
export type { SkillRunPayload, SkillRunOutput } from "./skill-run.task";
