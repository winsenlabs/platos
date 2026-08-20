# Hard erasure — contract and evidence

Status: **API implemented, migration NOT applied. ClickHouse erasure implemented;
provisioned per deployment.** Read "Deployment prerequisites" before integrating.

## Endpoints

All under `/api/v1/agent/admin/privacy`, on the agent service (port 3100).

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/subjects/:externalUserId/inventory?organizationId=…` | Content-free discovery: counts + scope ids |
| `POST` | `/erasures` | Request an erasure (idempotent) |
| `GET`  | `/erasures/:operationId` | Fetch the receipt |
| `POST` | `/erasures/:operationId/retry` | Re-run unsettled stores only |
| `POST` | `/erasures/resume-due` | Drain the queue for this organization |

## Authentication

`Authorization: Bearer plt_mcp_...`, verified against the hashed control-plane
credential row. The token must be `admin` tier and organization-bound. Ordinary
Platos sessions and static callback secrets **cannot** reach these routes: the
API destroys data irreversibly across four stores, and a session token is the
credential most likely to be sitting in a browser.

## Request / response

```jsonc
// POST /erasures
{ "externalUserId": "walle-user-123",
  "organizationId": "org_…",
  "idempotencyKey": "walle-erasure-…",     // repeat -> existing operation, 200
  "legalHoldPolicyId": null }               // set -> blocked_legal_hold, nothing runs
