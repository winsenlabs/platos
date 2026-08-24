# IDENTITY-CORE hardening — per-user Composio-MCP end-user identity

Status: design (2026-07-23). Branch target: `security-hardening-p4`.
Author-of-record for the resolver contract: this doc. Walle's `finish-setup`
dual-write depends on section **A**; treat the A contract as frozen once merged.

## Problem

`{{endUserId}}` (Composio's `user_id`) is substituted into a
`connectionKind="mcp"` server's URL/headers at dispatch
(`mcpDispatch`, `tool-executor.service.ts:1263`). It must equal the **end
user's EXTERNAL id = the Walle DB user id = the Composio `user_id`**. Today it
resolves to `PlatosEndUser.externalUserId`, which on the Slack path is an
**opaque conversation id** (`slack:<team>:<user>` or the pinned
`channel-app:<installationId>:<threadKey>` person), never the Walle id. Three
gaps break correctness and isolation:

- **A — no external-id adoption (go-live blocker).** There is no way for Walle
  to bind "this Slack person = this Walle user id", and no resolver preference
  for such a binding. `{{endUserId}}` can never become the Composio `user_id`.
- **B — durable drops the identity.** `spawn_job`, `agent_batch`, and
  `spawn_agent` do not carry the resolved end user, so a durable/child tool
  call has no `{{endUserId}}` and fails closed (or, pre-hardening, would have
  borrowed the wrong one).
- **C — shared-thread bleed.** The turn reads `PlatosAgentThread.platosEndUserId`,
  pinned ONCE to the **first author** (`channel-runtime.service.ts:822`). In a
  multi-human Slack thread, author B's Composio tools would run as author A.
  The gate below (a `singleEndUser` thread flag) only helps if the flag is
  actually stamped on the channel-created thread — and today it can't be: the
  channel bindings mint the `PlatosAgentThread` through
  `getOrCreateThread(scope, agentId, undefined)`
  (`channel-runtime.service.ts:822`, `:1449`), and `getOrCreateThread`
  (`conversation.service.ts:1497`, signature `(scope, agentId, threadId?)`)
  calls `createThread(scope, agentId)` with **no opts**. So every new channel
  thread inherits `singleEndUser @default(true)` — the gate would **fail OPEN**
  for exactly the shared threads it exists to close. Closing C therefore
  requires threading a `singleEndUser` opt through this seam (see §C).

Invariant preserved throughout: **unresolved ⇒ structured failure, never a
shared identity.** The existing fail-closed machinery
(`McpCredentialService` throw + `hasResidualEndUserTemplate` residual scan,
`tool-executor.service.ts:1285`) stays the enforcement point; every change
below either feeds it a correct id or feeds it `null`.

---

## Ground truth confirmed in code

- Origin resolver: `resolveOriginEndUserId` (`agent.service.ts:1507-1537`) →
  `thread.platosEndUserId` → `PlatosEndUser.externalUserId`. Per-turn memoized
  by `resolveEndUserOnce` (`agent.service.ts:1747`).
- Second resolver (inbound MCP-as-server): `resolveEndUserIdForScope`
  (`mcp-entity.controller.ts:370`) → `PlatosEndUser.externalUserId` by
  `externalUserId = scope.userId`. Must honour the same rule as A.
- `resolveEndUser` (`conversation.service.ts:345-512`): (a) verified-claim
  anchor → (b) find-or-create by `externalUserId=scope.userId` → (c)
  link-not-merge attach. `link_identity`/`bind` must reuse this model.
- Channel binding calls `resolveEndUser(authorScope)` on **first contact only**
  (`channel-runtime.service.ts:833`, `:1460`); the returned id is stored on
  `PlatosChannelAppThread.platosEndUserId` — NOT what the turn reads. The turn
  reads the `PlatosAgentThread` pinned via `getOrCreateThread(conversationScope)`
  whose `externalUserId` is the opaque conv id.
- The thread the turn reads is minted at `channel-runtime.service.ts:822`
  (`resolveThreadBinding`, v1) and `:1449` (`resolveAppThreadBinding`, app-tier),
  BOTH via `getOrCreateThread({ ...conversationScope, agentId }, agentId,
  undefined)`. `getOrCreateThread` (`conversation.service.ts:1497`) forwards
  nothing to `createThread` beyond `(scope, agentId)` — the seam that must
  learn to carry `singleEndUser` (§C, G1). Each binding already has the raw
  channel id in hand via `extractPlatformChannelId(threadKey)` (helper at
  `channel-runtime.service.ts:154`).
- Existing identity tools: `end_users.get / link_identity / unlink_identity`
  (`mcp-platform/tools/end-users.ts`), registered via `buildEndUserToolHandlers`
  (`tools/index.ts:769`). `link_identity` is keyed by `platosEndUserId` (the
  cuid) — which Walle does not have; it only has `(channel, handle)` + its own
  user id. This is why A needs a claim-keyed adoption op, not an extension of
  `link_identity`.
- Durable receiver already accepts the id: `/internal/execute-tool` reads
  `body.endUserId` and passes `{ source:"agent_turn", endUserId }`
  (`internal-execute-tool.controller.ts:150,195`). The senders don't send it.

---

## A — externalId resolution + link adoption (the contract Walle depends on)

### A.1 Representation — `linkedExternalId`

Add a nullable scalar to `PlatosEndUser`:

```prisma
/// Adopted EXTERNAL id (e.g. the Walle DB user id = Composio user_id). When
/// set, PREFERRED over externalUserId as {{endUserId}}. Null = fall back to
/// externalUserId (reproduces pre-adoption behaviour exactly).
linkedExternalId String?

@@unique([organizationId, projectId, environmentId, linkedExternalId], map: "platos_end_user_scope_linked_ext_uniq")
```

`@@unique` is scope-scoped; Postgres treats NULLs as distinct, so the many
un-adopted rows coexist freely, while two persons in one scope can never claim
the same Composio `user_id`. The adoption op handles a conflict explicitly
(below) rather than letting Prisma throw.

Migration is additive, no backfill: `NULL` means "use `externalUserId`", i.e.
byte-for-byte today's behaviour for every existing row.

### A.2 Resolver rule (the frozen contract)

```
endUserId = firstNonEmpty(linkedExternalId, externalUserId)   // "" treated as unset
          → if none usable OR thread not single-end-user (see C) → null → fail closed
```

Apply in **both** resolvers:

- `resolveOriginEndUserId` (`agent.service.ts:1524-1533`): `select` gains
  `linkedExternalId`; return `pickExternalId(endUser)` where
  `pickExternalId = r => (r.linkedExternalId?.trim() || r.externalUserId?.trim() || null)`.
- `resolveEndUserIdForScope` (`mcp-entity.controller.ts:374-383`): same
  `select` + same `pickExternalId`.

Extract `pickExternalId` into one small shared helper so the two paths cannot
drift (mirrors how `hasResidualEndUserTemplate` is a single source of truth).

### A.3 Adoption op — `end_users.bind_external_id`

New tool in `end-users.ts` (same file, same trust model, registered in
`tools/index.ts`). Keyed by the **verified claim**, not the cuid — this is what
lets Walle call it with only `(channel, handle, externalId)`.

**Input:** `{ channel, handle, externalId, verified? = true }`
(channel/handle sanitized by the existing `sanitizeChannel`/`sanitizeHandle`;
`externalId` trimmed, 1..256, no control chars — same bounds as
`externalUserId`). NOTE (G5): the `verified` input flag does **not** gate the
anchor — the web-first CREATE path (step 3) always writes `verified:true`
(rationale below). The flag is retained only for wire-compat / future use.

**Algorithm (scope-pinned, one logical unit):**
1. Find the identity row by `(scope, channel, handle)`.
2. **Row exists** (Slack turn happened first) → `person = row.platosEndUserId`.
   Link-not-merge is automatic: we adopt whoever already owns the claim, never
   re-point the CLAIM. (The `linkedExternalId` on that person IS overwritten in
   step 4 — see G4.)
3. **Row absent** (web/finish-setup happened first) → find-or-create a
   `PlatosEndUser` by `externalUserId = "${channel}:${handle}"` (mirrors the
   `authorScope.userId` convention so a later inbound's step-(b) resolves to the
   SAME person), then create the `(channel, handle)` identity row with
   **`verified:true` FORCED** (G5) pointing at it. If a concurrent insert lost
   the race, re-read and adopt the winner (link-not-merge).
   - **Why forced `verified:true` (G5).** A web-first bind must lay down a claim
     that a LATER inbound Slack message can anchor on. `resolveEndUser`
     step-(a) (`conversation.service.ts:388`) only adopts an identity row when
     `hit.verified === true`; a `verified:false` row is ignored, so the inbound
     would fall through to step-(b) find-or-create and could mint a SECOND
     person for the same human. Forcing `verified:true` makes the web-first
     anchor authoritative — the exact trust the frozen contract depends on.
4. Set `person.linkedExternalId = externalId` — **idempotent overwrite (G4)**:
   - If `person.linkedExternalId` is already `externalId` → no-op (return
     `created:false`, unchanged).
   - If `person.linkedExternalId` is unset OR a DIFFERENT value → overwrite it
     with the new `externalId`. This is the deliberate re-bind semantics: a
     second bind of the same `(channel, handle)` to a NEW `externalId`
     **re-links** (moves the Composio identity to the new Walle user id). We do
     NOT reject a re-bind of the same claim.
   - The scoped-unique index still guards CROSS-PERSON collisions: if a
     *different* person in scope already owns this `externalId`, the write is
     rejected → return `{ error: "external_id_conflict", existingPlatosEndUserId }`.
     (Re-binding the SAME person's own claim never trips this, since it targets
     the same row.)
5. Audit via the existing `auditMutation` helper (record old→new
   `linkedExternalId` on a re-link so the move is traceable).

**Output:** `{ ok:true, platosEndUserId, externalId, created }` (`created` =
whether a new person/identity row was minted in step 3; a pure re-bind of an
existing person returns `created:false`).

**Why a verified claim may anchor here:** the caller holds a scoped MCP token
(same `(org,project,env)` trust boundary the channel runtime asserts verified
slack claims under). This is the same trust level, not a new one — documented
inline against the identity-squatting note (`conversation.service.ts:381-387`).

### A.4 Ordering — both races resolved WITHOUT re-pointing or duplicating

| Order | State before `bind_external_id` | Result |
| --- | --- | --- |
| Slack first, then web link | person P owns `slack:team:user` | find row → set `P.linkedExternalId = walleId` |
| Web link first, then Slack | no identity row | create person + **forced-verified** slack identity + set `linkedExternalId`; the later inbound's `resolveEndUser` step-(a) resolves to that same person (anchor works BECAUSE the row is `verified:true`, G5) |
| Returning user, new DM | `slack:team:user` already owned by P (from a prior DM) | new thread's `resolveEndUser` step-(a) collapses onto P; adoption already set `P.linkedExternalId` → both DMs return `walleId` |
| **Re-bind** same claim to a NEW `externalId` | P owns `slack:team:user`, `P.linkedExternalId = walleId_old` | **overwrite** → `P.linkedExternalId = walleId_new` (G4 idempotent overwrite: moves the Composio identity). Identical re-call (same `externalId`) is a no-op. |

**Walle finish-setup contract (freeze this):**
```
end_users.bind_external_id({
  channel:   "slack",
  handle:    "<teamId>:<slackUserId>",   // team-qualified, matches channel-runtime handle
  externalId:"<walleUserId>",            // = Composio user_id
  verified:  true
})
```

**Frozen-contract semantics (baked; re-bind + anchor marked *pending Tejas
confirm*):**
- **Signature** — `bind_external_id({ channel, handle, externalId, verified? })`,
  keyed by the verified `(channel, handle)` claim (NOT the cuid). Frozen.
- **Resolver value** — `{{endUserId}} = firstNonEmpty(linkedExternalId,
  externalUserId)`; unresolved ⇒ `null` ⇒ fail closed. Frozen.
- **Re-bind = idempotent overwrite (G4, *pending Tejas confirm*).** Same
  `(channel, handle)` → new `externalId` re-links; identical re-call is a
  no-op; cross-person `externalId` clash ⇒ `external_id_conflict`.
- **Web-first anchor = forced `verified:true` (G5, *pending Tejas confirm*).**
  The CREATE path always writes a verified claim so a later inbound can anchor
  on it; the `verified` input flag cannot downgrade this.

---

## B — endUserId through durable execution

**Principle:** the **parent resolves once** (post-gate, so `null` when C closes
it) and passes the id DOWN. Children never re-resolve from scratch (which could
diverge from the parent's verified-claim person or bypass the C gate).

### B.1 `spawn_job` (single durable tool call)

**Critical seam correction (G2): `spawn_job` hits the LEGACY normalizePayload
branch, which reconstructs a fresh payload object and drops any top-level
`endUserId`.** `_bgoPayload` (`agent.service.ts:2424-2434`) uses the **legacy
top-level shape** (`taskId`, `instruction`, `tools`, `timeout`,
`organizationId`, …, `userId`, `agentId`) — NOT the new `{ tool, scope }` shape.
So in the task, `normalizePayload` (`agent-tool-block.task.ts:92`) takes the
**legacy branch** (`:94`, `if (p.instruction && p.organizationId && …)`), which
**reconstructs a brand-new object** (`:95-110`) with only `tool/params/scope/
origin`. A naively-added top-level `endUserId` on `_bgoPayload` would be
**silently dropped** by that reconstruction. The new-shape branch (`:93`,
`return p`) is NOT the one `spawn_job` reaches.

Fix chain (all four touch points required):
- Handler (`agent.service.ts:2424`, building `_bgoPayload`): resolve
  `const endUserId = await this.resolveOriginEndUserId(scope)` (post-gate, so
  `null` when C closes it) and add top-level `endUserId` to `_bgoPayload`.
- `AgentToolBlockPayload` (`agent-tool-block.task.ts:67-75`, legacy-fields
  block): add top-level `endUserId?: string` alongside the other legacy fields.
- `normalizePayload` **legacy branch** (`agent-tool-block.task.ts:95-110`): the
  returned reconstructed object MUST carry `endUserId: p.endUserId` (this is the
  line that today drops it — the whole point of G2). Add it to the returned
  shape. (The new-shape branch at `:93` returns `p` verbatim, so a top-level
  `endUserId` already survives there — but `spawn_job` doesn't use that branch.)
- Task body (`agent-tool-block.task.ts:165-182`): destructure `endUserId` from
  `normalized` (alongside `tool, params, scope, origin` at `:138`) and add
  `endUserId` to the HMAC-covered `body`.
- Receiver: `/internal/execute-tool` already reads `body.endUserId`
  (`internal-execute-tool.controller.ts:150,195`). No change. Threading the id
  explicitly is exactly right: the legacy bgo payload's `origin.threadId=""`
  means server-side re-resolution can't work anyway.

### B.2 `spawn_agent` / subagent (full child turn) — thread-copy

The child thread is minted by `createThread(childScope, agentId, undefined,
{ parentThreadId })` (`internal-execute-tool.controller.ts:375-380`).
`childScope` carries NO `userIdentities` (`agent.service.ts:2896-2907`), so
`resolveEndUser(childScope)` re-derives by `externalUserId=scope.userId` and can
land on a different person than the parent's verified-claim person.

**Fix in `createThread` (`conversation.service.ts:222-229`):** when
`opts.parentThreadId` is present, **copy** the parent thread's `platosEndUserId`
(and `singleEndUser`, section C) from the scope-pinned parent row and SKIP
`resolveEndUser`. The child now shares the parent's exact (adopted) person.
Robust across the multi-turn subrun loop (each `/internal/subagent-turn` reuses
the same child thread). Isolation intact: scope tuple is still copied 1:1; the
person is inherited, never client-chosen. Fail-closed: a null parent
`platosEndUserId` yields a null child → downstream fails closed.

### B.3 `agent_batch` (fresh per-item thread) — server-stamped override

Batch deliberately mints a FRESH thread per item with no `parentThreadId`
(`internal-execute-tool.controller.ts:213-218`), so B.2's thread-copy doesn't
apply. Introduce a **server-only** scope field (analogous to `spawnDepth` —
never read from a client token), added to the `RequestScope` interface
(`scope.guard.ts:125`, next to `spawnDepth`):

```
scope.resolvedEndUserId?: string | null
```

**Fail-OPEN hazard this closes (G3).** `resolveOriginEndUserId` short-circuits
on `scope.resolvedEndUserId !== undefined`. If the override is ever left
`undefined` on a batch item, resolution falls through to the **thread-based
path**, which reads the FRESH per-item thread — a thread `resolveEndUser`
find-or-created by `externalUserId = scope.userId`, i.e. a LIVE person that may
carry a `linkedExternalId`. So a parent that gated **closed** (`endUserId ===
null`) could have its batch item silently resolve a real `walleId` and run
Composio as that user. The fix is a strict explicit-null contract end to end:

- **Contract:** the parent ALWAYS sends `endUserId` **explicitly** as
  `string | null` (never `undefined`); every hop preserves the key even when
  its value is `null`.
- `resolveOriginEndUserId`: keep the `scope.resolvedEndUserId !== undefined`
  short-circuit — return it verbatim (already resolved + C-gated in the parent,
  including a deliberate `null`). Else run the thread-based path.
- `agent_batch` handler (`agent.service.ts:2649-2662`): resolve
  `const endUserId = await this.resolveOriginEndUserId(scope)` (gives
  `string | null`) and add it to `payload` — **always include the key**, even
  when `null`.
- `platos-agent-batch` task (`agent-batch.task.ts:170-192`, per-item `body`):
  forward `endUserId` into the `/internal/batch-turn` HMAC body
  **unconditionally** (include the key when `null`; do NOT drop null keys via
  a conditional spread or `JSON.stringify` omission — a `null` is a signal, not
  an absence).
- `/internal/batch-turn` (`internal-execute-tool.controller.ts:220-292`): add
  `endUserId?: string | null` to the `@Body()` type, and stamp
  `scope.resolvedEndUserId = body.endUserId` **UNCONDITIONALLY** on the rebuilt
  scope (`:250-261`) — including when `null`. Stamping only "if truthy" would
  reopen the hazard: a gated-closed parent (`null`) would leave the field
  `undefined` and fall through to the fresh-thread path.
- **Scope preservation:** the batch-turn scope is REBUILT field-by-field at
  `:250-261` (it does not spread the incoming scope), so `resolvedEndUserId`
  must be added to that literal exactly like `spawnDepth` is stamped on the
  subagent path. `AgentTaskService.executeNonStreamingTurn`
  (`agent-task.service.ts:1532`) then passes this scope straight through to
  `executeStreamingTurn` by reference, so the field survives to the inner
  turn's dispatch — as long as no intermediate step reconstructs the scope and
  omits it. Preserve/copy `resolvedEndUserId` anywhere the scope is rebuilt
  (mirror the treatment of `spawnDepth`).

(The same `resolvedEndUserId` override MAY also be stamped on
`/internal/subagent-turn` as defence-in-depth, but B.2's thread-copy is the
primary mechanism there.)

---

## C — shared-thread identity safety

**Decision: gate `{{endUserId}}` to single-end-user threads (Option B in the
brief). Rejected: per-author resolution at turn time (Option A).**

**Why the gate, not per-author resolution.** Per-author resolution
(`resolveEndUser(turnScope)`) is unsafe here: `turnScope.userId` is the OPAQUE
conversation id (`conversationScope`, `channel-runtime.service.ts:1034`), so a
second author whose slack claim has never been seen would fall through step-(a)
and hit step-(b) find-or-create by `externalUserId = <opaque conv id>` —
**colliding onto author A's pinned person**. Making it safe requires
per-inbound person creation for every author + careful claim-only resolution +
subagent/durable re-plumbing — a large surface for a launch. The gate is a few
lines, provably eliminates cross-user execution, and matches the product:
per-user Composio is a **personal-assistant** feature (DMs / assistant threads /
web sessions), not a shared-channel feature.

**Mechanism.** Add a per-thread flag:

```prisma
// PlatosAgentThread
/// True ⇒ exactly one human owns this thread, so {{endUserId}} may resolve.
/// False ⇒ multi-human (shared channel / group DM): per-user MCP fails closed.
singleEndUser Boolean @default(true)
```

- `createThread` (`conversation.service.ts:162-179`): add
  `singleEndUser?: boolean` to the `opts` object and stamp it on the
  `platosAgentThread.create` data (`:231-254`), default `true`. Web/API/direct
  threads stay `true` (one token = one end user) — no behaviour change.
- **`getOrCreateThread` MUST forward the flag (G1 — the real seam).**
  `getOrCreateThread` (`conversation.service.ts:1497`, signature
  `(scope, agentId, threadId?)`) today calls `createThread(scope, agentId)`
  with **no opts** (`:1507`), so a `singleEndUser` opt on `createThread` never
  reaches a channel-minted thread and the gate fails OPEN. Fix: **add an `opts`
  parameter to `getOrCreateThread`** (`{ singleEndUser?: boolean }`, extensible)
  and forward it to `createThread`. (Alternative, equivalent: have
  `resolveThreadBinding`/`resolveAppThreadBinding` call `createThread`
  directly with opts instead of going through `getOrCreateThread`. Adding the
  opts param is preferred — one seam, no duplicated auto-create logic.)
- **Channel bindings compute `isDmOrAssistant` and pass it (G1).** Both
  `resolveThreadBinding` (`channel-runtime.service.ts:822`) and
  `resolveAppThreadBinding` (`:1449`) call `getOrCreateThread({
  ...conversationScope, agentId }, agentId, undefined)`. Change the third-arg
  `undefined` (threadId) to keep, and add `{ singleEndUser: isDmOrAssistant }`
  as the new opts arg. Compute `isDmOrAssistant` locally from the channel id
  already available via `extractPlatformChannelId(threadKey)` (helper at
  `:154`):
  - **Slack** (app-tier `resolveAppThreadBinding` is Slack channel-apps; and
    the Slack case of v1 `resolveThreadBinding`): `isDmOrAssistant =
    channelId?.startsWith("D") === true`. Group DMs (`"G"`/mpim) and channels
    (`"C"`) ⇒ `false`. (Matches the existing assistant-thread predicate at
    `:1046`, `parsed.channel.startsWith("D")`.)
  - **Non-Slack providers on the v1 `resolveThreadBinding` path (G6):** there is
    NO per-provider DM predicate today, and a `"D"`-prefix test is meaningless
    for non-Slack channel-id schemes. **FAIL CLOSED** — pass
    `singleEndUser: false` for any provider without an explicit DM predicate,
    until a per-provider predicate lands. Rationale: a false-negative (a real DM
    treated as shared) only *withholds* per-user Composio (fails closed, no
    bleed); a false-positive (a shared thread treated as a DM) is a
    cross-user execution bug. Per-provider DM detection is the forward path
    (add a predicate per provider; flip to `true` once it exists).
- `resolveOriginEndUserId`: `select` gains `singleEndUser`; if
  `thread.singleEndUser === false`, return `null` (fail closed) BEFORE reading
  the person. In a 1:1 thread the single (adopted) pinned person IS the one
  human — correct by construction, and composes with A.

**Backfill (data migration, flagged — DECISION: run it).** `@default(true)`
marks EVERY existing row single — wrong for existing multi-human channel
threads. Set `singleEndUser=false` for `PlatosAgentThread`s reachable from a
`PlatosChannelThread`/`PlatosChannelAppThread` whose channel id is **not** a
`"D"` DM (i.e. group DMs and channels), computed via
`extractPlatformChannelId` over the stored `channelThreadKey`. Non-Slack
channel-threads with no DM predicate ⇒ `false` (same fail-closed rule as G6).
Blast radius is low (no per-user Composio is live yet), but the decision is to
run it so no latent bleed exists the day A goes live.

**Future upgrade path (not now).** Option A (true per-author resolution) is what
unlocks per-user Composio in shared channels: run `resolveEndUser(authorScope)`
per inbound so every author has a person, then drive `{{endUserId}}` from the
author's verified claim (never the opaque `externalUserId` fallback). Left as a
follow-up; the gate is forward-compatible (flip specific surfaces to `true` once
per-author resolution lands).

---

## Ordered commit plan

Each commit is independently reviewable; migrations flagged **[MIGRATION]**.

1. **[MIGRATION] `PlatosEndUser.linkedExternalId`** — nullable field + scoped
   `@@unique`. Additive, no backfill. *Verify:* migrate; column present; all
   existing rows `NULL`; app boots.
2. **Resolver prefers `linkedExternalId`** — add `pickExternalId` helper; wire
   into `resolveOriginEndUserId` and `resolveEndUserIdForScope` (empty-string
   guard). *Verify:* unit — `linkedExternalId` set → returned; unset →
   `externalUserId`; both empty → `null`.
3. **`end_users.bind_external_id` tool** — adoption by verified `(channel,
   handle)` claim; find-or-create; **web-first CREATE forces `verified:true`
   (G5)**; set `linkedExternalId` with **idempotent-overwrite re-bind (G4)**;
   `external_id_conflict` only on a DIFFERENT-person unique clash; audited
   (record old→new on re-link); registered in `index.ts`. *Verify:* Slack-first
   sets on existing person; web-first creates person+**verified** identity (a
   later inbound anchors on it); re-bind same claim → `externalId` overwritten,
   `created:false`; identical re-call → no-op; conflicting cross-person
   `externalId` refused; scope-pinned (cross-scope handle → not_found).
4. **[MIGRATION] `PlatosAgentThread.singleEndUser`** — `Boolean @default(true)`.
   *Verify:* migrate; existing rows `true`.
5. **Single-end-user gate (G1 + G6)** — `createThread` gains
   `opts.singleEndUser` (default true) and stamps it; **`getOrCreateThread`
   gains an `opts` param and forwards `{ singleEndUser }` to `createThread`**
   (the seam that today drops it, `conversation.service.ts:1507`); channel
   bindings (`channel-runtime.service.ts:822`, `:1449`) compute
   `isDmOrAssistant` via `extractPlatformChannelId(threadKey).startsWith("D")`
   for Slack and **fail closed (`false`) for non-Slack providers with no DM
   predicate (G6)**, passing it as the new opts arg; `resolveOriginEndUserId`
   returns `null` when `singleEndUser === false`. Include the **[MIGRATION]**
   backfill for existing non-DM channel threads. *Verify:* DM thread resolves an
   id; channel/group-DM thread → `null` → `{{endUserId}}` tool returns "tool
   requires a linked user"; non-Slack channel thread → `null`; residual-scan
   test still green.
6. **B.1 `spawn_job` carries endUserId (G2 — legacy branch)** — handler resolves
   (gated) + adds top-level `endUserId` to `_bgoPayload`; add `endUserId?` to
   `AgentToolBlockPayload` legacy fields **AND to the object the
   `normalizePayload` LEGACY branch returns (`agent-tool-block.task.ts:95-110`,
   the branch spawn_job actually hits)**; task destructures + adds `endUserId`
   to the HMAC body (`:165-182`). *Verify:* bgo from a DM thread → durable
   `execute-tool` receives the id and substitutes; from a channel thread →
   `null` → fails closed. Regression-guard: assert the legacy branch preserves
   `endUserId` (not the new-shape branch).
7. **B.2 subagent thread-copy** — `createThread` copies parent
   `platosEndUserId`+`singleEndUser` when `parentThreadId` present (skips
   `resolveEndUser`). *Verify:* child thread's `platosEndUserId` == parent's;
   multi-turn subrun keeps the parent's id; null parent → child null.
8. **B.3 batch override (G3 — unconditional stamp + scope preservation)** —
   add server-only `scope.resolvedEndUserId?: string | null` to `RequestScope`
   (`scope.guard.ts:125`); `resolveOriginEndUserId` short-circuits to it when
   `!== undefined`; `agent_batch` handler resolves (gated) + adds `endUserId`
   to payload **always (even null)**; `platos-agent-batch` task forwards
   `endUserId` into the batch-turn body **unconditionally (null-preserving)**;
   `/internal/batch-turn` stamps `scope.resolvedEndUserId = body.endUserId`
   **UNCONDITIONALLY** on the rebuilt scope (`:250-261`, like `spawnDepth`).
   *Verify:* batch item's MCP dispatch uses the parent's id; **parent
   gated-closed (`null`) → item fails closed (does NOT fall through to the
   fresh-thread path and resolve a live walleId)**.

---

## Decisions (baked; items 1-2 flagged *pending Tejas confirm*)

These were the open questions; resolved with the recommended defaults and folded
into the sections above. Three carry a *pending Tejas confirm* flag.

1. **verified-anchor trust — YES (*pending Tejas confirm*).** A scoped
   MCP-token caller (Walle) may write a `verified:true` slack claim via
   `bind_external_id`, and the web-first CREATE path **forces** `verified:true`
   (G5) so a later inbound can anchor. Same `(org,project,env)` trust boundary
   the channel runtime already asserts verified slack claims under — same trust
   level, new writer. See §A.3 / §A.4 frozen-contract semantics.
2. **re-bind semantics — idempotent overwrite (G4, *pending Tejas confirm*).**
   A second bind of the same `(channel, handle)` to a NEW `externalId` re-links
   (moves the Composio identity); an identical re-call is a no-op; a
   cross-person clash returns `external_id_conflict`. `linkedExternalId` keeps
   the scoped `@@unique` (NULL-distinct) so two persons can't share one Composio
   `user_id`. See §A.1 / §A.3 step 4.
3. **gate launch surface — DM/assistant + web only.** Group DMs (`"G"`/mpim)
   and channels (`"C"`) fail closed until per-author resolution (Option A)
   lands. Non-Slack providers with no DM predicate also fail closed (G6). See
   §C.
4. **inbound MCP-as-server path — leave UNGATED.** `resolveEndUserIdForScope`
   (`mcp-entity.controller.ts:370`) is NOT gated by `singleEndUser`: a 1:1 MCP
   client session is inherently single-user (one MCP token = one authenticated
   user), so the shared-thread hazard C addresses does not exist there. It still
   honours the A resolver rule (`pickExternalId`, prefers `linkedExternalId`).
5. **backfill — RUN IT.** Set `singleEndUser=false` for existing non-DM channel
   threads now (see §C backfill), rather than accepting default-true. Low blast
   radius today; eliminates a latent bleed the day A goes live.
