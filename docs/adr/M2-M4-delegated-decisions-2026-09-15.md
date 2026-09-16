# ADR M2/M4 — Founder-Delegated Decisions for the V1 Completion Branch (2026-09-15)

**Status:** **ACCEPTED (founder-delegated), 2026-09-15** · **Supersedes:** nothing · **Feeds:** M2 and M4 completion on the branch `tejas/m2-m4-complete`

> **Immutable evidence.** This ADR is accepted and frozen. Do not edit accepted decisions in place — a later change is recorded in a new, superseding ADR (or an amendment section appended below the decision record) that names the decision it changes by its D-number. The decision record is §7.

**How to cite a decision:** the path of this file plus the D-number, for example `docs/adr/M2-M4-delegated-decisions-2026-09-15.md` D3. D-numbers are stable identifiers: D1 to D24, plus five named decisions (D-COOKIE, D-ADVISORY, D-ZOD, D-DEPLOY-HEADER, D-PUBLISH-CORE), 29 in all. §2 to §6 group them by subject, which is why the numbers are not in order there; §7 lists every one.

---

## 1. Authority and scope

- **Authority.** The founder delegated these decisions on 2026-09-15 ("take all decisions that are towards the goal"). They are binding for the M2/M4 completion branch `tejas/m2-m4-complete`.
- **Not delegated, and still the founder's alone:** merging, tagging, publishing images or packages, deploying anything (including test.platos.dev), and DNS.
- **Standing scope boundary:** M3.1 owns apps/agent `AgentController` and `AgentService`.

Each decision below is stated, then justified from the tree.

## 2. Identity, tenancy, sessions

**D1 — Invitation authorization.**
- Only an ACTIVE member with the role OWNER or ADMIN of the target organization may issue an invitation.
- Any other caller is refused with a distinct code.
- The rule lives in the tenancy application (`issueInvitation`), not in a transport.
- Why: it mirrors the only gate that exists today, the Remix route's `organization.findFirst` over OWNER/ADMIN. The oracle has no rule at all, so none can be ported.

**D3 — Rate limiter unreachable.**
- The composed rate-limit path FAILS CLOSED: `LIMITER_UNAVAILABLE_POLICY = "deny"`.
- Why: its consumers include verify-mfa and enrol-totp, so `allow` means unlimited TOTP guesses while Redis is down. A missing limiter adapter already fails closed.
- Accepted cost: sign-in stops while Redis is unreachable.
- Consequence: differential expectations that encoded the oracle's `allow` must be re-recorded, and must name this decision.

**D4 — Guest principal.**
- A stateless signed guest claim, verified by identity-access.
- `PRINCIPAL_TIERS` stays `["OPERATOR","END_USER"]`.
- Why: the live guest credential is already stateless (`guest-<hex>`, `isGuest`), and widening the enum would move the schema, the ORM register and the mutation ledgers.

**D5 — Minted EndUserSession.**
- Preserve the oracle's behaviour exactly: a signed JWT carrying the same claims, algorithm and key source that `resolveEndUser` trusts today.
- Add a signer port to identity-access for it. `MINTABLE_BEARER_KINDS` gains the end-user session only through that signer.
- Why: the programme's first principle is behavioural parity with the frozen oracle.

**D6 — OAuth authorization server.**
- identity-access owns the OAuth authorization-server use cases.
- `oauth.controller` moves onto them.

**D19 — Sessions survive the cutover.**
- A cookie minted by the legacy Remix code must authenticate through core-api. A forced re-login does NOT count as a permitted cutover.

**D20 — Magic-link email.**
- core-api sends it through the notifier-email adapter.
- A login-capable token is never returned to the BFF.

**D-COOKIE — core-api behind a TLS-terminating proxy.**
- Trust exactly one proxy hop, and only when explicitly configured. The default is off.
- Consume the documented `PLATOS_SECURITY_SESSION_COOKIE_SECURE` / `_NAME` / `_SAME_SITE` settings, which are documented today but read nowhere.
- Once that is proven, remove the interim Set-Cookie strip on the Caddy core host.

## 3. Persistence and security posture

**D2 — AgentEval.criterion.**
- `onDelete: SetNull`, with `criterionId` made nullable, delivered as an expand migration.
- Why: `criterionSnapshot` exists only to outlive its criterion, and the `agentVersion`/`turn` relations on the same model are already SetNull.
- Must be coordinated with retention (M5.6); record the link.

**D9 — Approved secret-response boundaries.**
- Approved as classes: one-time-reveal-by-design, and protocol-required (RFC 6749 §5.1).
- V1 rows are signed off individually; `token-mint.ts:128` is approved.
- Anything outside those classes is a defect.

**D12 — Retry-policy statuses.** Keep the category default, 400.

**D-ADVISORY.**
- The 24 carried/unassessed HIGH advisory dispositions that now include core-api stay carried.
- Assessing them is scheduled work.
- Accepting them into v1 still happens at the founder's merge, as the policy says.

**D-ZOD — Shipped must equal tested.**
- The core-api image must resolve the same dependency versions CI tests against. Today the Slack adapter peers get zod 3 in the image and zod 4 in the lockfile.
- Fix the deploy so the bundle matches the lockfile; do not just record the difference.

## 4. Transports and runtime

**D8 — apps/agent and the kernel.**
- apps/agent MAY import `@platos/kernel` (pure value objects and rules, e.g. `negotiateStreamVersion`).
- It may NOT import adapters or contexts.
- Legacy routes retire by moving to core-api, not by apps/agent composing contexts.

**D7 — Durable runtime supplier.**
- Trigger.dev (and the Trigger Sessions AI SDK) is the initial supplier, behind `@platos/adapter-durable-runtime`, as the project mission states.
- The minimal slice needed to compose `channels` is pulled forward and handed to M3.3 to extend.

