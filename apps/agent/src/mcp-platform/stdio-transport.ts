import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-router";
import { RPC_ERRORS } from "./mcp-router";

/** A token-pinned view of the same McpRouter used by HTTP and SSE. */
export interface McpStdioSession {
  handle(request: JsonRpcRequest, abortSignal?: AbortSignal): Promise<JsonRpcResponse>;
}

export interface McpStdioTransportOptions {
  input: Readable;
  session: McpStdioSession;
  /** Abort closes readline and destroys the owned stdin stream. */
  signal?: AbortSignal;
  /** The stdio entrypoint supplies the only function allowed to write stdout. */
  writeProtocolLine(line: string): Promise<void> | void;
}

function errorResponse(
  code: number,
  message: string,
  id: string | number | null = null
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request["jsonrpc"] === "2.0" && typeof request["method"] === "string";
}

/**
 * MCP stdio framing is one JSON-RPC message per line. Requests are processed
 * serially so responses preserve input order and macro/approval state cannot
 * race itself inside one IDE connection.
 */
export async function runMcpStdioTransport(options: McpStdioTransportOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  const requestAbort = new AbortController();
  const cancelInFlight = () => {
    if (!requestAbort.signal.aborted) requestAbort.abort();
  };
  const abortTransport = () => {
    cancelInFlight();
    lines.close();
    if (!options.input.destroyed) options.input.destroy();
  };
  const onInputEnd = () => cancelInFlight();
  const onInputClose = () => cancelInFlight();
  options.input.once("end", onInputEnd);
  options.input.once("close", onInputClose);
  options.signal?.addEventListener("abort", abortTransport, { once: true });
  try {
    if (options.signal?.aborted) abortTransport();
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        await options.writeProtocolLine(
          `${JSON.stringify(errorResponse(RPC_ERRORS.PARSE_ERROR, "invalid JSON"))}\n`
        );
        continue;
      }

      if (!isJsonRpcRequest(parsed)) {
        await options.writeProtocolLine(
          `${JSON.stringify(
            errorResponse(RPC_ERRORS.INVALID_REQUEST, "invalid JSON-RPC 2.0 request")
          )}\n`
        );
        continue;
      }

      const response = await options.session.handle(parsed, requestAbort.signal);
      // JSON-RPC notifications have no id and MUST NOT produce a response.
      if (parsed.id === undefined) continue;
      await options.writeProtocolLine(`${JSON.stringify(response)}\n`);
    }
  } finally {
    options.input.off("end", onInputEnd);
    options.input.off("close", onInputClose);
    options.signal?.removeEventListener("abort", abortTransport);
    lines.close();
  }
}
