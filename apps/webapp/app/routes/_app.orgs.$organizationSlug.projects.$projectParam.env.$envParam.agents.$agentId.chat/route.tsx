import {
  BeakerIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  PhotoIcon,
  StopIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction, useFetcher, useNavigate } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { type ThreadArtifact } from "~/components/platos/ArtifactPanel";
import { ChatMessageActions } from "~/components/platos/ChatMessageActions";
import { ChatMessageContent } from "~/components/platos/ChatMessageContent";
import { PlatosArtifact } from "~/components/platos/PlatosArtifact";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { usePostHogTracking } from "~/hooks/usePostHog";
import { Prisma } from "@platos/database";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { env as envServer } from "~/env.server";
import { requireUserId } from "~/services/session.server";
import { mintPlatosSessionToken } from "~/services/platosSessionToken.server";
import { agentConversationPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Chat | Platos" }];

/**
 * EOBD.67 — structured metadata attached to assistant bubbles.
 *
 * The wire protocol emits 17+ stream event variants (see
 * `apps/agent/src/agent-runtime/agent.service.ts::AgentStreamEvent`). The
 * previous chat route handled only 7 and silently dropped the rest. We now
 * surface every variant — either by mutating the in-flight assistant bubble
 * (tokens, tool calls, safety flags, structured output, artifacts) or by
 * rendering an inline stream-event chip (`unknown`, `run_update`, citations,
 * reasoning, `approval_needed`, etc.).
 */
interface StreamChip {
  /** Internal id used for React keys. */
  key: string;
  /** Event type verbatim from the wire protocol. */
  type: string;
  /** Short human-readable label. */
  label: string;
  /** Extra payload to surface in a `<details>` panel. */
  detail?: unknown;
  /** Visual theme — neutral / warn / danger / info / success. */
  tone?: "neutral" | "warn" | "danger" | "info" | "success";
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  toolCalls?: Array<{ type: string; name: string; result?: unknown }>;
  attachments?: Array<{ id: string; name: string; mimeType: string; bytes: number }>;
  /**
   * EOBD.67 — generic stream-event chips rendered under the bubble. Populated
   * by variants we don't inline into the main bubble content: safety flags,
   * structured_output, run_update, citations, reasoning, approvals, and
   * unknown event types.
   */
  chips?: StreamChip[];
  /**
   * EOBD.67 / Theme F.7 — artifacts committed under this bubble. Overlays
   * the per-thread artifacts panel but keeps them inline for quick access.
   */
  artifacts?: ThreadArtifact[];
  /**
   * Internal — true iff this bubble has received ANY content (delta chip,
   * tool call, structured output, chip, artifact, reasoning, etc). Used to
   * drop orphan "Thinking…" placeholders on `done` / `error` with zero
   * landed content (EOBD.72).
   */
  hasLanded?: boolean;
  /**
   * Theme J.1 — current user's thumbs vote on this message (assistant only).
   */
  rating?: 1 | -1 | null;
  /**
   * EOBD.69 — server-assigned id, set via `message_persisted`. Enables
   * fork / edit / retry on the assistant bubble.
   */
  persistedId?: string;
  /** PRA-TC: cached reply count from server. */
  replyCount?: number;
  /** PRA-TC: non-null when this message is itself a sub-thread reply. */
  threadReplyToId?: string | null;
  /** PRA-AC: which cluster agent wrote this message. */
  authorAgentId?: string | null;
}

interface PendingAttachment {
  localId: string;
  attachmentId?: string;
  file: File;
  previewUrl?: string;
  progress: number; // 0-100
  status: "uploading" | "ready" | "error";
  error?: string;
}

const ACCEPTED_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/plain",
  "text/markdown",
];

function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Theme CTX — session-context contract.
 *
 * `PlatosAgentThread.sessionContext` is a per-thread key=value bag (e.g.
 * `{ "user.id": "usr_abc", "tenant.id": "winsen-bridge" }`) consumed by the
 * runtime for prompt substitution, tool-arg auto-injection, envelope
 * forwarding, and tool-matrix routing (via `entity_ids: string[]`).
 *
 * `PlatosAgent.contextMapping` declares WHICH keys play WHICH role. This
 * route exposes the raw JSON to the operator + a derived "which keys inject
 * where" preview so they can type-check their context bag before saving.
 */
type ContextMapping = {
  promptVars?: string[];
  toolArgInjection?: Record<string, string>;
  envelopeKeys?: string[];
  entityIdsKey?: string;
};

type SessionContext = Record<string, unknown>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const agentId = params.agentId!;
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  let agentName = agentId === "default" ? "Default Agent" : agentId;
  try {
    const { isAgentServiceAvailable, getAgent } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const agent = await getAgent(agentId, scope);
      if (agent?.name) agentName = agent.name;
    }
  } catch {
    // Agent service not running
  }

  // CTX.3 — pull contextMapping from the agent (scope-gated) + sessionContext
  // from the active thread (if the URL carries one). Thread scope is checked
  // at the action site; the loader just reads, so failure is benign.
  const url = new URL(request.url);
  const threadIdFromUrl = url.searchParams.get("threadId");

  const [agentRow, threadRow, userRow] = await Promise.all([
    prisma.platosAgent.findFirst({
      where: {
        id: agentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      // PRELAUNCH-A1-8 — pull `model` so the trace panel can resolve the
      // provider-aware cache discount label (90% / 50% / 75%) instead of
      // hard-coding Anthropic's 90%.
      select: { contextMapping: true, modelRoutes: true, enableThreading: true, model: true },
    }),
    threadIdFromUrl
      ? prisma.platosAgentThread.findFirst({
          where: {
            id: threadIdFromUrl,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          select: { sessionContext: true },
        })
      : Promise.resolve(null),
    prisma.user.findFirst({
      where: { id: userId },
      select: { id: true, name: true, displayName: true, email: true },
    }),
  ]);

  const contextMapping = (agentRow?.contextMapping as ContextMapping | null) ?? null;
  const sessionContext = (threadRow?.sessionContext as SessionContext | null) ?? null;

  const sessionToken = mintPlatosSessionToken(scope, 3600);

  // Postman templates — fetch from agent service; non-fatal on failure
  let postmanTemplates: Array<{
    id: string;
    name: string;
    simulateUserId: string;
    sessionContext: unknown;
    isDefault: boolean;
  }> = [];
  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const scopeHeaders = {
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
    };
    if (await isAgentServiceAvailable()) {
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/postman-templates?agentId=${encodeURIComponent(agentId)}`,
        { headers: scopeHeaders, signal: AbortSignal.timeout(3000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { templates: typeof postmanTemplates };
        postmanTemplates = data.templates ?? [];
      }
    }
  } catch {
    // agent unavailable — silently omit templates
  }

  return typedjson({
    agentId,
    agentName,
    userId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    wsUrl: (
      process.env.PLATOS_AGENT_PUBLIC_WS_URL ||
      process.env.PLATOS_AGENT_WS_URL ||
      "http://localhost:3100"
    ).replace(/\/(tools\/sync|socket\.io|agent).*$/, ""),
    // Single-domain deploys serve the agent's Socket.io under a distinct
    // path (e.g. /agent-io/socket.io) so it doesn't collide with the
    // webapp's own /socket.io/. Null → Socket.io uses its default path
    // (the agent-on-its-own-host / subdomain deploy).
    wsPath: process.env.PLATOS_AGENT_WS_PATH || null,
    // apiUrl is sent to the browser — must be the public-facing origin, not
    // the internal container address. Caddy routes /api/v1/agent/* → agent.
    apiUrl: process.env.PLATOS_AGENT_PUBLIC_API_URL || envServer.APP_ORIGIN || "http://localhost:3100",
    attachmentMaxBytes: envServer.PLATOS_ATTACHMENT_MAX_BYTES,
    sessionToken: sessionToken?.token ?? null,
    contextMapping,
    sessionContext,
    postmanTemplates,
    agentModelRoutes: (agentRow?.modelRoutes as any[] | null) ?? null,
    // PRELAUNCH-A1-8 — surface the agent's model so the trace panel can
    // render a provider-aware cache discount label.
    agentModel: (agentRow?.model as string | null) ?? null,
    enableThreading: agentRow?.enableThreading ?? false,
    currentUser: {
      id: userRow?.id ?? userId,
      name: userRow?.displayName || userRow?.name || userRow?.email || null,
    },
  });
}

/**
 * CTX.3 — playground save-session-context action.
 *
 * Parses the posted raw JSON, validates it's an object-shaped bag, then writes
 * `sessionContext` into the scoped thread row. Scope is double-gated: the
 * `where` clause filters by (threadId, org, project, env) — no cross-tenant
 * writes possible.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return { ok: false as const, error: "project not found" };
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return { ok: false as const, error: "environment not found" };

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");
  const agentId = params.agentId!;

  if (intent === "save-postman-template") {
    const templateName = String(fd.get("templateName") || "").trim();
    const simUserId = String(fd.get("simulateUserId") || "").trim();
    const rawCtx = String(fd.get("sessionContext") || "{}").trim();
    if (!templateName) return { ok: false as const, error: "Template name required" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawCtx);
    } catch {
      return { ok: false as const, error: "Invalid JSON in session context" };
    }
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const tplHeaders = {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": project.organizationId,
      "X-Platos-Project-Id": project.id,
      "X-Platos-Environment-Id": environment.id,
      "X-Platos-User-Id": userId,
    };
    try {
      await fetch(`${AGENT_API_URL}/api/v1/agent/postman-templates`, {
        method: "POST",
        headers: tplHeaders,
        body: JSON.stringify({
          agentId,
          name: templateName,
          simulateUserId: simUserId,
          sessionContext: parsed,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
    return { ok: true as const };
  }

  if (intent !== "save-session-context") {
    return { ok: false as const, error: `unknown intent: ${intent}` };
  }

  const threadId = String(fd.get("threadId") || "").trim();
  if (!threadId) return { ok: false as const, error: "threadId is required" };

  const rawJson = String(fd.get("sessionContext") || "").trim();
  let parsed: unknown;
  try {
    parsed = rawJson.length === 0 ? {} : JSON.parse(rawJson);
  } catch (err) {
    return {
      ok: false as const,
      error: `invalid JSON: ${err instanceof Error ? err.message : "parse failed"}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false as const, error: "sessionContext must be a JSON object" };
  }

  const result = await prisma.platosAgentThread.updateMany({
    where: {
      id: threadId,
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
    },
    data: { sessionContext: parsed as Prisma.InputJsonValue },
  });

  if (result.count === 0) {
    return { ok: false as const, error: "thread not found in this scope" };
  }

  return { ok: true as const, savedAt: new Date().toISOString() };
}

/**
 * EOBD.67 — canonical list of known wire-event types. Anything not in this
 * set renders as `[unknown:<type>]` in a generic chip so dev users can still
 * see (and report) the event.
 */
const KNOWN_EVENT_TYPES = new Set([
  "status",
  "meta",
  "token",
  "delta",
  "message_boundary",
  "thinking",
  "reasoning",
  "tool_call",
  "tool_use",
  "tool_result",
  "approval_needed",
  "approval_requested",
  "approval_resolved",
  "safety_flags",
  "error",
  "structured_output",
  "artifact",
  "artifact_start",
  "artifact_delta",
  "artifact_committed",
  "artifact_error",
  "run_update",
  "turn_in_progress",
  "already_processed",
  "bgo_cap_exceeded",
  "message_persisted",
  "citation",
  "done",
  "trace_request",
  "trace_step",
]);

