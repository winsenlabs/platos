# Upgrading from trigger.dev

Platos adds an agent layer around an external Trigger durable-runtime service. Durable task APIs stay on Trigger's published SDK, while Platos REST and WebSocket APIs use the separately published Platos client.

This guide is for teams already running trigger.dev (cloud or self-hosted) who want to migrate to Platos without losing tasks, runs, or SDK usage.

## What's unchanged

All of these continue to work exactly as before:

- **Task definitions.** Your `trigger/*.ts` files continue to use `@trigger.dev/sdk`.
- **`tasks.trigger()`, `tasks.batchTrigger()`, `schedules`, `wait.*`.** Same API.
- **CLI.** `trigger.dev dev`, `trigger.dev deploy`, `trigger.dev promote` — unchanged.
- **Run engine.** Same queues, same retries, same checkpoints, same observability.
- **Build extensions.** Your Dockerfile extensions, Python layer, FFmpeg layer — unchanged.
- **API routes.** All upstream `/api/v1/*` routes work as they did.
- **Webapp UI.** Runs view, deployments, schedules UI — untouched.

If all you need is trigger.dev, you can run Platos and never touch the agent layer. `apps/agent` won't boot unless you explicitly bring its service up.

## What's different

### Added

- **`apps/agent`** — new NestJS service on port 3100. Real-time agent runtime.
- **Prisma schema extensions** — `PlatosAgent`, `PlatosAgentThread`, `PlatosAgentMessage`, `PlatosAgentUserProfile`, `ToolDefinition`, `OrgToolMapping`, `ToolHealth`. Additive — no existing tables are touched.
- **`docker-compose.platos.yml`** — composes webapp + agent + postgres + redis.
- **New env vars** — `PLATOS_*` namespace (see [env-vars.md](./env-vars.md)). All optional unless you boot the agent.
- **New UI routes** — `/agents`, `/agents/:id`, `/agents/:id/chat`. Old routes untouched.

### SDK boundaries

- **Durable runtime:** import `task`, `tasks`, `runs`, `schedules`, and `wait` from `@trigger.dev/sdk`.
- **Platos API client:** import `PlatosClient` and the REST/WebSocket client namespaces from `@platosdev/client`.
- Workspace packages (internal):

| Before | After |
|---|---|
| `@internal/agent-worker` (unused — name collision risk) | `@platos/agent` |
| `@trigger.dev/platform` | `@platos/platform` (re-exports `@trigger.dev/platform`) |
| `@trigger.dev/database` | `@platos/database` (re-exports) |

