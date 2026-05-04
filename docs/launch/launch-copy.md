# Platos v1.0 — Launch Copy (DRAFTS)

## Tweet thread (5 tweets)

**Tweet 1 / hero**
> Introducing Platos — an open-source agent runtime platform.
>
> Durable execution. Tool matrix. Sub-agent tool-calling. HITL approvals. Multi-tenant. Prompt caching that actually works.
>
> Built on top of trigger.dev. Apache 2.0.
>
> github.com/winsenlabs/platos

**Tweet 2 / the two-half trick**
> Every message to an agent has two halves: the cached prefix (system prompt, blocks, tool schemas) and the dynamic suffix (history, user profile, request-time context).
>
> Platos gives you a builder that makes this split first-class. 90% token discount for repeated prefixes.

**Tweet 3 / sub-agent**
> 100+ tools? Don't shove their schemas into your main LLM. Pick sub-agent mode → a dedicated Haiku runs the tool-calling loop and returns a result to your parent Sonnet.
>
> Claude Code architecture, out of the box.

**Tweet 4 / HITL + tool matrix**
> Every tool can be marked `requiresApproval`. Agent pauses, UI emits approval modal, user approves, tool executes.
>
> Tools come from a multi-tenant registry. BM25-searchable. HMAC-signed. Your org connects via WebSocket and pushes whatever tools you have.

**Tweet 5 / closer**
> Batteries included: durable runs, schedules, checkpoints, observability, build extensions (Playwright/Python/FFmpeg), cost tracking.
>
> `docker compose up` from a fresh clone and you're talking to an agent in 20 minutes.
>
> Help us ship v1.1: github.com/winsenlabs/platos

---

## Show HN post

**Title:** Show HN: Platos — open-source agent runtime built on top of trigger.dev

**Body:**
Hey HN — I've been building a production agent for my company (Winsen Labs) and got tired of duct-taping LangChain/CrewAI with custom durability, observability, and tool execution. So I forked trigger.dev's run engine and built a dedicated agent layer on top.

**The core idea:** every agent turn is a *static* prefix (cached via Anthropic cache_control → 90% discount) plus a *dynamic* suffix (conversation history, user profile, request-time context). The agent builder UI is split in half — you configure both sides explicitly.

**Things that are first-class:**
- Sub-agent mode — main LLM (Sonnet 4.6) only sees a `delegate_to_sub_agent` meta-tool. A dedicated Haiku handles tool schemas + execution. Main context stays tiny across long conversations. This is basically Claude Code's architecture.
- HITL approvals — `request_approval` meta-tool. Emits event to Socket.IO, pauses on Redis BLPOP, user approves/denies in the UI. 5-min timeout.
- User profiling — per-agent-per-user profile. LLM calls `update_user_profile(key, value)` as it learns about users; `recall_user_profile()` on demand. Auto-inject snippet into every conversation.
- Multi-tenant tool matrix — your backend connects via WebSocket, pushes your tools. BM25-searchable registry. HMAC-signed execution. Per-org enable/disable and callback URLs.
- Conversation compaction — when threads cross a threshold, oldest messages summarize in background via Haiku. Summary auto-injected next turn. Long-horizon memory at 10% token cost.
- Prompt caching — attached at the correct message-level position, not top-level metadata (which is a common mistake). Verified via real Anthropic console responses.

**Built on:** Remix + NestJS + Postgres + Redis + Trigger.dev's run engine. Durable tasks, schedules, batches, checkpoints all work. `docker compose up` boots everything.

**Status:** v1.0, Apache 2.0. I'm dog-fooding it for Winsen's internal CRM/agent stack. Happy to trade war stories or walk through the code.

Repo: github.com/winsenlabs/platos
Docs: docs.platos.dev

---

## LinkedIn post (longer-form, Tejas personal brand)

**Opening hook:**
> I got tired of every agent framework being a leaky abstraction, so I built the one I wanted to use.

**Body (4 short paragraphs):**

After shipping an AI workplace OS (FanDesk — 596 API endpoints, 369 MCP tools, ~11 AI services), I kept running into the same problem: every agent framework claimed production-readiness, but none of them survived a server restart mid-tool-call.

So I forked trigger.dev (the best durable execution platform I could find) and built an agent runtime on top. Two-half message architecture — static prefix gets cached (90% token discount), dynamic suffix gets the work-specific context. Sub-agent mode for 100+ tools. HITL approvals. Per-user profiling that accumulates memory. Conversation compaction in the background.

Shipped as Platos v1.0 today. Apache 2.0. github.com/winsenlabs/platos.

It's what I wish existed when I started. Would love your feedback.

**Hashtags:** #OpenSource #AI #Agents

---

## Reddit r/selfhosted post

**Title:** Platos — self-hostable agent runtime with durable execution, multi-tenant tool matrix, HITL approvals (Apache 2.0)

**Body:**
Sharing the agent runtime I built. Self-hostable via Docker Compose, no external services required except your LLM provider (Anthropic/OpenAI/Google).

Key things if you're self-hosting:
- Encrypted provider keys (AES-256) stored per-org in your DB
- No telemetry. No cloud dependency. Runs on your own infra.
- Postgres + Redis + two Node services (webapp + agent)
- `trigger.dev dev` integration for durable task execution
- Prisma migrations for schema
- CORS configurable; HMAC secrets for service-to-service auth

Would love other self-hosters to kick the tires.

Repo: github.com/winsenlabs/platos

---

## Email to early-access list

**Subject:** Platos v1.0 is live — agent runtime we've been talking about

Hey,

Quick update: Platos v1.0 is out. Same thing I've been describing — durable agent runtime, built on trigger.dev, with a proper agent layer on top (tool matrix, sub-agent mode, HITL, user profiling, compaction).

It's Apache 2.0 and on GitHub. Self-hostable via Docker Compose. Quickstart takes 20 minutes.

Repo: github.com/winsenlabs/platos
Docs: docs.platos.dev
Demo: demo@platos.dev (if you want a walkthrough)

If you're in on the early-access list, you'll get my direct Slack DM — I want to hear what breaks first and what's confusing.

— Tejas

---

## DO NOT POST until approved

All of the above are drafts. Target order:
1. Land the GitHub repo public
2. Tag v1.0.0 release with release-notes-v1.0.0.md as the body
3. Post Tweet thread (draft above, edit for voice)
4. Post Show HN the same hour (link to repo + release)
5. LinkedIn post later that day (personal brand angle)
6. Reddit r/selfhosted 48h later (secondary channel)
7. Email list within 24h of repo going public

**Hold until founder (Tejas) explicit go.**
