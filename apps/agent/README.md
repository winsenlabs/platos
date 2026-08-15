# Platos Agent Service

The AI agent runtime for the Platos platform. Handles agent orchestration, tool discovery, conversation management, memory, monitoring, and real-time streaming.

## Quick Start

```bash
# Prerequisites: PostgreSQL + Redis running (via docker compose)
cd /path/to/platos
docker compose -f docker/docker-compose.yml up -d database redis

# Run migrations
pnpm run db:migrate

# Start the agent service
cd apps/agent
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres" \
REDIS_URL="redis://localhost:6379" \
PLATOS_TEST_MODE="true" \
node dist/main.js
```

The service runs on port 3100 by default.

## API Endpoints

### Health
- `GET /api/health` — service health check

### Threads (Conversations)
- `POST /api/v1/agent/threads` — create a conversation thread
- `GET /api/v1/agent/threads` — list threads (scoped by org + user)
- `GET /api/v1/agent/threads/:id` — get thread details
- `PATCH /api/v1/agent/threads/:id` — update thread (title, status)
- `DELETE /api/v1/agent/threads/:id` — delete thread

### Messages
- `POST /api/v1/agent/threads/:id/messages` — send message (non-streaming)
- `POST /api/v1/agent/threads/:id/stream` — send message (SSE streaming)
- `GET /api/v1/agent/threads/:id/messages` — get message history

### Tools
- `GET /api/v1/agent/tools` — list tools for an org
- `GET /api/v1/agent/tools/search?q=...` — BM25 tool search
- `GET /api/v1/agent/tools/stats` — tool index statistics

### Organizations
- `POST /api/v1/agent/orgs` — register an org
- `GET /api/v1/agent/orgs` — list connected orgs
- `GET /api/v1/agent/orgs/:orgId` — get org details + connection status
- `DELETE /api/v1/agent/orgs/:orgId` — remove an org

### Credentials
- `POST /api/v1/agent/credentials` — store encrypted API key / service account
- `GET /api/v1/agent/credentials` — list configured providers
- `DELETE /api/v1/agent/credentials/:provider` — remove a credential
- `GET /api/v1/agent/credentials/status` — check encryption configuration

### Monitoring
- `GET /api/v1/agent/monitoring/cost/:orgId` — org daily cost
- `GET /api/v1/agent/monitoring/cost/thread/:threadId` — thread cost

### WebSocket (Real-time)
- `ws://localhost:3100/agent` — agent chat (token streaming)
- `ws://localhost:3100/tools/sync` — tool registration sync

### Test mode
`PLATOS_TEST_MODE=true` selects deterministic providers for local tests. The
main application no longer registers unauthenticated `/test/*` token-minting
controllers, and strict production builds remove their compiled files.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | `redis://localhost:6379` | Redis connection string |
| `PLATOS_AGENT_PORT` | No | `3100` | HTTP port |
| `PLATOS_TEST_MODE` | No | `false` | Enable deterministic local test providers |
| `PLATOS_DEFAULT_MODEL` | No | `anthropic:claude-sonnet-4-20250514` | Default LLM model |
| `PLATOS_ENCRYPTION_KEY` | Prod | — | 32-byte hex for secrets encryption |
| `SESSION_SECRET` | Prod | — | Session token signing secret |
| `PLATOS_MESSAGE_ENCRYPTION_KEY` | Prod | — | 32-byte hex for versioned message/audit-content encryption |
| `PLATOS_INTERNAL_AUTH_TOKEN` | Prod | — | Dedicated scheduled/internal callback authentication only |
| `PLATOS_CORS_ORIGIN` | No | `*` | CORS allowed origins |
| `PLATOS_RATE_LIMIT_PER_MIN` | No | `60` | Per-org requests/minute |
| `PLATOS_RATE_LIMIT_PER_DAY` | No | `1000` | Per-org requests/day |
| `PLATOS_WORKING_MEMORY_TTL` | No | `3600` | Working memory TTL (seconds) |
| `PLATOS_TOOL_EXECUTOR_MODEL` | No | — | GPT-OSS model for Mode 1 tool execution |
| `ANTHROPIC_API_KEY` | No | — | Default Anthropic API key |
| `OPENAI_API_KEY` | No | — | Default OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | No | — | Default Google AI API key |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | — | GCP service account JSON path |

## Authentication

Two auth methods:
1. **Session tokens** (`X-Platos-Session-Token` header) — HMAC-signed, short-lived
2. **Direct headers** (`X-Platos-Org-Id` + `X-Platos-User-Id`) — dev/service-to-service

All endpoints are scoped by org_id + user_id. Org A cannot access Org B's data.

## Built On

- [trigger.dev](https://trigger.dev) — Durable task execution (Apache 2.0)
- [Vercel AI SDK](https://sdk.vercel.ai) — LLM interaction layer
- [NestJS](https://nestjs.com) — Application framework
- [Pydantic AI](https://ai.pydantic.dev) — Inspiration for agent runtime design
