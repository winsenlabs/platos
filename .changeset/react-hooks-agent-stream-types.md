---
"@platos/react-hooks": patch
---

Export typed `AgentStreamEvent` discriminated union from `@platos/react-hooks`. Mirrors the agent service's streaming protocol (status, meta, token, message_boundary, thinking, tool_call, tool_result, approval_needed, safety_flags, error, done) with strong type narrowing via the new `isAgentEvent(event, kind)` helper. Consumer apps can now replace `any`-typed event handlers with a proper discriminated union.
