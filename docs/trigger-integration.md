# Trigger Integration

Platos is built on top of trigger.dev. The agent layer uses trigger's run engine for every durable primitive it exposes: `spawn_bgo` (formerly `spawn_task` — kept as a deprecated alias; see [BGO_RENAME.md](./BGO_RENAME.md)), schedules, batches, realtime subscriptions, wait-for-token HITL. This doc explains how the integration is wired so you can reach for the underlying primitives when you need to.

If you're new to trigger.dev: it's a durable task platform for TypeScript. You define tasks in a `trigger/` directory, deploy them, and invoke them with `tasks.trigger()`. The engine handles retries, checkpoints, queues, observability. Platos inherits all of this.

## The bridge

`apps/agent/src/trigger-bridge/` is the only place the agent service talks to trigger.dev. It wraps the `@trigger.dev/sdk` (re-exported as `@platos/sdk`) with:

- A graceful fallback when `TRIGGER_SECRET_KEY` is not set (local dev)
- An internal privileged client for realtime subscriptions (uses `TRIGGER_INTERNAL_SECRET`)
- Correlation: every task triggered from an agent turn is tagged with `agentId`, `threadId`, `messageId`, `runId` so the runs view groups cleanly

```ts
// apps/agent/src/trigger-bridge/trigger.service.ts (excerpt)
@Injectable()
export class TriggerService {
  constructor(private config: ConfigService) {
    if (!config.get("TRIGGER_SECRET_KEY")) {
      this.client = new StubTriggerClient(this.redis);
      logger.info("No TRIGGER_SECRET_KEY — using Redis stub (not durable!)");
    } else {
      this.client = tasks;
    }
  }
  
  async trigger(taskId: string, payload: unknown, opts: TriggerOpts) {
    return this.client.trigger(taskId, payload, {
      ...opts,
      tags: [...(opts.tags ?? []), `agent:${opts.agentId}`, `thread:${opts.threadId}`],
      metadata: {
        platos: { agentId: opts.agentId, threadId: opts.threadId, runId: opts.runId },
        ...opts.metadata,
      },
    });
  }
}
```

The stub does enough to make development round-trip (writes the "run" to Redis, returns a handle, emits fake events), but it's not durable. Set `TRIGGER_SECRET_KEY` to get actual durability.

## `spawn_bgo` — the meta-tool (alias: `spawn_task`)

When an agent has `spawn_bgo` in its tool list (or the deprecated alias `spawn_task`, kept for one release — see [BGO_RENAME.md](./BGO_RENAME.md)), it can trigger arbitrary tasks that you've defined in your `trigger/` directory. The tool signature:

```ts
spawn_bgo({
  taskId: string,         // e.g. "fetch_and_summarize"
  payload: unknown,       // JSON-serializable
  queue?: string,
  concurrencyLimit?: number,
  delay?: string | Date,  // e.g. "5m"
  maxDuration?: number,
  tags?: string[],
})
```

Returns:

```ts
{ runId: string, publicAccessToken: string }
```

The `publicAccessToken` can be handed to the UI so the browser can subscribe directly to the run's events (streaming logs, progress). This is useful for long-running tasks — the UI doesn't need to proxy through the agent.

### Defining tasks

Standard trigger.dev. In your `trigger/` directory:

```ts
// trigger/research.ts
import { task, logger } from "@trigger.dev/sdk/v3";

export const fetchAndSummarize = task({
  id: "fetch_and_summarize",
  maxDuration: 300,
  retry: { maxAttempts: 3, minTimeoutInMs: 2000 },
  run: async ({ query }: { query: string }) => {
    logger.info("Fetching", { query });
    const urls = await search(query);
    const pages = await Promise.all(urls.map(u => fetch(u).then(r => r.text())));
    const summary = await summarize(pages.join("\n\n"));
    return { query, summary, sourceCount: urls.length };
  },
});
```

Register by running `pnpm exec trigger.dev@latest dev` in your project (or `deploy` for production). The task shows up in the webapp and becomes callable via `spawn_bgo` (or the deprecated `spawn_task` alias).

### Task handle resolution

Agents that spawn a task usually want to wait for the result. Two patterns:

**Pattern A: `wait_for_runs` meta-tool** (blocking)

```
spawn_bgo → { runId }
spawn_bgo → { runId }
wait_for_runs([run1, run2]) → blocks until both complete, returns outputs
```

Internally this uses `runs.poll()` with a 1s interval and a 10-minute timeout.

**Pattern B: realtime subscription** (streaming)

The UI gets the `publicAccessToken` and subscribes:

```ts
import { runs } from "@platos/sdk";

for await (const update of runs.subscribeToRun(runId, { accessToken })) {
  console.log(update.status, update.output);
}
```

Pattern B is better UX for long runs — the user sees progress logs. Pattern A is simpler for agent code that just needs the final answer.

## Schedules

Trigger's schedules are exposed unchanged. To build an agent that fires on cron, define a scheduled task:

```ts
import { schedules } from "@trigger.dev/sdk/v3";

export const dailyDigest = schedules.task({
  id: "daily_digest",
  cron: "0 9 * * *",             // 9am UTC
  run: async (payload) => {
    await platos.messages.send({
      agentId: "agt_digest",
      threadId: "thr_system",
      role: "system",
      content: "Run daily digest",
    });
  },
});
```