```

Responds `201` on create, `200` on a repeat, with an `ErasureReceipt`.

`POST /erasures/:id/retry` takes an **optional** `{ "externalUserId": "…" }`.
Supplying it gives the pass the same reach as the original, so its
verifications count for as much. Omitting it resumes from the persisted plan
instead — see "Resuming an unsettled store" below. A retry under legal hold
returns `409`.

## Subject mapping

A person is a `PlatosEndUser`, **not** a `userId`. Resolution matches:

- `PlatosEndUser.externalUserId`
- `PlatosEndUser.linkedExternalId`
- `PlatosEndUserIdentity.handle` (email, phone, Slack id, …)

then expands to every `PlatosEndUser` those touch and every
`(organizationId, projectId, environmentId)` scope they appear in. Rows are then
swept **both** canonically (`platosEndUserId`) and historically (`userId`).

> The previous admin route selected only by denormalized `userId`. Six models
> carry `platosEndUserId` instead, so that route could report success while
> leaving the person reconstructable.

### Tables NOT swept, deliberately

`userId` is two namespaces. On `OrgMember`, `PersonalAccessToken`,
`MfaBackupCode`, `PlatosPAT` and the OAuth tables it means the **Platos
operator**, not the subject. Deleting by `userId` wherever that column appears
would destroy an operator's login, access tokens and MFA recovery codes while
purporting to serve a customer erasure. Subject tables are an explicit
allow-list with a test asserting the two sets never overlap.

## Store behaviour

Execution order is **MinIO → Redis → ClickHouse → Postgres**, and it is
load-bearing:

- **MinIO first.** Object keys live in `PlatosMessageAttachment.storageKey`;
  deleting the rows first destroys the only map to the bytes.
- **Postgres last.** It holds the identifiers every other store is addressed by.

| Store | Behaviour | Verification |
|---|---|---|
| MinIO | Deletes objects by `storageKey` | Re-probes each key; `unknown` if no probe available |
| Redis | Deletes subject keys, **retains** aggregates | Re-checks each deleted key |
| ClickHouse | Mutates the turn-shaped tables + the legacy span projection | Polls `system.mutations` for `is_done`, then re-counts; `not_provisioned` only when absent |
| Postgres | Transactional, children → parents → identity | Counts survivors across threads/memories/audits/end-users |

### Redis key prefix

The client sets `keyPrefix: "platos:"`. `keys()`/`scan()` return **prefixed**
keys and `del()` **re-prefixes**, so passing scan output straight to `del()`
produces `platos:platos:…`, matches nothing, and reports success. Real keys are
`platos:trace:thread:<id>`, `platos:cost:user:<scope>:<userId>:<date>`.

### Retention exceptions

- **Tool-call audits are anonymized, not deleted** (`userId` and
  `platosEndUserId` nulled). They are the record that the erasure happened;
  destroying them removes the proof.
- **`cost:scope:*` and `cost:agent:*` are retained.** Summed float counters with
  no user dimension — one contribution cannot be subtracted, and no personal
  data is present. Reported as `retained`, never silently skipped.

## Write barrier — keeping an erasure erased

Deleting rows is not enough. A session token, a Slack webhook or a durable task
outlives the sweep, and the next write re-creates the subject:
`ConversationService.resolveEndUserRow` finds no identity, mints a fresh
`PlatosEndUser` under a **new uuid**, and re-attaches every handle it was
handed. The receipt cannot see that uuid, so it goes on certifying an erasure
that no longer holds.

So the sweep leaves something behind. `ErasureTombstone` holds one row per
**alias**, written **before** any store executor runs — early enough to close
the mid-sweep window, and early enough that the `PlatosEndUserIdentity` rows
enumerating the aliases still exist, since Postgres is about to delete them.

Consulted at the identity chokepoints, which is where every subject-keyed row
gets its `endUserId`:

| Call site | Aliases checked |
|---|---|
| `ConversationService.resolveEndUserRow` | external, session, and every verified channel claim on the turn |
| `ChannelPersistenceService.resolveVerifiedIdentity` | the inbound channel handle |
| `ChannelPersistenceService.attachVerifiedEmail` | the email being linked |
| `end_users.link_identity` (MCP) | the handle and the target end-user uuid |

Four properties, each load-bearing:

1. **Every alias, not the requested one.** Keyed by `(channel, subject)` and
   sealed from every identity row the subject owns — including rows already
   `disabledAt`, which the sweep deletes too — plus the raw `PlatosEndUser`
   uuid, for asynchronous writers that captured it before the sweep. An erasure
   requested by external id therefore also refuses the subject's Slack handle
   and their email. The **issuer** is deliberately excluded from the key:
   issuer strings differ per write path (`channel:slack` vs
   `channel:slack:<realm>`), so binding to it would leave the other door open.
2. **Content-free.** Rows store `sha256(salt ‖ organizationId ‖ "alias" ‖
   channel ‖ subject)`, never a handle. A register of raw identifiers would
   recreate, in a new table, exactly what the operation destroyed.
3. **Fails closed.** If the lookup cannot run — database unreachable, migration
   not applied — the write is **refused**, not allowed. A failed turn is
   recoverable; a resurrected subject is not.
4. **Bounded.** See the retention rule below.

### Retention rule

A tombstone lives **30 days** from the moment the subject was sealed
(`PLATOS_ERASURE_TOMBSTONE_TTL_DAYS`, floored at 1 day), and expiry is applied
at **read time** so the rule holds whether or not anything sweeps.

30 days is the window that outlives the longest-lived reference that could
still land a write for the erased subject — a live end-user session, an
in-flight durable task, and the 30-day ClickHouse span TTL. Past it nothing
anywhere still points at the subject, and a signup reusing the same handle is a
different person who must not inherit someone else's erasure.

Steady-state size is therefore `(erasures in the last 30 days) × (aliases per
subject)`. Sealing opportunistically purges expired rows, so the table stays
trimmed without depending on a scheduler.

There is no un-seal API. Expiry is the only exit — a "release this subject"
route would be a way to undo an erasure, and it would be reachable by whoever
compromises an admin credential.

## Resuming an unsettled store

A store that did not settle used to be abandoned. The receipt said so honestly
and then nothing looked at the row again: `retryCount` was written and never
read, `canRetry` was written and never called, and the only way to finish an
erasure was for a human to POST the retry route by hand — supplying the subject
id, which by then only they had, because the first pass deleted the identity
row that resolves it.

So every operation now carries a **resume plan**, captured before anything runs
and while Postgres still holds the locators: canonical `PlatosEndUser` ids,
thread ids, scopes, and the object count from the inventory. Those are internal
surrogate keys — after the sweep they address no row and appear in no external
system — which is exactly why they can be kept when the identifier cannot.

Two stores needed the plan more than expected. **Redis** and **ClickHouse** both
discovered their thread ids from Postgres, and Postgres deletes those rows in
the same operation, so a retry scanned for nothing at all: `platos:trace:thread:<id>`
does not disappear because the thread row did. **MinIO** discovers object keys
from `PlatosMessageAttachment.storageKey`, which is deleted too — and its keys
end in the uploader's filename, so they cannot be persisted. The plan's object
count is what lets a later pass tell "the bucket is clean" from "the map is
gone"; the second reports `unknown`, never `verified 0/0`.

### Coverage

| Pass | Coverage | Can certify |
|---|---|---|
| First run, and retry **with** `externalUserId` | `full` | every store |
| Retry/resume **without** it | `locators_only` | MinIO only |

The subject's external id is deliberately not persisted, so a resume driven from
the plan alone cannot address the rows keyed by it: the `__platosAudit` /
`__platosSafety` JSON paths in Postgres, `cost:user:*` and `rl:day:*` in Redis,
`user_id` in ClickHouse. Such a pass deletes over a narrower `WHERE` — and would
then VERIFY over that same narrower `WHERE`, find no survivors, and report a
pass it never earned. That is rounding an unknown up to "gone" from a new
direction, so those verifications are demoted to `unknown` and the operation
stays open until an operator supplies the id.

A retry may also never *soften* an earlier `failed` verification. "We deleted
and it is still there" is evidence; a later pass returning `unknown` has not
refuted it, it has failed to gather any. Only a fresh `passed` clears it.

### Queue

| State | Meaning |
|---|---|
| `resumePlan` | Locators captured before the first executor ran |
| `nextAttemptAt` | When the queue should re-drive it; `null` = settled, held, or exhausted |
| `leaseToken` / `leaseExpiresAt` | Held for one destructive pass, 15 minutes |
| `retryCount` | Attempts so far; drives the backoff |

Backoff doubles from 1 minute to a 6-hour ceiling and is deterministic, not
jittered — these are rare, operator-visible operations, and a predictable
`nextAttemptAt` is one an operator can reason about. After
`PLATOS_ERASURE_MAX_ATTEMPTS` (default 8) the queue stops re-driving; the
receipt, the plan and the retry route all survive.

Every destructive pass runs under a lease, **including the first one**. That is
what makes retry idempotent: two concurrent passes cannot both sweep, and a pass
whose process died leaves an expiring lease the queue reclaims rather than a row
nobody dares touch. It also closes the old crash window — an operation is leased
and due from the moment it is created, so a process that dies mid-sweep no
longer leaves a `PENDING` row indistinguishable from an erasure never started.

`POST /erasures/resume-due` drains everything due for the calling organization.
It is a route rather than a background task because this module schedules
nothing of its own; point a cron, a scheduler or an operator at it.

## Admin audit

Every erasure action lands in `AdminAudit`, which is append-only at the database
level (`reject_admin_audit_mutation`) — so a per-attempt record cannot later be
quietly revised, unlike `stores`, which each pass overwrites wholesale.

| Action | When |
|---|---|
| `privacy.erasure.requested` | Intent, **before** any executor runs |
| `privacy.erasure.finished` | Outcome, after the receipt is persisted |
| `privacy.erasure.refused` | Legal hold, or an idempotency key reused against another subject |
| `privacy.erasure.inventoried` | A subject's footprint was enumerated |

Two records per pass rather than one, because the case that matters is a pass
that dies mid-sweep: the intent record survives it, so "who asked, and when" is
answerable even when the outcome never got written. A failure to write the
intent record **aborts** the erasure — if we cannot record who ordered an
irreversible deletion, we do not perform it — while a failure to write the
outcome is logged, because the destruction already happened and losing the
receipt with it would be worse.

- **Who.** `actorUserId` is the operator who minted the admin credential; the
  credential row id travels in the payload so a rotated token stays traceable.
- **Where.** One row per environment the subject appeared in, so an operator
  reading environment X's admin log sees that data was destroyed in X. Entries
  with no subject scopes — an erasure that resolved nobody, a refusal that never
  reached discovery — are filed against the acting credential's environment,
  which `AdminAudit` requires to be non-null.
- **What.** Per-store status, verification, counts and note; the coverage of the
  pass; and the next scheduled attempt, so churn is visible in the log.
- **Retention class.** Every record names its own rule rather than deferring to
  a policy document: `erasure-evidence` (the receipt, the anonymized tool-call
  audits and this trail, retained indefinitely as the proof) alongside
  `erasure-barrier` (the tombstone register, bounded — see above).

Content-free on the same terms as the receipt: `subjectId` is the salted hash,
and `assertAuditContentFree` scans the **whole** entry rather than a chosen
subset, because an audit payload is assembled from an inventory, an actor and a
set of store outcomes, and a leak would arrive through whichever a later change
touches.

## Receipt statuses

| Status | Meaning |
|---|---|
| `pending` | Created, not started |
| `running` | Stores in flight |
| `blocked_legal_hold` | Nothing ran; `legalHoldPolicyId` set |
| `partial_failure` | A store failed **or** finished unproven |
| `verification_failed` | Data survived, **or** discovery resolved to zero keys |
| `completed` | Every required store settled and verified |

Three rules the state machine enforces:

1. **Unknown is never success.** An in-flight mutation or unconfirmed delete
   keeps the operation open.
2. **Successful deletes are never rolled back.** Restoring data to reach a tidy
   all-or-nothing status would recreate what the subject asked to destroy.
3. **`not_provisioned` is not `verified`.** A store absent from the deployment
   settles the operation but is reported distinctly.

Discovery resolving to **zero** keys is `verification_failed`, not `completed` —
it usually means the subject was resolved by the wrong key.

## Content-free guarantee

`subjectKeyHash` is `sha256(salt ‖ organizationId ‖ externalUserId)` — salted per
deployment and scoped per organization, so the same person is not correlatable
across tenants. Store notes record error **classes**, never messages (messages
routinely embed the identifiers being erased). `assertContentFree` refuses to
persist a receipt containing a subject identifier.

## Deployment prerequisites

1. **Migration required.** `ErasureOperation` and `ErasureTombstone` exist in
   `schema.prisma`; generate and apply before use. `ErasureTombstone`
   especially: the write barrier fails closed, so until the table exists
   **every** identity resolution is refused, not just erased ones.
2. Mint an organization-bound, admin-tier `plt_mcp_` control-plane credential.
3. **`PLATOS_ERASURE_HASH_SALT`** must be set in production and must be independent from authentication credentials.
4. **ClickHouse is optional.** The executor reads `PLATOS_OTEL_CLICKHOUSE_URL`
   (the variable the agent process receives), falling back to `CLICKHOUSE_URL`.
   Unset — as in local/dev, where ClickHouse is deliberately not in compose —
   the store reports `not_provisioned` with every deletion counter pinned to
   zero. Configured but unreachable, unauthorized or schema-drifted reports
   `failed`/`unknown` instead: only true absence settles an operation.
5. **MinIO object deletion requires an attachments client** with
   `deleteObject`/`objectExists`. Without it the store reports
   `not_provisioned` rather than pretending.
6. **Point something at `POST /erasures/resume-due`.** Without it, an operation
   whose store did not settle keeps its resume plan and its schedule but nothing
   acts on them; the retry route still works by hand.

## Known gaps

- ClickHouse erasure has not been exercised against a running server: the
  mutate → poll → verify sequence is covered by unit tests only, per the
  standing instruction not to stand ClickHouse up locally.
- The turn-shaped tables (`platos_observability.turns_v1`, `steps_v1`,
  `tool_calls_v1`, `usage_events_v1`) have no writer yet; the executor mutates
  whichever of them a deployment actually has and skips the rest.
- The MinIO client is optional-injected; wire it in `PrivacyModule` before
  relying on object deletion.
- An operation whose MinIO pass left objects unproven can never reach
  `completed` from the queue alone, and often not at all: Postgres deletes the
  only map to those keys in the same operation, and the keys cannot be persisted
  because they end in the uploader's filename. The honest remedy is a
  bucket-side lifecycle rule; the receipt says `unknown` rather than pretending
  otherwise.
- The queue is drained by an authenticated route, not a scheduler. Nothing in
  this repo calls it yet.
