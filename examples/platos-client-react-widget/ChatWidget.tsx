/**
 * React chat widget example. Theme I.11.
 *
 * Drop `<ChatWidget agentId=...>` inside a `<PlatosProvider>` and you
 * have a working chat UI — typed-token streaming, tool-call indicator,
 * inline artifact rendering.
 */

import { useMemo, useState } from "react";
import {
  PlatosProvider,
  useAgentStream,
  useStreamingResponse,
  usePlatosClient,
} from "@platos/react-hooks";
import { PlatosClient } from "@platosdev/client";

type WidgetProps = {
  baseUrl: string;
  sessionToken: string;
  agentId: string;
};

export function ChatWidget({ baseUrl, sessionToken, agentId }: WidgetProps) {
  const client = useMemo(
    () => new PlatosClient({ baseUrl, sessionToken }),
    [baseUrl, sessionToken],
  );
  return (
    <PlatosProvider client={client as unknown as Parameters<typeof PlatosProvider>[0]["client"]}>
      <ChatInner agentId={agentId} />
    </PlatosProvider>
  );
}

function ChatInner({ agentId }: { agentId: string }) {
  const client = usePlatosClient();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const { events, tokens, isStreaming, cancel } = useAgentStream(threadId, pending, { agentId });
  const { done } = useStreamingResponse(events);

  async function onSend(form: FormData) {
    const input = String(form.get("input") ?? "").trim();
    if (!input) return;
    let id = threadId;
    if (!id) {
      const thread = (await client.threads.create(undefined, { agentId })) as { id: string };
      id = thread.id;
      setThreadId(id);
    }
    setPending(input);
  }

  return (
    <div className="platos-chat-widget">
      <div className="platos-chat-widget__messages">
        <pre>{tokens}</pre>
        {isStreaming && <span className="platos-chat-widget__cursor" aria-hidden>▋</span>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSend(new FormData(e.currentTarget));
          e.currentTarget.reset();
        }}
      >
        <input name="input" placeholder="Ask me anything…" autoComplete="off" />
        <button type="submit" disabled={isStreaming}>
          Send
        </button>
        {isStreaming && (
          <button type="button" onClick={cancel}>
            Stop
          </button>
        )}
      </form>
      {done && <small>done ✓</small>}
    </div>
  );
}
