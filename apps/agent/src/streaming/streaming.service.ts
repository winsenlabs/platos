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
 */
@Injectable()
export class StreamingService {
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

    try {
      for await (const event of events) {
        seq++;
        const data = JSON.stringify({ ...event, _seq: seq });
        res.write(`id: ${seq}\ndata: ${data}\n\n`);
      }
    } catch (error) {
      seq++;
      const errorMsg = error instanceof Error ? error.message : "Stream error";
      res.write(`id: ${seq}\ndata: ${JSON.stringify({ type: "error", message: errorMsg, _seq: seq })}\n\n`);
      seq++;
      res.write(`id: ${seq}\ndata: ${JSON.stringify({ type: "done", _seq: seq })}\n\n`);
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