// EOBD.99 — styled 404 for deleted/missing agents. Anything else (5xx,
// thrown Errors, auth failures) bubbles to the root ErrorBoundary.
export { RouteNotFoundBoundary as ErrorBoundary } from "~/components/platos/RouteNotFoundBoundary";

// ─── Approval Card ──────────────────────────────────────────────────────────
// Replaces the plain chip for approval_needed / approval_requested events.
// Shows the action description + details, then Approve / Reject buttons that
// POST to the agent API's approval resolution endpoint.

function ApprovalCard({
  approvalId,
  action,
  details,
  apiUrl,
  sessionToken,
  organizationId,
  projectId,
  environmentId,
  userId,
}: {
  approvalId: string;
  action: string;
  details?: string;
  apiUrl: string;
  sessionToken: string | null;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}) {
  const [status, setStatus] = useState<"pending" | "approving" | "rejecting" | "approved" | "rejected" | "timed_out" | "error">("pending");
  const [comment, setComment] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [showComment, setShowComment] = useState(false);

  // Listen for resolution events from the chat stream. Covers three paths the
  // local resolve() call can't see: BLPOP timeout on the agent (status =
  // timed_out), resolution by a sibling tab/operator, and resolution by the
  // socket-based approval_response handler. Without this, the spinner can
  // outlive the actual approval state.
  useEffect(() => {
    if (!approvalId) return;
    function onResolved(e: Event) {
      const ce = e as CustomEvent<{ approvalId?: string; status?: string }>;
      if (!ce.detail || ce.detail.approvalId !== approvalId) return;
      const s = ce.detail.status;
      if (s === "approved") setStatus("approved");
      else if (s === "rejected") setStatus("rejected");
      else if (s === "timed_out") {
        setStatus("timed_out");
        setErrorMsg("Approval timed out before a response.");
      }
    }
    window.addEventListener("platos:approval_resolved", onResolved as EventListener);
    return () => window.removeEventListener("platos:approval_resolved", onResolved as EventListener);
  }, [approvalId]);

  const resolve = async (approved: boolean) => {
    setStatus(approved ? "approving" : "rejecting");
    // External requests through Caddy must carry a session token. If the page
    // was rendered before SESSION_SECRET was configured, sessionToken
    // is null and the agent will reject raw scope headers with 401 — surface
    // that explicitly instead of silently 401'ing.
    if (!sessionToken) {
      setErrorMsg(
        "Session token missing. Reload the page; if this persists, ensure SESSION_SECRET is set on the webapp.",
      );
      setStatus("error");
      return;
    }
    // Hard 15s timeout — the BLPOP on the agent side is up to 5 minutes, but
    // the resolve POST itself is cheap. If it hangs the user sees "Approving…"
    // forever; cap the wait so the card always reaches a terminal state.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Platos-Session-Token": sessionToken,
      };
      const res = await fetch(`${apiUrl}/api/v1/agent/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        headers,
        body: JSON.stringify({ approved, comment: comment.trim() || undefined }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(err.error || err.message || `HTTP ${res.status}`);
      }
      setStatus(approved ? "approved" : "rejected");
      if (typeof window !== "undefined" && (window as any).posthog) {
        (window as any).posthog.capture("platos_approval_resolved", { approved, approvalId });
      }
    } catch (e: unknown) {
      const isAbort = (e as any)?.name === "AbortError";
      setErrorMsg(
        isAbort
          ? "Approval request timed out after 15s. The agent may still be reachable; try again or check the approvals dashboard."
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setStatus("error");
    } finally {
      clearTimeout(timer);
    }
  };

  if (status === "approved" || status === "rejected" || status === "timed_out") {
    const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Timed out";
    const cls =
      status === "approved"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
        : status === "rejected"
          ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-300";
    return (
      <div className={`flex items-center gap-2 rounded border px-3 py-2 text-xs ${cls}`}>
        {status === "approved"
          ? <CheckCircleIcon className="size-4 flex-shrink-0" />
          : <XCircleIcon className="size-4 flex-shrink-0" />}
        <span className="font-medium">{label}</span>
        <span className="text-text-dimmed">· {action}</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="mt-0.5 size-2 rounded-full bg-amber-400 flex-shrink-0 animate-pulse" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-amber-300">Approval required</p>
          <p className="text-sm text-text-bright mt-0.5 font-medium">{action}</p>
        </div>
      </div>

      {/* Details */}
      {details && (
        <pre className="text-[11px] text-text-dimmed bg-charcoal-900/60 rounded px-2 py-1.5 whitespace-pre-wrap overflow-x-auto border border-charcoal-700">
          {details}
        </pre>
      )}

      {/* Comment (optional) */}
      {showComment && (
        <div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment…"
            rows={2}
            className="w-full bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 resize-none"
          />
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <p className="text-xs text-rose-400">{errorMsg}</p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={status === "approving" || status === "rejecting"}
          onClick={() => resolve(true)}
          className="flex items-center gap-1.5 rounded bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <CheckCircleIcon className="size-3.5" />
          {status === "approving" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          disabled={status === "approving" || status === "rejecting"}
          onClick={() => resolve(false)}
          className="flex items-center gap-1.5 rounded bg-rose-500/80 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <XCircleIcon className="size-3.5" />
          {status === "rejecting" ? "Rejecting…" : "Reject"}
        </button>
        <button
          type="button"
          onClick={() => setShowComment((v) => !v)}
          className="ml-auto text-xs text-text-dimmed hover:text-text-bright underline"
        >
          {showComment ? "hide comment" : "+ comment"}
        </button>
      </div>
    </div>
  );
}

/**
 * CTX.3 — default session-context bag for a freshly-opened thread with no
 * persisted context yet. Pre-populates user.id + user.name so the runtime
 * has the bare minimum identity for prompt substitution / envelope routing.
 */
function defaultSessionContext(user: {
  id: string;
  name: string | null;
}): SessionContext {
  const ctx: SessionContext = { "user.id": user.id };
  if (user.name) ctx["user.name"] = user.name;
  return ctx;
}

/**
 * CTX.3 — classify every top-level key in the session-context bag against the
 * agent's declared mapping so the operator sees at-a-glance which keys inject
 * where. Returns tuples of (key, role[]) — a single key may play multiple
 * roles (e.g. prompt-var + envelope).
 */
function classifyKeys(
  ctx: SessionContext,
  mapping: ContextMapping | null,
): Array<{ key: string; roles: string[] }> {
  const out: Array<{ key: string; roles: string[] }> = [];
  const promptVars = new Set(mapping?.promptVars ?? []);
  const toolArgInjection = mapping?.toolArgInjection ?? {};
  const envelopeKeys = new Set(mapping?.envelopeKeys ?? []);
  const entityIdsKey = mapping?.entityIdsKey;

  for (const key of Object.keys(ctx)) {
    const roles: string[] = [];
    if (promptVars.has(key)) roles.push("prompt");
    for (const [toolName, ctxKey] of Object.entries(toolArgInjection)) {
      if (ctxKey === key) roles.push(`tool:${toolName}`);
    }
    if (envelopeKeys.has(key)) roles.push("envelope");
    if (entityIdsKey && entityIdsKey === key) roles.push("entity-routing");
    out.push({ key, roles });
  }
  return out;
}

/**
 * CTX.3 — declared mapping keys that are NOT present in the sessionContext.
 * Surfaced as a warning so operators know the agent will silently fall back
 * to the literal placeholder at runtime.
 */
function missingReferences(
  ctx: SessionContext,
  mapping: ContextMapping | null,
): string[] {
  if (!mapping) return [];
  const present = new Set(Object.keys(ctx));
  const missing = new Set<string>();
  for (const k of mapping.promptVars ?? []) if (!present.has(k)) missing.add(k);
  for (const k of Object.values(mapping.toolArgInjection ?? {})) {
    if (typeof k === "string" && !present.has(k)) missing.add(k);
  }
  for (const k of mapping.envelopeKeys ?? []) if (!present.has(k)) missing.add(k);
  if (mapping.entityIdsKey && !present.has(mapping.entityIdsKey)) {
    missing.add(mapping.entityIdsKey);
  }
  return [...missing];
}

export default function AgentChatPage() {
  const {
    agentId,
    agentName,
    userId,
    organizationId,
    projectId,
    environmentId,
    wsUrl,
    wsPath,
    apiUrl,
    attachmentMaxBytes,
    sessionToken,
    contextMapping,
    sessionContext,
    postmanTemplates,
    agentModelRoutes,
    agentModel,
    enableThreading,
    currentUser,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const { capture } = usePostHogTracking();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [selectedModelLabel, setSelectedModelLabel] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // Initialize null on both server and client to avoid SSR/hydration mismatch
  // (#418/#425 storms when window.location.search differs from server render).
  // The threadId query param is read in a useEffect after mount below.
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const tid = params.get("threadId");
    if (tid) setCurrentThreadId(tid);
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<any>(null);
  const msgCounterRef = useRef(0);
  const threadIdRef = useRef<string | null>(null);
  const loadedThreadsRef = useRef<Set<string>>(new Set());
  const attCounterRef = useRef(0);
  /** EOBD.72 — track the currently-streaming assistant bubble id so we can
   *  drop it when `done` / `error` arrives with zero landed content. */
  const currentBotIdRef = useRef<string | null>(null);
  const chipCounterRef = useRef(0);

  /**
   * Graceful rate-limit banner state. Populated when an `error` event with
   * `code: "rate_limit"` arrives over the agent socket. While set, the
   * composer is disabled and an amber banner counts down. Once the timer
   * expires the banner clears and the composer re-enables. The most recent
   * unsent text is preserved in `input` (we never clear `input` on a
   * rate-limit rejection — only on a successful send).
   */
  type RateLimitBanner = {
    scope: "user_per_minute" | "user_per_hour" | "user_per_day" | "org_per_minute" | "org_per_day";
    message: string;
    retryAfterSeconds: number;
    /** Wall-clock ms when the lockout expires (used for the live countdown). */
    expiresAtMs: number;
    /** Limit value reported by the server. Optional. */
    limit?: number;
  };
  const [rateLimit, setRateLimit] = useState<RateLimitBanner | null>(null);
  const [rateLimitRemaining, setRateLimitRemaining] = useState(0);
  /**
   * Client-side throttle. Soft-disable the send button for 1.5s after each
   * send so a user mashing Enter doesn't slam the server limit.
   */
  const lastSentAtRef = useRef<number>(0);
  const [softThrottled, setSoftThrottled] = useState(false);
  /**
   * The text content of the most recent send attempt. On a rate-limit
   * rejection we restore this back into the composer so the user does not
   * have to retype.
   */
  const lastSentTextRef = useRef<string>("");

  // CTX.3 — session-context editor state. `ctxJson` is the raw textarea
  // string (operator-typed, possibly invalid). `ctxParseError` is nulled
  // whenever the bag parses clean on blur.
  const initialCtx =
    sessionContext ??
    defaultSessionContext({ id: currentUser.id, name: currentUser.name });
  const [ctxJson, setCtxJson] = useState<string>(() =>
    JSON.stringify(initialCtx, null, 2),
  );
  const [ctxParseError, setCtxParseError] = useState<string | null>(null);
  const [ctxPanelOpen, setCtxPanelOpen] = useState<boolean>(false);

  // PIFSP-9 Postman mode
  const [postmanMode, setPostmanMode] = useState(false);
  const [postmanUserId, setPostmanUserId] = useState<string>(userId);
  const effectiveUserId = postmanMode ? postmanUserId : userId;
  const lastEffectiveUserIdRef = useRef<string>(effectiveUserId);
  // The reset effect lives AFTER the thread-reply state declarations
  // (around line 800) so all setters are defined when it runs.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const tplFetcher = useFetcher<typeof action>();

  // Inspector panel — collects trace events for the current turn
  // PRA-TC: threading state
  const [activeThreadMessageId, setActiveThreadMessageId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<ChatMessage[]>([]);
  const [threadInput, setThreadInput] = useState("");
  const [isThreadStreaming, setIsThreadStreaming] = useState(false);
  const threadBotIdRef = useRef<string>("thread-bot-0");
  const threadMsgCounterRef = useRef(0);

  // PIFSP-9 follow-up: when the effective userId changes (Postman toggle or
  // simulated user-id edit), the backend scopes thread lookups under the new
  // user. Resuming the prior thread under a different user always misses the
  // WHERE clause, so the agent silently mints a new thread and breaks
  // conversation memory across the toggle. Clear the in-memory thread ref,
  // selected thread, message list, AND thread-reply state so the next send
  // starts cleanly. The thread-reply state matters because activeThreadMessageId
  // points to a specific persisted message id; under the new effective user
  // that target is guaranteed-stale and would cause a backend
  // "Reply parent message not found" error on send.
  useEffect(() => {
    if (lastEffectiveUserIdRef.current !== effectiveUserId) {
      lastEffectiveUserIdRef.current = effectiveUserId;
      threadIdRef.current = null;
      setCurrentThreadId(null);
      setMessages([]);
      setInput("");
      setActiveThreadMessageId(null);
      setThreadMessages([]);
      setIsThreadStreaming(false);
      try {
        const u = new URL(window.location.href);
        if (u.searchParams.has("threadId")) {
          u.searchParams.delete("threadId");
          window.history.replaceState({}, "", u.toString());
        }
      } catch {}
    }
  }, [effectiveUserId]);

  // Clear thread-reply state whenever the active thread changes. Without this,
  // navigating from thread A to thread B with the reply panel still open keeps
  // activeThreadMessageId pointing at a message in A, so the next thread-panel
  // send asks the backend to find that id within thread B and gets rejected.
  const lastThreadIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastThreadIdRef.current !== currentThreadId) {
      lastThreadIdRef.current = currentThreadId;
      setActiveThreadMessageId(null);
      setThreadMessages([]);
      setIsThreadStreaming(false);
    }
  }, [currentThreadId]);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"request" | "steps" | "events">("request");
  const [traceRequest, setTraceRequest] = useState<Record<string, unknown> | null>(null);
  const traceToolNames: string[] = Array.isArray(traceRequest?.toolNames)
    ? (traceRequest!.toolNames as string[])
    : [];
  const [traceSteps, setTraceSteps] = useState<Array<Record<string, unknown>>>([]);
  const [traceEvents, setTraceEvents] = useState<Array<{ type: string; ts: number; data: unknown }>>([]);
  const ctxFetcher = useFetcher<typeof action>();
  const ctxSaveState = ctxFetcher.state;
  const ctxActionData = ctxFetcher.data;

  // Validate the current textarea content on every edit for the preview /
  // warning panes. `parsedCtx` stays null while invalid; the preview falls
  // back to the last-known-good persisted bag.
  const parsedCtx = useMemo<SessionContext | null>(() => {
    try {
      const trimmed = ctxJson.trim();
      if (trimmed.length === 0) return {};
      const v = JSON.parse(trimmed);
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
      return v as SessionContext;
    } catch {
      return null;
    }
  }, [ctxJson]);

  const ctxForPreview = parsedCtx ?? sessionContext ?? initialCtx;
  const classifiedKeys = useMemo(
    () => classifyKeys(ctxForPreview, contextMapping),
    [ctxForPreview, contextMapping],
  );
  const missingRefs = useMemo(
    () => missingReferences(ctxForPreview, contextMapping),
    [ctxForPreview, contextMapping],
  );

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * Rate-limit countdown. Re-evaluates the wall-clock remaining seconds on
   * a 1Hz tick. We bind to `expiresAtMs` (not retryAfterSeconds) so a tab
   * that backgrounds and refocuses still sees the correct remaining value.
   * Day-scope banners do not auto-clear (the wait is too long for a tab
   * to stay open).
   */
  useEffect(() => {
    if (!rateLimit) {
      setRateLimitRemaining(0);
      return;
    }
    const tick = () => {
      const remainingMs = rateLimit.expiresAtMs - Date.now();
      const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
      setRateLimitRemaining(remaining);
      if (remaining <= 0 && rateLimit.scope !== "user_per_day" && rateLimit.scope !== "org_per_day") {
        setRateLimit(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [rateLimit]);

  /**
   * Soft throttle release. Re-enables the send button 1500ms after the last
   * successful send so a user holding Enter eases up to the server limit
   * rather than slamming it on every keystroke.
   */
  useEffect(() => {
    if (!softThrottled) return;
    const id = setTimeout(() => setSoftThrottled(false), 1500);
    return () => clearTimeout(id);
  }, [softThrottled]);

  const loadHistoryFromServer = useCallback(
    async (threadId: string) => {
      try {
        const proxyUrl = `/resources/agent?path=${encodeURIComponent(
          `/api/v1/agent/threads/${threadId}/messages`
        )}&organizationId=${organizationId}&projectId=${projectId}&environmentId=${environmentId}`;
        const res = await fetch(proxyUrl);
        if (!res.ok) return;
        const data = (await res.json()) as { messages?: any[] };
        const mapped: ChatMessage[] = (data.messages || [])
          .filter((m: any) => m.content && (m.role === "user" || m.role === "assistant"))
          .map((m: any) => ({
            id: m.id,
            persistedId: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            hasLanded: true,
            replyCount: m.replyCount ?? 0,
            threadReplyToId: m.threadReplyToId ?? null,
            authorAgentId: m.authorAgentId ?? null,
          }));
        setMessages(mapped);
      } catch {}
    },
    [organizationId, projectId, environmentId]
  );

  useEffect(() => {
    if (!currentThreadId) return;
    threadIdRef.current = currentThreadId;
    if (loadedThreadsRef.current.has(currentThreadId)) return;
    loadedThreadsRef.current.add(currentThreadId);
    socketRef.current?.emit("join_thread", { threadId: currentThreadId });
    if (messages.length === 0) {
      loadHistoryFromServer(currentThreadId);
    }
  }, [currentThreadId, loadHistoryFromServer]);

  /**
   * EOBD.67 — append a stream-event chip under the currently-streaming
   * assistant bubble. `markLanded` flips `hasLanded` so the EOBD.72 drop
   * logic treats this as meaningful content.
   */
  const appendChip = useCallback(
    (chip: Omit<StreamChip, "key">, markLanded = true) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant") return prev;
        const key = `chip-${++chipCounterRef.current}`;
        return [
          ...prev.slice(0, -1),
          {
            ...last,
            chips: [...(last.chips ?? []), { ...chip, key }],
            hasLanded: markLanded ? true : last.hasLanded,
          },
        ];
      });
    },
    []
  );

  const upsertArtifactOnBubble = useCallback(
    (patch: Partial<ThreadArtifact> & { artifactKey: string }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== "assistant") return prev;
        const existing = last.artifacts ?? [];
        const idx = existing.findIndex((a) => a.artifactKey === patch.artifactKey);
        let next: ThreadArtifact[];
        if (idx === -1) {
          const seeded: ThreadArtifact = {
            id: patch.id ?? patch.artifactKey,
            artifactKey: patch.artifactKey,
            revision: patch.revision ?? 1,
            kind: patch.kind ?? "markdown",
            title: patch.title ?? null,
            language: patch.language ?? null,
            content: patch.content ?? "",
            metadata: patch.metadata ?? null,
            createdAt: patch.createdAt ?? new Date().toISOString(),
            revisionCount: 1,
            streaming: patch.streaming,
            error: patch.error,
          };
          next = [...existing, seeded];
        } else {
          const current = existing[idx]!;
          next = [...existing];
          next[idx] = {
            ...current,
            ...patch,
            metadata: patch.metadata ?? current.metadata,
            revisionCount:
              patch.revision !== undefined && patch.revision > current.revision
                ? (current.revisionCount ?? 1) + 1
                : current.revisionCount,
          };
        }
        return [
          ...prev.slice(0, -1),
          { ...last, artifacts: next, hasLanded: true },
        ];
      });
    },
    []
  );

  // WebSocket wiring — one effect, one socket, supports every stream variant.
  useEffect(() => {
    import("socket.io-client").then(({ io }) => {
      const socket = io(`${wsUrl}/agent`, {
        auth: sessionToken
          ? { token: sessionToken }
          : {
              organizationId,
              projectId,
              environmentId,
              userId,
            },
        transports: ["websocket"],
        ...(wsPath ? { path: wsPath } : {}),
      });

      socket.on("connected", () => setConnected(true));
      socket.on("disconnect", () => setConnected(false));

      socket.on("agent_event", (event: any) => {
        // Capture thread id from the meta event.
        if (event.type === "meta" && event.thread_id) {
          threadIdRef.current = event.thread_id;
          setCurrentThreadId(event.thread_id);
        }

        // PRA-TC: route thread-reply events to the thread panel, not main timeline.
        if (event.replyToMessageId) {
          if (event.type === "token" || event.type === "delta") {
            const text: string = event.text ?? event.delta ?? "";
            setThreadMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.isStreaming) {
                return [...prev.slice(0, -1), { ...last, content: last.content + text, hasLanded: true }];
              }
              return prev;
            });
          } else if (event.type === "message_persisted" && event.messageId) {
            setThreadMessages((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                const m = prev[i]!;
                if (m.role === "assistant" && !m.persistedId) {
                  const next = [...prev];
                  next[i] = { ...m, persistedId: event.messageId, id: event.messageId };
                  return next;
                }
              }
              return prev;
            });
            // Increment reply count chip on the parent message.
            setMessages((prev) => prev.map((m) =>
              m.id === event.replyToMessageId || m.persistedId === event.replyToMessageId
                ? { ...m, replyCount: (m.replyCount ?? 0) + 1 }
                : m
            ));
          } else if (event.type === "error") {
            // BUG-3 fix: surface error in thread panel and unblock the composer.
            setThreadMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.isStreaming) {
                const next = [...prev];
                next[prev.length - 1] = {
                  ...last,
                  isStreaming: false,
                  content: (last.content || "") + (last.content ? "\n\n" : "") + `[Error: ${event.message ?? "stream failed"}]`,
                  hasLanded: true,
                };
                return next;
              }
              return prev;
            });
            setIsThreadStreaming(false);
          } else if (event.type === "done") {
            setThreadMessages((prev) => prev.map((m) => ({ ...m, isStreaming: false })));
            setIsThreadStreaming(false);
          }
          return; // Don't fall through to main timeline handler
        }

        switch (event.type) {
          case "meta":
            // Meta carries usage + ids — usage is reported alongside `done`
            // in the same run; skip a chip for now.
            break;

          case "status":
            // Transient connection / phase markers — surface as lightweight info.
            appendChip(
              {
                type: event.type,
                label: `status · ${event.status ?? "update"}`,
                tone: "info",
              },
              false
            );
            break;

          // PRELAUNCH-A2-24 — dead alias branches removed: `delta`,
          // `reasoning`, and `tool_use` were never emitted by the agent
          // (grep confirms zero hits). Keeping only the live names: `token`,
          // `thinking`, `tool_call`.
          case "token": {
            const text: string = event.text ?? "";
            if (!text) break;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + text, hasLanded: true },
                ];
              }
              return prev;
            });
            break;
          }

          case "thinking": {
            const text: string = event.text ?? event.content ?? "";
            if (!text) break;
            appendChip({
              type: event.type,
              label: "thinking",
              detail: text,
              tone: "info",
            });
            break;
          }

          case "tool_call":
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    hasLanded: true,
                    toolCalls: [
                      ...(last.toolCalls || []),
                      { type: "call", name: event.name },
                    ],
                  },
                ];
              }
              return prev;
            });
            break;

          case "tool_result":
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                const calls = [...(last.toolCalls || [])];
                const idx = calls.findIndex(
                  (c) => c.name === event.name && c.type === "call"
                );
                if (idx >= 0) {
                  calls[idx] = {
                    type: "result",
                    name: event.name,
                    result: event.result,
                  };
                } else {
                  calls.push({ type: "result", name: event.name, result: event.result });
                }
                return [
                  ...prev.slice(0, -1),
                  { ...last, toolCalls: calls, hasLanded: true },
                ];
              }
              return prev;
            });
            break;

          case "safety_flags":
            appendChip({
              type: event.type,
              label: `safety · ${(event.flags ?? [])
                .map((f: any) => f.type)
                .slice(0, 3)
                .join(", ") || "flagged"}`,
              detail: event.flags,
              tone: "warn",
            });
            break;

          case "structured_output":
            appendChip({
              type: event.type,
              label: `structured output (attempts: ${event.attempts ?? 1})`,
              detail: event.object,
              tone: "success",
            });
            break;

          case "run_update":
            appendChip({
              type: event.type,
              label: `bgo run · ${event.status ?? "update"}${
                event.runId ? ` (${String(event.runId).slice(0, 8)})` : ""
              }`,
              detail: { runId: event.runId, status: event.status, output: event.output, error: event.error },
              tone: event.error ? "danger" : event.status === "completed" ? "success" : "info",
            });
            break;

          case "approval_needed":
          case "approval_requested":
            appendChip({
              type: event.type,
              label: `approval needed · ${event.action ?? ""}`,
              detail: { approvalId: event.approvalId, action: event.action, details: event.details },
              tone: "warn",
            });
            break;

          case "approval_resolved":
            // Forward to any open ApprovalCard. The card listens for this
            // CustomEvent on window and transitions out of the spinner state
            // even if the resolve POST itself never returned (timeout, BLPOP
            // expiry, resolution from a sibling tab).
            if (typeof window !== "undefined" && event.approvalId) {
              window.dispatchEvent(new CustomEvent("platos:approval_resolved", {
                detail: {
                  approvalId: event.approvalId,
                  status: event.status,
                  respondedBy: event.respondedBy,
                },
              }));
            }
            break;

          case "citation":
            appendChip({
              type: event.type,
              label: event.title ? `cite · ${event.title}` : "citation",
              detail: event,
              tone: "info",
            });
            break;

          // Legacy `artifact` single-event variant — treat as committed.
          case "artifact":
          case "artifact_committed":
            upsertArtifactOnBubble({
              id: event.artifactId ?? event.id,
              artifactKey: event.artifactKey ?? event.key ?? event.id,
              revision: event.revision ?? 1,
              kind: event.kind ?? "markdown",
              title: event.title ?? null,
              language: event.language ?? null,
              content: event.finalContent ?? event.content ?? "",
              createdAt: event.createdAt,
              streaming: false,
              error: undefined,
            });
            break;

          case "artifact_start":
            upsertArtifactOnBubble({
              id: event.artifactId,
              artifactKey: event.artifactKey,
              revision: event.revision,
              kind: event.kind,
              title: event.title ?? null,
              language: event.language ?? null,
              content: "",
              streaming: true,
              error: undefined,
            });
            break;

          case "artifact_delta":
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (!last || last.role !== "assistant") return prev;
              const existing = last.artifacts ?? [];
              const next = existing.map((a) =>
                a.artifactKey === event.artifactKey
                  ? { ...a, content: (a.content ?? "") + (event.chunk ?? "") }
                  : a
              );
              return [
                ...prev.slice(0, -1),
                { ...last, artifacts: next, hasLanded: true },
              ];
            });
            break;

          case "artifact_error":
            if (event.artifactKey) {
              upsertArtifactOnBubble({
                artifactKey: event.artifactKey,
                streaming: false,
                error: event.message || event.code,
              });
            } else {
              appendChip({
                type: event.type,
                label: `artifact error · ${event.code ?? "unknown"}`,
                detail: event,
                tone: "danger",
              });
            }
            break;

          case "message_boundary":
            // Segmentation marker between assistant sub-messages (tool loop).
            // Close the current bubble + open a new streaming one.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                const newId = `bot-${++msgCounterRef.current}`;
                currentBotIdRef.current = newId;
                return [
                  ...prev.slice(0, -1),
                  { ...last, isStreaming: false },
                  {
                    id: newId,
                    role: "assistant",
                    content: "",
                    isStreaming: true,
                    hasLanded: false,
                  },
                ];
              }
              return prev;
            });
            break;

          case "message_persisted":
            // Rebind the client-only `bot-*` id with the server id so
            // fork / edit / retry / thumbs rating become available.
            if (event.messageId) {
              setMessages((prev) => {
                // Find the nearest assistant bubble without a persistedId.
                for (let i = prev.length - 1; i >= 0; i--) {
                  const m = prev[i]!;
                  if (m.role === "assistant" && !m.persistedId) {
                    const next = [...prev];
                    next[i] = { ...m, persistedId: event.messageId, id: event.messageId };
                    return next;
                  }
                }
                return prev;
              });
            }
            break;

          case "turn_in_progress":
            appendChip({
              type: event.type,
              label: "another turn is streaming — please wait",
              tone: "warn",
            });
            setIsStreaming(false);
            break;

          case "already_processed":
            appendChip({
              type: event.type,
              label: "duplicate message — skipped",
              tone: "info",
            });
            setIsStreaming(false);
            break;

          case "bgo_cap_exceeded":
            appendChip({
              type: event.type,
              label: "bgo spawn cap reached for this turn",
              detail: event,
              tone: "warn",
            });
            break;

          case "done":
            setMessages((prev) => {
              // EOBD.72 — if the assistant placeholder never landed content,
              // drop it rather than leaving "Thinking…" hanging.
              const last = prev[prev.length - 1];
              if (
                last?.role === "assistant" &&
                last.isStreaming &&
                !last.hasLanded &&
                !last.content
              ) {
                return prev.slice(0, -1);
              }
              return prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
            });
            currentBotIdRef.current = null;
            setIsStreaming(false);
            break;

          case "error":
            // Rate-limit errors get special handling: no inline error row in
            // the conversation, restore the unsent text, and surface a
            // dedicated banner above the composer with a live countdown.
            if (event.code === "rate_limit") {
              const retryAfterSeconds: number =
                typeof event.retryAfterSeconds === "number" && event.retryAfterSeconds > 0
                  ? event.retryAfterSeconds
                  : 60;
              const scope: RateLimitBanner["scope"] =
                event.scope === "org_per_day" ||
                event.scope === "org_per_minute" ||
                event.scope === "user_per_hour" ||
                event.scope === "user_per_day"
                  ? event.scope
                  : "user_per_minute";
              setRateLimit({
                scope,
                message: event.message ?? "Rate limit reached.",
                retryAfterSeconds,
                expiresAtMs: Date.now() + retryAfterSeconds * 1000,
                limit: typeof event.limit === "number" ? event.limit : undefined,
              });
              // Drop the placeholder assistant bubble. The corresponding user
              // bubble (one back) is also rolled back so the rejected message
              // does not stay pinned in the timeline. The text is preserved in
              // the composer.
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                const secondLast = prev[prev.length - 2];
                if (
                  last?.role === "assistant" &&
                  last.isStreaming &&
                  !last.hasLanded &&
                  !last.content &&
                  secondLast?.role === "user"
                ) {
                  return prev.slice(0, -2);
                }
                if (last?.role === "assistant" && last.isStreaming && !last.hasLanded) {
                  return prev.slice(0, -1);
                }
                return prev;
              });
              if (lastSentTextRef.current) {
                setInput((current) => (current.length === 0 ? lastSentTextRef.current : current));
              }
              currentBotIdRef.current = null;
              setIsStreaming(false);
              break;
            }
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // EOBD.72 — if the error landed on an empty placeholder, drop
              // the placeholder AND surface an inline error row.
              if (
                last?.role === "assistant" &&
                last.isStreaming &&
                !last.hasLanded &&
                !last.content
              ) {
                return [
                  ...prev.slice(0, -1),
                  {
                    id: `err-${++msgCounterRef.current}`,
                    role: "assistant",
                    content: `[Error: ${event.message ?? "stream failed"}]`,
                    isStreaming: false,
                    hasLanded: true,
                  },
                ];
              }
              if (last?.role === "assistant" && last.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    content:
                      last.content +
                      `\n\n[Error: ${event.message ?? "stream failed"}]`,
                    isStreaming: false,
                    hasLanded: true,
                  },
                ];
              }
              return prev;
            });
            currentBotIdRef.current = null;
            setIsStreaming(false);
            break;

          case "trace_request":
            setTraceRequest(event);
            setTraceEvents((prev) => [...prev, { type: "trace_request", ts: Date.now(), data: event }]);
            break;

          case "trace_step":
            setTraceSteps((prev) => [...prev, event]);
            setTraceEvents((prev) => [...prev, { type: "trace_step", ts: Date.now(), data: event }]);
            break;

          default:
            // EOBD.67 — generic fallback so unknown variants are visible in dev.
            if (!KNOWN_EVENT_TYPES.has(event.type)) {
              appendChip({
                type: event.type ?? "unknown",
                label: `[unknown:${event.type ?? "?"}]`,
                detail: event,
                tone: "warn",
              });
            }
            break;
        }
        // Mirror every event into the inspector timeline when open
        if (inspectorOpen) {
          setTraceEvents((prev) => {
            const last = prev[prev.length - 1];
            if (last?.type === event.type && event.type === "trace_request") return prev;
            return [...prev, { type: event.type, ts: Date.now(), data: event }];
          });
        }
      });

      socketRef.current = socket;

      return () => {
        socket.disconnect();
      };
    });
  }, [wsUrl, wsPath, organizationId, projectId, environmentId, userId, sessionToken, appendChip, upsertArtifactOnBubble]);

  const uploadOne = useCallback(
    async (entry: PendingAttachment) => {
      try {
        const presignRes = await fetch("/api/v1/agent/attachments/presigned", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organizationId,
            projectId,
            environmentId,
            filename: entry.file.name,
            mimeType: entry.file.type || "application/octet-stream",
            bytes: entry.file.size,
          }),
        });
        if (!presignRes.ok) {
          const err = (await presignRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(err?.error || `Presign failed (${presignRes.status})`);
        }
        const presign = (await presignRes.json()) as {
          attachmentId: string;
          uploadUrl: string;
          headers: Record<string, string>;
        };

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", presign.uploadUrl);
          for (const [k, v] of Object.entries(presign.headers)) {
            xhr.setRequestHeader(k, v);
          }
          xhr.upload.onprogress = (ev) => {
            if (!ev.lengthComputable) return;
            const pct = Math.round((ev.loaded / ev.total) * 100);
            setPendingAttachments((prev) =>
              prev.map((a) =>
                a.localId === entry.localId ? { ...a, progress: pct } : a
              )
            );
          };
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300
              ? resolve()
              : reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
          xhr.onerror = () => reject(new Error("Upload network error"));
          xhr.send(entry.file);
        });

        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === entry.localId
              ? {
                  ...a,
                  status: "ready",
                  progress: 100,
                  attachmentId: presign.attachmentId,
                }
              : a
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === entry.localId
              ? { ...a, status: "error", error: message }
              : a
          )
        );
      }
    },
    [organizationId, projectId, environmentId]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      for (const file of list) {
        if (file.size > attachmentMaxBytes) {
          const localId = `att-${++attCounterRef.current}`;
          setPendingAttachments((prev) => [
            ...prev,
            {
              localId,
              file,
              progress: 0,
              status: "error",
              error: `File exceeds ${humanizeBytes(attachmentMaxBytes)} cap`,
            },
          ]);
          continue;
        }
        const localId = `att-${++attCounterRef.current}`;
        const previewUrl = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined;
        const entry: PendingAttachment = {
          localId,
          file,
          previewUrl,
          progress: 0,
          status: "uploading",
        };
        setPendingAttachments((prev) => [...prev, entry]);
        void uploadOne(entry);
      }
    },
    [attachmentMaxBytes, uploadOne]
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      setPendingAttachments((prev) => {
        const found = prev.find((a) => a.localId === localId);
        if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
        if (found?.attachmentId) {
          const params = new URLSearchParams({ organizationId, projectId, environmentId });
          void fetch(
            `/api/v1/agent/attachments/${found.attachmentId}?${params.toString()}`,
            { method: "DELETE" }
          ).catch(() => {});
        }
        return prev.filter((a) => a.localId !== localId);
      });
    },
    [organizationId, projectId, environmentId]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDraggingOver(false);
      if (e.dataTransfer?.files?.length) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  const rateMessage = useCallback(
    async (messageId: string, rating: 1 | -1) => {
      if (messageId.startsWith("bot-") || messageId.startsWith("user-") || messageId.startsWith("err-")) return;

      const existing = messages.find((m) => m.id === messageId)?.rating ?? null;
      const next: 1 | -1 | null = existing === rating ? null : rating;

      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, rating: next } : m))
      );

      try {
        const path = `/resources/agent?path=${encodeURIComponent(
          `/api/v1/agent/messages/${messageId}/rating`
        )}&organizationId=${organizationId}&projectId=${projectId}&environmentId=${environmentId}`;
        if (next === null) {
          await fetch(path, { method: "DELETE" });
        } else {
          await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rating: next }),
          });
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, rating: existing } : m))
        );
      }
    },
    [messages, organizationId, projectId, environmentId]
  );

  const sendMessage = useCallback(
    (text: string, attachmentIds: string[] = []) => {
      if ((!text && attachmentIds.length === 0) || !socketRef.current || isStreaming) return;

      const userMsg: ChatMessage = {
        id: `user-${++msgCounterRef.current}`,
        role: "user",
        content: text,
        hasLanded: true,
      };
      const botId = `bot-${++msgCounterRef.current}`;
      currentBotIdRef.current = botId;
      const botMsg: ChatMessage = {
        id: botId,
        role: "assistant",
        content: "",
        isStreaming: true,
        hasLanded: false,
      };

      setMessages((prev) => [...prev, userMsg, botMsg]);
      setIsStreaming(true);
      // Reset inspector trace for new turn
      setTraceRequest(null);
      setTraceSteps([]);
      setTraceEvents([]);

      socketRef.current.emit("message", {
        message: text,
        agentId,
        threadId: threadIdRef.current || undefined,
        attachmentIds,
        // PIFSP-9: Postman mode overrides (only when active)
        ...(postmanMode && parsedCtx ? { sessionContextOverride: parsedCtx } : {}),
        ...(postmanMode && postmanUserId !== userId ? { postmanUserId } : {}),
        ...(selectedModelLabel ? { modelLabel: selectedModelLabel } : {}),
      });
    },
    [agentId, isStreaming, postmanMode, parsedCtx, postmanUserId, userId, selectedModelLabel]
  );

  // PRA-TC: send a reply in the active sub-thread.
  const sendThreadMessage = useCallback(() => {
    const text = threadInput.trim();
    if (!text || !socketRef.current || isThreadStreaming || !activeThreadMessageId) return;

    const userMsg: ChatMessage = {
      id: `thread-user-${++threadMsgCounterRef.current}`,
      role: "user",
      content: text,
      hasLanded: true,
      threadReplyToId: activeThreadMessageId,
    };
    const botId = `thread-bot-${++threadMsgCounterRef.current}`;
    threadBotIdRef.current = botId;
    const botMsg: ChatMessage = {
      id: botId,
      role: "assistant",
      content: "",
      isStreaming: true,
      hasLanded: false,
      threadReplyToId: activeThreadMessageId,
    };

    setThreadMessages((prev) => [...prev, userMsg, botMsg]);
    setThreadInput("");
    setIsThreadStreaming(true);

    socketRef.current.emit("message", {
      message: text,
      agentId,
      threadId: threadIdRef.current || undefined,
      replyToMessageId: activeThreadMessageId,
      // PIFSP-9: Postman mode overrides MUST match handleSend, otherwise the
      // thread reply lands under the operator's userId while the parent
      // message lives under the simulated userId. Backend's getThread
      // filters by userId → returns null → creates a new empty thread →
      // storeMessage's parent check throws "Reply parent message not
      // found in this thread". This is the actual root cause behind every
      // recent reply-parent error in Postman mode.
      ...(postmanMode && parsedCtx ? { sessionContextOverride: parsedCtx } : {}),
      ...(postmanMode && postmanUserId !== userId ? { postmanUserId } : {}),
      ...(selectedModelLabel ? { modelLabel: selectedModelLabel } : {}),
    });
  }, [threadInput, isThreadStreaming, activeThreadMessageId, agentId, selectedModelLabel, postmanMode, parsedCtx, postmanUserId, userId]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    const readyAttachments = pendingAttachments.filter(
      (a) => a.status === "ready" && a.attachmentId
    );
    const hasAttachments = readyAttachments.length > 0;
    if ((!text && !hasAttachments) || !socketRef.current || isStreaming) return;
    // Block sends while rate-limited or soft-throttled. The composer is
    // already disabled visually; this is a defence-in-depth no-op.
    if (rateLimit) return;
    if (softThrottled) return;

    if (pendingAttachments.some((a) => a.status === "uploading")) return;

    // Attach the attachments inline onto the user bubble for display.
    const userAttachments = readyAttachments.map((a) => ({
      id: a.attachmentId!,
      name: a.file.name,
      mimeType: a.file.type,
      bytes: a.file.size,
    }));

    const userMsg: ChatMessage = {
      id: `user-${++msgCounterRef.current}`,
      role: "user",
      content: text,
      attachments: userAttachments,
      hasLanded: true,
    };
    const botId = `bot-${++msgCounterRef.current}`;
    currentBotIdRef.current = botId;
    const botMsg: ChatMessage = {
      id: botId,
      role: "assistant",
      content: "",
      isStreaming: true,
      hasLanded: false,
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);
    setInput("");
    setIsStreaming(true);
    lastSentTextRef.current = text;
    lastSentAtRef.current = Date.now();
    setSoftThrottled(true);

    capture("platos_message_sent", {
      agentId,
      postmanMode,
      hasSessionContext: !!parsedCtx,
      hasEntityIds: !!(parsedCtx as any)?.entity_ids,
      isNewThread: !threadIdRef.current,
    });

    socketRef.current.emit("message", {
      message: text,
      agentId,
      threadId: threadIdRef.current || undefined,
      attachmentIds: readyAttachments.map((a) => a.attachmentId!),
      // PIFSP-9: Postman mode overrides
      ...(postmanMode && parsedCtx ? { sessionContextOverride: parsedCtx } : {}),
      ...(postmanMode && postmanUserId !== userId ? { postmanUserId } : {}),
      ...(selectedModelLabel ? { modelLabel: selectedModelLabel } : {}),
    });

    for (const a of pendingAttachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setPendingAttachments([]);

    inputRef.current?.focus();
  }, [input, isStreaming, agentId, pendingAttachments, postmanMode, parsedCtx, postmanUserId, userId, capture, selectedModelLabel, rateLimit, softThrottled]);

  // EOBD.69 — fork: navigate to the new thread conversation viewer.
  const onForked = useCallback(
    (newThreadId: string) => {
      navigate(
        agentConversationPath(organization, project, environment, agentId, newThreadId)
      );
    },
    [navigate, organization, project, environment, agentId]
  );

  const onEditedAndRerun = useCallback(
    (newUserContent: string) => {
      sendMessage(newUserContent);
    },
    [sendMessage]
  );

  const onRetry = useCallback(
    (priorUserContent: string) => {
      sendMessage(priorUserContent);
    },
    [sendMessage]
  );

  const scopeForProxy = { organizationId, projectId, environmentId };

  return (
    <PageBody>
        {/* Chat toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-charcoal-700 flex-shrink-0">
          <div className="flex rounded border border-charcoal-600 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setPostmanMode(false)}
              className={`px-3 py-1.5 transition-colors ${!postmanMode ? "bg-charcoal-700 text-text-bright" : "text-text-dimmed hover:text-text-bright"}`}
            >
              Live chat
            </button>
            <button
              type="button"
              onClick={() => setPostmanMode(true)}
              className={`px-3 py-1.5 transition-colors ${postmanMode ? "bg-amber-500/20 text-amber-300 border-l border-charcoal-600" : "text-text-dimmed hover:text-text-bright border-l border-charcoal-600"}`}
            >
              Postman
            </button>
          </div>
          {postmanMode && (
            <span className="text-xs text-amber-300/70">
              Sending as user <code className="font-mono">{postmanUserId}</code> with sessionContext override
            </span>
          )}
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setInspectorOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs transition-colors ${
                inspectorOpen
                  ? "bg-blue-500/20 border-blue-500/50 text-blue-300"
                  : "border-charcoal-600 text-text-dimmed hover:text-text-bright hover:border-charcoal-500"
              }`}
            >
              <BeakerIcon className="size-3.5" />
              Inspect
              {traceSteps.length > 0 && (
                <span className="ml-1 rounded-full bg-blue-500/30 px-1.5 text-[10px] text-blue-300">
                  {traceSteps.length} step{traceSteps.length !== 1 ? "s" : ""}
                </span>
              )}
            </button>
          </div>
        </div>

        <div
          className={`relative flex flex-1 h-[calc(100vh-10rem)] sm:h-[calc(100vh-14rem)] gap-0 ${
            isDraggingOver ? "bg-emerald-500/5" : ""
          }`}
        >
          {/* PIFSP-9 Postman sidebar */}
          {postmanMode && (
            <aside className="w-72 flex-shrink-0 border-r border-charcoal-700 overflow-y-auto bg-charcoal-900/40 p-3 flex flex-col gap-3">
              <p className="text-xs font-semibold text-amber-300 uppercase tracking-wide">Request config</p>

              {/* Template selector */}
              {postmanTemplates.length > 0 && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-text-dimmed">Load template</span>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSelectedTemplateId(val);
                      if (val) {
                        const tpl = postmanTemplates.find((t) => t.id === val);
                        if (tpl) {
                          setPostmanUserId(tpl.simulateUserId);
                          setCtxJson(
                            tpl.sessionContext
                              ? JSON.stringify(tpl.sessionContext, null, 2)
                              : "",
                          );
                          capture("platos_postman_template_loaded", { agentId, templateId: val });
                        }
                      }
                    }}
                    className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5"
                  >
                    <option value="">— select template —</option>
                    {postmanTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.isDefault ? " ★" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-dimmed">User ID (simulate)</span>
                <input
                  type="text"
                  value={postmanUserId}
                  onChange={(e) => setPostmanUserId(e.target.value)}
                  className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono"
                  placeholder="user-id-to-simulate"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-text-dimmed">Session context (JSON)</span>
                <textarea
                  value={ctxJson}
                  onChange={(e) => setCtxJson(e.target.value)}
                  rows={8}
                  className={`bg-charcoal-800 border text-text-bright text-xs rounded px-2 py-1.5 font-mono resize-y ${ctxParseError ? "border-rose-500" : "border-charcoal-600"}`}
                  placeholder='{"entity_ids": ["ent_xxx"], "user.name": "Alice", "user.timezone": "Asia/Kolkata"}'
                />
                {ctxParseError && <span className="text-xs text-rose-400">{ctxParseError}</span>}
                {!ctxParseError && parsedCtx && (
                  <span className="text-xs text-emerald-400">✓ Valid JSON</span>
                )}
              </label>

              <div className="text-xs text-text-dimmed space-y-1">
                <p className="font-medium">Quick inserts:</p>
                <button
                  type="button"
                  onClick={() => {
                    const base = parsedCtx ?? {};
                    setCtxJson(JSON.stringify({ ...base, entity_ids: base.entity_ids ?? [] }, null, 2));
                  }}
                  className="text-xs text-emerald-400 hover:text-emerald-300 underline"
                >
                  + entity_ids
                </button>
              </div>

              {/* Save as template */}
              <div className="border-t border-charcoal-700 pt-2 flex flex-col gap-2">
                {!showSaveTemplate ? (
                  <button
                    type="button"
                    onClick={() => setShowSaveTemplate(true)}
                    className="text-xs text-amber-400 hover:text-amber-300 underline self-start"
                  >
                    Save as template…
                  </button>
                ) : (
                  <tplFetcher.Form method="post" onSubmit={() => { setShowSaveTemplate(false); setTemplateName(""); }}>
                    <input type="hidden" name="intent" value="save-postman-template" />
                    <input type="hidden" name="simulateUserId" value={postmanUserId} />
                    <input type="hidden" name="sessionContext" value={ctxJson} />
                    <div className="flex flex-col gap-1.5">
                      <input
                        type="text"
                        name="templateName"
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        placeholder="Template name"
                        className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={!templateName.trim() || tplFetcher.state === "submitting"}
                          className="text-xs bg-amber-600/80 hover:bg-amber-600 text-white rounded px-2 py-1 disabled:opacity-50"
                        >
                          {tplFetcher.state === "submitting" ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setShowSaveTemplate(false); setTemplateName(""); }}
                          className="text-xs text-text-dimmed hover:text-text-bright"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </tplFetcher.Form>
                )}
                {tplFetcher.data && "ok" in tplFetcher.data && tplFetcher.data.ok && (
                  <span className="text-xs text-emerald-400">Template saved</span>
                )}
                {tplFetcher.data && "ok" in tplFetcher.data && !tplFetcher.data.ok && (
                  <span className="text-xs text-rose-400">{tplFetcher.data.error}</span>
                )}
              </div>
            </aside>
          )}

          {/* Inspector panel — right sidebar showing full request trace */}
          {inspectorOpen && (
            <aside className="w-96 flex-shrink-0 border-l border-charcoal-700 bg-charcoal-900/60 flex flex-col overflow-hidden order-last">
              {/* Header + tabs */}
              <div className="flex-shrink-0 border-b border-charcoal-700 px-3 pt-3 pb-0">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-blue-300 uppercase tracking-wide flex items-center gap-1.5">
                    <BeakerIcon className="size-3.5" /> Request Inspector
                  </span>
                  <button type="button" onClick={() => setInspectorOpen(false)} className="text-text-dimmed hover:text-text-bright">
                    <XMarkIcon className="size-4" />
                  </button>
                </div>
                <div className="flex gap-0">
                  {(["request", "steps", "events"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setInspectorTab(t)}
                      className={`px-3 py-1.5 text-xs capitalize border-b-2 transition-colors ${
                        inspectorTab === t
                          ? "border-blue-400 text-blue-300"
                          : "border-transparent text-text-dimmed hover:text-text-bright"
                      }`}
                    >
                      {t}
                      {t === "steps" && traceSteps.length > 0 && (
                        <span className="ml-1 text-[10px] text-blue-400">({traceSteps.length})</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-y-auto p-3 text-xs font-mono space-y-3">
                {/* ── Request tab ── */}
                {inspectorTab === "request" && (
                  traceRequest ? (
                    <div className="space-y-3">
                      {/* Overview */}
                      <div className="rounded border border-charcoal-700 bg-charcoal-800/50 p-2 space-y-1">
                        <div className="flex justify-between text-text-dimmed"><span>Model</span><span className="text-text-bright">{String(traceRequest.model ?? "—")}</span></div>
                        <div className="flex justify-between text-text-dimmed"><span>Provider</span><span className="text-text-bright">{String(traceRequest.provider ?? "—")}</span></div>
                        <div className="flex justify-between text-text-dimmed"><span>System prompt</span><span className="text-text-bright">{String(traceRequest.systemPromptChars ?? 0)} chars / ~{String(traceRequest.systemPromptTokensEst ?? 0)} tokens</span></div>
                        <div className="flex justify-between text-text-dimmed"><span>History msgs</span><span className="text-text-bright">{String(traceRequest.historyMessageCount ?? 0)}</span></div>
                        <div className="flex justify-between text-text-dimmed"><span>Tools</span><span className="text-text-bright">{String(traceRequest.toolCount ?? 0)}</span></div>
                      </div>
                      {/* Tool list */}
                      {traceToolNames.length > 0 && (
                        <details className="rounded border border-charcoal-700">
                          <summary className="cursor-pointer px-2 py-1.5 text-text-dimmed hover:text-text-bright select-none">
                            Tool names ({traceToolNames.length})
                          </summary>
                          <div className="px-2 pb-2 space-y-0.5 max-h-40 overflow-y-auto">
                            {traceToolNames.map((n) => (
                              <div key={n} className="text-emerald-400">{n}</div>
                            ))}
                          </div>
                        </details>
                      )}
                      {/* System prompt */}
                      <details className="rounded border border-charcoal-700">
                        <summary className="cursor-pointer px-2 py-1.5 text-text-dimmed hover:text-text-bright select-none">
                          System prompt (full)
                        </summary>
                        <pre className="px-2 pb-2 pt-1 text-[11px] text-text-bright whitespace-pre-wrap break-words max-h-96 overflow-y-auto leading-relaxed">
                          {String(traceRequest.systemPrompt ?? "")}
                        </pre>
                      </details>
                      {/* Session context */}
                      {!!traceRequest.sessionContext && (
                        <details className="rounded border border-charcoal-700">
                          <summary className="cursor-pointer px-2 py-1.5 text-text-dimmed hover:text-text-bright select-none">
                            Session context
                          </summary>
                          <pre className="px-2 pb-2 pt-1 text-[11px] text-amber-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                            {JSON.stringify(traceRequest.sessionContext, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  ) : (
                    <p className="text-text-dimmed italic">Send a message to see the outbound request.</p>
                  )
                )}

                {/* ── Steps tab ── */}
                {inspectorTab === "steps" && (
                  traceSteps.length === 0
                    ? <p className="text-text-dimmed italic">No steps yet.</p>
                    : traceSteps.map((step, i) => {
                        const u = step.usage as any ?? {};
                        const cacheHit = Number(step.cacheRead ?? 0) > 0;
                        // PRELAUNCH-A1-8 — provider-aware discount label +
                        // reasoning + no-cache-token rows.
                        const inputTokens = Number(u.inputTokens ?? u.promptTokens ?? 0);
                        const outputTokens = Number(u.outputTokens ?? u.completionTokens ?? 0);
                        const cacheReadTokens = Number(step.cacheRead ?? u.inputTokenDetails?.cacheReadTokens ?? 0);
                        const cacheCreationTokens = Number(step.cacheCreation ?? u.inputTokenDetails?.cacheWriteTokens ?? 0);
                        const reasoningTokens = Number(u.reasoningTokens ?? u.outputTokenDetails?.reasoningTokens ?? 0);
                        // WIN-134 — PER-STEP, deliberately. The turn-level
                        // figure comes from the agent's usage ledger
                        // (`freshInputTokens`); this panel is the one place a
                        // per-step number is the right answer, and it is
                        // labelled per step. Same clamp, same base
                        // (`inputTokens` is inclusive of the cache slice), so
                        // the step rows sum to the turn total the ledger
                        // reports. It reads `step.cacheRead` first: the
                        // `trace_step` event carries the raw per-step blob,
                        // which is the granularity that blob is true at.
                        const noCacheInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
                        return (
                          <div key={i} className="rounded border border-charcoal-700 bg-charcoal-800/50 p-2 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-text-bright">Step {i + 1}</span>
                              <span className={`text-[10px] rounded px-1.5 py-0.5 ${
                                String(step.finishReason) === "stop"
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : "bg-amber-500/20 text-amber-300"
                              }`}>
                                {String(step.finishReason ?? "—")}
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-2 text-text-dimmed">
                              {/* AI SDK v6 — usage shape changed: */}
                              {/* `promptTokens` → `inputTokens`, `completionTokens` → `outputTokens`. */}
                              {/* Fall back to v4 names for any in-flight pre-migration data. */}
                              <span>Input tokens</span><span className="text-text-bright text-right">{inputTokens}</span>
                              <span>No-cache tokens</span><span className="text-text-bright text-right">{noCacheInputTokens}</span>
                              <span>Output tokens</span><span className="text-text-bright text-right">{outputTokens}</span>
                              {reasoningTokens > 0 && (
                                <>
                                  <span>Reasoning tokens</span>
                                  <span className="text-purple-300 text-right">{reasoningTokens}</span>
                                </>
                              )}
                              <span>Cache creation</span><span className="text-blue-300 text-right">{cacheCreationTokens}</span>
                              <span>Cache read</span><span className={`text-right ${cacheHit ? "text-emerald-400 font-semibold" : "text-text-dimmed"}`}>
                                {cacheReadTokens}{cacheHit ? " ✓ canonical rate" : ""}
                              </span>
                            </div>
                            {Array.isArray(step.toolCalls) && (step.toolCalls as string[]).length > 0 && (
                              <div className="pt-1 border-t border-charcoal-700/50">
                                <span className="text-text-dimmed">Tools called: </span>
                                {(step.toolCalls as string[]).map((t) => (
                                  <span key={t} className="mr-1 text-emerald-400">{t}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                )}

                {/* ── Events tab — raw timeline ── */}
                {inspectorTab === "events" && (
                  traceEvents.length === 0
                    ? <p className="text-text-dimmed italic">No events yet.</p>
                    : traceEvents.map((ev, i) => (
                        <div key={i} className="border-b border-charcoal-700/40 pb-1.5">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] rounded px-1 ${
                              ev.type.startsWith("trace") ? "bg-blue-500/20 text-blue-300" :
                              ev.type === "tool_call" ? "bg-amber-500/20 text-amber-300" :
                              ev.type === "tool_result" ? "bg-emerald-500/20 text-emerald-300" :
                              ev.type === "error" ? "bg-rose-500/20 text-rose-300" :
                              "bg-charcoal-700 text-text-dimmed"
                            }`}>{ev.type}</span>
                            <span className="text-charcoal-500 text-[10px]">{new Date(ev.ts).toISOString().slice(11, 23)}</span>
                          </div>
                          {ev.type !== "token" && ev.type !== "delta" && (
                            <pre className="mt-0.5 text-[10px] text-text-dimmed whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                              {JSON.stringify(ev.data, null, 2).slice(0, 500)}
                            </pre>
                          )}
                        </div>
                      ))
                )}
              </div>
            </aside>
          )}

          <div
            className={`relative flex flex-col flex-1 min-w-0 ${
              ctxPanelOpen ? "border-r border-charcoal-700" : ""
            }`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDraggingOver(false);
          }}
          onDrop={onDrop}
        >
          {isDraggingOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-emerald-950/60 backdrop-blur-[1px]">
              <div className="rounded-lg border-2 border-dashed border-emerald-400/70 bg-emerald-500/10 px-4 py-4 sm:px-8 sm:py-6 text-center text-emerald-100">
                <PhotoIcon className="size-8 sm:size-10 mx-auto mb-2 opacity-80" />
                <p className="text-sm font-medium">Drop files to attach</p>
                <p className="text-xs text-emerald-300/80 mt-1">
                  Max {humanizeBytes(attachmentMaxBytes)} per file
                </p>
              </div>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-2 sm:px-4 py-3 sm:py-4 space-y-3 sm:space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-text-dimmed">
                <ChatBubbleLeftRightIcon className="size-10 sm:size-12 mb-3 opacity-30" />
                <p className="text-sm">Send a message to start a conversation</p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`group flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] sm:max-w-[80%] rounded-lg px-3 py-2 sm:px-4 sm:py-3 ${
                    msg.role === "user"
                      ? "bg-emerald-600/20 text-text-bright"
                      : "bg-charcoal-750 text-text-bright"
                  }`}
                >
                  {/* PRA-AC: author attribution badge for cluster messages */}
                  {msg.role === "assistant" && msg.authorAgentId && msg.authorAgentId !== agentId && (
                    <div className="mb-1 flex items-center gap-1">
                      <span className="rounded bg-charcoal-700 px-1.5 py-0.5 text-[10px] font-mono text-text-dimmed">
                        {msg.authorAgentId.slice(0, 12)}…
                      </span>
                    </div>
                  )}

                  {/* Tool calls */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.toolCalls.map((tc, i) => {
                        const isCodeExec = tc.name === "run_python" || tc.name === "run_node" ||
                          tc.name === "platos_code_execution__run_python" || tc.name === "platos_code_execution__run_node";
                        const result = tc.result as Record<string, unknown> | null | undefined;
                        return (
                          <details
                            key={i}
                            className="rounded border border-charcoal-700 bg-charcoal-800/60 text-xs"
                          >
                            <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-text-dimmed hover:bg-charcoal-750">
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${tc.type === "result" ? (result?.error ? "bg-red-500" : "bg-green-500") : "bg-amber-500 animate-pulse"}`}
                              />
                              <span className="font-mono">{tc.name}</span>
                              {tc.type === "result" && isCodeExec && result && (
                                <span className={result.error ? "text-red-400" : "text-green-400"}>
                                  {result.error ? "error" : `${result.lang ?? "done"} · ${result.latencyMs ?? 0}ms`}
                                </span>
                              )}
                              {tc.type === "result" && !isCodeExec && (
                                <span className="text-green-400">done</span>
                              )}
                            </summary>
                            {tc.result !== undefined && (
                              isCodeExec && result ? (() => {
                                const stdout = result.stdout ? String(result.stdout) : null;
                                const stderr = result.stderr ? String(result.stderr) : null;
                                const error = result.error ? String(result.error) : null;
                                return (
                                  <div className="border-t border-charcoal-700">
                                    {error && (
                                      <pre className="overflow-x-auto bg-red-950/40 px-2 py-1.5 text-[11px] text-red-300 font-mono whitespace-pre-wrap">
                                        {error}
                                      </pre>
                                    )}
                                    {stdout && (
                                      <pre className="overflow-x-auto bg-charcoal-950 px-2 py-1.5 text-[11px] text-green-300 font-mono whitespace-pre-wrap">
                                        {stdout}
                                      </pre>
                                    )}
                                    {stderr && (
                                      <pre className="overflow-x-auto bg-yellow-950/30 px-2 py-1.5 text-[11px] text-yellow-300 font-mono whitespace-pre-wrap">
                                        {stderr}
                                      </pre>
                                    )}
                                    {!stdout && !stderr && !error && (
                                      <p className="px-2 py-1.5 text-[11px] text-text-dimmed italic">No output</p>
                                    )}
                                  </div>
                                );
                              })() : (
                                <pre className="overflow-x-auto border-t border-charcoal-700 bg-charcoal-900/60 px-2 py-1 text-[11px] text-text-dimmed">
                                  {JSON.stringify(tc.result, null, 2)}
                                </pre>
                              )
                            )}
                          </details>
                        );
                      })}
                    </div>
                  )}

                  {/* Attachments (user messages) */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {msg.attachments.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center gap-1.5 rounded-md border border-charcoal-700 bg-charcoal-800/60 px-2 py-1 text-xs text-text-dimmed"
                        >
                          <PaperClipIcon className="size-3" />
                          <span className="max-w-[160px] sm:max-w-[200px] truncate">
                            {a.name}
                          </span>
                          <span className="opacity-60">{humanizeBytes(a.bytes)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Markdown content */}
                  {msg.content && (
                    <ChatMessageContent
                      content={msg.content}
                      streaming={msg.isStreaming}
                    />
                  )}

                  {/* Streaming cursor */}
                  {msg.isStreaming && msg.content && (
                    <span className="inline-block w-0.5 h-4 bg-emerald-400 ml-0.5 animate-pulse" />
                  )}

                  {/* Thinking indicator (only when nothing has landed) */}
                  {msg.isStreaming && !msg.hasLanded && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-text-dimmed">Thinking</span>
                      <span className="flex gap-0.5">
                        {[0, 150, 300].map((d) => (
                          <span
                            key={d}
                            className="w-1 h-1 rounded-full bg-emerald-400 animate-bounce"
                            style={{ animationDelay: `${d}ms` }}
                          />
                        ))}
                      </span>
                    </div>
                  )}

                  {/* Stream event chips (safety flags, run_update, citations, unknowns, …) */}
                  {msg.chips && msg.chips.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1">
                      {msg.chips.map((chip) => {
                        // Approval cards get a dedicated interactive UI instead of a plain chip
                        if (chip.type === "approval_needed" || chip.type === "approval_requested") {
                          const d = chip.detail as { approvalId?: string; action?: string; details?: string } | undefined;
                          const approvalId = d?.approvalId;
                          return (
                            <ApprovalCard
                              key={chip.key}
                              approvalId={approvalId ?? ""}
                              action={d?.action ?? chip.label}
                              details={d?.details}
                              apiUrl={apiUrl}
                              sessionToken={sessionToken}
                              organizationId={organizationId}
                              projectId={projectId}
                              environmentId={environmentId}
                              userId={userId}
                            />
                          );
                        }
                        return (
                          <details
                            key={chip.key}
                            className={`rounded border px-2 py-1 text-[11px] ${
                              chip.tone === "danger"
                                ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                                : chip.tone === "warn"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                  : chip.tone === "success"
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                    : chip.tone === "info"
                                      ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
                                      : "border-charcoal-700 bg-charcoal-800/60 text-text-dimmed"
                            }`}
                          >
                            <summary className="cursor-pointer font-mono">
                              {chip.label}
                            </summary>
                            {chip.detail !== undefined && (
                              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px] opacity-80">
                                {typeof chip.detail === "string"
                                  ? chip.detail
                                  : JSON.stringify(chip.detail, null, 2)}
                              </pre>
                            )}
                          </details>
                        );
                      })}
                    </div>
                  )}

                  {/* Artifacts attached to this bubble (Theme F.7) */}
                  {msg.artifacts && msg.artifacts.length > 0 && (
                    <div className="mt-2 flex flex-col gap-2">
                      {msg.artifacts.map((a) => (
                        <details
                          key={a.artifactKey}
                          className="rounded border border-emerald-500/30 bg-emerald-500/5"
                        >
                          <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/10">
                            <span className="font-semibold">
                              {a.title || "Artifact"}
                            </span>
                            <span className="rounded bg-charcoal-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-dimmed">
                              {a.kind}
                            </span>
                            {a.streaming ? (
                              <span className="text-amber-400">streaming…</span>
                            ) : (
                              <span className="text-[10px] text-text-dimmed">
                                rev {a.revision}
                              </span>
                            )}
                            {a.error ? (
                              <span className="text-[10px] text-rose-400">
                                {a.error}
                              </span>
                            ) : null}
                          </summary>
                          <div className="p-2">
                            <PlatosArtifact
                              artifact={{
                                id: a.id,
                                artifactKey: a.artifactKey,
                                type: a.kind,
                                content: a.content,
                                title: a.title ?? undefined,
                                revision: a.revision,
                                metadata: {
                                  ...(a.metadata ?? {}),
                                  ...(a.language ? { language: a.language } : {}),
                                },
                              }}
                            />
                          </div>
                        </details>
                      ))}
                    </div>
                  )}

                  {/* Thumbs rating (assistant only, post-persistence) */}
                  {msg.role === "assistant" &&
                    !msg.isStreaming &&
                    msg.persistedId &&
                    msg.content && (
                      <div className="mt-2 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => rateMessage(msg.id, 1)}
                          aria-label="Rate message thumbs up"
                          className={`rounded-md p-1 transition-colors ${
                            msg.rating === 1
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "text-text-dimmed hover:bg-charcoal-800 hover:text-emerald-400"
                          }`}
                        >
                          <HandThumbUpIcon className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => rateMessage(msg.id, -1)}
                          aria-label="Rate message thumbs down"
                          className={`rounded-md p-1 transition-colors ${
                            msg.rating === -1
                              ? "bg-red-500/20 text-red-400"
                              : "text-text-dimmed hover:bg-charcoal-800 hover:text-red-400"
                          }`}
                        >
                          <HandThumbDownIcon className="size-3.5" />
                        </button>
                      </div>
                    )}

                  {/* EOBD.69 — fork / edit / retry actions. Appears on hover.
                      Only when we have BOTH a threadId + a persisted message id.
                      User bubbles fork/edit, assistant bubbles fork/retry. */}
                  {currentThreadId &&
                    msg.content &&
                    (msg.role === "user" ||
                      (msg.role === "assistant" && msg.persistedId)) ? (
                    <ChatMessageActions
                      role={msg.role}
                      messageId={msg.persistedId ?? msg.id}
                      threadId={currentThreadId}
                      scope={scopeForProxy}
                      content={msg.content}
                      onForked={onForked}
                      onEditedAndRerun={onEditedAndRerun}
                      onRetry={onRetry}
                    />
                  ) : null}

                  {/* PRA-TC: reply count chip + "Reply in thread" button.
                      Both require persistedId — temp client IDs (bot-N) cannot be
                      used as threadReplyToId since they don't exist in the DB. */}
                  {enableThreading && !msg.threadReplyToId && msg.persistedId && (
                    <div className="mt-1.5 flex items-center gap-2">
                      {(msg.replyCount ?? 0) > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveThreadMessageId(msg.persistedId!);
                            setThreadMessages([]);
                          }}
                          className="flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 hover:underline"
                        >
                          <ChatBubbleLeftRightIcon className="size-3" />
                          {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setActiveThreadMessageId(msg.persistedId!);
                          setThreadMessages([]);
                        }}
                        className="hidden group-hover:flex items-center gap-1 text-[11px] text-text-dimmed hover:text-text-bright"
                      >
                        <ChatBubbleLeftRightIcon className="size-3" />
                        Reply in thread
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* PRA-TC: Thread panel — right-side drawer when a sub-thread is active */}
          {enableThreading && activeThreadMessageId && (
            <div className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-charcoal-700 bg-charcoal-900 shadow-xl">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2">
                <span className="text-xs font-medium text-text-dimmed">Thread</span>
                <button
                  type="button"
                  onClick={() => { setActiveThreadMessageId(null); setThreadMessages([]); setIsThreadStreaming(false); }}
                  className="rounded p-0.5 text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright"
                  aria-label="Close thread"
                >
                  <XMarkIcon className="size-4" />
                </button>
              </div>

              {/* Thread messages */}
              <div className="flex-1 overflow-y-auto space-y-2 px-2 py-3">
                {threadMessages.length === 0 && (
                  <p className="text-center text-xs text-text-dimmed italic">No replies yet. Send the first reply below.</p>
                )}
                {threadMessages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[90%] rounded-lg px-2.5 py-2 text-sm ${msg.role === "user" ? "bg-emerald-600/20 text-text-bright" : "bg-charcoal-750 text-text-bright"}`}>
                      {msg.content}
                      {msg.isStreaming && !msg.hasLanded && (
                        <span className="text-xs text-text-dimmed">Thinking…</span>
                      )}
                      {msg.isStreaming && msg.content && (
                        <span className="inline-block w-0.5 h-3 bg-emerald-400 ml-0.5 animate-pulse" />
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Thread composer */}
              <div className="border-t border-charcoal-700 px-2 py-2 flex gap-2">
                <textarea
                  value={threadInput}
                  onChange={(e) => setThreadInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendThreadMessage(); } }}
                  placeholder="Reply in thread…"
                  disabled={isThreadStreaming}
                  rows={2}
                  className="flex-1 resize-none rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={sendThreadMessage}
                  disabled={!threadInput.trim() || isThreadStreaming}
                  className="self-end rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          )}

          {/* Pending attachment tray */}
          {pendingAttachments.length > 0 && (
            <div className="border-t border-charcoal-700 px-2 sm:px-4 py-2 flex flex-wrap gap-2">
              {pendingAttachments.map((a) => (
                <div
                  key={a.localId}
                  className="relative flex items-center gap-2 rounded-md border border-charcoal-700 bg-charcoal-800/80 pl-1 pr-8 py-1"
                >
                  {a.previewUrl ? (
                    <img
                      src={a.previewUrl}
                      alt={a.file.name}
                      className="size-10 rounded object-cover"
                    />
                  ) : (
                    <div className="flex size-10 items-center justify-center rounded bg-charcoal-700">
                      <PaperClipIcon className="size-5 text-text-dimmed" />
                    </div>
                  )}
                  <div className="flex flex-col pr-1">
                    <span className="max-w-[140px] sm:max-w-[180px] truncate text-xs text-text-bright">
                      {a.file.name}
                    </span>
                    <span className="text-[10px] text-text-dimmed">
                      {humanizeBytes(a.file.size)}
                      {a.status === "uploading" && ` · ${a.progress}%`}
                      {a.status === "error" && ` · ${a.error}`}
                      {a.status === "ready" && " · ready"}
                    </span>
                    {a.status === "uploading" && (
                      <div className="mt-0.5 h-0.5 w-[140px] sm:w-[180px] bg-charcoal-700">
                        <div
                          className="h-full bg-emerald-500 transition-all"
                          style={{ width: `${a.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.localId)}
                    aria-label="Remove attachment"
                    className="absolute right-1 top-1 rounded p-0.5 text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright"
                  >
                    <XMarkIcon className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Model route selector — shown when the agent has multiple routes */}
          {agentModelRoutes && Array.isArray(agentModelRoutes) && agentModelRoutes.length > 1 && (
            <div className="flex items-center gap-2 px-2 py-1 border-b border-charcoal-700">
              <span className="text-xs text-text-dimmed">Model:</span>
              <select
                value={selectedModelLabel}
                onChange={(e) => setSelectedModelLabel(e.target.value)}
                className="rounded border border-charcoal-600 bg-charcoal-900 px-2 py-0.5 text-xs text-text-bright"
              >
                <option value="">Default ({(agentModelRoutes as any[]).find((r: any) => r.isDefault)?.label ?? (agentModelRoutes as any[])[0]?.label})</option>
                {(agentModelRoutes as any[]).map((r: any) => (
                  <option key={r.label} value={r.label}>{r.label} — {r.model.split(":").pop()}</option>
                ))}
              </select>
            </div>
          )}

          {/* Input — sticky on mobile so it doesn't scroll away. */}
          <div className="sticky bottom-0 border-t border-charcoal-700 bg-charcoal-900/80 backdrop-blur px-2 sm:px-4 py-2 sm:py-3">
            {rateLimit && (
              <div
                role="status"
                aria-live="polite"
                className="mb-2 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100"
              >
                <div className="flex items-center gap-2">
                  <span>
                    {rateLimit.scope === "user_per_day" || rateLimit.scope === "org_per_day"
                      ? rateLimit.message
                      : `Rate limit reached. Sending paused for `}
                  </span>
                  {rateLimit.scope !== "user_per_day" && rateLimit.scope !== "org_per_day" && (
                    <span className="font-mono text-amber-200">{rateLimitRemaining}s</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setRateLimit(null)}
                  aria-label="Dismiss rate limit notice"
                  className="rounded p-1 text-amber-200/70 hover:bg-amber-500/10 hover:text-amber-100"
                >
                  <XMarkIcon className="size-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5 sm:gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_MIME.join(",")}
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!connected || isStreaming || !!rateLimit}
                aria-label="Attach file"
                className="rounded-md p-2 text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright disabled:opacity-50"
              >
                <PaperClipIcon className="size-4" />
              </button>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder={rateLimit ? "Sending paused while rate limit clears." : "Type a message or drop a file..."}
                disabled={!connected || !!rateLimit}
                className="flex-1 min-w-0 rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {isStreaming ? (
                <Button
                  variant="danger/small"
                  onClick={() => socketRef.current?.emit("stop", {})}
                >
                  <StopIcon className="size-4" />
                </Button>
              ) : (
                <Button
                  variant="primary/small"
                  onClick={handleSend}
                  disabled={
                    (!input.trim() &&
                      pendingAttachments.every((a) => a.status !== "ready")) ||
                    !connected ||
                    !!rateLimit ||
                    softThrottled ||
                    pendingAttachments.some((a) => a.status === "uploading")
                  }
                >
                  <PaperAirplaneIcon className="size-4" />
                </Button>
              )}
            </div>
          </div>
          </div>

          {/* CTX.3 — session-context editor panel. Collapsible right-rail. */}
          {ctxPanelOpen && (
            <aside className="flex w-full max-w-[480px] flex-col overflow-y-auto bg-charcoal-900/40">
              <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2">
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-text-bright">
                    Session context
                  </span>
                  <span className="text-[11px] text-text-dimmed">
                    Per-thread key=value bag. Consumed by the runtime for prompt
                    substitution, tool-arg injection, and entity routing.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setCtxPanelOpen(false)}
                  aria-label="Close session context panel"
                  className="rounded p-1 text-text-dimmed hover:bg-charcoal-800 hover:text-text-bright"
                >
                  <XMarkIcon className="size-4" />
                </button>
              </div>

              <div className="flex flex-col gap-3 px-3 py-3">
                {!currentThreadId && (
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                    Send a message to start a thread — the editor saves to the
                    active thread only.
                  </div>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-text-dimmed">
                    Raw JSON
                  </span>
                  <textarea
                    value={ctxJson}
                    onChange={(e) => {
                      setCtxJson(e.target.value);
                      if (ctxParseError) setCtxParseError(null);
                    }}
                    onBlur={() => {
                      const trimmed = ctxJson.trim();
                      if (trimmed.length === 0) {
                        setCtxParseError(null);
                        return;
                      }
                      try {
                        const v = JSON.parse(trimmed);
                        if (v === null || typeof v !== "object" || Array.isArray(v)) {
                          setCtxParseError("must be a JSON object");
                          return;
                        }
                        setCtxParseError(null);
                      } catch (err) {
                        setCtxParseError(
                          err instanceof Error ? err.message : "invalid JSON",
                        );
                      }
                    }}
                    rows={12}
                    spellCheck={false}
                    className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-2 py-1.5 text-[12px] font-mono text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                  {ctxParseError && (
                    <span className="text-[11px] text-rose-300">
                      JSON error: {ctxParseError}
                    </span>
                  )}
                </label>

                <div>
                  <ctxFetcher.Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="save-session-context"
                    />
                    <input
                      type="hidden"
                      name="threadId"
                      value={currentThreadId ?? ""}
                    />
                    <input
                      type="hidden"
                      name="sessionContext"
                      value={ctxJson}
                    />
                    <Button
                      type="submit"
                      variant="primary/small"
                      disabled={
                        !currentThreadId ||
                        ctxParseError !== null ||
                        parsedCtx === null ||
                        ctxSaveState !== "idle"
                      }
                    >
                      {ctxSaveState === "submitting"
                        ? "Saving…"
                        : "Save to thread"}
                    </Button>
                  </ctxFetcher.Form>
                  {ctxActionData && "ok" in ctxActionData && ctxActionData.ok && (
                    <span className="ml-2 text-[11px] text-emerald-300">
                      saved
                    </span>
                  )}
                  {ctxActionData && "ok" in ctxActionData && !ctxActionData.ok && (
                    <span className="ml-2 text-[11px] text-rose-300">
                      {ctxActionData.error}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-text-dimmed">
                    Key → role preview
                  </span>
                  {classifiedKeys.length === 0 ? (
                    <span className="text-[11px] text-text-dimmed">
                      No keys yet.
                    </span>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {classifiedKeys.map(({ key, roles }) => (
                        <li
                          key={key}
                          className="flex items-center justify-between gap-2 rounded border border-charcoal-700 bg-charcoal-800/60 px-2 py-1 text-[11px]"
                        >
                          <span className="font-mono text-text-bright">
                            {key}
                          </span>
                          <span className="flex flex-wrap gap-1">
                            {roles.length === 0 ? (
                              <span className="text-text-dimmed">
                                unmapped
                              </span>
                            ) : (
                              roles.map((r) => (
                                <span
                                  key={r}
                                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                                    r.startsWith("tool:")
                                      ? "bg-sky-500/20 text-sky-200"
                                      : r === "prompt"
                                        ? "bg-emerald-500/20 text-emerald-200"
                                        : r === "envelope"
                                          ? "bg-violet-500/20 text-violet-200"
                                          : r === "entity-routing"
                                            ? "bg-amber-500/20 text-amber-200"
                                            : "bg-charcoal-700 text-text-dimmed"
                                  }`}
                                >
                                  {r}
                                </span>
                              ))
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {missingRefs.length > 0 && (
                  <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                    <div className="font-semibold">
                      Mapping references missing keys
                    </div>
                    <div className="mt-0.5">
                      The agent&apos;s contextMapping references keys not
                      present in this bag. Runtime will fall back to literal
                      placeholders.
                    </div>
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {missingRefs.map((k) => (
                        <li
                          key={k}
                          className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono"
                        >
                          {k}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!contextMapping && (
                  <div className="rounded border border-charcoal-700 bg-charcoal-800/60 px-2 py-1.5 text-[11px] text-text-dimmed">
                    This agent has no contextMapping declared — context keys
                    are stored but not auto-injected. Configure the mapping on
                    the agent edit page to enable prompt / tool / routing use.
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
    </PageBody>
  );
}
