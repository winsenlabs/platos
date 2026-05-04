---
"@platos/react-hooks": patch
---

Theme F.7 — extend `AgentStreamEvent` with four artifact lifecycle variants (`artifact_start`, `artifact_delta`, `artifact_committed`, `artifact_error`) that the agent emits when `generate_artifact` or `revise_artifact` runs during a turn. New `ArtifactKind` and `ArtifactErrorCode` exports so consumer UIs can exhaustively narrow on kind + error code. Backward-compatible: existing narrowing with `isAgentEvent(event, "tool_call")` etc. is unchanged; the new variants are additive.
