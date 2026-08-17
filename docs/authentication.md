# Dashboard authentication

Platos owns dashboard authentication in `@platos/database`; it does
not use trigger.dev session, membership, MFA, invitation, or impersonation
models. Agent-facing `plt_`, `plt_ent_`, and entity-signed credentials are a
separate boundary and are unchanged.

## Login and sessions

- Login methods are email magic link and configured GitHub/Google OAuth only.
  There is no password or shared passcode/backdoor path.
- `OperatorSession` stores only a SHA-256 hash of a random opaque `plt_os_`
  token. The HTTP-only, SameSite=Lax, Secure cookie carries only the raw token.
- Sessions are revocable and expiring. Organization authorization resolves an
  active membership on every request; a valid session for another organization
  receives 403 rather than 401.
- Organization role changes, membership deactivation, and membership deletion
  revoke the affected user's active sessions in both the service and a database
  trigger.
- Login and invitation acceptance use persisted fixed-window rate-limit buckets
  keyed by a hash of the normalized identifier.

## MFA and invitations

- TOTP seeds require reversible storage and are encrypted with AES-256-GCM
  using the 32-byte webapp `ENCRYPTION_KEY`. Recovery codes are random, shown
  once, SHA-256 hashed at rest, and atomically consumed once.
- A TOTP counter cannot be reused. Enabling MFA revokes existing sessions.
- Magic-link and invitation tokens are opaque and SHA-256 hashed at rest.
  Invitations are normalized-email-bound, expiring, revocable, and atomically
  single-use.

## Impersonation

Only a user explicitly marked `platformOperator` may start impersonation. It
creates a distinct opaque session with actor and effective-user identities;
authorization results expose an explicit `impersonation.active` state for the
UI banner. START and STOP events are append-only `ImpersonationAudit` rows. The
database rejects updates and deletes of those records.

## Production test boundary

Strict agent builds do not register `TestModule` and delete `dist/test`. Remix
production builds ignore the development `agent-connect.mint-token` resource
route. Setting `PLATOS_TEST_MODE=true` in a production runtime therefore cannot
add either token-minting endpoint to the already-built application graph.
