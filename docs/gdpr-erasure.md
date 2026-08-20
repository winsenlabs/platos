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
`POST /erasures/:id/retry` requires `{ "externalUserId": "…" }` — once Postgres
has run the canonical row is gone, so the operation cannot re-resolve the
subject from its own record. A retry under legal hold returns `409`.

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

1. **Migration required.** `PlatosErasureOperation` exists in `schema.prisma`;
   generate and apply before use, or every request 500s.
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

## Known gaps

- ClickHouse erasure has not been exercised against a running server: the
  mutate → poll → verify sequence is covered by unit tests only, per the
  standing instruction not to stand ClickHouse up locally.
- The turn-shaped tables (`platos_observability.turns_v1`, `steps_v1`,
  `tool_calls_v1`, `usage_events_v1`) have no writer yet; the executor mutates
  whichever of them a deployment actually has and skips the rest.
- The MinIO client is optional-injected; wire it in `PrivacyModule` before
  relying on object deletion.
