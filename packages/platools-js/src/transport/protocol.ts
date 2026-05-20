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

export type PlatformToSdk = ToolCallMessage | HeartbeatAckMessage | WelcomeMessage;

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
    default:
      return null;
  }
}

/** Serialize an SDK → Platform message to a JSON string. */
export function encodeSdkMessage(message: SdkToPlatform): string {
  return JSON.stringify(message);
}
