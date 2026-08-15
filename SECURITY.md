# Security Policy

## Supported Versions

Platos follows semver. Security fixes are backported to:

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email `hello@winsenlabs.com` with:

- A description of the vulnerability
- Steps to reproduce (PoC preferred)
- Affected versions
- Your suggested fix or mitigation (optional)

We respond within 72 hours. Critical vulnerabilities get a fix + disclosure
within 14 days; lower-severity issues within 30 days.

## Scope

In-scope targets:

- The `apps/webapp` Remix dashboard + API
- The `apps/agent` NestJS service (port 3100)
- The `@platos/*` published npm packages
- Official Docker images under `ghcr.io/winsenlabs/platos-*`
- Platos-specific code paths (agent runtime, tool gateway, memory system)

Out-of-scope:

- Upstream trigger.dev code paths (report those to Trigger.dev, Inc.)
- Self-hosted misconfigurations (expose your .env → that's on you)
- Social engineering or phishing against Platos team members
- Denial-of-service via exhaustion that requires control of N >= 100 legitimate accounts

## Coordinated Disclosure

We follow responsible disclosure:

1. You report → we acknowledge (72 hrs)
2. We triage + fix privately
3. We publish a patch + CVE (if eligible)
4. We credit you in the release notes unless you prefer anonymity

## Hall of Fame

Security researchers who have responsibly disclosed issues are listed at
https://platos.dev/security/hall-of-fame (coming post-launch).

## Hardening Checklist for Self-Hosters

If you're running Platos in production, at minimum:

- [ ] Rotate `PLATOS_ENCRYPTION_KEY` from the default
- [ ] Set `SESSION_SECRET` to a strong unique value shared by the webapp and agent
- [ ] Set `TRIGGER_INTERNAL_SECRET` (HMAC signing for durable task callbacks)
- [ ] Put TLS in front (reverse proxy / load balancer)
- [ ] Restrict CORS origin from `*` to your actual frontend domain
- [ ] Enable rate limiting (reverse proxy or Platos-native limits)
- [ ] Isolate Platos's Postgres from the open internet
- [ ] Backup Postgres daily; test restore monthly
- [ ] Monitor the OTEL traces + log exports for anomalies
- [ ] Rotate org service secrets quarterly

More: see `docs/self-hosting.md` (production checklist section).
