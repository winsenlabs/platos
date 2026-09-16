---
"@platosdev/client": major
---

`PlatosClient` no longer retries a request that a retry could duplicate.

Commit 77864609 changed `_fetchWithRetry` so a request is retried only when its
method is idempotent under RFC 9110 §9.2.2 (GET, HEAD, PUT, DELETE, OPTIONS) or
when it carries an `Idempotency-Key`. A POST or PATCH without that header is now
sent exactly once, and its first failure — a network error, a 5xx, a 429 — is the
error the caller receives. Before, the same call was repeated up to `maxRetries`
times, which for a side-effecting call meant the effect could happen more than
once.

This is an intentional observable change that can turn a previously recovered
transient failure into a thrown error, so it is recorded as a MAJOR. It shipped
without version intent; this entry records it after the fact, and
`scripts/sdk/changeset-gate.mjs` now refuses the next change that does the same.
`createV1Client` is unaffected: it already mints one key per logical call and
retries under it. See "Retries" in `docs/sdk-v1-migration.md`.
