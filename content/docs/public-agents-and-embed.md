---
slug: public-agents-and-embed
title: Public agents and embed
description: Share an agent publicly via a guest-token route, or drop in a web-component embed.
category: dx
order: 80
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I make an agent publicly chattable?"
  - "What is a guest token and how is it minted?"
  - "How do I embed a public agent on my marketing site?"
  - "Are public conversations rate limited differently?"
  - "How do I disable a public agent?"
  - "Can I customize the embed UI?"
related:
  - auth-modes
  - rate-limits
  - sdks
source_files_referenced:
  - apps/agent/src/auth/public-guest-token.controller.ts
  - apps/agent/src/agent-runtime/agent.controller.ts
  - apps/webapp/app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.share/route.tsx
---

# Public agents and embed

A public agent is an agent flagged shareable. It accepts traffic from anonymous users via short-lived guest tokens, is rate-limited tightly, and can be embedded as a web component in a marketing site. Use it for B2C demos, public chat assistants, or pre-sales bots.

## What it is

Two related controllers, one user-facing concept (drift D-009 notes the split):

- `agent.controller.ts` ships the share-token endpoint for an authenticated owner to mint a per-user share link.
- `auth/public-guest-token.controller.ts` ships the public-guest-token mint endpoint that an unauthenticated browser hits to get a session token.

The flow: the dashboard owner enables sharing on the agent. A "share URL" is generated. A visitor lands on the URL; the page fetches a guest token (no auth, just the share id); the chat UI uses the guest token as a Mode 2 session token; the conversation runs scoped to the agent.

The web component embed is a stand-alone HTML page (PIFSP-21 finished the embed mint; the full embed-HTML route is deferred to a Theme K follow-up). For now, drop a `<platos-chat>` element with a share id and the runtime serves the chat UI inside an iframe.

## Why it matters

Without a public flow, every chat is gated behind your auth. That is great for internal tools, useless for marketing. Public agents let you ship "talk to our docs bot" without asking the visitor to sign up first; the rate-limit-by-IP defaults keep you from being scraped to bankruptcy.

The web-component embed is the lowest-effort integration: paste two lines of HTML on your marketing page and your customers chat with your agent. No iframe wrangling, no CSP rules; the runtime owns the surface.

## How to use it

### Make an agent public

In the agent's share tab, toggle "Public". Configure rate limits (requests per minute per IP), the optional message-of-the-day, and the visible model. Save; the share URL is shown.

### Embed via web component

```html
<script src="https://platos.example.com/embed.js"></script>
<platos-chat share-id="agent-share-abc123"></platos-chat>
```

The component fetches a guest token, opens the chat, and renders inline. Style with attributes (`width`, `height`, `theme`).

### Mint a guest token from your own UI

```bash
curl -X POST https://platos.example.com/agent/v1/public-guest-token \
  -H "Content-Type: application/json" \
  -d '{"shareId":"agent-share-abc123"}'
```

Response is a 5-minute session token. Use it for the chat stream call.

### Disable

Toggle "Public" off. Active sessions finish; new tokens are refused.

### Customize the embed

Style via CSS variables (`--platos-bg`, `--platos-fg`, `--platos-accent`). Override the welcome message via the `welcome` attribute. Full custom UI: skip the embed, mint guest tokens directly from your code, and render with `@platos/client`.

## Common pitfalls

- Public agents have stricter rate limits per IP. The default is 30 req/min; aggressive bots will hit it. Tune in the share tab if your traffic is legitimate.
- Guest tokens are short-lived. The web component re-mints transparently; custom UIs must handle the 5-minute expiry.
- Public conversations still go through [Safety and PII](/docs/safety-and-pii). A public agent without filters is a prompt-injection target.
- The share endpoint and the public-guest-token endpoint live in different controllers (drift D-009). For most users this is invisible; for low-level integrators it can be confusing.

## Related

- [Auth modes](/docs/auth-modes): the guest token rides Mode 2.
- [Rate limits](/docs/rate-limits): public traffic gets per-IP caps by default.
- [SDKs](/docs/sdks): `@platos/client` plus a guest token works for fully custom UIs.
