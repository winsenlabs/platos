---
"@platosdev/client": minor
"@platosdev/react-widget": minor
---

Add thumbs up/down message rating to the SDKs.

The backend rating API (`POST/GET/DELETE /messages/:id/rating`, satisfaction
aggregates, MCP `messages.rate`, memory-feedback loop) shipped previously but
was never reachable from the published SDKs, so embedded chat surfaces had no
way to let end users vote.

- `@platosdev/client`: new `client.messages.rate(messageId, "up"|"down", { comment? })`,
  `.unrate(messageId)`, and `.getForMessage(messageId)`. Exports
  `PlatosRatingDirection`, `PlatosMessageRating`, `PlatosMessageRatingState`.
  Added a typed `message_persisted` stream event (carries the server
  `messageId` needed to rate a streamed message).
- `@platosdev/react-widget`: `usePlatosChat` now captures `message_persisted`,
  stamps `serverId` + `rating` onto each `ChatMessage`, and returns a
  `rate(messageId, direction)` callback (optimistic, toggles to clear).
  `<PlatosFab>` renders thumbs up/down on persisted assistant bubbles.
