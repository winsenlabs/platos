/**
 * Wire protocol for SDK ↔ Platform WebSocket messages.
 *
 * Every message has a literal `type` discriminator so both sides
 * can decode safely with a narrow switch. This mirrors
 * `platools/transport/protocol.py` — field names and types are byte
 * compatible so the platform's router doesn't care which SDK
 * produced the payload.
 */

import type { JsonSchema } from "../types.js";

/** A single tool schema sent during registration. */
export interface ToolSchemaPayload {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  readonly output_schema: JsonSchema | null;
  readonly auth: string;
  readonly roles: readonly string[];
  readonly annotations: Readonly<Record<string, unknown>>;
}

// ----- SDK → Platform -------------------------------------------------

export interface ToolRegisterMessage {
  readonly type: "tool_register";
  /** Complete current declaration; omitted tools are pruned by the platform. */
  readonly tools: readonly ToolSchemaPayload[];
}

export interface ToolResultMessage {
  readonly type: "tool_result";
  readonly call_id: string;
  readonly result: unknown;
  readonly latency_ms: number;
}

export interface ToolErrorMessage {
  readonly type: "tool_error";
  readonly call_id: string;
  readonly error: string;
  readonly traceback?: string;
}

export type ToolHealthStatus = "healthy" | "degraded" | "down";

export interface ToolHealthEntry {
  readonly status: ToolHealthStatus;
  readonly avg_latency_ms: number;
  readonly error_count_1h: number;
  readonly last_error?: string;
}

export interface HeartbeatMessage {
  readonly type: "heartbeat";
  readonly tools_health: Readonly<Record<string, ToolHealthEntry>>;
}

export type SdkToPlatform =
  | ToolRegisterMessage
  | ToolResultMessage
  | ToolErrorMessage
  | HeartbeatMessage;

// ----- Platform → SDK -------------------------------------------------

export interface ToolCallMessage {
  readonly type: "tool_call";
  readonly call_id: string;
  readonly tool_name: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface HeartbeatAckMessage {
  readonly type: "heartbeat_ack";
}

export interface WelcomeMessage {
  readonly type: "welcome";
  readonly sdk_connection_id: string;
  /**
   * Canonical organization id. The server emits `organization_id`;
   * older SDKs (< 0.2.1) only decoded `org_id`. The decoder accepts
   * either shape, exposes the canonical name here, and back-fills
   * `org_id` for any consumer that still reads the legacy field.
   */
  readonly organization_id: string;
  /** @deprecated alias for `organization_id` — preserved for v0.2.x consumers. */
  readonly org_id: string;
  readonly entity_id?: string;
  readonly environment_id?: string;
  readonly project_id?: string;
}

/**
 * Acknowledgement for a `tool_register` batch. The platform sends this on every
 * successful registration, which means it lands immediately after connect — a
 * decoder that does not know it warns "malformed message" on every session.
 */
export interface ToolsRegisteredMessage {
  readonly type: "tools_registered";
  readonly entity_id?: string;
  readonly environment_id?: string;
  readonly count?: number;
  readonly new_tools?: readonly string[];
  /** Number of mappings removed because they were absent from this declaration. */
  readonly pruned?: number;
}

/** Registration rate limit hit; retry after the supplied delay. */
export interface RegisterThrottledMessage {
  readonly type: "register_throttled";
  readonly error: string;
  readonly retry_after_ms?: number;
}

/** Health transition for a registered tool, pushed by the platform. */
export interface ToolHealthAlertMessage {
  readonly type: "tool_health_alert";
  readonly tool: string;
  readonly status: string;
  readonly details?: unknown;
}

/** Terminal protocol error — the platform closes the socket after sending it. */
export interface PlatformErrorMessage {
  readonly type: "error";
  readonly error: string;
}

export type PlatformToSdk =
  | ToolCallMessage
  | HeartbeatAckMessage
  | WelcomeMessage
  | ToolsRegisteredMessage
  | RegisterThrottledMessage
  | ToolHealthAlertMessage
  | PlatformErrorMessage;

/**
 * Decode a raw JSON string into a `PlatformToSdk` message.
 *
 * Returns `null` if the payload is malformed or the discriminator
 * is unknown — the transport logs these at warn level and continues
 * the read loop, matching the Python SDK's swallow-and-log
 * behavior.
 */
export function decodePlatformMessage(raw: string): PlatformToSdk | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  switch (type) {
    case "tool_call":
      if (
        typeof record.call_id !== "string" ||
        typeof record.tool_name !== "string" ||
        record.params === null ||
        typeof record.params !== "object"
      ) {
        return null;
      }
      return {
        type: "tool_call",
        call_id: record.call_id,
        tool_name: record.tool_name,
        params: record.params as Record<string, unknown>,
      };
    case "heartbeat_ack":
      return { type: "heartbeat_ack" };
    case "welcome": {
      const orgId =
        typeof record.organization_id === "string"
          ? record.organization_id
          : typeof record.org_id === "string"
            ? record.org_id
            : null;
      if (typeof record.sdk_connection_id !== "string" || orgId === null) {
        return null;
      }
      const welcome: WelcomeMessage = {
        type: "welcome",
        sdk_connection_id: record.sdk_connection_id,
        organization_id: orgId,
        org_id: orgId,
        ...(typeof record.entity_id === "string"
          ? { entity_id: record.entity_id }
          : {}),
        ...(typeof record.environment_id === "string"
          ? { environment_id: record.environment_id }
          : {}),
        ...(typeof record.project_id === "string"
          ? { project_id: record.project_id }
          : {}),
      };
      return welcome;
    }
    case "tools_registered":
      return {
        type: "tools_registered",
        ...(typeof record.entity_id === "string" ? { entity_id: record.entity_id } : {}),
        ...(typeof record.environment_id === "string"
          ? { environment_id: record.environment_id }
          : {}),
        ...(typeof record.count === "number" ? { count: record.count } : {}),
        ...(Array.isArray(record.new_tools)
          ? { new_tools: record.new_tools.filter((t): t is string => typeof t === "string") }
          : {}),
        ...(typeof record.pruned === "number" ? { pruned: record.pruned } : {}),
      };
    case "register_throttled":
      if (typeof record.error !== "string") return null;
      return {
        type: "register_throttled",
        error: record.error,
        ...(typeof record.retry_after_ms === "number"
          ? { retry_after_ms: record.retry_after_ms }
          : {}),
      };
    case "tool_health_alert":
      if (typeof record.tool !== "string" || typeof record.status !== "string") return null;
      return {
        type: "tool_health_alert",
        tool: record.tool,
        status: record.status,
        ...(record.details !== undefined ? { details: record.details } : {}),
      };
    case "error":
      if (typeof record.error !== "string") return null;
      return { type: "error", error: record.error };
    default:
      return null;
  }
}

/** Serialize an SDK → Platform message to a JSON string. */
export function encodeSdkMessage(message: SdkToPlatform): string {
  return JSON.stringify(message);
}
