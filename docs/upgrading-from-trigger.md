# Upgrading from trigger.dev

Platos is a superset of trigger.dev. Everything trigger does, Platos does — identically. The delta is an added agent layer (`apps/agent`), an extended Prisma schema, a renamed SDK re-export, and a new docker-compose profile.

This guide is for teams already running trigger.dev (cloud or self-hosted) who want to migrate to Platos without losing tasks, runs, or SDK usage.

## What's unchanged

All of these continue to work exactly as before:

- **Task definitions.** Your `trigger/*.ts` files need no changes.
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

### Renamed

- **`@trigger.dev/sdk` → `@platos/sdk`** — thin re-export. Both packages resolve to the same code; `@platos/sdk` also exposes the agent-layer clients (`PlatosClient`, `client.agents`, `client.messages`, `client.threads`).
- Workspace packages (internal):

| Before | After |
|---|---|
| `@internal/agent-worker` (unused — name collision risk) | `@platos/agent` |
| `@trigger.dev/platform` | `@platos/platform` (re-exports `@trigger.dev/platform`) |
| `@trigger.dev/database` | `@platos/database` (re-exports) |

If you import from internal packages directly (most users don't), update these imports. If you only use `@trigger.dev/sdk` in consumer code, see the migration path below — you can migrate lazily.

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

Add the three required Platos env vars:

```bash
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)              # 64 hex chars = 32 bytes
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)      # distinct 64-hex value
ANTHROPIC_API_KEY=sk-ant-...
```

> Generate new encryption-domain keys as 64 hex chars (32 bytes decoded), with a different value for every domain. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` values continue working verbatim and must not be replaced without re-encryption. See [env-vars.md](./env-vars.md#core).

Nothing else changes. Your existing `SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`, `TRIGGER_SECRET_KEY` keep working verbatim.

### Step 3 — (Optional) Rename SDK imports

In consumer projects (your task-defining repos), swap the SDK:

```ts
// before
import { tasks, schedules, wait } from "@trigger.dev/sdk/v3";

// after
import { tasks, schedules, wait } from "@platos/sdk";
// or, for agent-layer access:
import { PlatosClient, tasks, schedules, wait } from "@platos/sdk";
```

Both still work. `@trigger.dev/sdk` is kept as a dev dependency so existing imports compile. For new code or when doing a pass, prefer `@platos/sdk`.

### Step 4 — (Optional) Start building agents

Once the agent service is up and reachable from your UI or apps, follow [quickstart.md](./quickstart.md) from step 3 onward to create your first agent. You can mix freely: tasks you already have (`fetch_and_summarize`, `send_email`, etc.) are instantly callable from agents via the `spawn_bgo` meta-tool (formerly `spawn_task` — kept as a deprecated alias; see [BGO_RENAME.md](./BGO_RENAME.md)).

### Step 5 — (Optional) Deprecate direct `@trigger.dev/sdk` use

Once everything's migrated, remove `@trigger.dev/sdk` from your package.json. Our monorepo dependency on it is transitive through `@platos/sdk`. Your lockfile still resolves the same underlying code.

## Before / after snippets

### Triggering a task from backend code

```ts
// before
import { tasks } from "@trigger.dev/sdk/v3";
import { fetchAndSummarize } from "./trigger/research";

await tasks.trigger<typeof fetchAndSummarize>("fetch_and_summarize", { query: "quantum computing" });
```

```ts
// after (same, new import)
import { tasks } from "@platos/sdk";
import { fetchAndSummarize } from "./trigger/research";

await tasks.trigger<typeof fetchAndSummarize>("fetch_and_summarize", { query: "quantum computing" });
```

### Triggering from an agent turn

Not possible before. Now:

```ts
// The agent calls spawn_bgo as a meta-tool during a user turn (the old
// name spawn_task is kept as a deprecated alias for one release — see
// docs/BGO_RENAME.md).
// No code change needed in your task — just add spawn_bgo to the agent's
// tool list (either name works during the compat window).
```

### Schedules

```ts
// before
import { schedules } from "@trigger.dev/sdk/v3";

export const dailyCleanup = schedules.task({ id: "daily_cleanup", cron: "0 3 * * *", run: async () => { /*...*/ } });
```

```ts
// after — identical
import { schedules } from "@platos/sdk";

export const dailyCleanup = schedules.task({ id: "daily_cleanup", cron: "0 3 * * *", run: async () => { /*...*/ } });
```

### Realtime subscription from UI

```ts
// before
import { runs } from "@trigger.dev/sdk/v3";
for await (const update of runs.subscribeToRun(runId, { accessToken })) { /*...*/ }
```

```ts
// after — identical
import { runs } from "@platos/sdk";
for await (const update of runs.subscribeToRun(runId, { accessToken })) { /*...*/ }
```

### HITL via `wait.forToken`

Unchanged. Still `wait.createToken` + `wait.forToken`. Agents can create these tokens via the new `request_durable_approval` meta-tool, which is a thin wrapper.

## Breaking changes

None at runtime. Two worth noting for build / deploy pipelines:

1. **Docker image name.** `triggerdotdev/trigger.dev` → `platos-dev/platos-webapp`. Update your image pulls.
2. **Workspace package names.** If you consume internal packages directly (`@internal/*`), check the rename table above and update imports. Consumers of the public SDK are unaffected.

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
