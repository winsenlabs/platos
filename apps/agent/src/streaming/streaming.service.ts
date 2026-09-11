import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import type { AgentStreamEvent } from "../agent-runtime/agent.service";

/**
 * StreamingService — handles SSE streaming for HTTP fallback.
 *
 * Primary streaming is WebSocket (ConnectionsGateway).
 * SSE is the fallback for environments without WebSocket.
 *
 * SSE format:
 *   id: {sequence}
 *   data: {"type":"token","text":"Hello"}
 *
 *   id: {sequence}
 *   data: {"type":"done"}
 *
 * -----------------------------------------------------------------------------
 * AT MOST ONE TERMINAL FRAME PER STREAM, AND THIS LANE USED TO WRITE TWO.
 *
 * The failure path wrote an `error` frame AND THEN a `done` frame. A client that
 * reads to the end of that stream sees a success marker after a failure marker,
 * so it cannot tell a failed turn from a successful one followed by noise — and
 * the frames are indistinguishable in the other direction too: a `done` is what
 * a COMPLETED turn ends on, so the reader has no rule that separates them.
 *
 * The canonical lane was built not to do this.
 * `apps/core-api/src/transports/ws/streams.controller.ts` writes its terminal
 * frame in ONE function and names this file, by path, as the counter-example:
 * its `sealed` outcome writes nothing precisely because the producer's own
 * terminal frame has already gone out, and a second one "would be the duplicate
 * terminal frame the acceptance forbids". `TERMINAL_FAULTS` in that file omits
 * `sealed`, `disconnected` and `consumer-too-slow` for the same reason.
 *
 * So this lane now holds the same rule, in the shape a relay can hold it:
 *
 *   - the producer's own terminal frame is relayed and NOTHING is added after it;
 *   - a failure mid-stream ends on ONE transport-minted `error` frame;
 *   - a failure AFTER the producer already terminated adds nothing at all, which
 *     is the `sealed` case — the client already has its ending, and a second
 *     frame would contradict an ending it has already acted on.
 *
 * WHAT THIS LANE STILL DOES NOT DO, stated rather than implied. It mints no
 * `done` of its own on the success path: an event stream that ends without one
 * ends TRUNCATED, and that is the producer's contract, not this relay's. It also
 * carries no resume cursor — `_seq` counts frames on this connection, so a
 * reconnecting client cannot ask for what it missed. Both are properties of the
 * legacy lane that the canonical one exists to replace; neither is made worse
 * here, and neither is fixed here.
 */
@Injectable()
export class StreamingService {
  /**
   * The event types that END a turn. Read by `streamToSSE` to decide whether the
   * producer has already terminated the stream, which is the whole difference
   * between a missing ending and a duplicated one.
   *
   * A SET AND NOT A PAIR OF STRING COMPARISONS: the two names appear once each,
   * so a third terminal type cannot be added to `AgentStreamEvent` and honoured
   * in one branch but not the other.
   */
  private static readonly TERMINAL_EVENT_TYPES: ReadonlySet<AgentStreamEvent["type"]> = new Set<
    AgentStreamEvent["type"]
  >(["done", "error"]);

  /**
   * Stream agent events as SSE to an HTTP response.
   */
  async streamToSSE(
    events: AsyncGenerator<AgentStreamEvent>,
    res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let seq = 0;
    let terminated = false;

    try {
      for await (const event of events) {
        seq++;
        const data = JSON.stringify({ ...event, _seq: seq });
        res.write(`id: ${seq}\ndata: ${data}\n\n`);
        if (StreamingService.TERMINAL_EVENT_TYPES.has(event.type)) terminated = true;
      }
    } catch (error) {
      // THE `sealed` CASE. The producer already put its own terminal frame on
      // the wire and then threw — the generator's cleanup failing, say. The
      // client has its ending; a second frame here would contradict it.
      if (!terminated) {
        seq++;
        const errorMsg = error instanceof Error ? error.message : "Stream error";
        res.write(
          `id: ${seq}\ndata: ${JSON.stringify({ type: "error", message: errorMsg, _seq: seq })}\n\n`,
        );
      }
    } finally {
      res.end();
    }
  }

  /**
   * Format an agent event as an SSE string.
   */
  formatSSE(event: AgentStreamEvent, seq: number): string {
    const data = JSON.stringify({ ...event, _seq: seq });
    return `id: ${seq}\ndata: ${data}\n\n`;
  }
}
