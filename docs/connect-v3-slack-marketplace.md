# Connect v3 — Marketplace-Grade Channel Apps (Slack first)

*Spec synthesized 2026-07-22 from official Slack docs (docs.slack.dev) + marketplace-bot
field research (Claude, ChatGPT, Linear, GitHub, Notion). Source URLs at bottom.
Status: DESIGN — approved direction, not yet built.*

## The verdict that shapes everything

**"As good as Claude on the Marketplace" = ONE platform-owned Slack app installed into N
workspaces via OAuth V2.** It is NOT built with the Manifest API (that mints new,
customer-owned apps — the right tool for upgrading the *bring-your-own-app* tier, wrong
for a marketplace listing). Two products, two tiers:

| Tier | Who owns the Slack app | Install UX | Exists today? |
|---|---|---|---|
| **T-BYO** (self-host / enterprise) | Customer | Today: manual walk-through. Upgrade: "paste one config token, Platos builds your app" via `apps.manifest.create` | ✅ live (manual) |
| **T-APP** (publishable / marketplace) | Platos (or the agent's org) | **"Add to Slack" → OAuth → done.** Zero tokens ever touched | ❌ the build |

## Second architecture-shaping finding: target the AI-Apps surface

Slack ships a first-class **"Agents & AI Apps"** surface — split-view container, app
threads, native **streaming**, suggested prompts, thinking-status. This is what Claude
targets; a bare `app_mention` bot reads as second-class. Requires: the feature toggle,
`assistant:write` scope, `assistant_thread_started` / `assistant_thread_context_changed`
events, `assistant.threads.setStatus/setTitle/setSuggestedPrompts` methods. Our runtime
should treat this as the primary Slack surface, mention-bot as fallback.

## Data model

```
PlatosChannelApp            — the publishable app identity (per provider)
  clientId, clientSecret(enc), signingSecret(enc), scopes[], distribution: private|public
  ownerScope (org/project), aiAppsSurface: bool, tokenRotation: bool

PlatosChannelInstallation   — one row per workspace install
  appId → PlatosChannelApp
  teamId (nullable on Grid org-install) + enterpriseId + isEnterpriseInstall
  botToken(enc) [+ refreshToken(enc) + expiresAt when rotating], botUserId, grantedScopes
  agentBinding (default agent + agentRouting rules — carries over from v2)
  installedBy, createdAt / revokedAt

PlatosEndUserLink           — T2 account linking (extends PlatosEndUserIdentity)
  platosEndUserId, channel='slack', teamId+userId, linkedExternalIdentity
  nonce lifecycle handled by the hosted linking flow
```

`PlatosChannelConnection` (v2) stays as the T-BYO tier unchanged.

## Flows (exact contracts in the research; key params here)

**Install**: `https://slack.com/oauth/v2/authorize?client_id&scope&state&redirect_uri`
(state = CSRF nonce, verify on return) → callback `?code&state` →
`POST oauth.v2.access {code, client_id, client_secret}` → store by `team.id`
(bot token at root; `authed_user.access_token` nested; Grid: `is_enterprise_install`,
`team:null`, key by enterprise). Redirect URL must be pre-registered HTTPS.

**Events**: single request URL for the whole app; route by `team_id + api_app_id`.
Ack < 3s (fast-ack pattern already proven). **Dedupe on `event_id`** — Slack retries 3×
(immediate / +1min / +5min, `x-slack-retry-num`); a slow-but-successful handler gets
retried. `x-slack-no-retry: 1` to suppress. >95% failures over 60min = auto-disabled.

**Uninstall hygiene**: handle BOTH `app_uninstalled` and `tokens_revoked`
(order NOT guaranteed — known Slack quirk; never hard-delete state on the first event).
Purge tenant tokens + invalidate end-user links.

**Token rotation** (recommended, not mandated): `token_rotation_enabled` is one-way;
12h `xoxe.` tokens; refresh tokens single-use with a 2-active cap → refresh needs a
per-workspace lock so two workers can't double-refresh.

**Account linking (T2, opt-in per agent — `linking: none|optional|required`)**:
bot posts "Connect your account" Block Kit button → Platos-hosted page with single-use
signed nonce (bound to team+user, TTL) → user authenticates via Sign in with Slack OIDC
(`openid profile email`; id_token carries **verified email** + `team_id`/`user_id`
claims) or the agent's own login → binding stored → confirmation DM. NEVER map by
typed email (impersonation; explicitly banned by marketplace guidance).
T1 (auto identity mapping on verified team+user) is already live via the identity
foundation. Lifecycle: member deactivation / tokens_revoked ⇒ bindings invalidated;
ship `/unlink`.

## Marketplace checklist (hard requirements)

- Security review: signing-secret verify everywhere, TLS ≥1.2, `state` mandatory,
  tokens never logged/client-side.
- **Scope minimization with per-scope written justification.** Banned: `identity.*`,
  `admin.*`, `search:read`. Enhanced review: `*:history`, `files:read`.
- Privacy policy (public, no login) with retention duration + deletion process;
  support page with ≤2-business-day response; real landing page; screenshots 1600×1000.
- **AI-specific**: no training on Slack data; **zero-copy** (pull real-time, store only
  metadata); LLM-inaccuracy + paid-plan disclaimers; disclose model/retention/tenancy;
  no consequential autonomous actions without human review; set thread status.
- ≥5 active workspaces before listing. Org-ready (Grid) apps must work in Slack Connect
  channels without cross-org leakage (`is_ext_shared_channel`).

## Build plan

1. **Phase A — App tier core**: PlatosChannelApp/Installation models + OAuth install
   endpoints (`/channels/oauth/:app/install|callback`) + team_id-routed single events URL
   (reuse fast-ack + bridge; add `event_id` dedupe) + uninstall lifecycle + "Add to
   Slack" badge on Connect.
2. **Phase B — AI-Apps surface**: assistant-thread events + setStatus/Title/Prompts +
   streaming replies; mention-bot fallback preserved.
3. **Phase C — Hosted linking**: nonce flow + SIWS OIDC + `linking:` policy knob +
   lifecycle invalidation + `/unlink`.
4. **Phase D — BYO upgrade**: config-token + `apps.manifest.create` ("paste one token,
   Platos builds your app"). Token rotation. Grid org-install support.
5. **Phase E — Listing readiness**: privacy/support/landing content, scope
   justifications, review submission. (Business step; tech from A–D is the prerequisite.)

## Key sources
docs.slack.dev: /authentication/installing-with-oauth · /authentication/using-token-rotation ·
/authentication/sign-in-with-slack · /authentication/binding-accounts-across-services ·
/apis/events-api · /ai/agents · /reference/methods/apps.manifest.create ·
/slack-marketplace/slack-marketplace-app-guidelines-and-requirements ·
/reference/events/{url_verification,app_uninstalled,tokens_revoked,assistant_thread_started}
Field research: Claude-in-Slack (mandatory linking), Linear (hybrid — best UX),
GitHub (`/github signin`), Notion AI (per-user permission mapping).
