---
slug: conversations-and-threads
title: Conversations and threads
description: How a conversation is stored, encrypted, branched, forked, and threaded.
category: platform
order: 100
questions:
  - "What is the difference between a conversation and a thread?"
  - "How do I reply in a sub-thread vs the main conversation?"
  - "How do I fork a conversation?"
  - "What is auto-naming and when does it run?"
  - "How are conversations encrypted at rest?"
  - "How do I edit a message and re-evaluate from that point?"
  - "What does a soft-deleted conversation look like?"
related:
  - chat-and-postman
  - memory
  - encryption-and-secrets
  - traces
---

# Conversations and threads

In Platos, every chat is a thread of messages. A thread can branch (Slack-style sub-threads under a single message), fork (clone the prefix and run a different continuation), and rewind (edit a past message and re-evaluate the agent from that point). Messages are encrypted at rest, attributed to an `authorAgentId`, and tagged so the dashboard can filter, archive, pin, and rename without losing audit history.

## What it is

Two tables, one model:

- `Thread`: the durable conversation container. It owns title, tags, pin and archive state, tenancy ancestry, and Agent or AgentCluster ownership.
- `Turn`: one accepted input and completed Agent response, with AgentVersion, status, content, cost, timing, revisions, Steps, Tool Calls, attachments, and Artifacts.

Threads can be:

- **Sub-threaded** via `threadReplyToId`. A reply with `threadReplyToId: <messageId>` lives in a side panel. The PRA-TC spec defines the semantics; messages can also be cross-posted into the parent stream when the agent decides so.
- **Forked**. `POST /api/v1/agent/threads/:threadId/fork` clones the message prefix into a new thread; both threads share the same conversation summary but evolve independently.
- **Edited**. `POST /api/v1/agent/threads/:threadId/messages/:messageId/edit-and-rerun` mutates the message and replays the agent from that point. The original suffix is dropped.

Auto-naming runs after the first user turn. The `auto-name` background job calls a cheap model with the first three messages and writes a 3-6 word name. You can rename at any time; auto-naming respects manual renames.

Messages are AES-256 encrypted at rest with `PLATOS_MESSAGE_ENCRYPTION_KEY`. The `MessageCryptoService` handles the round-trip; fork and edit both decrypt-then-re-encrypt transparently.

## Why it matters

Conversations are the source of truth for memory extraction, evals, traces, and cost attribution. If they are lossy or unsafe, every downstream system inherits the problem. Platos's invariants:

- Encryption at rest. The dashboard, the audit log, and the export endpoint all read decrypted in-memory; the database carries ciphertext only.
- Audit-stable history. Soft-delete leaves the row but flips a flag; messages stay readable for compliance review.
- Branching without aliasing. A forked thread is a copy, not a reference. The original is untouched.

That set is what lets you ship "let users edit a past prompt and rerun" without exploding cost accounting or losing the receipt of what was originally said.

## How to use it

### Read sub-thread replies

```ts
const replies = await fetch(
  "https://platos.example.com/api/v1/agent/threads/{threadId}/messages/{messageId}/replies",
).then((response) => response.json());
```

Supply the same authorization and scope headers as other generated requests. The generated public route reads replies for a parent message; the current OpenAPI contract does not publish a matching write route.

### Fork a conversation

```ts
const forked = await fetch("https://platos.example.com/api/v1/agent/threads/{threadId}/fork", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ atMessageId }),
});
```

The new thread inherits the prefix up to (and including) `atMessageId`. Memory writes from the forked thread land in the same user scope; the agent does not get amnesia.

### Edit and rerun

```ts
await fetch("https://platos.example.com/api/v1/agent/threads/{threadId}/messages/{messageId}/edit-and-rerun", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newContent: "What about Tuesday?" }),
});
```

The runtime re-encrypts the edited message, drops the suffix, and dispatches a fresh turn. Cost for the dropped suffix stays in the audit row; ratings stay attached to the (now archived) original message id.

### Soft-delete and archive

`DELETE /api/v1/agent/threads/:threadId` flips `archived: true` plus `deletedAt`. Hard delete (admin-scope) cascades to messages, ratings, and any extracted memory rows. Use it for GDPR; otherwise prefer soft-delete.

## Common pitfalls

- Without `PLATOS_MESSAGE_ENCRYPTION_KEY` set to a 32-byte ASCII string, every message read returns `<encrypted>` and every write panics. Boot will exit if the key is missing in non-dev mode.
- The race-fix invariant in `tool-sync-ws.service.ts:130-135, 281-284` applies to streamed messages, not just tool sync. Frames received before auth completes are buffered and replayed; do not bypass.
- Auto-naming uses a cheap model. If your project has no provider key for that model, threads stay un-named until you wire one. The cost shows up in the auto-name lane on the [Costs](/docs/costs) page.
- Forking does not duplicate attachments; both threads reference the same MinIO object. Deleting an attachment from one thread silently breaks it in the other.

## Related

- [Chat and Postman mode](/docs/chat-and-postman): the playground that reads/writes conversations from the dashboard.
- [Memory](/docs/memory): extraction reads thread messages after a turn ends.
- [Encryption and secrets](/docs/encryption-and-secrets): the message-crypto key and rotation policy.
- [Traces](/docs/traces): turn-level tracing keyed off the thread plus message ids.
