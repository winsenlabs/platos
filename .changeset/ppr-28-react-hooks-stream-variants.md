---
"@platos/react-hooks": patch
---

PPR-28: Extend `AgentStreamEvent` union in `@platos/react-hooks` to match the agent's emit contract. Adds the `structured_output` variant (Theme F.5 — carries the validated `object` + `attempts` after enforcement succeeds) and extends the `error` variant with the structured-output failure fields (`code: "structured_output_invalid"`, `validationErrors`, `attempts`). Consumer apps narrowing with `isAgentEvent(ev, "structured_output")` now typecheck. `message_boundary` was already present.
