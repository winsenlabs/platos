import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { FormEvent, useEffect, useRef, useState } from "react";

const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function loader({ params, request }: LoaderFunctionArgs) {
  if (!params.agentId || !/^[A-Za-z0-9_-]{1,80}$/.test(params.agentId)) throw new Response("Not found", { status: 404 });
  const search = new URL(request.url).searchParams;
  const environmentId = search.get("environmentId") ?? "";
  if (!ENVIRONMENT_ID.test(environmentId)) throw new Response("Not found", { status: 404 });
  const messageId = search.get("messageId") ?? "";
  const threadId = search.get("threadId") ?? "";
  if ((messageId && !SAFE_ID.test(messageId)) || (threadId && !SAFE_ID.test(threadId))) {
    throw new Response("Not found", { status: 404 });
  }
  return json({ agentId: params.agentId, environmentId, messageId, threadId });
}

type ChatMessage = { role: "user" | "agent" | "error"; content: string };
type RatingState = { userRating: { rating?: unknown } | null; aggregate: { ups: number; downs: number } };

function tokenText(type: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value === "string" && type === "token" ? value : "";
  const data = value as Record<string, unknown>;
  for (const key of ["token", "delta", "text"]) if (typeof data[key] === "string" && ["token", "delta", "text"].includes(type)) return data[key] as string;
  return "";
}

function canonicalRating(value: unknown): 1 | -1 | null {
  return value === 1 ? 1 : value === -1 ? -1 : null;
}

