---
"@platosdev/client": major
---

`createV1Client(...).environmentStreams.read` returns an event stream that
resumes, instead of a promise that could never resolve.

The generated method used to go through the JSON transport, which parsed the
`text/event-stream` body as JSON and threw `SyntaxError` on every valid response;
no request carried `Last-Event-ID`, and the transport's timeout and GET retry
would have re-read a live stream from the start. `scripts/sdk/v1-contract.mjs`
now finds event-stream operations on core-api's own handlers (a handler that
calls the SSE lane's `openEventStream`) and emits them as streaming methods.

`read(environmentId, streamId, options?)` returns a `V1EventStream`: an async
iterable of the frames that were APPLIED, in order. It reads the leading
`stream_meta` event, admits each frame with the kernel's `admitFrame` rule
(dropping redelivered frames, re-reading after a gap), and on a severed or
interrupted stream reconnects with `Last-Event-ID` set to the last applied
frame's cursor, within `maxReconnects`. `lastEventId` and `lastSeq` on the stream
let a later reader resume the same position. `V1Transport` gains `stream()`, and
`V1Operation` gains `responseKind`; `send()` refuses an event-stream operation.

The return type of `read` changed from `Promise<void>` to `V1EventStream`, and a
custom `V1Transport` must now implement `stream`, so this is recorded as a MAJOR.
The Python client (`platos_client`) gains the same reader in the same generation
pass; it has no npm identity, so its intent is recorded here. See "Reading an
event stream" in `docs/sdk-v1-migration.md`.
