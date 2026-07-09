import {
  ArchiveBoxIcon,
  ArrowLeftIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  PaperAirplaneIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction, useNavigate } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ArtifactPanel, type ThreadArtifact } from "~/components/platos/ArtifactPanel";
import { ChatMessageActions } from "~/components/platos/ChatMessageActions";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { mintPlatosSessionToken } from "~/services/platosSessionToken.server";
import {
  agentConversationPath,
  agentConversationsPath,
  agentTracePath,
  v3RunPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Conversation | Platos" }];

// Live streaming message appended to the loader-provided history.
interface StreamedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  toolCalls?: Array<{ type: string; name: string; result?: unknown }>;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const threadId = params.threadId!;
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

  let thread: any = null;
  let messages: any[] = [];
  let initialArtifacts: ThreadArtifact[] = [];

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const headers = {
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      };

      // Theme F.9 — seed the artifact panel with history via the new
      // per-thread artifacts endpoint. Live `artifact_*` stream events
      // overlay on top of this list as they arrive.
      // Operator console — pass allUsers so the platform owner can open a
      // conversation created under a simulated / embed / SDK end-user id.
      // The conversations list already uses allUsers; the detail must match
      // it or opening a listed thread 404s.
      const [threadRes, msgsRes, artRes] = await Promise.all([
        fetch(`${AGENT_API_URL}/api/v1/agent/threads/${threadId}?allUsers=true`, { headers }),
        fetch(`${AGENT_API_URL}/api/v1/agent/threads/${threadId}/messages?limit=100&allUsers=true`, { headers }),
        fetch(`${AGENT_API_URL}/api/v1/agent/threads/${threadId}/artifacts`, { headers }),
      ]);

      if (threadRes.ok) {
        const data = (await threadRes.json()) as any;
        // The endpoint returns `{ error, status: 404 }` as an HTTP 200 when
        // the thread isn't found — never render that as a thread (that's
        // what surfaced as "404 turns" + "Created: Invalid Date").
        if (data && !data.error) thread = data as typeof thread;
      }
      if (msgsRes.ok) {
        const data = (await msgsRes.json()) as { messages?: any[] };
        messages = data.messages || [];
      }
      if (artRes.ok) {
        const data = (await artRes.json()) as { artifacts?: any[] };
        initialArtifacts = (data.artifacts || []).map(
          (a): ThreadArtifact => ({
            id: a.id,
            artifactKey: a.artifactKey,
            revision: a.revision,
            kind: a.kind,
            title: a.title ?? null,
            language: a.language ?? null,
            content: a.content,
            metadata: (a.metadata as Record<string, unknown> | null) ?? null,
            createdAt:
              typeof a.createdAt === "string"
                ? a.createdAt
                : new Date(a.createdAt).toISOString(),
            revisionCount: typeof a.revisionCount === "number" ? a.revisionCount : 1,
          }),
        );
      }
    }
  } catch {}

  // PPR-7 — mint a platform-issued session token so the browser handshake
  // survives the agent's viaProxy check (Caddy stamps X-Forwarded-For).
  const sessionToken = mintPlatosSessionToken(scope, 3600);

  // K.3 — load all durable runs spawned from this thread (spawn_bgo,
  // agent-tool-block, agent-batch — anything the agent runtime spawned with
  // `metadata.set("threadId", threadId)`). Scoped to (project, env), then
  // JSON-parsed per row to confirm the threadId matches exactly (the DB
  // column is a `String` — we use `contains` as a cheap pre-filter and
  // verify after). Missing metadata / parse failures silently drop out.
  let spawnedRuns: Array<{
    friendlyId: string;
    taskIdentifier: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  }> = [];
  try {
    const candidates = await $replica.taskRun.findMany({
      where: {
        projectId: project.id,
        runtimeEnvironmentId: environment.id,
        metadata: { contains: `"threadId":"${threadId}"` },
      },
      select: {
        friendlyId: true,
        taskIdentifier: true,
        status: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        metadata: true,
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    spawnedRuns = candidates
      .filter((r) => {
        if (!r.metadata) return false;
        try {
          const parsed = JSON.parse(r.metadata);
          return parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).threadId === threadId;
        } catch {
          return false;
        }
      })
      .map((r) => ({
        friendlyId: r.friendlyId,
        taskIdentifier: r.taskIdentifier,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      }));
  } catch {
    spawnedRuns = [];
  }

  return typedjson({
    thread,
    messages,
    initialArtifacts,
    agentId,
    threadId,
    userId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    wsUrl: process.env.PLATOS_AGENT_PUBLIC_WS_URL || process.env.PLATOS_AGENT_WS_URL || "http://localhost:3100",
    // Single-domain deploys serve the agent Socket.io on a distinct path
    // (see the chat route). Null → default path.
    wsPath: process.env.PLATOS_AGENT_WS_PATH || null,
    sessionToken: sessionToken?.token ?? null,
    spawnedRuns,
  });
}

export default function ConversationViewerPage() {
  const {
    thread,
    messages,
    initialArtifacts,
    agentId,
    threadId,
    userId,
    organizationId,
    projectId,
    environmentId,
    wsUrl,
    wsPath,
    sessionToken,
    spawnedRuns,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();

  // Live messages emitted after this page mounts (loader `messages` renders above).
  const [liveMessages, setLiveMessages] = useState<StreamedMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  // Theme F.9 — artifact panel state. `artifacts` merges loader-seeded
  // history with live-stream updates keyed by artifactKey; `panelOpen`
  // controls drawer visibility (toggleable via button or keyboard).
  const [artifacts, setArtifacts] = useState<ThreadArtifact[]>(initialArtifacts);
  const [panelOpen, setPanelOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<any>(null);
  const msgCounterRef = useRef(0);
  // Continue the existing thread from the URL param -- no new thread created.
  const threadIdRef = useRef<string>(threadId);

  const scopeForProxy = {
    organizationId,
    projectId,
    environmentId,
  };

  // Helper: upsert an artifact row by artifactKey. Used by every
  // `artifact_*` branch so stream updates never duplicate rows.
  const upsertArtifact = useCallback(
    (patch: Partial<ThreadArtifact> & { artifactKey: string }) => {
      setArtifacts((prev) => {
        const idx = prev.findIndex((a) => a.artifactKey === patch.artifactKey);
        if (idx === -1) {
          // New artifact — seed with sane defaults.
          return [
            {
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
            } satisfies ThreadArtifact,
            ...prev,
          ];
        }
        const existing = prev[idx]!;
        const next: ThreadArtifact = {
          ...existing,
          ...patch,
          metadata: patch.metadata ?? existing.metadata,
          // Bump revisionCount when we observe a newer revision than we had.
          revisionCount:
            patch.revision !== undefined && patch.revision > existing.revision
              ? (existing.revisionCount ?? 1) + 1
              : existing.revisionCount,
        };
        const out = [...prev];
        out[idx] = next;
        return out;
      });
    },
    [],
  );

  // Auto-scroll on new live content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveMessages]);

  // Connect to the agent WS namespace and wire streaming event handlers.
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    import("socket.io-client").then(({ io }) => {
      const socket = io(`${wsUrl}/agent`, {
        auth: sessionToken
          ? { token: sessionToken }
          : { organizationId, projectId, environmentId, userId },
        transports: ["websocket"],
        ...(wsPath ? { path: wsPath } : {}),
      });

      socket.on("connected", () => {
        setConnected(true);
        // Join the existing thread's room so server routes events to us.
        socket.emit("join_thread", { threadId: threadIdRef.current });
      });
      socket.on("disconnect", () => setConnected(false));

      socket.on("agent_event", (event: any) => {
        switch (event.type) {
          case "token":
            setLiveMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.isStreaming) {
                return [...prev.slice(0, -1), { ...last, content: last.content + event.text }];
              }
              return prev;
            });
            break;

          case "tool_call":
            setLiveMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    toolCalls: [...(last.toolCalls || []), { type: "call", name: event.name }],
                  },
                ];
              }
              return prev;
            });
            break;

          case "tool_result":
            setLiveMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                const calls = [...(last.toolCalls || [])];
                const idx = calls.findIndex((c) => c.name === event.name && c.type === "call");
                if (idx >= 0) {
                  calls[idx] = { type: "result", name: event.name, result: event.result };
                }
                return [...prev.slice(0, -1), { ...last, toolCalls: calls }];
              }
              return prev;
            });
            break;

          case "message_boundary":
            setLiveMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant") {
                return [
                  ...prev.slice(0, -1),
                  { ...last, isStreaming: false },
                  {
                    id: `bot-${++msgCounterRef.current}`,
                    role: "assistant",
                    content: "",
                    isStreaming: true,
                  },
                ];
              }
              return prev;
            });
            break;

          case "done":
            setLiveMessages((prev) =>
              prev.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
            );
            setIsStreaming(false);
            break;

          case "error":
            setLiveMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.isStreaming) {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    content: last.content + `\n\n[Error: ${event.message}]`,
                    isStreaming: false,
                  },
                ];
              }
              return prev;
            });
            setIsStreaming(false);
            break;

          // PRELAUNCH-A2-18 — silently consume the broader event types so
          // they don't fall through to a noisy console warn. Most are
          // bookkeeping signals (meta, thinking, safety flags, structured
          // output, trace events, message_persisted) the conversations
          // route doesn't render today; consuming them here keeps the
          // conversation viewer's stream clean and parity with the chat
          // route's switch shape. UI rendering for these surfaces lives
          // on the chat playground; the conversations viewer is read-mostly.
          case "meta":
          case "thinking":
          case "reasoning":
          case "safety_flags":
          case "structured_output":
          case "run_update":
          case "approval_needed":
          case "approval_resolved":
          case "approval_response":
          case "citation":
          case "artifact":
          case "trace_request":
          case "trace_step":
          case "message_persisted":
          case "status":
          case "heartbeat":
            // No-op — see comment above.
            break;

          // Theme F.9 — artifact lifecycle. `artifact_start` opens a
          // placeholder card in the panel; `artifact_delta` appends
          // streaming chunks; `artifact_committed` replaces with the final
          // content + clears `streaming`; `artifact_error` marks the row.
          case "artifact_start":
            upsertArtifact({
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
            // Auto-open the panel on first artifact so the user doesn't miss it.
            setPanelOpen((open) => open || true);
            break;

          case "artifact_delta":
            setArtifacts((prev) =>
              prev.map((a) =>
                a.artifactKey === event.artifactKey
                  ? { ...a, content: (a.content ?? "") + (event.chunk ?? "") }
                  : a,
              ),
            );
            break;

          case "artifact_committed":
            upsertArtifact({
              id: event.artifactId,
              artifactKey: event.artifactKey,
              revision: event.revision,
              kind: event.kind,
              title: event.title ?? null,
              language: event.language ?? null,
              content: event.finalContent,
              createdAt: event.createdAt,
              streaming: false,
              error: undefined,
            });
            break;

          case "artifact_error":
            if (event.artifactKey) {
              upsertArtifact({
                artifactKey: event.artifactKey,
                streaming: false,
                error: event.message || event.code,
              });
            }
            break;
        }
      });

      socketRef.current = socket;
      cleanup = () => socket.disconnect();
    });

    return () => {
      cleanup?.();
    };
  }, [wsUrl, wsPath, organizationId, projectId, environmentId, userId]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text || !socketRef.current || isStreaming) return;

      const userMsg: StreamedMessage = {
        id: `user-${++msgCounterRef.current}`,
        role: "user",
        content: text,
      };
      const botMsg: StreamedMessage = {
        id: `bot-${++msgCounterRef.current}`,
        role: "assistant",
        content: "",
        isStreaming: true,
      };

      setLiveMessages((prev) => [...prev, userMsg, botMsg]);
      setIsStreaming(true);

      // Always reuse the URL thread -- preserves history.
      socketRef.current.emit("message", {
        message: text,
        agentId,
        threadId: threadIdRef.current,
      });
    },
    [agentId, isStreaming],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    sendMessage(text);
    inputRef.current?.focus();
  }, [input, sendMessage]);

  // Theme F.9 — fork action: navigate to the new thread's conversation URL.
  const onForked = useCallback(
    (newThreadId: string) => {
      navigate(
        agentConversationPath(organization, project, environment, agentId, newThreadId),
      );
    },
    [navigate, organization, project, environment, agentId],
  );

  // Theme F.9 — edit-and-rerun: the server already soft-deleted the old
  // message + persisted the new user revision. We kick off a fresh turn
  // via the socket to regenerate the assistant response in-place.
  const onEditedAndRerun = useCallback(
    (newUserContent: string) => {
      sendMessage(newUserContent);
    },
    [sendMessage],
  );

  // Theme F.9 — retry: the server returned the prior user message; re-emit
  // it so the agent regenerates the assistant turn without the user
  // retyping anything.
  const onRetry = useCallback(
    (priorUserContent: string) => {
      sendMessage(priorUserContent);
    },
    [sendMessage],
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={thread?.title || "Conversation"}
          icon={<ChatBubbleLeftRightIcon className="size-5 text-emerald-500" />}
        />
        <PageAccessories>
          <Badge variant={connected ? "success" : "error"}>
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${connected ? "bg-green-500" : "bg-red-500"}`}
            />
            {connected ? "Connected" : "Disconnected"}
          </Badge>
          <Button
            variant="tertiary/small"
            LeadingIcon={ArchiveBoxIcon}
            onClick={() => setPanelOpen((o) => !o)}
            aria-label={panelOpen ? "Close artifacts panel" : "Open artifacts panel"}
            aria-expanded={panelOpen}
          >
            Artifacts ({artifacts.length})
          </Button>
          <LinkButton
            to={agentTracePath(organization, project, environment, agentId, threadId)}
            variant="tertiary/small"
            LeadingIcon={BoltIcon}
          >
            View Trace
          </LinkButton>
          <LinkButton
            to={agentConversationsPath(organization, project, environment, agentId)}
            variant="tertiary/small"
            LeadingIcon={ArrowLeftIcon}
          >
            Back to Conversations
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="flex h-[calc(100vh-9rem)]">
          {/* Chat column (shrinks when the artifact panel is open) */}
          <div className="flex flex-1 flex-col min-w-0">
          {/* Thread metadata */}
          {thread && (
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-charcoal-700">
              <Badge variant={thread.status === "active" ? "success" : "outline-rounded"}>
                {thread.status}
              </Badge>
              <span className="text-xs text-text-dimmed">{thread.turnCount} turns</span>
              <span className="text-xs text-text-dimmed">
                Created: {new Date(thread.createdAt).toLocaleString()}
              </span>
            </div>
          )}

          {/*
            K.3 — Spawned runs. Surfaces the durable trigger.dev runs that
            this thread kicked off (spawn_bgo, agent-tool-block, agent-batch)
            so an operator can walk from Agent > Thread > Run without
            digging through the global run list. Collapsed by default to
            keep the chat viewport tall. Empty list still renders the
            disclosure so it's discoverable.
          */}
          <details className="mb-4 rounded border border-charcoal-700 bg-charcoal-850 overflow-hidden">
            <summary className="flex items-center justify-between px-3 py-2 text-xs cursor-pointer hover:bg-charcoal-750 select-none">
              <span className="text-text-bright font-medium">
                Spawned runs{" "}
                <span className="text-text-dimmed font-normal">({spawnedRuns.length})</span>
              </span>
              <span className="text-text-dimmed">Click to expand</span>
            </summary>
            <div className="border-t border-charcoal-700">
              {spawnedRuns.length === 0 ? (
                <div className="px-3 py-4 text-xs text-text-dimmed text-center">
                  No durable runs spawned from this thread yet.
                </div>
              ) : (
                <ul className="divide-y divide-charcoal-700">
                  {spawnedRuns.map((r) => {
                    const startedAt = r.startedAt ? new Date(r.startedAt) : null;
                    const completedAt = r.completedAt ? new Date(r.completedAt) : null;
                    const durationMs =
                      startedAt && completedAt ? completedAt.getTime() - startedAt.getTime() : null;
                    const durationLabel =
                      durationMs === null
                        ? "\u2014"
                        : durationMs < 1000
                          ? `${durationMs}ms`
                          : `${(durationMs / 1000).toFixed(2)}s`;
                    const statusClass =
                      r.status === "COMPLETED_SUCCESSFULLY"
                        ? "text-green-400"
                        : r.status === "COMPLETED_WITH_ERRORS" ||
                            r.status === "CRASHED" ||
                            r.status === "SYSTEM_FAILURE" ||
                            r.status === "TIMED_OUT"
                          ? "text-red-400"
                          : r.status === "CANCELED" || r.status === "EXPIRED"
                            ? "text-text-dimmed"
                            : "text-amber-400";
                    const href = v3RunPath(organization, project, environment, {
                      friendlyId: r.friendlyId,
                    });
                    return (
                      <li key={r.friendlyId}>
                        <a
                          href={href}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-charcoal-800"
                        >
                          <span className="font-mono text-xs text-text-bright truncate flex-1 min-w-0">
                            {r.taskIdentifier}
                          </span>
                          <span className={`text-xs shrink-0 ${statusClass}`}>{r.status}</span>
                          <span className="text-xs text-text-dimmed shrink-0 w-14 text-right">
                            {durationLabel}
                          </span>
                          <span className="font-mono text-xs text-text-dimmed shrink-0">
                            {r.friendlyId}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </details>

          {/* Messages (scrollable) */}
          <div className="flex-1 overflow-y-auto">
            {messages.length === 0 && liveMessages.length === 0 ? (
              <div className="text-center py-12 text-text-dimmed">
                <Paragraph variant="base/bright">No messages in this conversation.</Paragraph>
              </div>
            ) : (
              <div className="space-y-4 max-w-3xl">
                {/* Loader-provided history (full-fidelity rendering preserved) */}
                {messages.map((msg: any) => (
                  <div
                    key={msg.id}
                    className={`group rounded-lg px-4 py-3 ${
                      msg.role === "user"
                        ? "bg-emerald-600/10 border border-emerald-600/20 ml-8"
                        : msg.role === "tool"
                          ? "bg-amber-600/10 border border-amber-600/20 mx-4"
                          : "bg-charcoal-750 border border-charcoal-700 mr-8"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className={`text-xs font-semibold ${
                          msg.role === "user"
                            ? "text-emerald-400"
                            : msg.role === "tool"
                              ? "text-amber-400"
                              : "text-blue-400"
                        }`}
                      >
                        {msg.role === "user" ? "You" : msg.role === "tool" ? "Tool" : "Agent"}
                      </span>
                      <span className="text-xs text-text-dimmed">
                        {new Date(msg.createdAt).toLocaleTimeString()}
                      </span>
                    </div>

                    {msg.content && (
                      <div className="text-sm text-text-bright whitespace-pre-wrap">
                        {msg.content}
                      </div>
                    )}

                    {msg.toolCalls && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {msg.toolCalls.map((tc: any, i: number) => (
                          <details
                            key={i}
                            className="rounded border border-charcoal-600 bg-charcoal-800 overflow-hidden"
                          >
                            <summary className="px-3 py-1.5 text-xs cursor-pointer hover:bg-charcoal-750">
                              <span className={tc.type === "result" ? "text-green-400" : "text-amber-400"}>
                                {tc.type === "result" ? "Result" : "Call"}:
                              </span>{" "}
                              <span className="font-mono">{tc.name}</span>
                            </summary>
                            <pre className="px-3 py-2 text-xs text-text-dimmed overflow-x-auto border-t border-charcoal-600">
                              {JSON.stringify(tc.result || tc.params || tc, null, 2)}
                            </pre>
                          </details>
                        ))}
                      </div>
                    )}

                    {msg.thinkingContent && (
                      <details className="mt-2 rounded border border-purple-600/30 bg-purple-600/5 overflow-hidden">
                        <summary className="px-3 py-1.5 text-xs text-purple-400 cursor-pointer">
                          Thinking ({msg.thinkingContent.length} chars)
                        </summary>
                        <div className="px-3 py-2 text-xs text-text-dimmed whitespace-pre-wrap border-t border-purple-600/20">
                          {msg.thinkingContent}
                        </div>
                      </details>
                    )}

                    {msg.responseJson && (
                      <div className="mt-2 flex items-center gap-3 text-xs text-text-dimmed">
                        {msg.responseJson.model && <span>Model: {msg.responseJson.model}</span>}
                        {msg.responseJson.usage && (
                          <span>
                            Tokens: {msg.responseJson.usage.inputTokens || 0} in /{" "}
                            {msg.responseJson.usage.outputTokens || 0} out
                          </span>
                        )}
                        {msg.responseJson.cost_cents !== undefined && (
                          <span>Cost: ${(msg.responseJson.cost_cents / 100).toFixed(4)}</span>
                        )}
                      </div>
                    )}

                    {/* Theme F.9 — per-message hover actions. Tool messages
                        have no fork/edit/retry semantics (they're emitted
                        by the runtime, not the user), so skip them. */}
                    {(msg.role === "user" || msg.role === "assistant") && msg.content ? (
                      <ChatMessageActions
                        role={msg.role}
                        messageId={msg.id}
                        threadId={threadId}
                        scope={scopeForProxy}
                        content={msg.content}
                        onForked={onForked}
                        onEditedAndRerun={onEditedAndRerun}
                        onRetry={onRetry}
                      />
                    ) : null}
                  </div>
                ))}

                {/* Live messages emitted this session */}
                {liveMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`rounded-lg px-4 py-3 ${
                      msg.role === "user"
                        ? "bg-emerald-600/10 border border-emerald-600/20 ml-8"
                        : "bg-charcoal-750 border border-charcoal-700 mr-8"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className={`text-xs font-semibold ${
                          msg.role === "user" ? "text-emerald-400" : "text-blue-400"
                        }`}
                      >
                        {msg.role === "user" ? "You" : "Agent"}
                      </span>
                    </div>

                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-2 space-y-1">
                        {msg.toolCalls.map((tc, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs text-text-dimmed">
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${tc.type === "result" ? "bg-green-500" : "bg-amber-500 animate-pulse"}`}
                            />
                            <span className="font-mono">{tc.name}</span>
                            {tc.type === "result" && <span className="text-green-400">done</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="text-sm text-text-bright whitespace-pre-wrap">
                      {msg.content}
                    </div>

                    {msg.isStreaming && msg.content && (
                      <span className="inline-block w-0.5 h-4 bg-emerald-400 ml-0.5 animate-pulse" />
                    )}
                    {msg.isStreaming && !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0) && (
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
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-charcoal-700 px-4 py-3 mt-4">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                placeholder="Continue this conversation..."
                disabled={!connected}
                className="flex-1 rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              {isStreaming ? (
                <Button variant="danger/small" onClick={() => socketRef.current?.emit("stop", {})}>
                  <StopIcon className="size-4" />
                </Button>
              ) : (
                <Button
                  variant="primary/small"
                  onClick={handleSend}
                  disabled={!input.trim() || !connected}
                >
                  <PaperAirplaneIcon className="size-4" />
                </Button>
              )}
            </div>
          </div>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
