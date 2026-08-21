import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { FormEvent, useRef, useState } from "react";
import { Page } from "~/components/platos/DashboardShell";
import { asRecord, asString, stableJson } from "~/components/platos/safe";
import { requireEnvironmentScope } from "~/services/auth.server";
import { agentPanel, agentRequest, agentResponse } from "~/services/platosAgent.server";

async function scoped(args: LoaderFunctionArgs | ActionFunctionArgs) {
  const organizationSlug = args.params.organizationSlug;
  const projectSlug = args.params.projectParam;
  const environmentSlug = args.params.envParam;
  if (!organizationSlug || !projectSlug || !environmentSlug) throw new Response("Invalid scope", { status: 400 });
  return requireEnvironmentScope({ request: args.request, organizationSlug, projectSlug, environmentSlug });
}

export async function loader(args: LoaderFunctionArgs) {
  const { scope } = await scoped(args);
  const agentId = args.params.agentId;
  if (!agentId) throw new Response("Agent not found", { status: 404 });
  const [agent, templates] = await Promise.all([
    agentPanel(`/api/v1/agent/agents/${encodeURIComponent(agentId)}`, scope),
    agentPanel(`/api/v1/agent/postman-templates?agentId=${encodeURIComponent(agentId)}`, scope),
  ]);
  return json({ agentId, agent, templates });
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Response("Invalid request", { status: 400 });
  return value as Record<string, unknown>;
}

function safeMessageId(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Response("Invalid message id", { status: 400 });
  return id;
}

