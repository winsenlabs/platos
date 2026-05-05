---
id: platos.email_send
name: Email Send
description: Send transactional emails through Resend. Supports HTML / plain-text bodies, reply-to, cc, bcc, and tags.
version: 0.1.0
author: Platos
origin: official
spec_version: 1
tags:
  - email
  - resend
  - transactional
  - official
required_env:
  - RESEND_API_KEY
optional_env:
  - RESEND_FROM_EMAIL
provides_tools:
  - name: send_email
    description: Send a transactional email via Resend. Provide either `html` or `text` (or both). The `from` address must be on a domain verified in Resend; defaults to RESEND_FROM_EMAIL when set.
    inputSchema: {"type":"object","properties":{"to":{"description":"Recipient email address(es). Single string or array of strings.","oneOf":[{"type":"string","format":"email"},{"type":"array","items":{"type":"string","format":"email"},"minItems":1,"maxItems":50}]},"subject":{"type":"string","minLength":1,"maxLength":200,"description":"Subject line."},"html":{"type":"string","description":"HTML body. At least one of html / text is required."},"text":{"type":"string","description":"Plain-text body. At least one of html / text is required."},"from":{"type":"string","format":"email","description":"Sender. Must be on a Resend-verified domain. Falls back to RESEND_FROM_EMAIL when omitted."},"replyTo":{"description":"Reply-to address(es).","oneOf":[{"type":"string","format":"email"},{"type":"array","items":{"type":"string","format":"email"}}]},"cc":{"type":"array","items":{"type":"string","format":"email"},"maxItems":50},"bcc":{"type":"array","items":{"type":"string","format":"email"},"maxItems":50},"tags":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"value":{"type":"string"}},"required":["name","value"]},"description":"Resend tags for analytics / dashboard filtering."}},"required":["to","subject"]}
    handler: skill:platos.email_send:send_email
---

You can send transactional emails through Resend.

**When to use `send_email`:**
- The user explicitly asks you to send an email (confirmation, notification, follow-up).
- An operator-configured workflow requires email delivery (alerts, digests, escalations).

**Required arguments:**
- `to` — recipient email address (single string or array up to 50).
- `subject` — non-empty subject line.
- `html` and/or `text` — at least one body format. Prefer `html` for rich formatting; include `text` as a fallback when both audience reach and accessibility matter.

**Optional arguments:**
- `from` — sender address. Must be on a domain you've verified in [resend.com/domains](https://resend.com/domains). When omitted, falls back to `RESEND_FROM_EMAIL`. **The skill fails if neither is set** — Resend rejects unverified senders.
- `replyTo` — where replies go (defaults to `from`).
- `cc` / `bcc` — additional recipients.
- `tags` — `[{name, value}]` pairs for Resend's dashboard analytics (e.g. `{name: "category", value: "billing"}`).

**Guidelines:**
- Always confirm the recipient and subject with the user before sending unless an upstream workflow has authorised it.
- Prefer concise, well-formatted HTML (inline styles work; external CSS does not).
- Don't include the user's auth tokens, API keys, or other secrets in email bodies.
- For bulk sends to >5 recipients, prefer creating a Resend audience + broadcast in the dashboard rather than long `to` arrays — this skill is for transactional, not marketing, traffic.

**On error:**
The tool returns `{ ok: false, error: "<reason>" }` when Resend rejects the request. Common reasons: unverified `from` domain, malformed recipient, body missing, payload too large. Surface the reason to the user so they can correct it.