export default function Embed() {
  const { agentId, environmentId, messageId: loadedMessageId, threadId: loadedThreadId } = useLoaderData<typeof loader>();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [persistedMessageId, setPersistedMessageId] = useState(loadedMessageId);
  const [persistedThreadId, setPersistedThreadId] = useState(loadedThreadId);
  const [ratingState, setRatingState] = useState<RatingState>({
    userRating: null,
    aggregate: { ups: 0, downs: 0 },
  });
  const abortRef = useRef<AbortController | null>(null);
  const sessionReadyRef = useRef(false);
  const persistedMessageIdRef = useRef(loadedMessageId);

  function ratingPath(targetMessageId: string) {
    const search = new URLSearchParams({ environmentId, messageId: targetMessageId });
    return `/api/v1/public/agents/${encodeURIComponent(agentId)}/chat/stream?${search}`;
  }

  async function readRating(targetMessageId: string) {
    const response = await fetch(ratingPath(targetMessageId), { cache: "no-store" });
    if (!response.ok) throw new Error("The persisted rating could not be read");
    const payload = await response.json() as Record<string, unknown>;
    const aggregate = payload.aggregate && typeof payload.aggregate === "object" && !Array.isArray(payload.aggregate)
      ? payload.aggregate as Record<string, unknown>
      : {};
    const userRating = payload.userRating && typeof payload.userRating === "object" && !Array.isArray(payload.userRating)
      ? payload.userRating as Record<string, unknown>
      : null;
    const next: RatingState = {
      userRating: userRating ? { rating: canonicalRating(userRating.rating) } : null,
      aggregate: {
        ups: Number.isInteger(aggregate.ups) ? Number(aggregate.ups) : 0,
        downs: Number.isInteger(aggregate.downs) ? Number(aggregate.downs) : 0,
      },
    };
    return next;
  }

  useEffect(() => {
    if (!persistedMessageId) return;
    const targetMessageId = persistedMessageId;
    const controller = new AbortController();
    setRatingBusy(true);
    void readRating(targetMessageId)
      .then((next) => {
        if (!controller.signal.aborted && persistedMessageIdRef.current === targetMessageId) {
          setRatingState(next);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setMessages((current) => [...current, { role: "error", content: "The persisted rating could not be read" }]);
      })
      .finally(() => {
        if (!controller.signal.aborted && persistedMessageIdRef.current === targetMessageId) {
          setRatingBusy(false);
        }
      });
    return () => controller.abort();
  }, [persistedMessageId]);

  async function setRating(rating: 1 | -1) {
    if (!persistedMessageId || ratingBusy) return;
    setRatingBusy(true);
    try {
      const targetMessageId = persistedMessageId;
      const current = canonicalRating(ratingState.userRating?.rating);
      const response = await fetch(ratingPath(targetMessageId), {
        method: current === rating ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: current === rating ? undefined : JSON.stringify({ rating }),
      });
      if (!response.ok) throw new Error("The rating mutation was rejected");
      const next = await readRating(targetMessageId);
      if (persistedMessageIdRef.current === targetMessageId) setRatingState(next);
    } catch (error) {
      setMessages((current) => [...current, { role: "error", content: error instanceof Error ? error.message : "Rating failed" }]);
    } finally {
      setRatingBusy(false);
    }
  }

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
      if (!sessionReadyRef.current) {
        const tokenResponse = await fetch("/api/v1/public/guest-token", { method: "POST", body: new URLSearchParams({ agentId, environmentId }) });
        if (!tokenResponse.ok) throw new Error("This Agent is not available for public guest access");
        sessionReadyRef.current = true;
      }

      const streamSearch = new URLSearchParams({ environmentId });
      const response = await fetch(`/api/v1/public/agents/${encodeURIComponent(agentId)}/chat/stream?${streamSearch}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("The Agent could not start this Turn");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let canonicalMessageId = "";
      let canonicalThreadId = "";
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
          if (type === "message_persisted" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const eventData = parsed as Record<string, unknown>;
            canonicalMessageId = typeof eventData.messageId === "string" ? eventData.messageId : "";
            canonicalThreadId = typeof eventData.threadId === "string" ? eventData.threadId : "";
          }
          answer += tokenText(type, parsed);
        }
        setMessages((current) => [...current.slice(0, -1), { role: "agent", content: answer }]);
      }
      if (!SAFE_ID.test(canonicalMessageId) || !SAFE_ID.test(canonicalThreadId)) {
        throw new Error("The Agent reply did not reach authoritative persistence");
      }
      persistedMessageIdRef.current = canonicalMessageId;
      setPersistedMessageId(canonicalMessageId);
      setPersistedThreadId(canonicalThreadId);
      const url = new URL(window.location.href);
      url.searchParams.set("messageId", canonicalMessageId);
      url.searchParams.set("threadId", canonicalThreadId);
      window.history.replaceState(null, "", url);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessages((current) => [...current.slice(0, -1), { role: "error", content: error instanceof Error ? error.message : "Streaming failed" }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  const rating = canonicalRating(ratingState.userRating?.rating);

  return (
    <main className="flex min-h-screen flex-col bg-background-dimmed p-4 text-text-bright">
      <header className="border-b border-grid-bright pb-3"><h1 className="font-semibold">Platos Agent</h1><p className="text-xs text-text-dimmed">Public guest session · no verified identity claims</p></header>
      <div className="flex-1 space-y-3 overflow-y-auto py-6 text-sm">
        {messages.length ? messages.map((entry, index) => <div key={index} className={`rounded border p-3 ${entry.role === "user" ? "ml-8 border-[var(--accent)] bg-[var(--accent-soft)]" : entry.role === "error" ? "mr-8 border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]" : "mr-8 border-grid-bright bg-background-bright"}`}>{entry.content || (busy ? "…" : "No response content")}</div>) : <p className="text-text-dimmed">Start a guest Turn. Visibility and dual IP/Agent rate limits are enforced before a token is issued.</p>}
        {persistedMessageId && <article data-rating-witness className="mr-8 space-y-2 rounded border border-grid-bright bg-background-bright p-3">
          <div className="text-xs text-text-dimmed">Persisted Agent reply <code>{persistedMessageId}</code></div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" aria-pressed={rating === 1} disabled={ratingBusy} onClick={() => void setRating(1)} className={`rounded border px-2 py-1 ${rating === 1 ? "border-[var(--good)] text-[var(--good)]" : "border-grid-bright"}`}>Useful</button>
            <button type="button" aria-pressed={rating === -1} disabled={ratingBusy} onClick={() => void setRating(-1)} className={`rounded border px-2 py-1 ${rating === -1 ? "border-[var(--danger)] text-[var(--danger)]" : "border-grid-bright"}`}>Not useful</button>
            <span>{ratingState.aggregate.ups} useful · {ratingState.aggregate.downs} not useful</span>
            <span>EndUser rating</span>
          </div>
        </article>}
      </div>
      <form onSubmit={send} className="flex gap-2"><input value={message} onChange={(event) => setMessage(event.target.value)} className="flex-1 rounded border border-grid-bright bg-background-bright px-3 py-2" placeholder="Ask the agent…" /><button className="rounded bg-primary px-4 py-2 text-white" disabled={busy}>{busy ? "Streaming…" : "Send"}</button>{busy && <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-grid-bright px-3 py-2">Stop</button>}</form>
      {persistedThreadId && <span className="sr-only">Persisted Thread {persistedThreadId}</span>}
    </main>
  );
}
