---
title: "[POINT-IN-TIME] Ppr 34 Platos Client Mvp"
lifecycle: "POINT-IN-TIME"
"@platos/client": minor
"@platos/react-hooks": patch
---

> **Lifecycle: POINT-IN-TIME.** This is a historical snapshot, not current product acceptance. Verify current truth with executable repository evidence.

PPR-34: Initial release of `@platos/client` — the official JavaScript / TypeScript SDK for Platos. MVP scope (Theme I.1 – I.3): `PlatosClient` construction with session-token or direct-header auth, `agents.list / agents.get`, `threads.create`, `threads.send` (Socket.IO streaming). Full SDK surface (tools, artifacts, skills, memory, evals, observability) lands across the remaining Theme I subtasks.

PPR-26: Extend `AgentStreamEvent` in `@platos/react-hooks` with the `run_update` variant emitted by the agent's RunsBridgeService when forwarding trigger.dev realtime run events into the thread's Socket.IO room. Keeps the server emit contract and the client type in lockstep.
