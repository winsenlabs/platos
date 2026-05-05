"use client";

import { PlatosClient } from "@platosdev/client";
import { PlatosClientProvider, useAgentStream } from "@platos/react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";

function useClientFromToken(baseUrl: string) {
  const [client, setClient] = useState<PlatosClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/platos/token", { method: "POST" });
      const { token } = await res.json();
      if (cancelled) return;
      setClient(
        new PlatosClient({
          baseUrl,
          sessionToken: token,
          onTokenRefresh: async () => {
            const r = await fetch("/platos/token", { method: "POST" });
            const body = await r.json();
            return body.token;
          },
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return client;
}

function Chat({ agentId }: { agentId: string }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { events, isStreaming, error } = useAgentStream(threadId, pending, { agentId });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events]);

  const bodyText = useMemo(
    () =>
      events
        .filter((e) => e.type === "delta" || e.type === "token")
        .map((e) => (e["text"] as string) ?? "")
        .join(""),
    [events],
  );

  async function onSend() {
    if (!inputValue.trim()) return;
    if (!threadId) {
      // First message — defer thread creation to the server on next send.
      // MVP: trigger a stream with no thread id; server auto-creates.
      setThreadId("new");
    }
    setPending(inputValue);
    setInputValue("");
  }

  return (
    <div style={{ maxWidth: 640, margin: "24px auto", fontFamily: "system-ui" }}>
      <h1>Platos agent chat</h1>
      <div
        ref={scrollRef}
        style={{ height: 420, overflow: "auto", border: "1px solid #ddd", padding: 12, borderRadius: 8 }}
      >
        <pre style={{ whiteSpace: "pre-wrap" }}>{bodyText || "(Say hi…)"}</pre>
        {isStreaming && <div style={{ opacity: 0.6 }}>streaming…</div>}
        {error && <div style={{ color: "crimson" }}>error: {error.message}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          style={{ flex: 1, padding: 8 }}
          placeholder="Type a message…"
        />
        <button onClick={onSend} disabled={isStreaming}>
          Send
        </button>
      </div>
    </div>
  );
}

export default function Page() {
  const baseUrl = process.env.NEXT_PUBLIC_PLATOS_BASE_URL || "http://localhost:3100";
  const agentId = process.env.NEXT_PUBLIC_PLATOS_AGENT_ID || "agt_demo";
  const client = useClientFromToken(baseUrl);
  if (!client) return <div style={{ padding: 24 }}>Loading…</div>;
  return (
    <PlatosClientProvider client={client}>
      <Chat agentId={agentId} />
    </PlatosClientProvider>
  );
}
