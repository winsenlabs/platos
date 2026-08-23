import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Page } from "~/components/platos/DashboardShell";
import {
  Alert,
  Button,
  CodeBlock,
  EmptyState,
  InspectionRail,
  PageHeader,
  Panel,
  PanelFailure,
  SectionHeader,
  SegmentedControl,
  StatusChip,
} from "~/components/platos/ProductPrimitives";
import { asArray, asNumber, asRecord, asString, stableJson } from "~/components/platos/safe";
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
  const attachmentIds = Array.isArray(body.attachmentIds)
    ? body.attachmentIds.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id))
    : undefined;

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

export type TimelineEvent = { type: string; data: unknown };

type InspectorTab = "assembly" | "tools" | "memory" | "raw";

function eventData(event: TimelineEvent): Record<string, unknown> {
  return asRecord(event.data);
}

export function eventText(event: TimelineEvent): string {
  const data = eventData(event);
  if (["token", "delta", "text"].includes(event.type)) return asString(data.token, asString(data.delta, asString(data.text, "")));
  return "";
}

function serverMessageId(event: TimelineEvent): string | null {
  if (event.type !== "message_persisted") return null;
  const data = eventData(event);
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

export function collectedAnswer(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  const record = asRecord(value);
  for (const key of ["text", "answer", "content", "output"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key] as string;
  }
  for (const key of ["result", "response", "message", "data"]) {
    const nested = collectedAnswer(record[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

function ToolCallCard({ call, result }: { call: TimelineEvent; result?: TimelineEvent }) {
  const callData = eventData(call);
  const resultData = result ? eventData(result) : {};
  const resultValue = resultData.result ?? resultData.output ?? result?.data;
  const resultRecord = asRecord(resultValue);
  const error = asString(resultData.error, asString(resultRecord.error, asString(resultRecord.message, "")));
  const failed = Boolean(error) || result?.type === "tool_error";
  const status = !result ? "executing" : failed ? "failed" : "complete";
  return (
    <article className={`rounded-lg border p-3 ${failed ? "border-[var(--danger)] bg-[var(--danger-soft)]" : "border-grid-bright bg-[var(--surface-2)]"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <code className="font-semibold">{asString(callData.name, asString(callData.toolName, "Tool Call"))}</code>
          <div className="mt-1 text-[10px] text-text-dimmed">Call {asString(callData.callId, "pending")}</div>
        </div>
        <StatusChip tone={failed ? "danger" : result ? "good" : "accent"}>{status}</StatusChip>
      </div>
      {error && <p className="mt-3 text-xs text-[var(--danger)]">{error}</p>}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-[var(--accent)]">Arguments and result</summary>
        <div className="mt-2 grid gap-2 xl:grid-cols-2">
          <CodeBlock label="Arguments">{stableJson(callData.params ?? callData.input ?? {})}</CodeBlock>
          <CodeBlock label="Result">{result ? stableJson(resultValue) : "Waiting for the runtime result…"}</CodeBlock>
        </div>
      </details>
    </article>
  );
}

function ReasoningBlock({ event }: { event: TimelineEvent }) {
  const data = eventData(event);
  return (
    <div className="rounded-lg border-l-2 border-[var(--agent-violet)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--agent-violet)]">Reasoning · streamed</div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-text-dimmed">{asString(data.text, asString(data.reasoning, "Reasoning event received"))}</p>
    </div>
  );
}

function AssemblyInspector({ agent, threadId, attachments, transport }: { agent: Record<string, unknown>; threadId: string; attachments: string; transport: string }) {
  const blocks = asArray(agent.promptBlocks);
  const routes = asArray(agent.modelRoutes ?? agent.defaultModelRoutes);
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">System prompt · next Turn</div>
        {blocks.length ? (
          <div className="divide-y divide-grid-dimmed rounded-lg border border-grid-bright">
            {blocks.map((value, index) => {
              const block = asRecord(value);
              const volatile = block.volatile === true;
              return (
                <div key={index} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span>{asString(block.label, asString(block.type, `Prompt block ${index + 1}`))}</span>
                  <StatusChip tone={volatile ? "warning" : "accent"}>{volatile ? "volatile" : "cached prefix"}</StatusChip>
                </div>
              );
            })}
          </div>
        ) : <p className="text-sm text-text-dimmed">No structured prompt blocks are present in the loaded Agent projection.</p>}
      </div>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">Model route</div>
        <code className="block rounded-md border border-grid-bright bg-[var(--bg)] p-3 text-xs">
          {asString(agent.model, asString(asRecord(routes[0]).model, "Unresolved model"))}
        </code>
      </div>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">Turn context</div>
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-text-dimmed">Transport</dt><dd className="mt-1">{transport === "stream" ? "SSE stream" : "REST collected"}</dd></div>
          <div><dt className="text-text-dimmed">Thread</dt><dd className="mt-1 break-all font-mono">{threadId || "New thread"}</dd></div>
          <div className="col-span-2"><dt className="text-text-dimmed">Attachments</dt><dd className="mt-1 break-all font-mono">{attachments || "None"}</dd></div>
        </dl>
      </div>
    </div>
  );
}

function ToolsInspector({ events, templates }: { events: TimelineEvent[]; templates: unknown }) {
  const calls = events.filter((event) => event.type === "tool_call");
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">This Turn</div>
        {calls.length ? calls.map((call, index) => {
          const callId = asString(eventData(call).callId, "");
          const result = events.find((event) => ["tool_result", "tool_error"].includes(event.type) && asString(eventData(event).callId, "") === callId);
          return <ToolCallCard key={`${callId}-${index}`} call={call} result={result} />;
        }) : <p className="text-sm text-text-dimmed">No Tool Call has been emitted for this Turn.</p>}
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-[var(--accent)]">Postman templates</summary>
        <CodeBlock className="mt-2">{stableJson(templates)}</CodeBlock>
      </details>
    </div>
  );
}

function MemoryInspector({ events, agent }: { events: TimelineEvent[]; agent: Record<string, unknown> }) {
  const memoryEvents = events.filter((event) => event.type.toLowerCase().includes("memory"));
  const policy = agent.memoryPolicy ?? agent.memoryConfig;
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">Memory policy</div>
        {policy ? <CodeBlock>{stableJson(policy)}</CodeBlock> : <p className="text-sm text-text-dimmed">No memory policy is present in the loaded Agent projection.</p>}
      </div>
      <div>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">Live memory events</div>
        {memoryEvents.length ? <CodeBlock>{stableJson(memoryEvents)}</CodeBlock> : <p className="text-sm text-text-dimmed">No memory recall or write event has been emitted for this Turn.</p>}
      </div>
    </div>
  );
}

function RawInspector({ events }: { events: TimelineEvent[] }) {
  return events.length
    ? <CodeBlock label={`${events.length} canonical stream event${events.length === 1 ? "" : "s"}`}>{stableJson(events)}</CodeBlock>
    : <p className="text-sm text-text-dimmed">Raw transport events appear here after the Turn starts.</p>;
}

export default function ChatRoute() {
  const data = useLoaderData<typeof loader>();
  const [message, setMessage] = useState("");
  const [submittedMessage, setSubmittedMessage] = useState("");
  const [threadId, setThreadId] = useState("");
  const [attachments, setAttachments] = useState("");
  const [transport, setTransport] = useState<"stream" | "collect">("stream");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [answer, setAnswer] = useState("");
  const [messageId, setMessageId] = useState<string | null>(null);
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("assembly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const agent = data.agent.ok ? asRecord(data.agent.data) : {};
  const agentName = asString(agent.name, "Agent");
  const reasoning = events.filter((event) => ["thinking", "reasoning"].includes(event.type));
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const persisted = [...events].reverse().find((event) => event.type === "message_persisted");
  const persistedData = persisted ? eventData(persisted) : {};
  const streamError = [...events].reverse().find((event) => event.type === "error");

  async function send(event: FormEvent) {
    event.preventDefault();
    const userMessage = message.trim();
    if (!userMessage || busy) return;
    setBusy(true);
    setError(null);
    setEvents([]);
    setAnswer("");
    setMessageId(null);
    setRating(null);
    setSubmittedMessage(userMessage);
    const controller = new AbortController();
    abortRef.current = controller;
    const attachmentIds = attachments.split(",").map((id) => id.trim()).filter(Boolean);

    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: transport, message: userMessage, threadId: threadId || undefined, attachmentIds }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await response.text());

      if (transport === "collect") {
        const payload = await response.json();
        setEvents([{ type: "result", data: payload }]);
        setAnswer(collectedAnswer(payload) || "The collected Turn completed without a textual answer. Inspect Raw for the canonical response.");
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
          const emittedThreadId = asString(parsedRecord.threadId, asString(parsedRecord.thread_id, ""));
          if (emittedThreadId) setThreadId(emittedThreadId);
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

  async function rate(nextRating: 1 | -1) {
    if (!messageId) return;
    const response = await fetch(window.location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "rate", messageId, rating: nextRating }),
    });
    if (!response.ok) setError(await response.text());
    else setRating(nextRating);
  }

  function resetThread() {
    abortRef.current?.abort();
    setMessage("");
    setSubmittedMessage("");
    setThreadId("");
    setAttachments("");
    setEvents([]);
    setAnswer("");
    setMessageId(null);
    setRating(null);
    setError(null);
  }

  return (
    <Page>
      <PageHeader
        title="Playground"
        description="A real Turn against the live Agent. Inspection is the point; Raw remains available without becoming the primary UI."
        breadcrumbs={[{ label: "Platos" }, { label: agentName }, { label: "Playground" }]}
        actions={<>
          <select aria-label="Agent" value={data.agentId} disabled className="min-h-9 rounded-md border border-grid-bright bg-background-bright px-3 text-sm">
            <option value={data.agentId}>{agentName}</option>
          </select>
          <StatusChip tone={asString(agent.canaryVersionId, "") !== "" ? "accent" : "muted"}>
            {asString(agent.canaryVersionId, "") !== "" ? "current config + canary" : "current config"}
          </StatusChip>
          <Button type="button" onClick={resetThread}>Reset thread</Button>
        </>}
      />

      {!data.agent.ok && <div className="mb-5"><PanelFailure error={data.agent.error} /></div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex min-h-[42rem] min-w-0 flex-col overflow-hidden rounded-xl border border-grid-bright bg-background-bright">
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {!submittedMessage && !busy ? (
              <EmptyState
                title={`Say something to ${agentName}`}
                description="Prompt blocks, Tool Calls, memory events, and canonical stream frames for the next Turn remain visible in the inspector."
              />
            ) : <>
              {submittedMessage && (
                <article>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">You · Playground</div>
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-[var(--accent-soft)] px-4 py-3 text-sm text-text-bright">{submittedMessage}</div>
                </article>
              )}
              {reasoning.map((reasoningEvent, index) => <ReasoningBlock key={index} event={reasoningEvent} />)}
              {toolCalls.map((call, index) => {
                const callId = asString(eventData(call).callId, "");
                const result = events.find((item) => ["tool_result", "tool_error"].includes(item.type) && asString(eventData(item).callId, "") === callId);
                return <ToolCallCard key={`${callId}-${index}`} call={call} result={result} />;
              })}
              {(answer || busy) && (
                <article>
                  <div className="mb-2 flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-widest text-text-dimmed">
                    <span>{agentName} · {busy ? "streaming" : "complete"}</span>
                    {transport === "stream" && <span>SSE</span>}
                  </div>
                  <div className="max-w-[92%] rounded-2xl rounded-tl-sm border border-grid-bright bg-[var(--surface-2)] px-4 py-3 text-sm leading-6">
                    <span className="whitespace-pre-wrap">{answer || "Waiting for the first token…"}</span>
                    {busy && <span aria-label="Streaming" className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-[var(--accent)] align-[-2px]" />}
                  </div>
                </article>
              )}
              {streamError && <Alert tone="danger" title="Runtime failure">{asString(eventData(streamError).message, "The Agent emitted an error event.")}</Alert>}
              {error && <Alert tone="danger" title="Turn failed">{error}</Alert>}
              {messageId && (
                <div className="flex flex-wrap items-center gap-3 border-t border-grid-bright pt-3 text-xs text-text-dimmed">
                  <span>Persisted message <code>{messageId}</code></span>
                  {asNumber(persistedData.costCents) > 0 && <span>{(asNumber(persistedData.costCents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</span>}
                  {asNumber(persistedData.totalTokens) > 0 && <span>{asNumber(persistedData.totalTokens).toLocaleString()} tokens</span>}
                  <button type="button" onClick={() => rate(1)} className={`rounded border px-2 py-1 ${rating === 1 ? "border-[var(--good)] text-[var(--good)]" : "border-grid-bright"}`}>Useful</button>
                  <button type="button" onClick={() => rate(-1)} className={`rounded border px-2 py-1 ${rating === -1 ? "border-[var(--danger)] text-[var(--danger)]" : "border-grid-bright"}`}>Not useful</button>
                </div>
              )}
            </>}
          </div>

          <form onSubmit={send} className="border-t border-grid-bright bg-[var(--surface-2)] p-3 sm:p-4">
            <div className="flex items-end gap-2 rounded-xl border border-grid-bright bg-background-bright p-2 focus-within:border-[var(--accent)]">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                className="min-h-11 flex-1 resize-y bg-transparent px-2 py-2 text-sm outline-none"
                placeholder={`Message ${agentName}…`}
                rows={1}
              />
              {busy
                ? <Button type="button" tone="danger" onClick={() => abortRef.current?.abort()}>Stop</Button>
                : <Button type="submit" disabled={!message.trim()} tone="primary">Send</Button>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded-full border border-grid-bright px-2 py-1 text-text-dimmed">user: operator simulation</span>
              <span className="rounded-full border border-grid-bright px-2 py-1 text-text-dimmed">channel: Playground</span>
              <span className="rounded-full border border-grid-bright px-2 py-1 text-text-dimmed">memory: runtime policy</span>
              <label className="ml-auto flex items-center gap-2 text-text-dimmed">
                Transport
                <select value={transport} onChange={(event) => setTransport(event.target.value as "stream" | "collect")} className="rounded border border-grid-bright bg-background-bright px-2 py-1">
                  <option value="stream">SSE stream</option>
                  <option value="collect">REST collected</option>
                </select>
              </label>
            </div>
          </form>
        </section>

        <InspectionRail>
          <Panel>
            <SegmentedControl
              label="Playground inspector"
              value={inspectorTab}
              onChange={(value) => setInspectorTab(value as InspectorTab)}
              options={[
                { label: "Assembly", value: "assembly" },
                { label: "Tools", value: "tools" },
                { label: "Memory", value: "memory" },
                { label: "Raw", value: "raw" },
              ]}
            />
            <div className="mt-4">
              {inspectorTab === "assembly" && <AssemblyInspector agent={agent} threadId={threadId} attachments={attachments} transport={transport} />}
              {inspectorTab === "tools" && <ToolsInspector events={events} templates={data.templates.ok ? data.templates.data : data.templates.error} />}
              {inspectorTab === "memory" && <MemoryInspector events={events} agent={agent} />}
              {inspectorTab === "raw" && <RawInspector events={events} />}
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Thread and attachments" description="Optional canonical IDs are forwarded unchanged after validation." />
            <label className="block text-xs text-text-dimmed">
              Existing Thread ID
              <input value={threadId} onChange={(event) => setThreadId(event.target.value)} className="mt-1 w-full rounded-md border border-grid-bright bg-background-bright px-3 py-2 font-mono text-xs text-text-bright" />
            </label>
            <label className="mt-3 block text-xs text-text-dimmed">
              Attachment IDs, comma-separated
              <input value={attachments} onChange={(event) => setAttachments(event.target.value)} className="mt-1 w-full rounded-md border border-grid-bright bg-background-bright px-3 py-2 font-mono text-xs text-text-bright" />
            </label>
          </Panel>
        </InspectionRail>
      </div>
    </Page>
  );
}
