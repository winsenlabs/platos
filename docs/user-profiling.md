# User Profiling

Per-agent-per-user key/value memory. Lets an agent remember facts about an individual user across conversations without blowing up the context window. Two meta-tools (`update_user_profile`, `recall_user_profile`), one table, one Redis cache. This doc covers the mental model, data layout, auto-inject, and privacy boundaries.

## Why agent-scoped, not user-scoped?

A support bot should know the user's preferred contact channel. A code-review bot should know their stylistic preferences. A research assistant should know their recent topics of interest.

These facts are **different per agent** and often shouldn't leak between them. Your code-review bot doesn't need to know your support bot's notes. A single cross-agent user profile would either over-share (privacy leak) or under-share (the bot doesn't get the fact it needs).

Platos scopes profiles by `(agentId, userId)`. One user chatting with three agents has three independent profiles. The user can view and edit all three from a settings page, but agents only read their own.

## When to enable it

Enable profiling when:

- The agent has long-lived, persistent relationships with individual users (support bots, personal assistants, dev-tools agents).
- Facts the agent learns early should persist across threads ("I prefer TypeScript over Python", "our repo is github.com/acme/api").
- You don't want to re-prompt the user every session.

Don't enable it when:

- The agent is one-shot (support ticket triage, spam classifier). No persistence is needed.
- Inputs contain sensitive data you don't want durably stored (PII, PHI). Profiling persists to Postgres unencrypted at the value layer — encrypt elsewhere or don't record it.
- The agent is used in single-turn contexts via API. Profiling gives no benefit if there's no continuity.

Enable per-agent in the UI or via SDK:

```ts
await client.agents.update(agentId, {
  // Profiling is opt-in per agent
  autoInjectProfile: true,     // inject snippet into every conversation
  profileMaxKeys: 30,          // hard cap, older keys evicted
});
```

The meta-tools (`update_user_profile`, `recall_user_profile`) are enabled automatically when `autoInjectProfile: true`. You can also add them manually without auto-inject (agent explicitly calls `recall_user_profile` when it needs a fact, vs. having the snippet always injected).

## Data model

One table:

```prisma
model PlatosAgentUserProfile {
  agentId   String
  userId    String
  key       String
  value     String   @db.Text
  updatedAt DateTime @updatedAt

  agent PlatosAgent @relation(fields: [agentId], references: [id], onDelete: Cascade)
  @@id([agentId, userId, key])
}
```

Keys are free-form strings (lowercase kebab-case recommended: `preferred-language`, `home-repo`, `favorite-framework`). Values are free-form text up to 2KB.

Eviction: when `profileMaxKeys` is exceeded, the oldest-updated key is deleted. No silent overwrites of other keys — only the LRU eviction.

## The two meta-tools

### `update_user_profile(key, value)`

The agent writes a fact. Idempotent — calling twice with the same key overwrites.

```
Agent call: update_user_profile({ key: "preferred-language", value: "TypeScript" })
Result:     { ok: true, evicted: null }
```

If eviction kicked in: `{ ok: true, evicted: "some-old-key" }`. The LLM can log that as a notice but there's no action required.

### `recall_user_profile(key?)`

The agent reads a specific fact, or all facts if called with no argument.

```
Agent call: recall_user_profile({ key: "preferred-language" })
Result:     { key: "preferred-language", value: "TypeScript" }

Agent call: recall_user_profile()
Result:     [
  { key: "preferred-language", value: "TypeScript", updatedAt: "..." },
  { key: "home-repo", value: "github.com/acme/api", updatedAt: "..." },
  ...
]
```

Both tools are available to the agent regardless of `autoInjectProfile`. Explicit recall is useful when auto-inject is off (save tokens on every turn) but the agent needs to look something up.

## Auto-inject semantics

When `autoInjectProfile: true`, Platos builds a snippet and injects it into the **dynamic** block of every turn (after the cache breakpoint). The snippet is pre-formatted and cached in Redis (`platos:memory:{agentId}:{userId}`, 5-min TTL):

