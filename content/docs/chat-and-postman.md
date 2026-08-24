---
slug: chat-and-postman
title: Chat and Postman mode
description: The agent chat playground and the Postman-style request console for inspecting tool pipelines.
category: platform
order: 110
questions:
  - "What is Postman mode in the chat panel?"
  - "How do I see which entities a turn touched?"
  - "Can I save a chat turn as a reusable template?"
  - "How do I inspect the prompt that was sent to the model?"
  - "Why is the stop button not working in some chats?"
  - "How do I export a conversation?"
related:
  - conversations-and-threads
  - tools
  - traces
---

# Chat and Postman mode

The chat panel is the agent playground inside the dashboard. It runs a real turn against the live agent (or a selected version) with full streaming, tool inspection, and cost accounting. Postman mode is the same panel pivoted toward debugging: every assembled prompt block, every tool call, every entity round-trip is laid bare.

## What it is

Two views over the same agent endpoint:

- **Chat**: clean conversational UI. Streams tokens, renders artifacts inline, shows tool calls collapsed by default. Best for "does this agent work for my user?" sessions.
- **Postman**: developer mode. Each turn shows the assembled system prompt (per block), the model + provider key chosen, the entity tools matrix at the moment of the turn, the request and response of every tool call, and the per-step cost breakdown.

Both views write into the same thread. A turn started in chat is debuggable in Postman without replay.

## Why it matters

Most "the agent did the wrong thing" debugging needs are answered by seeing the prompt and the tool round-trip, not by reading logs. Postman collapses that into one view per turn so you can compare what the model saw against what you thought it would see.

The save-as-template feature turns a one-off Postman investigation into a regression: a Postman template is a reusable starting point (initial messages, agent version pin, optional context overrides) that anyone on the team can replay.

## How to use it

### Switch to Postman mode

In the chat panel, toggle the mode switch in the header. The right-hand inspector grows; each message gains a "Pipeline" disclosure showing the prompt, tools, and step list.

### See which entities a turn touched

Postman's pipeline view lists every tool call with its `entityId` (or "skill", "meta-tool", "control-plane"). A turn that hit Slack and the calendar shows two entities; an entity-less turn shows none.

### Save a Postman template

After a useful debugging session, click "Save as template" in the chat header. Fill in name, optional pinned agent version, optional initial context overrides. Templates are scoped to the project. Anyone with project access can replay.

### Inspect the assembled prompt

The first item in the pipeline is the assembled system prompt, broken down by block. Hover over a block to see whether it was Layer-1 cached, Layer-2 cached, or rebuilt. See [Prompts](/docs/prompts) for cache layer details.

### Export a conversation

The thread overflow menu has "Export". JSON export includes messages (decrypted), tool calls, costs, and the pinned agent version. CSV export is messages-only for spreadsheet analysis.

## Common pitfalls

- The stop button only cancels turns that have wired an `AbortController`. The runtime exposes one per turn now (post EOBD-26/27/28), but a third-party tool that does not check the abort signal will keep active. The canonical pattern is to wrap the long call inside `if (signal.aborted) throw new AbortedError()` checks; entity-side tools must respect the cancellation hint.
- Postman mode does not redact secrets. If a tool call carries a token in its arguments, it shows up in the pipeline view. Use the safety panel to filter PII before exporting.
- Templates pin the agent version at save time. If you rebase the agent's prompt later, replays use the pinned snapshot, not the latest. Edit the template to track latest if you need it.
- The chat stream uses the streaming endpoint described in [Streaming](/docs/streaming). Disconnects auto-resume, but the UI shows a "reconnecting" banner; do not assume a flaky connection means the turn died.

## Related

- [Conversations and threads](/docs/conversations-and-threads): the underlying thread model the chat panel reads.
- [Tools](/docs/tools): the tool families the pipeline view labels.
- [Traces](/docs/traces): the deeper view into a turn's spans, beyond the Postman pipeline summary.