If you import from internal packages directly (most users don't), update these imports. Consumer task code remains on the published Trigger SDK.

### Extended

- **Prisma client.** New models are available on the generated client. Existing models (`Organization`, `Project`, `TaskRun`, etc.) are unchanged.
- **Magic link flow.** Same flow, but post-login redirect can land on `/agents` if you set `DEFAULT_POST_LOGIN_PATH=/agents`.
- **Docker images.** `ghcr.io/platos-dev/platos-webapp` and `ghcr.io/platos-dev/platos-agent`. The webapp image is a rebrand of the trigger.dev webapp image with schema migrations included.

## Migration path

You don't have to do everything at once. Recommended order:

### Step 1 — Point your infrastructure at Platos's Docker images

Swap images in your compose / k8s manifests:

```yaml
# before
services:
  webapp:
    image: ghcr.io/triggerdotdev/trigger.dev:latest

# after
services:
  webapp:
    image: ghcr.io/platos-dev/platos-webapp:latest
    environment:
      DATABASE_URL: ${DATABASE_URL} # retained canonical clean database
      DIRECT_URL: ${DIRECT_URL}
  agent:
    image: ghcr.io/platos-dev/platos-agent:latest
    ports: ["3100:3100"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      PLATOS_ENCRYPTION_KEY: ${PLATOS_ENCRYPTION_KEY}
      PLATOS_MESSAGE_ENCRYPTION_KEY: ${PLATOS_MESSAGE_ENCRYPTION_KEY}
      SESSION_SECRET: ${SESSION_SECRET}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
```

On boot, migrations run additively. Existing tables are unchanged. New tables are created.

**Before you deploy:** take a Postgres backup. The new migrations are reversible (each has a `down.sql`) but it's still good hygiene.

### Step 2 — Update `.env`

Add the required Platos env vars and provision the canonical clean database:

```bash
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)              # 64 hex chars = 32 bytes
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)      # distinct 64-hex value
ANTHROPIC_API_KEY=sk-ant-...
```

> Generate new encryption-domain keys as 64 hex chars (32 bytes decoded), with a different value for every domain. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values continue working verbatim and must not be replaced without re-encryption. See [env-vars.md](./env-vars.md#core).

Your existing `SESSION_SECRET`, `ENCRYPTION_KEY`, `REDIS_URL`, and external
`TRIGGER_SECRET_KEY` can remain unchanged. Provision and migrate a clean Platos
database, then point both the webapp and agent `DATABASE_URL` at that database.
Do not run the clean initial migration against an inherited Trigger database.

### Step 3 — Use the current SDK boundaries

In consumer projects (your task-defining repos), swap the SDK:

```ts
// before (historical module specifier; do not copy): @trigger.dev/sdk/v3

// after: durable runtime APIs
import { tasks, schedules, wait } from "@trigger.dev/sdk";

// Platos REST/WebSocket APIs are a separate client surface
import { PlatosClient } from "@platosdev/client";
```

Do not combine these surfaces behind one package import. Keep Trigger execution primitives on `@trigger.dev/sdk` and Platos client calls on `@platosdev/client`.

### Step 4 — (Optional) Start building agents

Once the agent service is up and reachable from your UI or apps, follow [quickstart.md](./quickstart.md) from step 3 onward to create your first agent. You can mix freely: tasks you already have (`fetch_and_summarize`, `send_email`, etc.) are callable from agents via `spawn_job`.

### Step 5 — Remove legacy Trigger subpath imports

Once everything is migrated, replace legacy `@trigger.dev/sdk/v3` imports with the current `@trigger.dev/sdk` entrypoint. Keep `@trigger.dev/sdk` as a direct dependency of every task-defining project.

## Before / after snippets

### Triggering a task from backend code

```ts
// before (historical module specifier; do not copy): @trigger.dev/sdk/v3
import { fetchAndSummarize } from "./trigger/research";

await tasks.trigger<typeof fetchAndSummarize>("fetch_and_summarize", { query: "quantum computing" });
```

```ts
// after (current public entrypoint)
import { tasks } from "@trigger.dev/sdk";
import { fetchAndSummarize } from "./trigger/research";

await tasks.trigger<typeof fetchAndSummarize>("fetch_and_summarize", { query: "quantum computing" });
```

### Triggering from an agent turn

Not possible before. Now:

```ts
// The agent calls spawn_job as a runtime tool during a user Turn.
// No code change needed in your task — just add spawn_job to the agent's
// tool list.
```

### Schedules

```ts
// before (historical module specifier; do not copy): @trigger.dev/sdk/v3

export const dailyCleanup = schedules.task({ id: "daily_cleanup", cron: "0 3 * * *", run: async () => { /*...*/ } });
```

```ts
// after — identical API, current public entrypoint
import { schedules } from "@trigger.dev/sdk";

export const dailyCleanup = schedules.task({ id: "daily_cleanup", cron: "0 3 * * *", run: async () => { /*...*/ } });
```

### Realtime subscription from UI

```ts
// before (historical module specifier; do not copy): @trigger.dev/sdk/v3
for await (const update of runs.subscribeToRun(runId, { accessToken })) { /*...*/ }
```

```ts
// after — identical API, current public entrypoint
import { runs } from "@trigger.dev/sdk";
for await (const update of runs.subscribeToRun(runId, { accessToken })) { /*...*/ }
```

### HITL via `wait.forToken`

Unchanged. Still `wait.createToken` + `wait.forToken`. Agents can create these tokens via the new `request_durable_approval` meta-tool, which is a thin wrapper.

## Breaking changes

None at runtime. Two worth noting for build / deploy pipelines:

1. **Docker image name.** `triggerdotdev/trigger.dev` → `platos-dev/platos-webapp`. Update your image pulls.
2. **Workspace package names.** If you consume internal packages directly (`@internal/*`), check the rename table above and update imports. Durable-runtime consumers stay on `@trigger.dev/sdk`; Platos REST/WebSocket consumers use `@platosdev/client`.

## Rolling back

If something goes wrong after migration:

```bash
# 1. Pin webapp to the last trigger.dev image
docker compose stop webapp agent
# 2. Revert schema additions
psql $DATABASE_URL -f migrations/platos-rollback.sql
# 3. Restore prior image
docker compose up -d webapp
```

The rollback SQL is shipped in the `platos-dev/platos` repo under `migrations/rollback/`. It `DROP TABLE`s only Platos-added tables — your existing trigger data is untouched.

## FAQ

**Do I need to migrate my tasks to Platos-specific APIs?**
No. Tasks are unchanged.

**Does Platos charge extra?**
Apache 2.0, self-host free. There's a hosted offering at platos.dev with a free tier.

**Can I still use trigger.dev cloud as my engine?**
Yes. Set `TRIGGER_SECRET_KEY` to your cloud key and `TRIGGER_API_URL=https://api.trigger.dev`. The agent layer runs wherever you put it; the engine can be anywhere.

**What if I don't want the agent layer at all?**
Don't boot `apps/agent`. Run just the webapp container. Platos is a strict superset — nothing upstream is removed.

**Is Platos's Prisma schema compatible with upstream?**
Yes. Additive only. You can switch back by removing the added tables.

## Next

- New features worth exploring: [tool-gateway.md](./tool-gateway.md), [user-profiling.md](./user-profiling.md), [writing-agents.md](./writing-agents.md).
- Production hardening: [self-hosting.md](./self-hosting.md).
