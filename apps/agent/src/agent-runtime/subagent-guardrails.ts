import * as crypto from "crypto";

/**
 * Subagent-spawning guardrail primitives (docs/subagent-spawning-spec.md §
 * "Guardrails (non-negotiable)").
 *
 * These are extracted as pure functions so the security-critical logic —
 * depth cap, children cap, tool-ACL narrowing, dedupe, budget floor — can be
 * unit-tested in isolation without booting Nest, and so the meta-tool handler
 * (agent.service.ts) and the durable executor (agent-subrun.task.ts) share ONE
 * implementation of each rule rather than re-deriving it on each side.
 *
 * Nothing here reads a caller-supplied scope, depth, or budget: every value is
 * derived from server-held state (the parent turn's resolved config + the
 * runtime-stamped spawn depth). Scope inheritance is enforced structurally at
 * the call sites (the child payload copies the parent tuple 1:1 and the
 * meta-tool arg schema exposes NO scope fields), not here.
 */

/**
 * Depth cap ≤ 2. Root turn is depth 0. A spawn from depth 0 makes a depth-1
 * child; that child may spawn once more (depth-2 grandchild); a depth-2
 * grandchild may NOT spawn (a depth-3 great-grandchild is rejected).
 */
export const SUBAGENT_MAX_DEPTH = 2;

/** Default per-parent-turn cap on how many children a single turn may spawn. */
export const SUBAGENT_DEFAULT_CHILDREN_PER_TURN = 5;

/**
 * Terminal marker the child agent emits to signal the task is complete. The
 * subrun loop feeds continuation turns until it sees this marker, exhausts
 * maxTurns, or hits the budget floor.
 */
export const SUBAGENT_DONE_MARKER = "TASK_COMPLETE";

/** Coerce a possibly-absent runtime depth to a non-negative integer (root = 0). */
export function normalizeSpawnDepth(currentDepth: number | undefined | null): number {
  return typeof currentDepth === "number" && Number.isFinite(currentDepth) && currentDepth > 0
    ? Math.floor(currentDepth)
    : 0;
}

/** Depth of a child spawned from a turn currently running at `currentDepth`. */
export function childSpawnDepth(currentDepth: number | undefined | null): number {
  return normalizeSpawnDepth(currentDepth) + 1;
}

/**
 * A child spawned from `currentDepth` is allowed iff its resulting depth does
 * not exceed the cap. currentDepth 0 → child 1 (ok); 1 → child 2 (ok);
 * 2 → child 3 (REJECTED — grandchildren may not spawn).
 */
export function isSpawnDepthAllowed(
  currentDepth: number | undefined | null,
  maxDepth: number = SUBAGENT_MAX_DEPTH,
): boolean {
  return childSpawnDepth(currentDepth) <= maxDepth;
}

/**
 * Tool-ACL narrowing (spec: "child tools ⊆ parent tools ∩ spawn allowedTools").
 *
 * - `parentTools` is the parent turn's effective tool matrix
 *   (`agentConfig.toolsBlockConfig.enabledTools`).
 * - `requested` is the caller-supplied allow-list (`spec.allowedTools`).
 *
 * The result is ALWAYS a subset of `parentTools` — a caller can never widen
 * the child's reach past what the parent itself holds. When `requested` is
 * omitted/empty the child inherits the full parent matrix (still bounded by
 * `parentTools`, never a superset). Order follows `parentTools`; duplicates
 * are collapsed.
 */
export function narrowSpawnToolAcl(
  parentTools: string[] | undefined | null,
  requested?: string[] | null,
): string[] {
  const parent = Array.from(new Set((parentTools ?? []).filter((t) => typeof t === "string" && t.length > 0)));
  if (!requested || requested.length === 0) return parent;
  const requestedSet = new Set(requested.filter((t) => typeof t === "string" && t.length > 0));
  // Intersect while preserving parent order; a requested name absent from the
  // parent matrix is silently dropped (cannot be granted).
  return parent.filter((t) => requestedSet.has(t));
}

/**
 * Resolve the per-turn children cap: per-agent override wins, then the
 * `PLATOS_MAX_CHILDREN_PER_TURN` env value, then the built-in default. Always
 * ≥ 1 so a misconfiguration can't disable spawning entirely by accident.
 */
