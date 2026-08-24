import { Form, Link, useLocation } from "@remix-run/react";
import { asArray, asNumber, asRecord, asString, compactNumber, firstArray, moneyFromCents, stableJson } from "../safe";
import {
  Alert,
  CodeBlock,
  DataTable,
  EmptyState,
  InspectionRail,
  PaginationRange,
  Panel,
  ProgressBar,
  SectionHeader,
  StatTile,
  StatusChip,
  TokenCompositionBar,
  Toolbar,
} from "../ProductPrimitives";
import { Status, type SurfaceProps } from "./SurfaceCommon";

export function ThreadsSurface({ data }: SurfaceProps) {
  const root = asRecord(data); const threads = firstArray(root, "threads", "items"); const total = asNumber(asRecord(root.pagination).total, asNumber(root.total));
  return <div className="space-y-4"><Toolbar><span className="text-xs text-text-dimmed">Turn is the activity unit · {total} canonical Threads</span></Toolbar>{threads.length ? <DataTable headers={["Thread", "User", "Agent", "Turns", "State", "Cost", "Last activity"]} rows={threads.map((value, index) => { const thread = asRecord(value); const id = asString(thread.id, asString(thread.threadId, `thread-${index + 1}`)); const state = asString(thread.status, asString(thread.state, "active")); return [<div className={state.toLowerCase().includes("fail") ? "border-l-2 border-[var(--danger)] pl-3" : "pl-3"}><Link to={id} className="font-medium text-[var(--accent)] hover:underline">{asString(thread.title, asString(thread.summary, id))}</Link><code className="mt-1 block text-[10px] text-text-dimmed">{id}</code></div>, asString(thread.userAlias, asString(thread.userId, asString(thread.endUserId, "—"))), asString(thread.agentName, asString(thread.agentId, "—")), asNumber(thread.turnCount, asNumber(thread.turns)), <Status value={state} />, moneyFromCents(thread.costCents ?? thread.totalCostCents), asString(thread.lastTurnAt, asString(thread.updatedAt, asString(thread.createdAt, "—")))]; })} /> : <EmptyState title={total > 0 ? "No Threads on this page" : "No conversations yet"} description={total > 0 ? "This page is past the end of the Thread history. Use Previous to return to available results." : "Threads appear after this scope persists its first Turn. The dashboard does not synthesize activity from messages or Tool Calls."} />}<PaginationRange data={root} label="Thread pagination" /></div>;
}

type FlatSpan = { row: Record<string, unknown>; depth: number };
function flattenSpanTree(value: unknown, depth = 0): FlatSpan[] {
  if (Array.isArray(value)) return value.flatMap((entry) => flattenSpanTree(entry, depth));
  const row = asRecord(value); if (!Object.keys(row).length) return [];
  const children = firstArray(row, "children", "spans");
  return [{ row, depth }, ...children.flatMap((child) => flattenSpanTree(child, depth + 1))];
}
function traceRows(root: Record<string, unknown>) {
  const tree = flattenSpanTree(root.spanTree);
  const spans = firstArray(root, "spans", "items", "trace").map(asRecord);
  if (tree.length) {
    const spansById = new Map(spans.map((span) => [asString(span.id, asString(span.spanId, "")), span]));
    return tree.map(({ row, depth }) => {
      const metadata = spansById.get(asString(row.id, asString(row.spanId, "")));
      return { row: metadata ? { ...metadata, ...row } : row, depth };
    });
  }
  return spans.map((row) => ({ row, depth: Math.max(0, asNumber(row.depth)) }));
}