**D11 — Cutover.**
- The cutover CODE lands on the branch: core-api routes, Caddy per-route upstreams, and webapp per-route dispatch.
- Taking it to production is the founder's merge and deploy.

**D13 — stdio.**
- stdio is excluded from "external MCP failures are isolated". The live product never dispatches stdio.
- The clause is about remote-http/remote-sse pool isolation.

**D16 — Channel monolith.**
- Strangler: `channel-runtime.service.ts` and `channel-persistence.service.ts` stay live until `channels` is composed and serving; then they retire.

**D21 — MCP body cap in core-api.** Mirror apps/agent: 2 MB, `413 payload_too_large`, enforced before authentication.

**D22 — The react-hooks `@triggerdotdev/source` export condition.** Leave it.

## 5. Scope rulings

**D10 — Channel providers.**
- Discord, then WhatsApp, then Telegram. None is dropped.

**D14 — WIN-267 breadth.**
- Broad reading: every one of the 313 M0.2 REST cells, every mounted controller, and OpenAPI for the whole V1 surface.
- The 152 AgentController cells are carved out as an explicit M3.1 dependency.

**D15 — SDK release automation.**
- Publication from this repository stays forbidden (RELEASE.md, CHANGESETS.md).
- The clause is met by version automation instead: a changeset gate plus a release dry-run.

**D17 — The observability gate binds M4.**
- M4 issues are marked Done only with instrumentation evidence linked.
- Where that evidence depends on M5.3, the issue waits.

**D18 — MCP tools.**
- Retire none by default. The disposition register maps every tool and resource.
- A tool is retired only with evidence that it is dead.

## 6. Housekeeping

**D-DEPLOY-HEADER.**
- Correct the false header of `docker-compose.deploy.yml` and re-baseline its owner-authorization pin to the corrected bytes.
- Why: the header claims to remove every build block; `docs-mcp-bridge` and `core-api` keep theirs.

**D-PUBLISH-CORE.**
- Wire core-api into the protected manual publish flow, gated on a persisted-state tested identity, exactly like the agent image.
- Do not run that flow.

**D23 — Draft PR.**
- Open ONE draft PR from `tejas/m2-m4-complete` to v1, so CI and image builds run.
- No issue id may appear in its title or body.

**D24 — Linear.**
- Corrections and status comments are authorized.
- No issue is marked Done ahead of its tree.

## 7. Decision record (ACCEPTED 2026-09-15, founder-delegated)

| Decision | Section | Decided |
|---|---|---|
| D1 | §2 | Only an ACTIVE OWNER or ADMIN of the target organization issues an invitation; the rule lives in the tenancy application. |
| D2 | §3 | `AgentEval.criterion` becomes `onDelete: SetNull` with a nullable `criterionId`, as an expand migration coordinated with M5.6. |
| D3 | §2 | The composed rate-limit path fails closed (`"deny"`) while the limiter is unreachable. |
| D4 | §2 | The guest principal is a stateless signed claim verified by identity-access; `PRINCIPAL_TIERS` is unchanged. |
| D5 | §2 | The minted EndUserSession preserves the oracle's JWT exactly, through a new identity-access signer port. |
| D6 | §2 | identity-access owns the OAuth authorization-server use cases; `oauth.controller` moves onto them. |
| D7 | §4 | The supplier the project mission names is the initial durable runtime, behind `@platos/adapter-durable-runtime`; the minimal slice for `channels` is pulled forward. |
| D8 | §4 | apps/agent may import `@platos/kernel`, never adapters or contexts. |
| D9 | §3 | Secret-response boundaries are approved as two classes, with V1 rows signed off individually. |
| D10 | §5 | Channel providers land Discord, then WhatsApp, then Telegram; none is dropped. |
| D11 | §4 | The cutover code lands on the branch; production is the founder's merge and deploy. |
| D12 | §3 | Retry-policy statuses keep the category default, 400. |
| D13 | §4 | stdio is excluded from the external-MCP isolation clause. |
| D14 | §5 | The REST breadth reading is broad, with the 152 AgentController cells carved out to M3.1. |
| D15 | §5 | SDK release automation is version automation (changeset gate plus release dry-run); publication stays forbidden. |
| D16 | §4 | The channel monolith retires by strangler once `channels` is composed and serving. |
| D17 | §5 | M4 issues are Done only with instrumentation evidence linked. |
| D18 | §5 | No MCP tool is retired without evidence that it is dead. |
| D19 | §2 | Legacy session cookies authenticate through core-api; a forced re-login is not a permitted cutover. |
| D20 | §2 | core-api sends the magic-link email through notifier-email and never returns a login-capable token to the BFF. |
| D21 | §4 | core-api caps MCP bodies at 2 MB with `413 payload_too_large`, before authentication. |
| D22 | §4 | The react-hooks export condition §4 names stays. |
| D23 | §6 | One draft PR from `tejas/m2-m4-complete` to v1, with no issue id in its title or body. |
| D24 | §6 | Linear corrections and status comments are authorized; nothing is marked Done ahead of its tree. |
| D-COOKIE | §2 | core-api trusts exactly one configured proxy hop and consumes the documented session-cookie settings. |
| D-ADVISORY | §3 | The 24 carried HIGH advisory dispositions stay carried; acceptance happens at the founder's merge. |
| D-ZOD | §3 | The core-api image resolves the dependency versions CI tests against. |
| D-DEPLOY-HEADER | §6 | The false `docker-compose.deploy.yml` header is corrected and its owner-authorization pin re-baselined. |
| D-PUBLISH-CORE | §6 | core-api joins the protected manual publish flow like the agent image; the flow is not run. |
