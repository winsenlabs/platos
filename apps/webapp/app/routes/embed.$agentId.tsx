import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { FormEvent, useRef, useState } from "react";

export async function loader({ params }: LoaderFunctionArgs) {
  if (!params.agentId || !/^[A-Za-z0-9_-]{1,80}$/.test(params.agentId)) throw new Response("Not found", { status: 404 });
  return json({ agentId: params.agentId });
}

type ChatMessage = { role: "user" | "agent" | "error"; content: string };

function tokenText(type: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value === "string" && type === "token" ? value : "";
  const data = value as Record<string, unknown>;
  for (const key of ["token", "delta", "text"]) if (typeof data[key] === "string" && ["token", "delta", "text"].includes(type)) return data[key] as string;
  return "";
}

export default function Embed() {
  const { agentId } = useLoaderData<typeof loader>();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send(event: FormEvent) {
    event.preventDefault();
    const userMessage = message.trim();
    if (!userMessage || busy) return;
    setBusy(true);
    setMessage("");
    setMessages((current) => [...current, { role: "user", content: userMessage }, { role: "agent", content: "" }]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const tokenResponse = await fetch("/api/v1/public/guest-token", { method: "POST", body: new URLSearchParams({ agentId }) });
      if (!tokenResponse.ok) throw new Error("This Agent is not available for public guest access");
      const tokenPayload = await tokenResponse.json() as Record<string, unknown>;
      const token = String(tokenPayload.token ?? tokenPayload.sessionToken ?? "");
      if (!token) throw new Error("Guest session was not issued");

      const response = await fetch(`/api/v1/public/agents/${encodeURIComponent(agentId)}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Session-Token": token,
        },
        body: JSON.stringify({ message: userMessage }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("The Agent could not start this Turn");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          let type = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          const raw = dataLines.join("\n");
          let parsed: unknown = raw;
          try { parsed = JSON.parse(raw); } catch { /* preserve verbatim event data */ }
          if (type === "message" && parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).type === "string") type = (parsed as Record<string, unknown>).type as string;
          answer += tokenText(type, parsed);
        }
        setMessages((current) => [...current.slice(0, -1), { role: "agent", content: answer }]);
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessages((current) => [...current.slice(0, -1), { role: "error", content: error instanceof Error ? error.message : "Streaming failed" }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-background-dimmed p-4 text-text-bright">
      <header className="border-b border-grid-bright pb-3"><h1 className="font-semibold">Platos Agent</h1><p className="text-xs text-text-dimmed">Public guest session · no verified identity claims</p></header>
      <div className="flex-1 space-y-3 overflow-y-auto py-6 text-sm">{messages.length ? messages.map((entry, index) => <div key={index} className={`rounded border p-3 ${entry.role === "user" ? "ml-8 border-indigo-500/40 bg-indigo-950/20" : entry.role === "error" ? "mr-8 border-red-500/40 bg-red-950/20 text-red-200" : "mr-8 border-grid-bright bg-background-bright"}`}>{entry.content || (busy ? "…" : "No response content")}</div>) : <p className="text-text-dimmed">Start a guest Turn. Visibility and dual IP/Agent rate limits are enforced before a token is issued.</p>}</div>
      <form onSubmit={send} className="flex gap-2"><input value={message} onChange={(event) => setMessage(event.target.value)} className="flex-1 rounded border border-grid-bright bg-background-bright px-3 py-2" placeholder="Ask the agent…" /><button className="rounded bg-indigo-500 px-4 py-2" disabled={busy}>{busy ? "Streaming…" : "Send"}</button>{busy && <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-grid-bright px-3 py-2">Stop</button>}</form>
    </main>
  );
}
