---
"@platosdev/client": minor
"@platosdev/react-widget": minor
"@platosdev/embed": patch
"@platosdev/token-mint": patch
---

WIN-270 (M4.4) — the V1 surface is generated, and a mint retries under one key.

`@platosdev/client` gains `createV1Client`, whose namespaces and types are
EMITTED by `pnpm generate:sdk-v1` from the V1 OpenAPI document, the operation
manifest and core-api's own idempotency policy; `pnpm audit:sdk-v1` fails when a
committed client differs from what those inputs emit, so the generated layer
cannot drift from the server. The Python client gains the same surface from the
same generation pass, and both are driven against one cross-language fixture.

`Idempotency-Key` is minted ONCE PER LOGICAL CALL and reused on every retry of
that call, because a one-time-secret mint retried under a fresh key creates a
second live credential nobody knows about. Which operations require the header is
read off core-api's policy table rather than restated in either client.

Refusals now carry `error.code`: `PlatosError.code` and `PlatosError.refusal` are
new, and `PlatosRefusal` becomes the base of the 4xx family so one `catch`
reaches every coded refusal, including codes minted after this release.
`instanceof PlatosError` and every named subclass are unchanged; this only
widens what can be caught, which is why it is a MINOR rather than a major.

`@platosdev/react-widget`: a token mint that is refused now throws a coded
refusal, and the optimistic assistant bubble is withdrawn when the turn never
reached the agent instead of being rendered as `[error]`. A host that keyed off
that literal string should read `error` or the new `message.refusalCode`.

`@platosdev/embed`: `<platos-agent>` drops its internal iframe handle along with
the frame when a required attribute goes missing, so its `postMessage` trust
check never consults a detached element. No attribute or event changed.

`@platosdev/token-mint`: three doc comments on published types attributed ids
Platos mints, owns and validates to an external vendor's schema. Documentation
only; the wire format is unchanged.

See `docs/sdk-v1-migration.md` for the observable behaviour changes.
