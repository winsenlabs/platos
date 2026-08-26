---
slug: publish-postman-template
title: Publish a Postman conversation template
description: Save a chat turn as a reusable template that teammates can replay.
category: recipes
order: 100
questions:
  - "How do I save a turn as a template?"
  - "Who can see published templates?"
  - "How do I parameterize a template?"
  - "Can I run a template programmatically?"
related:
  - create-first-agent
---

# Publish a Postman conversation template

Save a useful chat turn as a reusable template anyone on the team can replay.

## The goal

A named template scoped to the project that teammates open and replay against the same agent (or a clone) without retyping prompts or context.

## Steps

1. **Run the chat in Postman mode.**

   Toggle Postman mode in the agent's chat panel. Have the conversation you want to capture.

2. **Save as template.**

   Chat header -> "Save as template". Provide:
   - Name (`refund-flow`).
   - Optional pinned agent version. Pin if you want the replay to always use that version.
   - Optional initial context overrides (`entity_ids`, `user_id`, custom session keys).

   Save.

3. **Find the template.**

   Agent -> Postman templates tab. Templates are scoped to the project; everyone with project access can see them.

4. **Replay.**

   Click "Replay". A fresh chat opens with the seeded messages, the pinned version (if set), and the context overrides. Continue from where the template left off.

## Verify

- The template appears in the Postman templates tab.
- A replay produces a chat that begins with the template's messages.
- Pinned versions are honoured even if the agent has rolled forward since.

## Programmatic replay

```ts
const thread = await platos.platos_call("postman_templates.run", {
  templateId,
  // Override per-Turn:
  sessionContext: { entity_ids: ["acme"] },
});
```

The runtime returns a fresh Thread id and seeds the template's messages. Continue through the documented Thread stream or `@platosdev/client`'s `threads.send()` method.

## Parameters

Use `${variable}` placeholders in template messages. The replay UI prompts for values; the runtime substitutes before dispatch.

## Next steps

- [Run a golden set](/guides/run-golden-set) using representative saved Threads.
- Templates pair well with [Chat and Postman mode](/docs/chat-and-postman) walkthroughs.