export function resolveMaxChildrenPerTurn(
  agentOverride: number | null | undefined,
  envValue: string | number | null | undefined,
): number {
  const fromAgent = typeof agentOverride === "number" && Number.isFinite(agentOverride) ? agentOverride : undefined;
  const fromEnv =
    typeof envValue === "number"
      ? envValue
      : typeof envValue === "string" && envValue.trim() !== "" && Number.isFinite(Number(envValue))
        ? Number(envValue)
        : undefined;
  return Math.max(1, Math.floor(fromAgent ?? fromEnv ?? SUBAGENT_DEFAULT_CHILDREN_PER_TURN));
}

/**
 * Loop-hygiene dedupe key on (parentTurnId, task-hash) — spec guardrail #4.
 * Fed into the Trigger `.trigger()` `idempotencyKey` so a RETRIED parent turn
 * re-issuing the identical spawn returns the existing child run instead of
 * double-spawning. Scoped by (org, project, env, parentThreadId) so a cuid
 * collision across tenants can't cross-dedup (mirrors the audit-L4 durable-turn
 * key namespacing). The identity payload is `{ task, spec }` (the WHAT + WHO),
 * NOT raw call args, so cosmetically-different retries still collapse.
 */
export function spawnDedupeKey(input: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  parentThreadId: string;
  task: string;
  spec?: unknown;
}): string {
  const identity = JSON.stringify({ task: input.task ?? "", spec: input.spec ?? null });
  return crypto
    .createHash("sha256")
    .update(
      `${input.organizationId}:${input.projectId}:${input.environmentId}:spawn_agent:${input.parentThreadId}:${identity}`,
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * Budget floor — spec: parent's `budgetCents` is a shared pool drawn down by
 * the child; exhaustion is a clean stop with a partial-results report. Returns
 * true once accumulated child spend meets or exceeds the ceiling. A non-positive
 * / absent ceiling means "no per-spawn cap" (the scope-wide BudgetService gate
 * inside every turn remains the coarser backstop, since the child inherits the
 * parent's scope tuple unchanged).
 */
export function budgetExhausted(spentCents: number, budgetCents: number | null | undefined): boolean {
  if (typeof budgetCents !== "number" || !Number.isFinite(budgetCents) || budgetCents <= 0) return false;
  return spentCents >= budgetCents;
}

/**
 * Detect the child's explicit completion signal. Case-insensitive so the LLM
 * needn't match casing exactly; also treats the marker appearing anywhere in
 * the final text as done (agents often prose around it).
 */
export function isSubagentDoneSignal(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.toUpperCase().includes(SUBAGENT_DONE_MARKER);
}

/**
 * Compose the per-turn message the subrun loop sends to the child. Turn 0 seeds
 * the task + context; later turns nudge the agent to either finish (emitting the
 * done marker) or continue. The done-marker instruction is embedded in the
 * message body (works for both ephemeral specs and referenced agents without
 * needing a systemPrompt mutation on the referenced-agent path).
 */
export function composeSubagentTurnMessage(input: {
  turnIndex: number;
  task: string;
  context?: string | null;
}): string {
  const doneInstruction =
    `When the task is fully complete, reply with a final line beginning "${SUBAGENT_DONE_MARKER}:" ` +
    `followed by your result. Do not emit that marker until you are actually done.`;
  if (input.turnIndex === 0) {
    const ctx = input.context ? `\n\nContext:\n${input.context}` : "";
    return `${input.task}${ctx}\n\n${doneInstruction}`;
  }
  return (
    `Continue working on the task. If it is complete, reply with "${SUBAGENT_DONE_MARKER}:" ` +
    `and your final result; otherwise take the next step.`
  );
}

/**
 * Format the child's outcome as the synthetic message that wakes the parent.
 * Rides in as a `user`-role turn (there is no native `subagent_report` role —
 * storeMessage only accepts user|assistant|tool), tagged so the parent LLM can
 * recognise it as a subagent report and reason over it (spawn more / synthesize
 * / finish).
 */
export function buildSubagentReportMessage(input: {
  task: string;
  status: string;
  result: string;
  costCents: number;
  turnsUsed: number;
  childThreadId?: string | null;
  childRunId?: string | null;
}): string {
  const lines = [
    `[subagent_report] A subagent you spawned has finished. Reason over its result and decide the next step.`,
    `- task: ${input.task}`,
    `- status: ${input.status}`,
    `- turns: ${input.turnsUsed}`,
    `- costCents: ${input.costCents}`,
    ...(input.childThreadId ? [`- childThreadId: ${input.childThreadId}`] : []),
    ...(input.childRunId ? [`- childRunId: ${input.childRunId}`] : []),
    ``,
    `Result:`,
    input.result || "(no textual result)",
  ];
  return lines.join("\n");
}