export function TraceWaterfall({ data, compact = false }: { data: unknown; compact?: boolean }) {
  const root = asRecord(data); const rows = traceRows(root); const maxDuration = Math.max(1, ...rows.map(({ row }) => asNumber(row.durationMs, asNumber(row.duration))));
  if (!rows.length) return <EmptyState title="No spans recorded" description="The observability endpoint returned no trace spans for this Thread." />;
  return <div className="overflow-hidden rounded-lg border border-grid-bright bg-background-bright"><div className="grid grid-cols-[minmax(12rem,1.2fr)_minmax(9rem,2fr)_5rem_6rem] gap-3 border-b border-grid-bright px-3 py-2 text-[10px] uppercase tracking-widest text-text-dimmed"><span>Span</span><span>Waterfall</span><span>Duration</span><span>State</span></div>{rows.slice(0, compact ? 8 : 500).map(({ row, depth }, index) => { const duration = asNumber(row.durationMs, asNumber(row.duration)); const failed = ["failed", "error"].includes(asString(row.status, asString(row.state, "success")).toLowerCase()); return <div key={asString(row.id, `${index}`)} className={`grid grid-cols-[minmax(12rem,1.2fr)_minmax(9rem,2fr)_5rem_6rem] gap-3 border-b border-grid-dimmed px-3 py-2 text-xs last:border-0 ${failed ? "border-l-2 border-l-[var(--danger)] bg-[var(--danger-soft)]" : ""}`}><div className="min-w-0 truncate" style={{ paddingLeft: `${depth * 14}px` }}><span className="font-medium">{asString(row.name, asString(row.operation, `Span ${index + 1}`))}</span><code className="mt-0.5 block truncate text-[9px] text-text-dimmed">{asString(row.id, asString(row.spanId, ""))}</code></div><div className="flex items-center"><div className="h-2 min-w-1 rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, (duration / maxDuration) * 100)}%` }} /></div><span className="font-mono">{duration}ms</span><Status value={failed ? "failed" : asString(row.status, "success")} /></div>; })}</div>;
}

export function TraceSurface({ data, secondary }: SurfaceProps) {
  const root = asRecord(data); const messages = firstArray(root, "messages", "items"); const audits = firstArray(asRecord(secondary), "items", "calls", "toolCalls"); const rows = traceRows(root); const failed = rows.filter(({ row }) => ["failed", "error"].includes(asString(row.status, asString(row.state, "")).toLowerCase())); const wallTime = asNumber(root.wallTimeMs, rows.reduce((sum, { row }) => sum + asNumber(row.durationMs), 0));
  return <div className="space-y-5">{failed.length > 0 && <Alert tone="danger" title={`${failed.length} failed span${failed.length === 1 ? "" : "s"}`}>Failure state comes from persisted span status. Open the diagnostic blocks below for canonical error detail.</Alert>}<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><StatTile title="Wall time" value={`${wallTime}ms`} /><StatTile title="Spans" value={rows.length} /><StatTile title="Input tokens" value={compactNumber(root.inputTokens)} /><StatTile title="Cost" value={moneyFromCents(root.costCents)} /></div><Panel><SectionHeader title="Trace waterfall" description="Nested span duration and state from the clean observability store." /><TraceWaterfall data={root} /></Panel>{failed.map(({ row }, index) => <Panel key={asString(row.id, `${index}`)} tone="danger"><SectionHeader title={`Failed span · ${asString(row.name, asString(row.operation, "unknown"))}`} description="Dispatch and provider attribution remain separate when the endpoint supplies them." /><div className="grid gap-3 lg:grid-cols-2"><CodeBlock label="Canonical error">{asString(row.error, asString(row.errorMessage, "No error detail persisted"))}</CodeBlock><CodeBlock label="Dispatch metadata">{stableJson(row.dispatch ?? row.attributes ?? row.metadata)}</CodeBlock></div></Panel>)}{audits.length > 0 && <Panel><SectionHeader title="Tool audit" description="Dispatch and provider outcomes from the subordinate canonical audit endpoint." /><div className="space-y-3">{audits.map((value, index) => <ToolCallCard key={index} value={value} />)}</div></Panel>}{messages.length > 0 && <Panel><SectionHeader title="Persisted messages" /><DataTable headers={["Role", "Message", "Persisted ID"]} rows={messages.map((value) => { const message = asRecord(value); return [asString(message.role, asString(message.type)), <span className="line-clamp-3 max-w-3xl whitespace-pre-wrap">{asString(message.content, message.text as string)}</span>, <code className="text-xs">{asString(message.id, asString(message.messageId))}</code>]; })} /></Panel>}</div>;
}

function ToolCallCard({ value }: { value: unknown }) {
  const call = asRecord(value); const error = asString(call.error, asString(call.errorMessage, "")); const failed = Boolean(error) || ["failed", "error"].includes(asString(call.status, "").toLowerCase());
  return <article className={`rounded-lg border p-3 ${failed ? "border-[var(--danger)] bg-[var(--danger-soft)]" : "border-grid-bright bg-[var(--surface-2)]"}`}><div className="flex flex-wrap items-center justify-between gap-2"><code className="font-semibold">{asString(call.toolName, asString(call.name, "Tool Call"))}</code><Status value={failed ? "failed" : asString(call.status, "complete")} /></div><p className="mt-2 text-xs text-text-dimmed">Dispatch: {asString(call.dispatchStatus, asString(call.dispatchCode, "canonical runtime"))} · Provider: {asString(call.providerStatus, failed ? "failed" : "complete")}</p>{error && <CodeBlock className="mt-3" label="Ground-truth error">{error}</CodeBlock>}</article>;
}

export function ThreadSurface({ data }: SurfaceProps) {
  const merged = asRecord(data);
  const thread = Object.keys(asRecord(merged.thread)).length ? asRecord(merged.thread) : merged;
  const turns = firstArray(thread, "turns", "items");
  const messageRoot = asRecord(merged.messages);
  const messages = firstArray(messageRoot, "messages", "items");
  const messageTotal = asNumber(asRecord(messageRoot.pagination).total, asNumber(messageRoot.total, messages.length));
  const artifactRoot = asRecord(merged.artifacts);
  const artifacts = firstArray(artifactRoot, "artifacts", "items");
  const artifactTotal = asNumber(artifactRoot.total, artifacts.length);
  const audits = firstArray(asRecord(merged.toolAudit), "items", "calls", "toolCalls");
  const trace = asRecord(merged.trace);
  const latest = asRecord(turns.at(-1));
  const usage = asRecord(latest.usage);
  const calls = [...firstArray(latest, "toolCalls"), ...audits];
  const unavailable = asArray(merged.unavailable).map(asRecord);
  const title = asString(thread.title, asString(thread.summary, `Thread ${asString(thread.id, "diagnostic")}`));
  const boundary = asString(latest.compactionBoundary ?? thread.compactionBoundary, "");
  const location = useLocation();
  const threadId = asString(thread.id, asString(thread.threadId));
  const traceHref = location.pathname.includes("/threads/")
    ? `${location.pathname.replace(/\/$/, "")}/trace`
    : location.pathname.replace(/\/conversations\/[^/]+\/?$/, `/trace/${encodeURIComponent(threadId)}`);
  const input = asNumber(usage.fullPriceInputTokens ?? latest.fullPriceInputTokens ?? usage.inputTokens ?? latest.inputTokens);
  const read = asNumber(usage.cacheReadInputTokens ?? usage.cacheReadTokens ?? latest.cacheReadTokens);
  const write = asNumber(usage.cacheCreationInputTokens ?? usage.cacheWriteTokens ?? latest.cacheWriteTokens);
  const output = asNumber(usage.outputTokens ?? latest.outputTokens);
  const forkBoundaries = Array.from(new Map<string, { id: string; label: string }>(messages.map((value) => {
    const message = asRecord(value);
    const id = asString(message.id, asString(message.messageId));
    return [id, { id, label: `${asString(message.role, asString(message.type, "message"))}: ${asString(message.content, asString(message.text, "Persisted message")).slice(0, 80)}` }] as const;
  }).filter(([id]) => Boolean(id))).values());

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-xl font-semibold">{title}</h2><div className="mt-2 flex flex-wrap gap-2"><Status value={thread.status ?? "active"} /><StatusChip tone="muted">{asString(thread.userAlias, asString(thread.userId, "Unknown user"))}</StatusChip><StatusChip tone="muted">{turns.length} Turns</StatusChip><StatusChip tone="muted">{moneyFromCents(thread.totalCostCents ?? latest.costCents)}</StatusChip></div></div>
      <Link to={traceHref} className="inline-flex min-h-9 items-center rounded-md border border-grid-bright bg-background-bright px-3 py-2 text-sm">Open trace</Link>
    </div>
    {unavailable.map((error, index) => <Alert key={index} tone="warning" title="Subordinate panel unavailable">{asString(error.message, asString(error.code, "Unknown panel error"))}</Alert>)}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <main className="min-w-0 space-y-4">
        {boundary && <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-[var(--warn)]"><span className="h-px flex-1 bg-[var(--warn)]" />Compaction boundary · {boundary}<span className="h-px flex-1 bg-[var(--warn)]" /></div>}
        {messages.length ? messages.map((value, index) => { const message = asRecord(value); const role = asString(message.role, asString(message.type, "message")); return <article key={`${asString(message.id, "message")}-${index}`} className={`rounded-lg border p-4 ${role === "user" ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-grid-bright bg-background-bright"}`}><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-widest text-text-dimmed">{role}</span><code className="text-[9px] text-text-dimmed">{asString(message.id, "")}</code></div><div className="whitespace-pre-wrap text-sm">{asString(message.content, asString(message.text, "Empty message"))}</div></article>; }) : <EmptyState title={messageTotal > 0 ? "No Messages on this page" : "Nothing here yet"} description={messageTotal > 0 ? "This page is past the end of the persisted Message history. Use Previous to return to available results." : "This Thread exists but contains no persisted Turns or Messages."} />}
        <PaginationRange data={messageRoot} label="Thread message pagination" />
        {calls.length > 0 && <Panel><SectionHeader title="Tool Calls" description="Ground-truth dispatch and provider state from Turn and Tool audit records." /><div className="space-y-3">{calls.map((value, index) => <ToolCallCard key={index} value={value} />)}</div></Panel>}
        <Panel><SectionHeader title="Artifacts" description={`${artifactTotal} canonical artifact${artifactTotal === 1 ? "" : "s"}; latest revision per artifact key.`} />{artifacts.length ? <div className="space-y-3">{artifacts.map((value, index) => { const artifact = asRecord(value); const content = artifact.content; return <article key={asString(artifact.id, `${index}`)} className="rounded-md border border-grid-bright p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{asString(artifact.title, asString(artifact.artifactKey, `Artifact ${index + 1}`))}</h3><StatusChip tone="accent">{asString(artifact.kind, "artifact")}</StatusChip></div><p className="mt-1 text-xs text-text-dimmed">Revision {asNumber(artifact.revision)} of {asNumber(artifact.revisionCount, 1)} · {asString(artifact.mimeType, "unknown MIME")} · Turn {asString(artifact.producedByTurnId, "—")}</p><CodeBlock className="mt-3">{typeof content === "string" ? content : stableJson(content)}</CodeBlock></article>; })}</div> : <EmptyState title="No artifacts" description="No canonical Artifact revision has been persisted for this Thread." />}</Panel>
        <Panel><SectionHeader title="Trace preview" /><TraceWaterfall data={trace} compact /></Panel>
      </main>
      <InspectionRail>
        <Panel><SectionHeader title={`Turn #${asNumber(latest.sequence ?? latest.number) || turns.length} inspector`} /><div className="space-y-3"><div><div className="mb-1 text-xs text-text-dimmed">Token composition</div><TokenCompositionBar segments={[{ label: "Full-price input", value: input, tone: "input" }, { label: "Cache read", value: read, tone: "read" }, { label: "Cache write", value: write, tone: "write" }, { label: "Output", value: output, tone: "output" }]} /></div><dl className="grid grid-cols-2 gap-3 text-xs"><div><dt className="text-text-dimmed">Model</dt><dd className="mt-1 font-mono">{asString(latest.model, asString(thread.model, "—"))}</dd></div><div><dt className="text-text-dimmed">Latency</dt><dd className="mt-1">{asNumber(latest.latencyMs)}ms</dd></div><div><dt className="text-text-dimmed">Stop reason</dt><dd className="mt-1">{asString(latest.stopReason, "—")}</dd></div><div><dt className="text-text-dimmed">Cost</dt><dd className="mt-1">{moneyFromCents(latest.costWithCacheCents ?? latest.costCents)}</dd></div></dl></div></Panel>
        <Panel><SectionHeader title="Fork Thread" description="Create a scoped child through the selected persisted Message boundary." /><Form method="post" className="space-y-3"><input type="hidden" name="intent" value="fork" /><label className="block text-xs text-text-dimmed">Boundary<select required name="upToMessageId" disabled={!forkBoundaries.length} className="mt-1 w-full rounded-md border border-grid-bright bg-background-bright px-3 py-2 text-text-bright"><option value="">Select a persisted Message</option>{forkBoundaries.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="block text-xs text-text-dimmed">Child title<input name="title" maxLength={200} className="mt-1 w-full rounded-md border border-grid-bright bg-background-bright px-3 py-2 text-text-bright" /></label><button type="submit" disabled={!forkBoundaries.length} className="inline-flex min-h-9 items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Fork and open child</button></Form></Panel>
        <Panel><SectionHeader title="Memory written" /><p className="text-sm text-text-dimmed">{asString(latest.memoryWritten, asString(thread.memoryWritten, "No memory write recorded"))}</p></Panel>
        <Panel><SectionHeader title="Turns" /><ProgressBar value={turns.length} max={Math.max(60, turns.length)} label={`${turns.length} persisted Turns${turns.length >= 60 ? " · dense history" : ""}`} /></Panel>
      </InspectionRail>
    </div>
  </div>;
}
