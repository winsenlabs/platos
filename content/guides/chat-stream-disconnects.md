---
slug: chat-stream-disconnects
title: Chat stream keeps disconnecting
description: Diagnose dropped WebSocket streams from the chat UI or your own SDK consumer.
category: troubleshooting
order: 50
questions:
  - "Why does my chat stream drop every 60 seconds?"
  - "How do I keep the WebSocket alive through a proxy?"
  - "What is the early-message buffer and why does it matter for reconnects?"
  - "How does platools handle reconnect backoff?"
related:
  - trace-a-turn
  - connect-entity-platools-ts
---

# Chat stream keeps disconnecting

The chat panel shows "reconnecting" every minute, or your custom SDK consumer drops without an error. Find the cause.

## The goal

A stable WebSocket that survives long turns and ordinary network blips.

## Steps

1. **Check the proxy timeout.**

   Most "60-second drop" issues are a reverse proxy with a 60-second idle timeout (Nginx default). Raise to at least 5 minutes:

   ```caddyfile
   platos.example.com {
     reverse_proxy webapp:3030 {
       transport http {
         dial_timeout 30s
         response_header_timeout 5m
         read_timeout 5m
         write_timeout 5m
       }
     }
   }
   ```

2. **Use the supported stream method.**

   `threads.send()` is the public streaming method. It already forces the WebSocket transport; it does not expose a consumer-configurable `transports` option:

   ```ts
   const stream = platos.threads.send(threadId, "Continue the report");

   for await (const event of stream) {
     if (event.type === "reconnecting") console.log("stream reconnecting");
   }
   ```

   If a proxy strips WebSocket `Upgrade` headers, fix the proxy; the SDK does not fall back to long polling.

3. **Check the early-message buffer.**

   The race-fix invariant in `tool-sync-ws.service.ts:130-135, 281-284` buffers early messages during the auth handshake. A custom client that bypasses it can drop the first frames after reconnect. If you wrote your own client, mirror the buffer.

4. **Check the SDK reconnect backoff.**

   `@platosdev/client` retries five times by default with delays of 0.5s, 1s, 2s, 4s, and 8s. On reconnect the client sends `resume_stream` for the current Thread and buffers events received by the iterator.

5. **Refresh expiring session tokens.**

   When your backend rotates the consumer's session token, call `platos.setSessionToken(freshToken)` before the next connection. The public stream method does not accept a transport override or a per-stream token.

## Verify

- Long turns (>1 minute) complete without UI flicker.
- The browser's network tab shows the WebSocket as `Upgraded` and persistent.
- A simulated network drop reconnects within 5 seconds.

## Common findings

- Cloudflare or similar in front with default 100-second timeout. Configure WebSocket-friendly timeouts.
- Corporate proxy that strips `Upgrade` headers; transport falls back to long-polling and adds latency.
- A misbehaving load balancer health check that closes the socket on health probe.

## Next steps

- [Trace a single turn](/guides/trace-a-turn) to confirm the turn itself completed engine-side.
- [Connect an entity (TypeScript)](/guides/connect-entity-platools-ts) for the entity-side equivalent of the same patterns.
