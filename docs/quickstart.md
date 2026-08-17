# Platos Quickstart

Zero to first agent reply in ~20 minutes. By the end of this guide you will have a local Platos stack running in Docker, a signed-in account, one agent configured with Claude Sonnet 4.6, and a working conversation.

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker | 24+ (with Compose v2) | `docker compose version` |
| Node | 20 LTS or newer | `node -v` |
| pnpm | 9+ | `pnpm -v` |
| An Anthropic API key | Any tier | [console.anthropic.com](https://console.anthropic.com) |

You do **not** need trigger.dev cloud keys. The stack ships with a local run engine. A `TRIGGER_SECRET_KEY` is only needed if you want the durable `spawn_bgo` meta-tool (formerly `spawn_task`; see [BGO_RENAME.md](./BGO_RENAME.md)) to register with a remote engine — otherwise Platos transparently falls back to a Redis-backed stub.

## 1. Clone and configure

```bash
git clone https://github.com/platos-dev/platos.git
cd platos
cp .env.example .env
```

Open `.env` and set at minimum:

```bash
# Session and login-link signing
SESSION_SECRET=$(openssl rand -base64 24 | tr -d '\n')
MAGIC_LINK_SECRET=$(openssl rand -base64 24 | tr -d '\n')

# Three independent AES-256-GCM domains; new values are 64 hex chars / 32 bytes
ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
PLATOS_MESSAGE_ENCRYPTION_KEY_V=1

# At least one provider
ANTHROPIC_API_KEY=sk-ant-...
```

> Generate each encryption key separately. Existing exact 32-byte UTF-8 `ENCRYPTION_KEY` deployments remain valid; do not replace that value without re-encrypting historical ciphertext. Platos rejects malformed keys and configured domains that reuse the same bytes.

`.env.example` documents everything. See [env-vars.md](./env-vars.md) for the full list.

> Rotating these secrets invalidates sessions and encrypted columns — rotate only with the key-rotation flow in [self-hosting.md](./self-hosting.md#key-rotation).

## 2. Boot the stack

```bash
docker compose -f docker-compose.platos.yml up -d
```

This starts:

- `postgres` (16) on 5432
- `redis` (7) on 6379
- `clickhouse` (25.3) on 8123
- `minio` (object store for multimodal attachments) on 9001 (API) + 9002 (console)
- `webapp` (Remix) on 3030
- `agent` (NestJS) on 3100

### Database migrations

Compose runs the guarded `@platos/database` migration package automatically in
the `migrations-init` one-shot before webapp and agent startup. For host-side
development, the equivalent command is:

```bash
pnpm install                           # hydrate deps
pnpm run db:migrate                    # Postgres schema
# ClickHouse migrations use a one-shot goose container — see docs/self-hosting.md
```

Ordinary migration accepts only an empty or already-clean catalog. A legacy
catalog is refused and must wait for the future operator-gated `db:cutover`
workflow; do not baseline the clean migration over it.

Expect ~90 seconds total between `up` and the first successful login.

### TLS / public exposure

The shipped compose file does NOT include a reverse proxy. For local dev this is fine — you reach the webapp at `http://localhost:3030` and the agent at `http://localhost:3100`. For a **public-reachable** deploy, front the stack with Caddy (or any reverse proxy that auto-stamps `X-Forwarded-For`):

- The agent's `ScopeGuard` + Socket.IO handshake both require `X-Forwarded-For` on external requests (SPEC §10.3) and reject raw scope headers from proxied origins.
- Presigned MinIO URLs must be signed against your public MinIO hostname — set `MINIO_PUBLIC_ENDPOINT` accordingly (see [env-vars.md](./env-vars.md#core)).
- See [`docs/self-hosting.md`](./self-hosting.md) for a worked Caddy example + Let's Encrypt setup.

Verify:

```bash
docker compose -f docker-compose.platos.yml ps
curl -fsS http://localhost:3030/healthcheck && echo OK
curl -fsS http://localhost:3100/api/health && echo OK
```

Both endpoints should return 200.

## 3. Log in

Open [http://localhost:3030](http://localhost:3030). Enter your email. Platos issues a magic link. In local/dev mode, email delivery logs the link to the webapp container instead of sending:

```bash
docker compose -f docker-compose.platos.yml logs webapp --tail=50 | grep "Magic link"
```

Paste the link in your browser. You're in.

## 4. Link a provider API key

Platos doesn't have a separate encrypted provider-credential store. Every API key (Anthropic, OpenAI, Google, skills, user tool code) lives in trigger.dev's **Environment Variables** table — one source of truth, encrypted at rest, rotatable without redeploy, scoped per environment.

The provider page just tells you which env vars a provider needs. You link the env var; the provider enables.

1. **Side menu → Providers** (route: `/agent-providers`). You'll see a list of every supported provider with its `required_env` next to it.

2. **Anthropic's card** shows `ANTHROPIC_API_KEY` as required. Click the **[Link env]** button (or the provider card itself). You'll be redirected to `/environment-variables/new?key=ANTHROPIC_API_KEY`.

3. **Paste your API key** into the Value field. Save. The env var is encrypted on write via `EnvironmentVariablesRepository` and scoped to `(org, project, env)` — same key can have different values per environment.

4. **Navigate back** to `/agent-providers`. The Anthropic card now shows the **Ready** pill instead of "Link env". Click the **Test** button on the card to fire a live probe (`POST /api/v1/agent/providers/anthropic/health`) and confirm the key works.

> You can repeat this for `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or any other provider. Models from unlinked providers show disabled in the agent builder's model picker with a **[Link env]** affordance. See [writing-agents.md](./writing-agents.md) for the agent builder flow.

## 5. Create your first agent

Go to **Agents → New Agent**:

- **Name**: `Support Bot`
- **Provider**: Anthropic
- **Model**: `claude-sonnet-4-6` (the default — Platos's canonical production model)
- **Tool execution mode**: Direct (Mode 2)
- **History mode**: Compact
- **Compact threshold**: 40 (summarize oldest turns once thread exceeds 40 messages)
- **System prompt**:

```
You are a friendly support bot for Acme Corp.
Be concise. If the user asks about pricing, refer them to pricing@acme.com.
```

Leave everything else default. Click **Save**.

## 6. Chat

Click **Chat** on the agent card. Say hi.

```
You:  Hey — what hours are you open?
Bot:  We're open 9am to 6pm Pacific, Monday through Friday. Anything else I can help with?
```

Behind the scenes on that first message:

1. UI opened a Socket.IO connection to `ws://localhost:3100/agent`
2. Gateway validated your session, resolved the agent config, and pushed the message to `AgentTaskService`
3. `AgentService.stream()` built the static block (system prompt + empty tool matrix), cached it via `cache_control`, appended the user turn, and called Anthropic
4. Streaming tokens came back as `delta` events → Socket.IO → UI
5. Final message was persisted to `PlatosAgentMessage` and the cache hit was logged to `platos:cost:*` in Redis

## 7. Give it a tool

Platos tools are always served from an **entity backend** — a small process of yours
that opens a WebSocket to the Platos tool gateway and answers tool calls. There's
no "inline" handler mode in the shipped runtime; the agent never executes arbitrary
customer code in-process.

For the quickest path, use the reference entity included in this repo:

```bash
# from repo root
cd references/entity-hello-world
pnpm install
PLATOS_ENTITY_ID=demo-entity \
PLATOS_SERVICE_SECRET=<paste from dashboard → Entities → New> \
pnpm dev
```

The reference entity registers a `get_business_hours` tool. Open the agent's
**Tools** tab, pick the entity you just connected, and check the tool on. Save.

Ask the bot `What time do you close on Tuesday?`. You'll see a tool call in the
message timeline:

```
→ tool_use: get_business_hours({ day: "Tuesday" })
← tool_result: { open: "09:00", close: "18:00", tz: "America/Los_Angeles" }
Bot:  We close at 6pm Pacific on Tuesday.
```

For production tools, follow the [tool gateway guide](./tool-gateway.md) — same
protocol, your own backend, your own data.

## 8. Inspect a run

Every user turn creates a durable run. Go to **Runs** in the sidebar. You'll see:

- Full event trace (message in, LLM call, tool calls, LLM call, message out)
- Token counts + cache hit ratio
- Latency per step
- Raw request/response payloads (redacted for provider keys)

This is the trigger.dev run engine — you get the same observability you'd get for any other trigger task. See [architecture.md](./architecture.md) for the full lifecycle.

## Troubleshooting

**Agent container crash-loops on boot.** Check `docker compose logs agent`. Confirm all three encryption inputs are independently generated 64-character hex values (`openssl rand -hex 32`) and that `PLATOS_MESSAGE_ENCRYPTION_KEY` is present in production. See [env-vars.md](./env-vars.md#core).

**Magic link never arrives.** In dev mode, check `docker compose logs webapp`. For production SMTP, set `FROM_EMAIL`, `RESEND_API_KEY`, or configure `SMTP_*` vars (see [env-vars.md](./env-vars.md)).

**Chat hangs on "Connecting…".** The browser couldn't reach `ws://localhost:3100`. If you're behind a reverse proxy, make sure `/agent` (Socket.IO path) is upgraded correctly and `APP_ORIGIN` in `.env` matches the browser origin.

**LLM call errors with 401.** The `ANTHROPIC_API_KEY` linked to the current scope in **Side menu → Providers** (route: `/agent-providers`) is wrong or expired. Open the provider card, click the linked env var, paste a fresh key, and hit **Test** to confirm. The value in the root `.env` is only used as a seed for bootstrap; the scoped Environment Variables value is what streams.

## Next steps

- Write a more interesting agent in [writing-agents.md](./writing-agents.md) (research agent, sub-agent mode)
- Connect a real tool server using the platools SDK in [tool-gateway.md](./tool-gateway.md)
- Deploy to production: [self-hosting.md](./self-hosting.md)
- Learn how durable runs back every turn: [trigger-integration.md](./trigger-integration.md)
