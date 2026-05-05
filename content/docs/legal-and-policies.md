---
slug: legal-and-policies
title: Terms, privacy, security policy
description: Where to find Platos's legal documents, security disclosure process, and what each covers.
category: dx
order: 999
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Where are Platos's terms of service?"
  - "Where is the privacy policy?"
  - "How do I report a security vulnerability?"
  - "What is the security policy?"
  - "How does Platos handle my data?"
  - "Is Platos GDPR compliant?"
related:
  - encryption-and-secrets
  - self-hosting
---

Platos is open source under Apache 2.0. The runtime ships without legal terms attached — when you self-host, you're on your own infrastructure and there's no contract between you and Winsen Labs. The documents below cover the **public-facing surfaces operated by Winsen Labs** (`platos.dev` and `play.platos.dev`).

## Terms of service

Apply when you use the Winsen-Labs-operated playground or marketing site.

- **Live at**: [platos.dev/terms](https://platos.dev/terms)
- **Covers**: acceptable use, account responsibilities, content licensing, disclaimer of warranties, liability cap, governing law

If you self-host, these terms do not apply — your runtime, your terms.

## Privacy policy

Apply when you use the Winsen-Labs-operated surfaces.

- **Live at**: [platos.dev/privacy](https://platos.dev/privacy)
- **Covers**: what we collect (analytics, contact form submissions, chat-widget visitor email), how it's used, retention, third-party processors (Resend for email, PostHog for analytics, Vercel for hosting), GDPR/CCPA rights, deletion requests

For self-hosted Platos, no data leaves your infrastructure unless you opt in (e.g. by configuring a third-party LLM provider with a remote API). The runtime ships no telemetry by default.

## Security disclosure

Report vulnerabilities **privately** — do not open public GitHub issues for security bugs.

- **Email**: [hello@winsenlabs.com](mailto:hello@winsenlabs.com) (encrypted reports welcome; PGP key on request)
- **Live policy**: [platos.dev/security](https://platos.dev/security)
- **Coverage**: the Platos runtime + agent + webapp + SDK packages, the play.platos.dev hosted demo, the platos.dev marketing site
- **Scope-out**: self-hosted instances run by third parties, findings requiring physical device access, social engineering against employees
- **What you get**: 48h acknowledgement, 5-business-day triage, public credit in the changelog (opt-in)

A web form at [platos.dev/security](https://platos.dev/security) submits to the same `hello@winsenlabs.com` inbox and prefixes the subject with `SECURITY REPORT ||` for triage.

## License

Platos itself is [Apache 2.0](https://github.com/winsenlabs/platos/blob/main/LICENSE). Use it, fork it, ship it. The license file in the repo is authoritative; everything in the docs is a summary.

## How does Platos handle my data?

Self-hosted: end-to-end you. Your Postgres holds the conversation rows (encrypted at rest with AES-256 envelopes — see [encryption-and-secrets](/docs/encryption-and-secrets)), your Redis/ClickHouse/MinIO hold caches/telemetry/attachments. Nothing exits your perimeter unless you point Platos at a remote LLM provider.

Playground (`play.platos.dev`): Winsen Labs operates the instance. Your data lives on our infra, gets reset periodically, and is not isolated from other playground users. **Do not paste real customer data.**
