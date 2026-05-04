/**
 * Typed client-side mirror of the agent service's streaming protocol.
 *
 * Keep in sync with
 *   apps/agent/src/agent-runtime/agent.service.ts  (AgentStreamEvent)
 *   apps/agent/src/monitoring/safety.service.ts    (SafetyFlag shape)
 *
 * If the agent adds a new event variant, add it here too and cut a
 * minor bump of @platos/react-hooks (changeset required).
 */

export interface AgentTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  costCents?: number;
  /** Legacy aliases carried by the wire protocol. */
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentSafetyFlag {
  type: "pii" | "injection" | "exfiltration";
  severity: "low" | "medium" | "high";
  detail: string;
  matchedText?: string;
}

export type AgentDisplayHint =
  | { kind: "card"; summary: string }
  | { kind: "table"; summary?: string; columns?: string[] }
  | { kind: "code"; language?: string; summary?: string }
  | { kind: "image-ref"; summary?: string; url?: string };

/**
 * Theme F.7 — canonical artifact kinds (matches PLATOS_SPEC §4.2 and
 * `apps/agent/src/agent-runtime/artifact-meta.ts`). Consumers of the
 * stream protocol narrow against this rather than `string` so a
 * `<PlatosArtifact>` renderer (F.8) can exhaustively switch on kind.
 */
export type ArtifactKind =
  | "markdown"
  | "code"
  | "html"
  | "json"
  | "csv"
  | "svg"
  | "image";

/** Theme F.7 — artifact_error codes returned by the agent meta-tools. */
export type ArtifactErrorCode =
  | "invalid_kind"
  | "invalid_content"
  | "not_found"
  | "scope_mismatch"
  | "persist_failed";

export type AgentStreamEvent =
  | {
      type: "status";
      status: "connected" | "thinking" | "executing" | "generating";
      agentId?: string;
    }
  | { type: "meta"; thread_id?: string; agent_id?: string; usage?: AgentTokenUsage }
  | { type: "token"; text: string }
  | { type: "message_boundary" }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      name: string;
      params: Record<string, unknown>;
      callId: string;
    }
  | {
      type: "tool_result";
      name: string;
      result: unknown;
      callId: string;
      display?: AgentDisplayHint;
    }
  | {
      type: "approval_needed";
      approvalId: string;
      action: string;
      details?: string;
      agentId?: string;
    }
  | { type: "safety_flags"; flags: AgentSafetyFlag[] }
  | {
      type: "error";
      message: string;
      /** Populated on input-safety failures. */
      flags?: AgentSafetyFlag[];
      /**
       * Theme F.5 — structured-output failure payload. Present only when the
       * error stems from `StructuredOutputError` so UIs can render the
       * validation errors distinctly from generic runtime failures.
       */
      code?: "structured_output_invalid";
      validationErrors?: string[];
      attempts?: number;
    }
  | {
      /**
       * Theme F.5 — emitted after structured-output enforcement succeeds.
       * Carries the validated JSON object. The streaming path also emits
       * incremental `token` events for the raw JSON text so legacy
       * consumers keep working.
       */
      type: "structured_output";
      object: unknown;
      attempts: number;
    }
  /**
   * Theme F.7 — artifact streaming lifecycle. Emitted by the agent when
   * `generate_artifact` or `revise_artifact` executes inside a turn.
   * Order per call: `artifact_start` → `artifact_delta`* →
   * `artifact_committed` (on success) OR `artifact_error` (on failure).
   */
  | {
      type: "artifact_start";
      artifactId: string;
      artifactKey: string;
      kind: ArtifactKind;
      revision: number;
      title?: string;
      language?: string;
      op: "generate" | "revise";
    }
  | {
      type: "artifact_delta";
      artifactId: string;
      artifactKey: string;
      chunk: string;
    }
  | {
      type: "artifact_committed";
      artifactId: string;
      artifactKey: string;
      kind: ArtifactKind;
      revision: number;
      title?: string;
      language?: string;
      finalContent: string;
      createdAt: string;
    }
  | {
      type: "artifact_error";
      artifactId?: string;
      artifactKey?: string;
      code: ArtifactErrorCode;
      message: string;
    }
  /**
   * PPR-26 — realtime trigger.dev run update forwarded by the agent's
   * RunsBridgeService into the thread + scope Socket.IO rooms. The
   * `spawn_bgo` (formerly `spawn_task` — kept as a deprecated alias)
   * meta-tool hands out the `runId`; a consumer that wants
   * a progress UI filters incoming stream events by `runId`.
   */
  | {
      type: "run_update";
      runId: string;
      status: string;
      metadata?: Record<string, unknown> | null;
      output?: unknown;
      error?: unknown;
    }
  | { type: "done"; usage?: AgentTokenUsage; stopped?: boolean };

/** Narrowing helper: keep only events of a given discriminator. */
export type AgentStreamEventOfType<K extends AgentStreamEvent["type"]> = Extract<
  AgentStreamEvent,
  { type: K }
>;

/** Type guard helper for consumer apps: `if (isAgentEvent(ev, "tool_call")) { ev.callId }`. */
export function isAgentEvent<K extends AgentStreamEvent["type"]>(
  event: AgentStreamEvent,
  kind: K,
): event is AgentStreamEventOfType<K> {
  return event.type === kind;
}
