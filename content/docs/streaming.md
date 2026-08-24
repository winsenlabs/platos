---
slug: streaming
title: Turn streaming
description: Stream text deltas, Tool Calls, Artifacts, and final Turn state.
category: dx
order: 5
questions:
  - "How do I stream an Agent response?"
  - "What happens after a disconnect?"
related:
  - turns
  - conversations-and-threads
  - tools
---

# Turn streaming

A stream is a transport view of one Turn. The committed Turn, Steps, Tool Calls, and Artifacts remain authoritative after the connection closes.

```http
POST /api/v1/agent/threads/{threadId}/stream
Content-Type: application/json

{"input":"Summarize the latest account notes."}
```

Events include Turn status, text deltas, Step boundaries, Tool Call lifecycle, Artifact references, safe errors, and completion. Every event carries a Turn identifier and monotonic sequence so clients can ignore duplicates.

After a disconnect, reconnect to the Thread and read the persisted Turn. Do not reconstruct final state solely from received deltas. Clients may retry the initial request only with the same idempotency key.
