# Trigger.dev Tasks (Platos integration)

Durable task definitions that the agent runtime spawns via `tasks.trigger()`.

## Tasks

| File | ID | Purpose |
|---|---|---|
| `agent-tool-block.task.ts` | `platos-agent-tool-block` | Durable execution of a tool block (for ops >30s, or when idempotency/retries matter) |
| `agent-batch-op.task.ts` | `platos-agent-batch-op` | One unit of a batch operation (AI-employee bulk ops). Spawned via `batchTrigger()`. |
| `agent-scheduled-run.task.ts` | `platos-agent-scheduled-run` | Agent execution on a cron schedule. Registered via `schedules.task()`. |

## Callback pattern

When a trigger.dev task needs to execute an actual tool call against an org's backend,
it calls back into the agent service via `POST /internal/execute-tool` with HMAC signing.
This keeps per-org credentials centralized in the agent service.

## Metadata/tags

Every trigger call is tagged:
- `org:{orgId}` — for dashboard grouping
- `agent:{agentId}` — which agent triggered it
- `thread:{threadId}` — which conversation
- `user:{userId}` — who initiated

And metadata includes:
- `orgId`, `agentId`, `threadId`, `userId`, `model`
- Updated during run: `progress`, `tokens`, `costCents`, `logs[]`
