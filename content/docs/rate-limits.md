---
slug: rate-limits
title: Rate limits
description: Per-IP, per-token, per-agent, and per-environment rate limits enforced at the agent runtime.
category: governance
order: 40
questions:
  - "What rate limits does Platos enforce out of the box?"
  - "How do I tighten or loosen the limit for a specific agent?"
  - "What is the difference between a rate limit and a budget cap?"
  - "How do I tell if a 429 came from rate limiting vs the upstream LLM?"
  - "Where are the rate limit hits logged?"
related:
  - budgets
  - safety-and-pii
  - auth-modes
---

# Rate limits

Rate limits cap requests per second along four axes: IP, auth token, agent, and environment. The runtime enforces them at the auth guard before any business logic runs, so a misbehaving caller burns very little of the agent's CPU before getting a 429.

## What it is

`RateLimitService` plus `RateLimitGuard`. Backed by Redis sliding-window counters keyed on:

- `(ip, route)`: per-source-IP cap. Default 60 req/min on chat endpoints, higher on public read endpoints.
- `(token, route)`: per-auth-token cap. Defaults vary by token type; PATs are tighter than session tokens.
- `(agentId)`: total turns per minute on a specific agent. Defaults configured per agent in its monitoring config.
- `(scope)`: scope-wide cap. The ceiling across every agent in the environment.

Hits are logged to `RateLimitHit` (sampled to avoid log spam) and rolled up on the [Monitoring](/docs/monitoring) page.

A 429 response carries `Retry-After` (seconds) plus `X-Platos-Rate-Limit-Bucket` so you know which axis fired.

## Why it matters

Rate limits and budget caps fix different problems:

- A budget cap fails when your spend is too high. It is a money brake.
- A rate limit fails when your requests-per-second are too high. It is a fairness brake.

A user that holds down "send" in the chat UI will burn through a budget cap eventually, but the rate limit kicks in first and protects the agent from cascading downstream errors. A scraper hammering your public agent will not blow your budget for an hour, but it will burn other users' latency budgets in the meantime; the rate limit stops that.

## How to use it

### Tighten or loosen per agent

In the agent's monitoring tab, set `rateLimit: { perMinute: 30 }`. The agent's per-agent counter caps at 30 RPS regardless of how many users hit it.

### Tighten by IP for public agents

Public agents (see [Public agents and embed](/docs/public-agents-and-embed)) typically need stricter IP caps to absorb scrape traffic. The default for public-share endpoints is 30 req/min per IP; raise the cap in the agent's share settings if you have a high-traffic public bot.

### Diagnose a 429

Inspect `X-Platos-Rate-Limit-Bucket`:

- `ip:chat` -> caller IP rate.
- `token:chat` -> caller token rate.
- `agent:abc123` -> the agent's per-minute cap.
- `scope:env-id` -> the environment's ceiling.

Each bucket has its own remaining-window header so you know exactly when retry will work.

### Distinguish from upstream

A 429 from Platos is the runtime's. A 429 from the underlying provider (OpenAI, Anthropic) lands as a 502 with a `provider_rate_limit` error code; the runtime never re-emits a provider 429 directly because that would conflate two different actors.

## Common pitfalls

- A long-running Job does not consume Turn request rate after acceptance. Apply separate Job admission and provider limits to heavy fan-out.
- Public agents should have stricter caps than internal ones; the default is intentionally tight.
- Sliding-window counters are per-replica until the cluster syncs. For multi-replica installations, configure `RATE_LIMIT_CLUSTER_SYNC=true` so caps are global, not per-replica.
- Rate limit hits are sampled in the audit log. If you need every hit, raise `RATE_LIMIT_LOG_SAMPLE` to 1.0; expect log volume to grow.

## Related

- [Budgets](/docs/budgets): the orthogonal axis (dollars, not RPS).
- [Safety and PII](/docs/safety-and-pii): the broader governance surface.
- [Auth modes](/docs/auth-modes): each auth mode has its own default rate config.