export async function action(args: ActionFunctionArgs) {
  const { scope } = await scoped(args);
  const agentId = args.params.agentId;
  if (!agentId) throw new Response("Agent not found", { status: 404 });
  const body = bodyRecord(await args.request.json());
  const intent = typeof body.intent === "string" ? body.intent : "stream";

  if (intent === "rate") {
    const rating = body.rating === 1 ? 1 : body.rating === -1 ? -1 : null;
    if (rating === null) return json({ ok: false, error: "Rating must be +1 or -1" }, { status: 400 });
    const result = await agentRequest(`/api/v1/agent/messages/${encodeURIComponent(safeMessageId(body.messageId))}/rating`, scope, {
      method: "POST",
      body: { rating },
    });
    return json({ ok: true, result });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 20_000) return json({ ok: false, error: "Message is required and must be at most 20,000 characters" }, { status: 400 });
  const threadId = typeof body.threadId === "string" && body.threadId.trim() ? body.threadId.trim() : undefined;
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)) : undefined;

  if (intent === "collect") {
    const result = await agentRequest(`/api/v1/agent/agents/${encodeURIComponent(agentId)}/messages`, scope, {
      method: "POST",
      body: { message, ...(threadId ? { threadId } : {}), ...(attachmentIds?.length ? { attachmentIds } : {}) },
      signal: args.request.signal,
    });
    return json({ ok: true, result });
  }

  const search = new URLSearchParams({ message });
  if (threadId) search.set("threadId", threadId);
  if (attachmentIds?.length) search.set("attachmentIds", attachmentIds.join(","));
  const upstream = await agentResponse(`/api/v1/agent/agents/${encodeURIComponent(agentId)}/chat/stream?${search}`, scope, { signal: args.request.signal });
  if (!upstream.ok || !upstream.body) {
    return json({ ok: false, error: await upstream.text().catch(() => "Streaming failed") }, { status: upstream.status || 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

type TimelineEvent = { type: string; data: unknown };

function eventText(event: TimelineEvent): string {
  const data = asRecord(event.data);
  if (["token", "delta", "text"].includes(event.type)) return asString(data.token, asString(data.delta, asString(data.text, "")));
  return "";
}

function serverMessageId(event: TimelineEvent): string | null {
  if (event.type !== "message_persisted") return null;
  const data = asRecord(event.data);
  const id = asString(data.messageId, asString(data.id, ""));
  return id || null;
}

function resultMessageId(value: unknown): string | null {
  const record = asRecord(value);
  for (const key of ["messageId", "assistantMessageId", "responseMessageId"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  for (const key of ["message", "result", "response"]) {
    const nested = asRecord(record[key]);
    for (const idKey of ["messageId", "id"]) if (typeof nested[idKey] === "string") return nested[idKey] as string;
  }
  return null;
}

export default function ChatRoute() {
  const data = useLoaderData<typeof loader>();
  const [message, setMessage] = useState("");
  const [threadId, setThreadId] = useState("");
  const [attachments, setAttachments] = useState("");
  const [transport, setTransport] = useState<"stream" | "collect">("stream");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [answer, setAnswer] = useState("");
  const [messageId, setMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const agent = data.agent.ok ? asRecord(data.agent.data) : {};

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    setAnswer("");
    setMessageId(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const attachmentIds = attachments.split(",").map((id) => id.trim()).filter(Boolean);

    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: transport, message, threadId: threadId || undefined, attachmentIds }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await response.text());

      if (transport === "collect") {
        const payload = await response.json();
        setEvents([{ type: "result", data: payload }]);
        setAnswer(stableJson(payload));
        setMessageId(resultMessageId(payload));
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Streaming response has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        const nextEvents: TimelineEvent[] = [];
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
          try { parsed = JSON.parse(raw); } catch { /* preserve verbatim upstream data */ }
          const parsedRecord = asRecord(parsed);
          if (type === "message" && typeof parsedRecord.type === "string") type = parsedRecord.type;
          const timelineEvent = { type, data: parsed };
          nextEvents.push(timelineEvent);
          assembled += eventText(timelineEvent);
          const persistedId = serverMessageId(timelineEvent);
          if (persistedId) setMessageId(persistedId);
        }
        if (nextEvents.length) {
          setEvents((current) => [...current, ...nextEvents]);
          setAnswer(assembled);
        }
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(caught instanceof Error ? caught.message : "Chat failed");
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function rate(rating: 1 | -1) {
    if (!messageId) return;
    const response = await fetch(window.location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent: "rate", messageId, rating }) });
    if (!response.ok) setError(await response.text());
  }

  return (
    <Page>
      <header className="mb-6 flex items-start justify-between gap-4"><div><div className="text-xs uppercase tracking-widest text-text-dimmed">Platos / Playground</div><h1 className="mt-1 text-2xl font-semibold">{asString(agent.name, "Agent chat")}</h1><p className="mt-1 text-sm text-text-dimmed">Real Turns over SSE or collected REST. Ratings attach only to the server-issued message ID.</p></div><span className="rounded-full border border-grid-bright px-3 py-1 text-xs">{asString(agent.executionMode, "direct")} runtime</span></header>
      {!data.agent.ok && <div className="mb-4 rounded border border-red-500/40 p-4 text-red-300">{data.agent.error.message}</div>}
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <section className="min-h-[34rem] rounded-lg border border-grid-bright bg-background-bright p-5">
          <div className="min-h-[24rem] whitespace-pre-wrap text-sm">{answer || <span className="text-text-dimmed">Send a message to start a Turn.</span>}</div>
          {error && <pre className="mt-3 overflow-auto rounded border border-red-500/40 p-3 text-xs text-red-300">{error}</pre>}
          {messageId && <div className="mt-4 flex items-center gap-3 border-t border-grid-bright pt-3 text-xs text-text-dimmed"><span>Persisted message <code>{messageId}</code></span><button onClick={() => rate(1)} className="rounded border border-grid-bright px-2 py-1">Useful</button><button onClick={() => rate(-1)} className="rounded border border-grid-bright px-2 py-1">Not useful</button></div>}
          <form onSubmit={send} className="mt-5 border-t border-grid-bright pt-4"><textarea value={message} onChange={(event) => setMessage(event.target.value)} className="min-h-24 w-full rounded border border-grid-bright bg-charcoal-950 p-3 text-sm" placeholder="Ask this Agent…" /><div className="mt-3 flex gap-2"><button disabled={busy} className="rounded bg-indigo-500 px-4 py-2 text-sm text-white">{busy ? "Running Turn…" : "Send"}</button>{busy && <button type="button" onClick={() => abortRef.current?.abort()} className="rounded border border-grid-bright px-4 py-2 text-sm">Stop</button>}</div></form>
        </section>
        <aside className="space-y-4"><section className="rounded-lg border border-grid-bright bg-background-bright p-4"><h2 className="font-semibold">Transport</h2><select value={transport} onChange={(event) => setTransport(event.target.value as "stream" | "collect")} className="mt-3 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 text-sm"><option value="stream">SSE incremental stream</option><option value="collect">REST collected response</option></select><label className="mt-3 block text-xs">Existing Thread ID<input value={threadId} onChange={(event) => setThreadId(event.target.value)} className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" /></label><label className="mt-3 block text-xs">Attachment IDs, comma-separated<input value={attachments} onChange={(event) => setAttachments(event.target.value)} className="mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 font-mono" /></label></section><details className="rounded-lg border border-grid-bright bg-background-bright p-4 text-xs"><summary className="font-semibold">Event timeline ({events.length})</summary><pre className="mt-3 max-h-80 overflow-auto">{stableJson(events)}</pre></details><details className="rounded-lg border border-grid-bright bg-background-bright p-4 text-xs"><summary className="font-semibold">Postman templates</summary><pre className="mt-3 max-h-64 overflow-auto">{stableJson(data.templates.ok ? data.templates.data : data.templates.error)}</pre></details></aside>
      </div>
    </Page>
  );
}