Alternatively, agents can create schedules dynamically via the `create_schedule` meta-tool:

```
create_schedule({
  taskId: "daily_digest",
  cron: "0 9 * * *",
  payload: { userId: "u_123" },
  deduplicationKey: "digest:u_123",
})
```

Dedup key means calling it twice is idempotent.

## Batches

For fan-out: summarize 100 documents, send 500 emails, etc. Use `batchTrigger`:

```ts
import { tasks } from "@trigger.dev/sdk/v3";

const handle = await tasks.batchTrigger("summarize_doc",
  documents.map(doc => ({ payload: { docId: doc.id } })),
);
// handle.batchId
// handle.runs[i].id
```

The agent meta-tool is `spawn_batch`:

```
spawn_batch({
  taskId: "summarize_doc",
  items: [{ payload: { docId: "d1" } }, { payload: { docId: "d2" } }, ...],
})
// → { batchId, runIds: [...] }
```

Then `wait_for_runs(runIds)` to block on completion, or subscribe to the batch via realtime.

## Realtime subscription from the agent

Sometimes the agent itself (not just the UI) wants to observe a run — e.g., to react to progress events before the final output. Inside an agent, you can `subscribe_to_run(runId)` which streams events back into the conversation turn:

```
User:   Transcribe this 3-hour podcast.
Agent:  spawn_bgo("transcribe_audio", { url: "..." }) → run_abc
        subscribe_to_run("run_abc", "progress_events_only")
        
        [stream event] { progress: 0.1, eta: "27m" }
        [stream event] { progress: 0.5, eta: "12m" }
        ...
        Transcription complete. 48,213 words. Here's the summary: ...
```

Under the hood, the agent uses `runs.subscribeToRun()` with `TRIGGER_INTERNAL_SECRET` and forwards filtered events back to the user over the main Socket.IO stream.

## HITL via `wait.forToken`

Human-in-the-loop approvals come in two flavors:

1. **In-conversation** — `request_approval(action, details)`. Publishes to Redis pub/sub, UI shows approve/deny buttons, resolves via `BLPOP`. 5-min timeout. This runs inside the agent turn and is appropriate for quick "are you sure?" prompts.

2. **Durable** — for long-running workflows where the human might take hours or days to respond, use `wait.forToken` inside a trigger task. Platos's `request_durable_approval` meta-tool wraps this:

```ts
// trigger/deploy.ts
import { task, wait } from "@trigger.dev/sdk/v3";

export const deployToProduction = task({
  id: "deploy_to_production",
  run: async ({ prUrl }) => {
    const token = await wait.createToken({
      timeout: "24h",
      tags: [`deploy:${prUrl}`],
    });
    
    // Notify humans (Slack, email, UI)
    await notifySlack({ prUrl, approveUrl: token.publicAccessToken });
    
    const result = await wait.forToken<{ approved: boolean }>(token);
    
    if (!result.ok || !result.output.approved) {
      return { deployed: false, reason: "not approved" };
    }
    
    await doDeploy(prUrl);
    return { deployed: true };
  },
});
```

The agent invokes this via `spawn_bgo("deploy_to_production", { prUrl })`. Token resolution happens out-of-band (a human clicks a link). The run stays durable for up to 24h.

## Metadata and tags for observability

Every run spawned from Platos is tagged:

- `agent:{agentId}` — which agent triggered it
- `thread:{threadId}` — which conversation
- `run:{parentRunId}` — if spawned from inside another trigger task
- `org:{organizationId}` — tenant isolation

Plus metadata:

```ts
{
  platos: {
    agentId: "agt_...",
    threadId: "thr_...",
    runId: "run_...",
    messageId: "msg_...",
    userId: "usr_..."
  }
}
```

You can filter runs in the webapp by tag (e.g., `tag:agent:agt_123`) to see every task a given agent ever triggered. Combined with Platos's message timeline, this gives you full trace correlation: conversation → LLM call → tool invocation → durable task → retries → final output.

## Running `trigger.dev dev`

For local development of tasks that agents will invoke:

```bash
# In your project root (not Platos's repo — your consumer project)
pnpm add @platos/sdk @trigger.dev/sdk
pnpm exec trigger.dev@latest init --projectRef proj_...

# Then, in one terminal:
pnpm exec trigger.dev@latest dev
```

This spins up a local worker that registers your tasks (`fetch_and_summarize`, `deploy_to_production`, etc.) with the Platos run engine. The worker polls for runs and executes them in-process, so you get the full durable-task lifecycle (retries, logs, checkpoints) on your laptop without deploying anything.

When you're ready for production:

```bash
pnpm exec trigger.dev@latest deploy
```

Your tasks are bundled, uploaded, and registered. Platos agents can immediately call them via `spawn_bgo` (or the deprecated `spawn_task` alias).

## Upgrade notes

Platos tracks upstream trigger.dev. When trigger ships a new SDK version, we bump `@platos/sdk` to re-export it and test for breaking changes in the agent bridge. See [upgrading-from-trigger.md](./upgrading-from-trigger.md) for the full compat story.

## Further reading

- `spawn_bgo` (alias: `spawn_task`) in practice: [writing-agents.md](./writing-agents.md#example-2)
- Run engine internals (upstream): [trigger.dev/docs/how-it-works](https://trigger.dev/docs/how-it-works)
- HITL approvals (both flavors): [architecture.md](./architecture.md) § Message lifecycle