```
<user_profile>
The user has shared the following facts about themselves with you:
- preferred-language: TypeScript
- home-repo: github.com/acme/api
- timezone: America/Los_Angeles
- test-framework: Vitest
</user_profile>
```

Placement is after compacted summary (if any) and before conversation history. The agent is instructed in its system prompt to trust the profile but verify if the user contradicts it.

Keys are formatted alphabetically to keep the snippet deterministic. Values are truncated to 200 chars per key in the snippet (the full value is still retrievable via `recall_user_profile`).

### Snippet size

Default: max 30 keys × 200 chars = ~6KB, typically 1-2KB with real usage. Tunable via `profileMaxKeys` and `profileSnippetCharLimit`.

### When auto-inject misses

Auto-inject happens once per turn at message-building time. If the agent calls `update_user_profile` mid-turn, the new fact is NOT in the current turn's injected snippet — it'll show up on the next turn. This is fine in practice (agents rarely need to re-read a fact they just wrote), but worth knowing.

## Privacy and scoping

**Agent scoped.** One user × three agents = three separate profiles. Agents cannot read each other's profiles. This is enforced at the DB layer — the service always includes `agentId` in the `WHERE` clause; there's no way to query across agents without admin privileges.

**Tenant scoped.** Profiles live within an org. `PlatosAgent.organizationId` constrains all queries. No cross-tenant read paths exist.

**User visible.** Users can view and delete their profile for any agent in **Settings → Agents → [Agent] → Profile**. Deletes cascade through Redis cache invalidation.

**Right to be forgotten.** A DELETE on the user cascades via Prisma's `onDelete: Cascade` relation from the `users` table through `PlatosAgent` → profiles.

## Tuning tips

- **Start with auto-inject OFF.** Let the agent explicitly call `recall_user_profile` when it needs a fact. Measure how often it does. If it's every turn, flip to auto-inject.
- **Cap `profileMaxKeys`.** 30 is plenty for most agents. Higher caps invite the LLM to "remember" noise — favorite colors, random preferences — that bloat the snippet without helping.
- **Review keys periodically.** Build an admin view that shows most-written keys. If you see `random-fact-1`, `random-fact-2`, the agent is using profiling as a scratch pad; tighten the system prompt.
- **Don't use profiling for large documents.** 2KB per value is the hard cap. For notes/memory, use a proper vector store.
- **Write prompts that encourage laconic keys.** "Store only durable facts that will still be true in 3 months. Don't store conversational context."

## Example prompt fragment

Include this in your system prompt when profiling is enabled:

```
You have access to update_user_profile and recall_user_profile. Use them to
remember durable facts about this specific user — preferences, frequently-
referenced resources (repos, team names, API endpoints), stylistic choices,
timezone.

Rules:
- Only store facts that will still be true in 3 months.
- Never store PII (SSNs, credit cards, addresses).
- Use kebab-case keys: "preferred-language", "on-call-schedule".
- If the user contradicts a stored fact, update it immediately.
- If auto-inject is on, you don't need to recall — the facts are already in
  your context. Only call recall_user_profile if you need details truncated
  in the snippet.
```

## Debugging

Every `update_user_profile` and `recall_user_profile` call shows up as a tool span in the run trace. You can see what the agent wrote, when, and how often it recalls. If an agent seems to "forget" something, check the trace — usually the key was evicted or the value was stored under a slightly different key.

Check the raw table:

```sql
SELECT key, value, updatedAt
FROM "PlatosAgentUserProfile"
WHERE "agentId" = 'agt_...' AND "userId" = 'usr_...'
ORDER BY updatedAt DESC;
```

Clear a profile manually:

```sql
DELETE FROM "PlatosAgentUserProfile"
WHERE "agentId" = 'agt_...' AND "userId" = 'usr_...';
```

Then invalidate the Redis cache:

```
redis-cli DEL "platos:memory:agt_:usr_"
redis-cli DEL "platos:memory:agt_:usr_:keys"
```

## Further reading

- Agent config (where `autoInjectProfile` lives): [writing-agents.md](./writing-agents.md)
- Where the snippet lands in the prompt: [architecture.md](./architecture.md) § Message lifecycle
