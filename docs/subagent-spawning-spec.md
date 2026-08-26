# Subagent Spawning — `spawn_agent` + `platos.agent.subrun`

*Spec 2026-07-22. Status: DESIGN — approved by Tejas ("both" identity modes,
default ephemeral). Build queue: AFTER Connect v3 phases A–D ship.*

## The gap

Platos has three subagent-adjacent primitives, none of which is
"spawn a durable multi-turn tool-calling agent that reports back so the
parent reasons over the result":

| Exists | Shape | Gap |
|---|---|---|
| `delegate_to_sub_agent` (toolMode "sub-agent") | real multi-step tool loop via `runSubAgent` (subAgentConfig: model/maxSteps/systemPrompt), abort cascades | synchronous, inline in the parent turn, non-durable, one-at-a-time |
| `spawn_job` (agent-tool-block.task) | ONE tool call made durable on Trigger via HMAC `/internal/execute-tool` | a tool call, not an agent loop |
| `agent_batch` (agent-batch.task) | durable parallel fan-out: N items × one tool-calling TURN each; `allowedTools`, `maxConcurrency`, `parentThreadId`; progress streamed to parent room | items are single turns, not autonomous agents; results stream PAST the parent instead of waking it |

## The primitive

**`spawn_agent` runtime tool** (registered beside `spawn_job`):

```jsonc
{
  // WHO — both modes (decision: both, DEFAULT ephemeral):
  "agentId": "…",                    // (a) reference a real Platos agent — gets its memory/skills/config
  "spec": {                          // (b) ephemeral inline spec — cheap, disposable, no registry row
    "model": "…", "systemPrompt": "…",
    "allowedTools": ["…"], "skills": ["…"]
  },
  // WHAT
  "task": "…", "context": "…",
  // HOW
  "mode": "background" | "wait",     // wait = triggerAndWait w/ timeout (short subtasks)
  "maxTurns": 6, "budgetCents": 50
}
```

**`platos.agent.subrun` Trigger task** (durable, parallel, observable):
1. Creates a CHILD thread (`parentThreadId` lineage — column already exists on
   PlatosAgentThread; ephemeral specs run agent-less threads with spec params
   passed per-turn, referenced agents run as themselves).
2. Runs the FULL agent loop: repeated callbacks into the agent's internal turn
   endpoint (durable-turn shape) until done-signal / maxTurns / budget floor.
   Tools, BYOK, memory, scope enforcement, approvals = the EXISTING runtime.
   No provider keys in Trigger, ever.
3. Report-back:
   - **background**: on completion POST `/internal/subagent-report` (admin-gated,
     scope.guard allowlist) → result injected into the PARENT thread as a
     `subagent_report` message → a durable PARENT turn is dispatched → the
     parent wakes and reasons over the result (spawn more / synthesize / finish).
   - **wait**: triggerAndWait with timeout; result returned as the tool result.

## Guardrails (non-negotiable)

- **Scope inherited, never chosen** — child runs under the parent's exact
  (org, project, env, userId). Audit rule applies doubly to spawned execution.
- **Depth cap ≤ 2** (subagents may spawn once more, grandchildren may not) +
  **children cap per turn** (default 5) + **budget inheritance**: parent's
  budgetCents is a shared pool drawn down by children via the existing cost
  ledger; exhaustion = clean stop with partial-results report.
- **Tool ACL narrowing only** — child tools ⊆ parent tools ∩ spawn allowedTools.
  Approval flows (require_approval floors) still apply inside child turns.
- **Loop hygiene**: dedupe key on (parentTurnId, task-hash) so a retried parent
  turn doesn't double-spawn; child runs tagged parentRunId/parentThreadId
  (L7 run-tagging rails) so the runs dashboard shows the tree; child progress
  streamed into the parent thread's room (agent_batch pattern).

## Why Trigger

Durability (subagent survives deploys mid-work), true parallelism with
concurrency caps, retries, dashboard observability — and it is the decided
architecture direction (agent-loop-body-as-trigger-tasks). employee-run.task
proved multi-turn-loop-on-Trigger; agent_batch proved fan-out + lineage +
callback. `spawn_agent` is a composition of owned rails, not new infra.

## Relationship to existing primitives (keep all three)

- `delegate_to_sub_agent` stays: the low-latency inline path for small
  delegations within a turn.
- `spawn_job` stays: single durable tool call.
- `agent_batch` stays: homogeneous fan-out over items.
- `spawn_agent` is for heterogeneous, autonomous, multi-turn work — research
  a topic, fix a bug, verify a claim — where the parent needs the RESULT as
  input to further reasoning.

## Build shape (when queued)

1. Schema: none required for v1 (ephemeral specs carry config in the task
   payload; child threads reuse parentThreadId). Optional: `spawnDepth` +
   `parentRunId` columns on thread/run tags if tag-based proves too loose.
2. `spawn_agent` meta-tool in agent.service buildMetaTools (+ prompt guidance).
3. `platos.agent.subrun` Trigger task + `/internal/subagent-turn` +
   `/internal/subagent-report` endpoints (admin-gated, allowlisted).
4. Parent-wake dispatch: reuse durable-turn dispatch with the report message.
5. Fable-gated workflows; deploy; live smoke: parent spawns 2 ephemeral
   researchers in background → both report → parent synthesizes.
