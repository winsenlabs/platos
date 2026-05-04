/**
 * Theme F.9 — per-message hover actions in the chat UI.
 *
 * Renders Fork / Edit / Retry buttons on hover. Each wraps a scoped
 * `/resources/agent` proxy call (loader route; see
 * `apps/webapp/app/routes/resources.agent.ts`) so the scope is resolved
 * from the current route's `(org, project, env)` tuple rather than
 * trusting client state.
 *
 * Behaviour:
 *   - **Fork** — always available (user + assistant messages). Issues
 *     `POST /api/v1/agent/threads/:id/fork` with `upToMessageId = msg.id`.
 *     On success the caller navigates to the new thread.
 *   - **Edit** — user messages only. Swaps the message body into a
 *     `<textarea>` + Save/Cancel. Save posts
 *     `POST /api/v1/agent/threads/:threadId/messages/:messageId/edit-and-rerun`
 *     then kicks off a streaming turn via the Socket.IO `message` event
 *     reusing the existing thread id.
 *   - **Retry** — assistant messages only. POSTs `/retry` and then
 *     re-emits the preceding user message via the agent socket so the
 *     assistant turn regenerates in place.
 *
 * `aria-label` on every button satisfies the F.9 a11y constraint. All
 * fetches go through the scope-aware proxy — no cross-origin leakage.
 */
import { ArrowPathIcon, ArrowsRightLeftIcon, PencilIcon } from "@heroicons/react/20/solid";
import { useState } from "react";

export interface MessageActionsScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

export interface MessageActionsProps {
  role: "user" | "assistant" | "tool";
  messageId: string;
  threadId: string;
  scope: MessageActionsScope;
  /** Called after a successful fork. Parent navigates to the fork. */
  onForked: (newThreadId: string) => void;
  /**
   * Called after a successful edit-and-rerun. Parent replays the new user
   * message via the agent socket to trigger regeneration.
   */
  onEditedAndRerun: (newUserContent: string) => void;
  /**
   * Called after a successful retry. Parent re-emits the prior user
   * message via the agent socket to regenerate the assistant turn.
   */
  onRetry: (priorUserContent: string) => void;
  /** Original message content — needed as default for the edit textarea. */
  content: string;
}

async function agentProxy(
  path: string,
  scope: MessageActionsScope,
  body?: unknown,
): Promise<Response> {
  const search = new URLSearchParams({
    path,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  });
  return fetch(`/resources/agent?${search.toString()}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function ChatMessageActions(props: MessageActionsProps) {
  const {
    role,
    messageId,
    threadId,
    scope,
    onForked,
    onEditedAndRerun,
    onRetry,
    content,
  } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const [busy, setBusy] = useState<"fork" | "edit" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function doFork() {
    setBusy("fork");
    setError(null);
    try {
      const res = await agentProxy(
        `/api/v1/agent/threads/${threadId}/fork`,
        scope,
        { upToMessageId: messageId },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `Fork failed (${res.status})`);
      }
      const data = (await res.json()) as { id?: string; error?: string };
      if (!data.id) throw new Error(data.error || "Fork response missing id");
      onForked(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fork failed");
    } finally {
      setBusy(null);
    }
  }

  async function doEditSave() {
    const newContent = draft.trim();
    if (!newContent || newContent === content) {
      setEditing(false);
      return;
    }
    setBusy("edit");
    setError(null);
    try {
      const res = await agentProxy(
        `/api/v1/agent/threads/${threadId}/messages/${messageId}/edit-and-rerun`,
        scope,
        { content: newContent },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `Edit failed (${res.status})`);
      }
      setEditing(false);
      onEditedAndRerun(newContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edit failed");
    } finally {
      setBusy(null);
    }
  }

  async function doRetry() {
    setBusy("retry");
    setError(null);
    try {
      const res = await agentProxy(
        `/api/v1/agent/threads/${threadId}/messages/${messageId}/retry`,
        scope,
        {},
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error || `Retry failed (${res.status})`);
      }
      const data = (await res.json()) as {
        priorUserMessage?: { content?: string | null } | null;
        error?: string;
      };
      const prior = data?.priorUserMessage?.content;
      if (!prior) throw new Error(data?.error || "No prior user message to retry");
      onRetry(prior);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  }

  if (editing) {
    return (
      <div className="mt-2 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(12, Math.max(2, draft.split("\n").length + 1))}
          aria-label="Edit message"
          className="w-full rounded-md border border-charcoal-600 bg-charcoal-800 px-3 py-2 text-sm text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />
        <div className="flex items-center justify-end gap-2">
          {error ? <span className="text-xs text-rose-400">{error}</span> : null}
          <button
            type="button"
            onClick={() => {
              setDraft(content);
              setEditing(false);
              setError(null);
            }}
            aria-label="Cancel edit"
            className="rounded-md border border-charcoal-600 bg-transparent px-2 py-1 text-xs text-text-dimmed hover:bg-charcoal-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doEditSave}
            disabled={busy === "edit"}
            aria-label="Save edit and rerun"
            className="rounded-md bg-emerald-600/20 border border-emerald-600/30 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-50"
          >
            {busy === "edit" ? "Saving…" : "Save & rerun"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="platos-message-actions mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={doFork}
        disabled={busy !== null}
        aria-label="Fork conversation from this message"
        title="Fork from here"
        className="inline-flex items-center gap-1 rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-[11px] text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright disabled:opacity-50"
      >
        <ArrowsRightLeftIcon className="size-3" />
        Fork
      </button>
      {role === "user" ? (
        <button
          type="button"
          onClick={() => {
            setDraft(content);
            setEditing(true);
          }}
          disabled={busy !== null}
          aria-label="Edit this message and rerun the agent"
          title="Edit and rerun"
          className="inline-flex items-center gap-1 rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-[11px] text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright disabled:opacity-50"
        >
          <PencilIcon className="size-3" />
          Edit
        </button>
      ) : null}
      {role === "assistant" ? (
        <button
          type="button"
          onClick={doRetry}
          disabled={busy !== null}
          aria-label="Retry this assistant response"
          title="Retry"
          className="inline-flex items-center gap-1 rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-[11px] text-text-dimmed hover:bg-charcoal-700 hover:text-text-bright disabled:opacity-50"
        >
          <ArrowPathIcon className="size-3" />
          {busy === "retry" ? "Retrying…" : "Retry"}
        </button>
      ) : null}
      {error ? <span className="text-[11px] text-rose-400">{error}</span> : null}
    </div>
  );
}
