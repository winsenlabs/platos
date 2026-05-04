---
slug: streaming
title: Streaming and WebSocket events
description: Real-time stream of token deltas, tool calls, artifacts, and run updates over WebSocket.
category: dx
order: 110
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "Which event types does Platos emit on a turn?"
  - "How do I consume the stream from a browser?"
  - "What is the early-message buffer and why does it matter?"
  - "How do I reconnect after a dropped WebSocket?"
  - "How do run_update events differ from token deltas?"
  - "Why does my chat client miss some event types?"
related:
  - sdks
  - chat-and-postman
  - tools
source_files_referenced:
  - apps/agent/src/streaming
  - apps/agent/src/connections/connections.gateway.ts
  - apps/agent/src/tool-gateway/tool-sync-ws.service.ts
---

# Streaming and WebSocket events

The streaming surface emits 17 event types over a Socket.IO connection: token deltas, tool call lifecycles, artifact creates, BGO run updates, errors, finishes. The chat panel and `@platos/client` consume the same stream; an event you see in the dashboard is the same event the SDK forwards.

## What it is

Two long-lived connections share the streaming protocol:

- The chat stream connection (`/agents/{agentId}/chat/stream`) streams events for an in-flight turn.
- The connections gateway (`/connections`) streams entity-side events plus tool sync.

Event types include:

- `text-delta`: incremental token output.
- `tool-call-start`, `tool-call-args`, `tool-call-result`, `tool-call-error`.
- `artifact-created`, `artifact-updated`.
- `step-start`, `step-finish`: per-step lifecycle (multi-step turns).
- `memory-write`, `memory-recall-result`.
- `run-update`: from `agent-tool-block.task.ts`; surfaces BGO progress in the chat stream.
- `approval-pending`, `approval-resolved`.
- `error`, `finish`.

`tool-sync-ws.service.ts:130-135, 281-284` carries the load-bearing early-message-buffer invariant. The buffer listener is attached before the async auth handshake; once auth completes, frames are replayed in order. Removing the buffer drops events during the connect race. Do not violate.

## Why it matters

Latency is the difference between "this feels live" and "this feels like a form submit". A turn that takes 3 seconds total but streams the first token at 200ms feels faster than a 1.5-second turn that lands as a single block. The 17-event protocol covers every meaningful state change, so a UI can render rich progress without polling.

The same event stream powers BGO progress. A `run_update` event mid-stream tells the chat panel "the BGO is at 40%"; the user sees a progress bar without a separate WebSocket. This was the PPR-25/26 unification.

## How to use it

### Consume from `@platos/client`

```ts
const stream = await platos.threads.stream({ threadId, message: "Hi" });

for await (const event of stream) {
  switch (event.type) {
    case "text-delta": process.stdout.write(event.delta); break;
    case "tool-call-start": console.log("tool", event.tool); break;
    case "artifact-created": handleArtifact(event); break;
    case "finish": stream.close(); break;
  }
}
```

### Consume from the browser

The `@platos/client` ships a React hook:

```tsx
import { usePlatosStream } from "@platos/client/react";

function Chat({ threadId }: { threadId: string }) {
  const { events, send } = usePlatosStream({ threadId });
  // events is the running event log; render as you wish.
}
```

### Reconnect

The SDK reconnects automatically with exponential backoff. The reconnect resumes from the last event id; events emitted during the disconnect are replayed up to a 30-second buffer. Beyond 30 seconds, the SDK starts a fresh stream and re-fetches the message history.

### Consume from a custom client

Use `socket.io-client` directly:

```ts
const socket = io("https://platos.example.com", {
  path: "/streaming",
  auth: { token: sessionToken },
});

socket.on("text-delta", (e) => console.log(e.delta));
socket.on("finish", () => socket.disconnect());
```

## Common pitfalls

- The early-message-buffer in `tool-sync-ws.service.ts` is the entity-side equivalent. Frames are buffered before auth and replayed after; do not bypass.
- A chat client that only handles `text-delta` and `finish` will miss tool calls, artifacts, BGO updates, approvals. The 17 event types are not optional; handle every one or your users see the agent "stuck" mid-turn.
- The Socket.IO transport prefers WebSocket but falls back to long-polling; on networks with WebSocket inspection, fallback latency increases. Configure `transports: ["websocket"]` if your network allows.
- Event ordering is preserved within a turn but not across turns. Two simultaneous turns on different threads can interleave; switch on `event.threadId` if you multiplex.

## Related

- [SDKs](/docs/sdks): the consumer SDK that wraps the stream.
- [Chat and Postman mode](/docs/chat-and-postman): the dashboard consumer.
- [Tools](/docs/tools): the tool-call event lifecycle plus the early-message buffer.
