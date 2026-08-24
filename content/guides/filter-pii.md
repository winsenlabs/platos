---
slug: filter-pii
title: Configure a PII filter
description: Block or redact specific PII categories per agent and log every hit.
category: recipes
order: 90
questions:
  - "Which PII categories does Platos detect?"
  - "How do I block emails on a specific agent?"
  - "How do I log without blocking?"
  - "Where do I see PII filter hits?"
related:
  - approve-tool-call
---

# Configure a PII filter

Detect and act on PII in chat input or memory writes per agent.

## The goal

An agent that automatically redacts (or blocks) sensitive content before it reaches the model or memory store, with every hit logged for audit.

## Steps

1. **Open the safety tab.**

   On the agent, Safety -> "PII filters".

2. **Pick categories.**

   Toggle defaults: `email`, `phone`, `credit_card`, `ssn`, `api_key`, `iban`. Per category, choose policy:
   - `flag`: pass through, emit an event for review.
   - `redact`: mask the match in the model input or memory write.
   - `block`: refuse the turn or memory write entirely.

3. **Add custom regex (optional).**

   - Name: `internal_id`.
   - Pattern: `\bACME-\d{6}\b`.
   - Policy: `redact`.

   Save.

4. **Test.**

   In the chat panel, send a message containing a fake match (e.g. an email like `test@example.com`). Watch the response: redacted content appears as `[REDACTED:email]`. The safety event card lights up on the governance page.

## Verify

- A Turn with a matched pattern creates a scoped safety event visible through monitoring.
- The governance page (`/agent-governance`) lists the event with category, policy, and decrypted match.
- Audit shows the redacted-match log row.

## Wire to an alert

Subscribe to `safety.event`. Filter by `category: credit_card` and policy `block`; route to your incident channel.

## Common pitfalls

- US phone regex misses international formats. Add custom patterns.
- `block` policy throws a turn error users see; use `redact` for first-party data the agent must acknowledge.
- The filter runs on input, not output. Output filtering is configured separately on the agent's `outputFilters`.

## Next steps

- [Add a human approval gate](/guides/approve-tool-call) for tools that act on detected entities.
- See [Safety, PII, governance](/docs/safety-and-pii) for the full rule engine.
