---
slug: embed-public-agent
title: Embed a public agent on a website
description: Drop the Platos web component on a page and let visitors chat with a guest token.
category: integrations
order: 50
questions:
  - "What HTML do I add to embed a public agent?"
  - "How do I rate-limit anonymous users?"
  - "How do I theme the embedded chat?"
  - "How do I capture the visitor's email after a chat?"
related:
  - consume-platos-mcp
  - webhook-on-conversation-events
---

# Embed a public agent on a website

Drop the Platos web component on your marketing page; visitors chat with the agent without signing in.

## The goal

A `<platos-chat>` element on your page wired to a Platos agent, mint-on-demand for anonymous visitors, with rate limits in place.

## Steps

1. **Make the agent public.**

   Open the agent. Share tab. Toggle "Public". Configure:
   - **Per-IP rate**: 30 req/min default; tune up if you get legitimate scrape-shaped traffic.
   - **Welcome message**: shown on first load.
   - **Visible model name**: defaults hidden; reveal if you want to brand the model.

   Save. Copy the share id.

2. **Embed the script.**

   On your marketing page:

   ```html
   <script src="https://platos.example.com/embed.js"></script>
   <platos-chat
     share-id="agent-share-abc123"
     theme="light"
     welcome="Hi! Ask me anything."
   ></platos-chat>
   ```

   The component fetches a guest token (5-minute session), opens a chat panel, and renders inline.

3. **Theme.**

   CSS variables override:

   ```css
   platos-chat {
     --platos-bg: #ffffff;
     --platos-fg: #111827;
     --platos-accent: #6366f1;
     width: 380px;
     height: 600px;
   }
   ```

4. **Capture lead info via tool calls.**

   Add a `capture_lead` tool to the agent (via your entity or as a meta-tool wrapper) that the agent calls when the visitor offers their email. The tool writes to your CRM and the conversation continues.

## Verify

- Visit the page in an incognito window. The chat panel loads.
- Send a message; tokens stream.
- Hit the rate cap (e.g. 31 messages in a minute). The 32nd request returns `RATE_LIMITED` with a `Retry-After` header.

## Lock down with a webhook

Subscribe to `conversation.created` and `message.created` for audit. See [Subscribe to conversation events](/guides/webhook-on-conversation-events).

## Next steps

- [Consume Platos via MCP](/guides/consume-platos-mcp) if you want the same agent's tools to power a non-embedded MCP client.
- [Subscribe to conversation events](/guides/webhook-on-conversation-events) for downstream notifications.
