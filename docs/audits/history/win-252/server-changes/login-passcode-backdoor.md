---
title: "[POINT-IN-TIME] Login Passcode Backdoor"
lifecycle: "POINT-IN-TIME"
area: webapp
type: feature
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

Operator passcode login on `/login/magic` for one specific email.

When BOTH `BACKDOOR_PLATOS_DEV` (passcode) and `BACKDOOR_PLATOS_DEV_EMAIL`
are set, and the email entered on `/login` matches the configured email,
the magic-link wait page renders an "Or sign in with passcode" button.
Clicking it reveals a passcode field; valid submission mints / fetches
the user record and commits the same `__session` cookie remix-auth
would write, redirecting to `/`.

Validation is fail-closed + constant-time:
- Either env var unset → button never renders + `passcode` action 404s
  (rejected with "Invalid email or passcode" — no leak about what's
  missing).
- Email mismatch → same generic rejection.
- Passcode length mismatch → same generic rejection.
- Passcode bytes compared with `timingSafeEqual` on equal-length
  Buffers.

The "last entered email" is tracked via a dedicated `__platos_last_email`
cookie (separate from `__session` because the magic-link strategy
clobbers the latter on its redirect). Cookie is HttpOnly + signed with
`SESSION_SECRET`, 24h TTL.

Disabled by default in production unless the operator sets both env
vars on the VPS.
