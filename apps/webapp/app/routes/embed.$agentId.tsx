/**
 * `/embed/:agentId` — iframe-embedded chat widget for public-guest agents.
 *
 * This route is the iframe target of the `<platos-agent>` web
 * component (@platos/embed). It:
 *   1. Fetches the agent's public metadata (name, theme hints) —
 *      404s if the agent isn't marked public-guest so attackers can't
 *      enumerate private agent ids.
 *   2. Client-side calls `/api/v1/public/guest-token` to mint a
 *      session token.
 *   3. Opens a Socket.IO connection with the guest token.
 *   4. Renders a minimal chat UI — no dashboard chrome.
 *
 * EOBD.89 + EOBD.90.
 */

import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const agentId = params.agentId;
  if (!agentId || !/^[A-Za-z0-9_\-]{1,64}$/.test(agentId)) {
    throw new Response(undefined, { status: 404 });
  }

  const agent = await prisma.platosAgent.findUnique({
    where: { id: agentId },
    select: { id: true, name: true, visibility: true, isActive: true },
  });
  if (!agent || agent.visibility !== "public-guest" || !agent.isActive) {
    // 404 instead of 403 so private agent ids can't be enumerated.
    throw new Response(undefined, { status: 404 });
  }

  const url = new URL(request.url);
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  // Public-facing URL for the agent API — browser calls this directly.
  // Falls back to process.env since the embed route is public and
  // doesn't touch the scoped env surface.
  const agentApiUrl =
    process.env.PLATOS_AGENT_PUBLIC_API_URL ||
    process.env.PLATOS_AGENT_API_URL ||
    "http://localhost:3100";

  return typedjson({
    agentId: agent.id,
    agentName: agent.name,
    theme,
    agentApiUrl,
  });
}

export default function EmbedAgent() {
  const { agentId, agentName, theme, agentApiUrl } =
    useTypedLoaderData<typeof loader>();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: "user" | "bot"; text: string }>>(
    [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mint guest token on first mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${agentApiUrl}/api/v1/public/guest-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`guest-token mint failed: ${res.status} ${body}`);
        }
        const data = (await res.json()) as { token: string };
        if (!cancelled) setToken(data.token);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentApiUrl, agentId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // Simple REST streaming via SSE — avoids pulling the whole Socket.IO
  // client into the embed bundle. Low-latency enough for a chat.
  async function send() {
    if (!input.trim() || !token) return;
    const userText = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text: userText }]);
    setBusy(true);
    try {
      const res = await fetch(
        `${agentApiUrl}/api/v1/agent/threads/${encodeURIComponent(`guest-${agentId}`)}/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Platos-Session-Token": token,
          },
          body: JSON.stringify({ message: userText, agentId }),
        },
      );
      if (!res.ok || !res.body) throw new Error("stream failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let botText = "";
      setMessages((prev) => [...prev, { role: "bot", text: "" }]);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const evt = JSON.parse(dataLine.slice(6)) as { type?: string; text?: string };
            if (evt.type === "token" && typeof evt.text === "string") {
              botText += evt.text;
              setMessages((prev) => {
                const out = [...prev];
                out[out.length - 1] = { role: "bot", text: botText };
                return out;
              });
            }
          } catch {
            /* non-JSON frames (heartbeats etc.) — ignore */
          }
        }
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const dark = theme === "dark";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: dark ? "#0a0a0a" : "#ffffff",
        color: dark ? "#e5e7eb" : "#111827",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${dark ? "#1f2937" : "#e5e7eb"}`,
          fontWeight: 600,
        }}
      >
        {agentName}
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {messages.length === 0 && (
          <div style={{ opacity: 0.6 }}>Say hi to get started.</div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "8px 12px",
                borderRadius: 12,
                background:
                  m.role === "user"
                    ? dark
                      ? "#4f46e5"
                      : "#6366f1"
                    : dark
                    ? "#1f2937"
                    : "#f3f4f6",
                color: m.role === "user" ? "#fff" : dark ? "#e5e7eb" : "#111827",
                whiteSpace: "pre-wrap",
              }}
            >
              {m.text || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
          </div>
        ))}
        {error && (
          <div style={{ color: "#ef4444", fontSize: 12, marginTop: 8 }}>Error: {error}</div>
        )}
      </div>
      <div style={{ padding: 12, borderTop: `1px solid ${dark ? "#1f2937" : "#e5e7eb"}` }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={token ? "Type a message…" : "Connecting…"}
            disabled={!token || busy}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 8,
              border: `1px solid ${dark ? "#374151" : "#d1d5db"}`,
              background: dark ? "#111827" : "#ffffff",
              color: dark ? "#e5e7eb" : "#111827",
            }}
          />
          <button
            type="submit"
            disabled={!token || busy || !input.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              background: "#6366f1",
              color: "#fff",
              border: 0,
              fontWeight: 600,
              cursor: "pointer",
              opacity: !token || busy || !input.trim() ? 0.5 : 1,
            }}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
