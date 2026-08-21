import { Form, Link, useActionData, useNavigation } from "@remix-run/react";
import type { ReactNode } from "react";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  compactNumber,
  firstArray,
  moneyFromCents,
  percent,
  stableJson,
} from "./safe";
import { Page } from "./DashboardShell";

export type PanelResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: { code: string; message: string } };
export type SurfaceData = {
  surface: string;
  title: string;
  description: string;
  panel: PanelResult;
  secondary?: PanelResult;
  supporting?: PanelResult;
  provenance?: string;
};
type MutationData = {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string } | string;
};

const fieldClass =
  "mt-1 w-full rounded border border-grid-bright bg-charcoal-950 px-3 py-2 text-sm";
const panelClass = "rounded-lg border border-grid-bright bg-background-bright p-4";

function Card({ title, value, hint }: { title: string; value: ReactNode; hint?: string }) {
  return (
    <div className={panelClass}>
      <div className="text-xs uppercase tracking-wide text-text-dimmed">{title}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-text-dimmed">{hint}</div>}
    </div>
  );
}

function Failure({ error }: { error: { code: string; message: string } }) {
  return (
    <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-4">
      <div className="text-sm font-semibold text-red-300">Panel unavailable</div>
      <div className="mt-1 text-sm text-red-200">{error.message}</div>
      <code className="mt-2 block text-xs text-text-dimmed">{error.code}</code>
    </div>
  );
}

function Status({ value }: { value: unknown }) {
  const text = asString(value, "unknown");
  const good = /healthy|working|active|connected|dispatchable|complete|success|stable|approved/i.test(text);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        good ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-200"
      }`}
    >
      {text}
    </span>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-grid-bright">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-background-bright text-xs uppercase tracking-wide text-text-dimmed">
          <tr>{headers.map((header) => <th key={header} className="border-b border-grid-bright px-3 py-2">{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-grid-dimmed last:border-0 hover:bg-charcoal-800/50">
              {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionFeedback({ data }: { data: MutationData | undefined }) {
  if (!data) return null;
  if (!data.ok) {
    const error = typeof data.error === "string" ? data.error : asString(data.error?.message, "Mutation failed");
    return <div className="mb-5 rounded border border-red-500/40 bg-red-950/20 p-3 text-sm text-red-200">{error}</div>;
  }
  const result = asRecord(data.result);
  const secret = asString(result.serviceSecret, asString(result.webhookSecret, asString(result.plaintextSecret, "")));
  return (
    <div className="mb-5 rounded border border-green-500/40 bg-green-950/20 p-3 text-sm text-green-200">
      <div>Mutation persisted through the canonical API.</div>
      {secret && (
        <div className="mt-3 rounded border border-amber-400/50 bg-charcoal-950 p-3">
          <div className="text-xs font-semibold uppercase text-amber-200">Reveal once — copy before leaving</div>
          <code className="mt-2 block break-all select-all text-white">{secret}</code>
          <p className="mt-2 text-xs text-text-dimmed">This value came only from the mutation response. Loader data will never return it.</p>
        </div>
      )}
    </div>
  );
}

function Agents({ data }: { data: unknown }) {
  const root = asRecord(data);
  const agents = firstArray(root, "agents", "items", "data");
  if (!agents.length) {
    return (
      <div className="rounded-xl border border-dashed border-grid-bright p-12 text-center">
        <h2 className="text-xl font-semibold">No agents yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-text-dimmed">An Agent is a configured AI worker: a model, prompt blocks, and the Tools it may call. Start with the minimum and verify the first successful Turn.</p>
        <Link className="mt-6 inline-block rounded bg-indigo-500 px-4 py-2 text-sm text-white" to="new">Create your first agent</Link>
      </div>
    );
  }
  return (
    <Table
      headers={["Agent", "Status", "Tool exposure", "Threads", "Execution", "Version"]}
      rows={agents.map((item) => {
        const agent = asRecord(item);
        const tools = asRecord(agent.toolsBlockConfig);
        const counts = asRecord(agent._count);
        return [
          <Link className="font-medium text-indigo-300 hover:underline" to={asString(agent.id)}>{asString(agent.name, agent.slug as string)}</Link>,
          <Status value={asBoolean(agent.isActive) ? "Active" : "Inactive"} />,
          asString(tools.toolExposure, "meta"),
          compactNumber(counts.threads ?? agent.threadCount ?? agent.threads),
          asString(agent.executionMode, "direct"),
          <code className="text-xs">{asString(agent.currentVersionId, agent.versionId as string)}</code>,
        ];
      })}
    />
  );
}

function Registry({ data, testable = false }: { data: unknown; testable?: boolean }) {
  const root = asRecord(data);
  const rows = firstArray(root, "rows", "tools", "items");
  const dispatchable = rows.filter((value) => asBoolean(asRecord(value).dispatchable)).length;
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card title="Registered" value={rows.length} />
        <Card title="Dispatchable now" value={dispatchable} />
        <Card title="Broken" value={rows.length - dispatchable} hint="Registry presence is not health" />
      </div>
      <Table
        headers={["Tool", "Source Entity", "Exposure", "Dispatchability", "Calls / failures", "Latency"]}
        rows={rows.map((value) => {
          const tool = asRecord(value);
          const health = asRecord(tool.health);
          const toolId = asString(tool.toolId, tool.id as string);
          const entityId = asString(tool.entityId, tool.sourceEntityId as string);
          return [
            <code>{asString(tool.name, tool.toolName as string)}</code>,
            entityId,
            asString(tool.exposure, tool.sourceKind as string),
            <div className="space-y-2"><Status value={asBoolean(tool.dispatchable) ? "Dispatchable" : "Broken / undispatchable"} />{testable && <Form method="post"><input type="hidden" name="toolId" value={toolId} /><input type="hidden" name="sourceEntityId" value={entityId} /><button className="block text-xs text-indigo-300 hover:underline">Test through runtime executor</button></Form>}</div>,
            `${asNumber(tool.totalCalls ?? health.totalCalls)} / ${asNumber(tool.totalFailures ?? health.totalFailures)}`,
            `${asNumber(tool.avgLatencyMs ?? health.avgLatencyMs)} / ${asNumber(tool.p95LatencyMs ?? health.p95LatencyMs)}ms`,
          ];
        })}
      />
    </>
  );
}

function Monitoring({ data }: { data: unknown }) {
  const root = asRecord(data);
  const cards = firstArray(root, "cards");
  const laneValue = root.costByLane;
  const lanes = Array.isArray(laneValue)
    ? laneValue.map((value) => asRecord(value))
    : Object.entries(asRecord(laneValue)).map(([lane, value]) => ({
        lane,
        costCents: typeof value === "number" ? value : asNumber(asRecord(value).costCents),
      }));
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((value, index) => {
          const card = asRecord(value);
          const unit = asString(card.unit);
          const formatted = unit === "cents" ? moneyFromCents(card.value) : compactNumber(card.value);
          const hint = asString(card.id) === "tasks_7d" ? "One task is one completed Turn" : unit;
          return <Card key={asString(card.id, String(index))} title={asString(card.label, asString(card.id))} value={formatted} hint={hint} />;
        })}
      </div>
      <div className={`mt-5 ${panelClass}`}>
        <h2 className="font-semibold">Usage-ledger cost lanes</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {lanes.map((lane, index) => <Card key={asString(lane.lane, String(index))} title={asString(lane.lane, asString(asRecord(lane).name))} value={moneyFromCents(lane.costCents)} />)}
        </div>
        <p className="mt-4 text-xs text-text-dimmed">Source: immutable Turn usage ledger · provider usage reconciled at completion · pricing catalogue version pinned historically. The dashboard formats returned values and performs no cost or task arithmetic.</p>
      </div>
    </>
  );
}

function AgentConfigForm({ data, create }: { data: unknown; create: boolean }) {
  const agent = asRecord(data);
  const tools = asRecord(agent.toolsBlockConfig);
  const routes = asArray(agent.modelRoutes);
  const promptBlocks = asArray(agent.promptBlocks);
  const defaultRoutes = routes.length ? routes : [
    { label: "default", model: "anthropic:claude-sonnet-4-5", isDefault: true },
    { label: "compaction", model: "anthropic:claude-haiku-4-5", isDefault: false },
  ];
  return (
    <Form method="post" className={`mt-5 ${panelClass}`}>
      <h2 className="font-semibold">Runtime Agent configuration</h2>
      <p className="mt-1 text-xs text-text-dimmed">Each field maps to runtime configuration and is persisted into an AgentVersion. Tool exposure is Direct or Meta; Runtime Tools remain present in both.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs">Name<input required={create} name="name" defaultValue={asString(agent.name, create ? "support-agent" : "")} className={fieldClass} /></label>
        {create && <label className="text-xs">Slug<input name="slug" defaultValue="support-agent" className={fieldClass} /></label>}
        <label className="text-xs">Primary model<input required name="model" defaultValue={asString(agent.model, "anthropic:claude-sonnet-4-5")} className={`${fieldClass} font-mono`} /></label>
        <label className="text-xs">Execution<select name="executionMode" defaultValue={asString(agent.executionMode, "direct")} className={fieldClass}><option value="direct">Direct execution</option><option value="durable">Durable execution</option></select></label>
        <label className="text-xs">Tool caller<select name="toolMode" defaultValue={asString(tools.mode, asString(agent.toolMode, "direct"))} className={fieldClass}><option value="direct">Parent Agent</option><option value="sub-agent">Sub-agent</option><option value="execute-tool">execute_tools</option></select></label>
        <label className="text-xs">Tool exposure<select name="toolExposure" defaultValue={asString(tools.toolExposure, "meta")} className={fieldClass}><option value="direct">Direct — inject enabled schemas</option><option value="meta">Meta — find_tools router</option></select></label>
        <label className="text-xs">History<select name="historyMode" defaultValue={asString(agent.historyMode, "rolling")} className={fieldClass}><option value="rolling">Rolling</option><option value="compact">Compact</option></select></label>
        <label className="text-xs">Max steps<input type="number" name="maxSteps" min="1" max="200" defaultValue={asNumber(agent.maxSteps, 20)} className={fieldClass} /></label>
        <label className="text-xs">Context limit<input type="number" name="contextLimit" min="1" max="500" defaultValue={asNumber(agent.contextLimit, 20)} className={fieldClass} /></label>
        <label className="text-xs">Compact threshold<input type="number" name="compactThreshold" min="1" max="100" defaultValue={asNumber(agent.compactThreshold, 40)} className={fieldClass} /></label>
      </div>
      <label className="mt-4 block text-xs">System prompt<textarea name="systemPrompt" defaultValue={asString(agent.systemPrompt, "You are a helpful assistant.")} className={`${fieldClass} min-h-32`} /></label>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <label className="text-xs">Model routes — strict JSON array<textarea name="modelRoutes" defaultValue={stableJson(defaultRoutes)} className={`${fieldClass} min-h-44 font-mono text-xs`} /></label>
        <label className="text-xs">Prompt blocks — malformed values are rejected<textarea name="promptBlocks" defaultValue={stableJson(promptBlocks)} className={`${fieldClass} min-h-44 font-mono text-xs`} /></label>
      </div>
      {!create && <label className="mt-4 block text-xs">Version note<input name="versionNote" placeholder="Why this runtime configuration changed" className={fieldClass} /></label>}
      <button className="mt-4 rounded bg-indigo-500 px-4 py-2 text-sm text-white">{create ? "Create Agent" : "Save runtime configuration"}</button>
    </Form>
  );
}

function Context({ data }: { data: unknown }) {
  const agent = asRecord(data);
  const mapping = asRecord(agent.contextMapping);
  const promptVars = asArray(mapping.promptVars).filter((value): value is string => typeof value === "string");
  const declared = asArray(mapping.declaredKeys).filter((value): value is string => typeof value === "string");
  const prompt = `${asString(agent.systemPrompt)} ${stableJson(agent.promptBlocks)}`;
  const placeholders = [...new Set(Array.from(prompt.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g), (match) => match[1]))];
  const configured = [...new Set([...promptVars, ...placeholders])];
  const volatile = configured.filter((key) => key === "user.current_time");
  const cached = configured.filter((key) => !volatile.includes(key));
  const unresolved = placeholders.filter((key) => !declared.includes(key) && !volatile.includes(key));
  const pills = (items: string[], tone: string) => items.length
    ? <div className="flex flex-wrap gap-2">{items.map((item) => <code key={item} className={`rounded border px-2 py-1 text-xs ${tone}`}>{item}</code>)}</div>
    : <p className="text-sm text-text-dimmed">None configured</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className={panelClass}><h2 className="font-semibold">Cached prompt variables</h2><p className="my-2 text-xs text-text-dimmed">Stable values may be substituted in the cached prefix.</p>{pills(cached, "border-grid-bright")}</section>
      <section className="rounded-lg border border-indigo-400/40 bg-indigo-950/20 p-4"><h2 className="font-semibold">Volatile variables</h2><p className="my-2 text-xs text-text-dimmed">Relocated after the last cache breakpoint on every Turn.</p>{pills(volatile, "border-indigo-400/40 text-indigo-200")}</section>
      <section className="rounded-lg border border-amber-400/40 bg-amber-950/20 p-4"><h2 className="font-semibold">Unresolved warnings</h2><p className="my-2 text-xs text-text-dimmed">Placeholders not declared by the session contract remain visible until a caller supplies them.</p>{pills(unresolved, "border-amber-400/40 text-amber-200")}</section>
      <section className={`${panelClass} lg:col-span-3`}><h2 className="font-semibold">Effective Context mapping</h2><pre className="mt-3 max-h-80 overflow-auto rounded bg-charcoal-950 p-3 text-xs">{stableJson(mapping)}</pre></section>
    </div>
  );
}

function AgentTools({ data }: { data: unknown }) {
  const root = asRecord(data);
  const rows = firstArray(root, "tools", "rows");
  const exposure = asString(root.toolExposure, "meta");
  return (
    <>
      <div className="mb-4 grid gap-3 md:grid-cols-3"><Card title="Entity Tools" value={rows.length} /><Card title="Exposure" value={exposure === "direct" ? "Direct" : "Meta"} hint={exposure === "direct" ? "Enabled schemas injected" : "Enabled Tools remain find-only"} /><Card title="Runtime Tools" value="Always present" hint="Unaffected by Direct / Meta" /></div>
      <Table headers={["Tool", "Source Entity", "Turn exposure", "Live state", "Mapping"]} rows={rows.map((value) => {
        const row = asRecord(value);
        const toolName = asString(row.toolName);
        const sourceEntity = asString(row.sourceEntity);
        const enabled = asBoolean(row.enabled);
        const turnExposure = !enabled ? "Disabled" : exposure === "direct" ? "Injected" : "Find-only";
        return [<code>{toolName}</code>, <code className="text-xs">{sourceEntity}</code>, turnExposure, <div className="space-y-1"><Status value={asBoolean(row.dispatchable) ? "Dispatchable" : "Unavailable"} /><div className="text-xs text-text-dimmed">{asString(row.health, "unknown")}</div></div>, <Form method="post"><input type="hidden" name="toolName" value={toolName} /><input type="hidden" name="sourceEntity" value={sourceEntity} /><input type="hidden" name="enabled" value={enabled ? "false" : "true"} /><button className="text-xs text-indigo-300 hover:underline">{enabled ? "Disable mapping" : "Enable mapping"}</button></Form>];
      })} />
      <p className="mt-3 text-xs text-text-dimmed">Mapping changes update the canonical Environment Tool registry and runtime cache, so the next Turn sees the same state shown here.</p>
    </>
  );
}

function Canary({ data, versionsData }: { data: unknown; versionsData: unknown }) {
  const root = asRecord(data);
  const rows = firstArray(root, "perVersion");
  const versions = firstArray(asRecord(versionsData), "versions");
  const canaryId = asString(root.canaryVersionId, "");
  return (
    <>
      <div className="grid gap-3 md:grid-cols-3"><Card title="Active version" value={<code className="text-sm">{asString(root.currentVersionId, "—")}</code>} /><Card title="Canary version" value={<code className="text-sm">{canaryId || "Disabled"}</code>} /><Card title="Traffic" value={`${asNumber(root.canaryPercent)}%`} hint={`${asNumber(root.hours, 24)} hour persisted cohort window`} /></div>
      <div className="mt-5"><Table headers={["Version", "Cohort", "Turns / tasks", "Ledger cost", "Tokens", "Latency / errors"]} rows={rows.map((value) => { const row = asRecord(value); return [`v${asNumber(row.versionNumber) || "?"}`, asBoolean(row.isCurrent) ? "Current" : asBoolean(row.isCanary) ? "Canary" : "Historical", `${compactNumber(row.turnCount)} / ${compactNumber(row.tasks)}`, moneyFromCents(row.totalCostCents), `${compactNumber(row.inputTokens)} in / ${compactNumber(row.outputTokens)} out`, `${compactNumber(row.avgLatencyMs)}ms / ${percent(row.errorRate)}`]; })} /></div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Form method="post" className={panelClass}><input type="hidden" name="intent" value="set" /><h2 className="font-semibold">Set canary traffic</h2><select name="canaryVersionId" defaultValue={canaryId} className={fieldClass}><option value="">Disable canary</option>{versions.map((value) => { const version = asRecord(value); return <option key={asString(version.id)} value={asString(version.id)}>v{asNumber(version.versionNumber)} · {asString(version.note, "No note")}</option>; })}</select><label className="mt-3 block text-xs">Percent<input type="number" name="canaryPercent" min="0" max="100" defaultValue={asNumber(root.canaryPercent)} className={fieldClass} /></label><button className="mt-3 rounded border border-grid-bright px-3 py-2 text-sm">Apply persisted cohort</button></Form>
        <Form method="post" className={panelClass}><input type="hidden" name="intent" value="promote" /><h2 className="font-semibold">Promote canary</h2><p className="mt-2 text-sm text-text-dimmed">Atomically makes the canary active and clears canary traffic. Promotion writes immutable audit metadata.</p><button disabled={!canaryId} className="mt-4 rounded bg-indigo-500 px-3 py-2 text-sm text-white disabled:opacity-40">Promote to active</button></Form>
      </div>
    </>
  );
}

function Conversations({ data }: { data: unknown }) {
  const root = asRecord(data);
  const threads = firstArray(root, "threads", "items");
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Conversations" value={asNumber(root.total, threads.length)} />
        <Card title="Loaded page" value={threads.length} hint="Turn is the activity unit" />
      </div>
      <Table
        headers={["Conversation", "User", "Turns", "Last activity"]}
        rows={threads.map((value, index) => {
          const thread = asRecord(value);
          const id = asString(thread.id, asString(thread.threadId, `thread-${index + 1}`));
          return [
            <Link to={id} className="text-indigo-300 hover:underline">
              {asString(thread.title, id)}
            </Link>,
            asString(thread.userId, asString(thread.endUserId, "—")),
            asNumber(thread.turnCount, asNumber(thread.turns)),
            asString(thread.lastTurnAt, asString(thread.updatedAt, asString(thread.createdAt, "—"))),
          ];
        })}
      />
    </div>
  );
}

function Trace({ data }: { data: unknown }) {
  const root = asRecord(data);
  const messages = firstArray(root, "messages", "items");
  const spans = firstArray(root, "spans", "items");
  const spanTree = root.spanTree;
  const hasSpanTree = Array.isArray(spanTree) || Object.keys(asRecord(spanTree)).length > 0;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="Messages" value={messages.length} />
        <Card title="Trace spans" value={spans.length} />
        <Card title="Span tree" value={hasSpanTree ? "Available" : "Unavailable"} />
      </div>
      {messages.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Trace messages</h2>
          <Table
            headers={["Role", "Message", "Persisted ID"]}
            rows={messages.map((value) => {
              const message = asRecord(value);
              return [
                asString(message.role, asString(message.type)),
                <span className="line-clamp-3 max-w-3xl whitespace-pre-wrap">
                  {asString(message.content, message.text as string)}
                </span>,
                <code className="text-xs">{asString(message.id, asString(message.messageId))}</code>,
              ];
            })}
          />
        </section>
      )}
      {spans.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Trace spans</h2>
          <Table
            headers={["Span", "State", "Duration", "Turn"]}
            rows={spans.map((value) => {
              const span = asRecord(value);
              return [
                asString(span.name, span.operation as string),
                <Status value={span.status} />,
                `${asNumber(span.durationMs)}ms`,
                <code className="text-xs">{asString(span.turnId, span.runId as string)}</code>,
              ];
            })}
          />
        </section>
      )}
      {hasSpanTree && (
        <section className={panelClass}>
          <h2 className="font-semibold">Span hierarchy</h2>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs">
            {stableJson(spanTree)}
          </pre>
        </section>
      )}
    </div>
  );
}

function Thread({ data }: { data: unknown }) {
  const merged = asRecord(data);
  const thread = Object.keys(asRecord(merged.thread)).length ? asRecord(merged.thread) : merged;
  const turns = firstArray(thread, "turns", "items");
  const messages = firstArray(asRecord(merged.messages), "messages", "items");
  const audits = firstArray(asRecord(merged.toolAudit), "items", "calls", "toolCalls");
  const spans = firstArray(asRecord(merged.trace), "spans", "items", "trace");
  const latest = asRecord(turns.at(-1));
  const usage = asRecord(latest.usage);
  const calls = firstArray(latest, "toolCalls");
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="max-h-[72vh] overflow-y-auto rounded-lg border border-grid-bright bg-background-bright">
          {turns.map((value, index) => { const turn = asRecord(value); return <div key={index} className="border-b border-grid-bright p-3"><div className="flex justify-between text-sm"><span>{`Turn #${asNumber(turn.sequence ?? turn.number) || index + 1}`}</span><span>{moneyFromCents(turn.costWithCacheCents ?? turn.costCents)}</span></div><p className="mt-1 truncate text-xs text-text-dimmed">{asString(turn.title, turn.content as string)}</p></div>; })}
        </div>
        <div className={panelClass}>
          <div className="grid gap-3 md:grid-cols-4"><Card title="Input" value={compactNumber(usage.inputTokens ?? latest.inputTokens)} /><Card title="Cache read" value={compactNumber(usage.cacheReadInputTokens ?? usage.cacheReadTokens ?? latest.cacheReadTokens)} /><Card title="Cache write" value={compactNumber(usage.cacheCreationInputTokens ?? usage.cacheWriteTokens ?? latest.cacheWriteTokens)} /><Card title="Full price" value={compactNumber(usage.fullPriceInputTokens ?? latest.fullPriceInputTokens)} /></div>
          <p className="mt-3 text-xs text-text-dimmed">Token composition comes from the persisted Turn/Step ledger: system prompt, Tool schemas, history, user input, cache read and cache creation remain separately attributable.</p>
          <h2 className="mt-5 font-semibold">Tool Calls</h2>
          {[...calls, ...audits].map((value, index) => { const call = asRecord(value); const error = asString(call.error, asString(call.errorMessage, "")); return <div className="mt-2 rounded border border-grid-bright p-3" key={index}><div className="flex justify-between"><code>{asString(call.toolName, call.name as string)}</code><Status value={call.status} /></div>{error && <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-red-300">{error}</pre>}</div>; })}
          <div className="mt-4 border-t border-grid-bright pt-3 text-xs text-text-dimmed">Compaction boundary: {asString(latest.compactionBoundary ?? thread.compactionBoundary, "No compacted history")}</div>
        </div>
      </div>
      {messages.length > 0 && <section><h2 className="mb-2 font-semibold">Persisted messages</h2><Table headers={["Role", "Message", "Persisted ID"]} rows={messages.map((value) => { const message = asRecord(value); return [asString(message.role), <span className="line-clamp-3 max-w-3xl whitespace-pre-wrap">{asString(message.content, message.text as string)}</span>, <code className="text-xs">{asString(message.id)}</code>]; })} /></section>}
      {spans.length > 0 && <section><h2 className="mb-2 font-semibold">Trace spans</h2><Table headers={["Span", "State", "Duration", "Turn"]} rows={spans.map((value) => { const span = asRecord(value); return [asString(span.name, span.operation as string), <Status value={span.status} />, `${asNumber(span.durationMs)}ms`, <code className="text-xs">{asString(span.turnId, span.runId as string)}</code>]; })} /></section>}
    </div>
  );
}

const versionFields = ["model", "systemPrompt", "executionMode", "toolsBlockConfig", "modelRoutes", "promptBlocks", "contextMapping"] as const;
function versionConfig(value: unknown) {
  const row = asRecord(value);
  const snapshot = asRecord(row.configSnapshot);
  return Object.keys(snapshot).length ? snapshot : Object.keys(asRecord(row.config)).length ? asRecord(row.config) : row;
}
function Versions({ data }: { data: unknown }) {
  const root = asRecord(data);
  const versions = firstArray(root, "versions", "items");
  const newest = versionConfig(versions[0]);
  const previous = versionConfig(versions[1]);
  const changes = versionFields.filter((field) => stableJson(newest[field]) !== stableJson(previous[field]));
  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <Table headers={["Version", "Note", "Created", "Action"]} rows={versions.map((value) => { const version = asRecord(value); const id = asString(version.id); return [asNumber(version.versionNumber) ? `v${asNumber(version.versionNumber)}` : asString(version.label, id), asString(version.note, "—"), asString(version.createdAt), <Form method="post"><input type="hidden" name="versionId" value={id} /><button className="text-xs text-indigo-300 hover:underline">Roll back via new immutable version</button></Form>]; })} />
      <section className={panelClass}>
        <h2 className="font-semibold">Readable config diff</h2>
        <p className="mt-1 text-sm text-text-dimmed">Newest versus previous immutable AgentVersion. Prompt blocks, Tools, exposure, model routes and Context are compared by field.</p>
        {!changes.length ? <p className="mt-4 text-sm text-text-dimmed">No field changes in this pair.</p> : <div className="mt-4 space-y-3">{changes.map((field) => <details key={field} className="rounded border border-grid-bright p-3" open><summary className="font-medium">{field}</summary><div className="mt-3 grid gap-3 xl:grid-cols-2"><div><div className="mb-1 text-xs uppercase text-text-dimmed">Previous</div><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-charcoal-950 p-3 text-xs">{stableJson(previous[field])}</pre></div><div><div className="mb-1 text-xs uppercase text-text-dimmed">Newest</div><pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-charcoal-950 p-3 text-xs">{stableJson(newest[field])}</pre></div></div></details>)}</div>}
      </section>
    </div>
  );
}

function Budgets({ data, capsData }: { data: unknown; capsData: unknown }) {
  const statusRoot = asRecord(data);
  const statuses = firstArray(statusRoot, "caps");
  const caps = firstArray(asRecord(capsData), "caps");
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3"><Card title="Enforcement" value={<Status value={asBoolean(statusRoot.blocked) ? "Blocked" : "Available"} />} hint={asString(statusRoot.reason, "Cache-aware ledger spend")} /><Card title="Evaluated caps" value={statuses.length} /><Card title="Task unit" value="Completed Turn" hint="Never Tool Calls" /></div>
      <Table headers={["Scope", "Period", "Cache-aware spend", "Limit", "Turns", "State"]} rows={statuses.map((value) => { const status = asRecord(value); const cap = asRecord(status.cap); return [`${asString(cap.scopeType)}/${asString(cap.targetId, "all")}`, asString(cap.period), moneyFromCents(status.spentCents), moneyFromCents(cap.limitCents), `${compactNumber(status.runs)} / ${compactNumber(cap.runsLimit)}`, <Status value={asBoolean(status.blocked) ? "Blocked" : asBoolean(status.overrideActive) ? "Override active" : "Active"} />]; })} />
      {caps.length > 0 && <Table headers={["Configured cap", "Lane", "Alerts", "Override", "Actions"]} rows={caps.map((value) => { const cap = asRecord(value); const id = asString(cap.id); return [`${asString(cap.scopeType)}/${asString(cap.period)} · ${moneyFromCents(cap.limitCents)}`, `${asString(cap.tier, "llm")}${asString(cap.skillSlug, "") ? `/${asString(cap.skillSlug)}` : ""}`, asArray(cap.alertThresholds).join(", "), asString(cap.overrideUntil, "—"), <div className="flex gap-3"><Form method="post"><input type="hidden" name="intent" value="override" /><input type="hidden" name="capId" value={id} /><input type="hidden" name="minutes" value="60" /><button className="text-xs text-indigo-300">Override 60m</button></Form><Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="capId" value={id} /><button className="text-xs text-red-300">Delete</button></Form></div>]; })} />}
      <Form method="post" className={panelClass}>
        <input type="hidden" name="intent" value="save" /><h2 className="font-semibold">Set or update a cache-aware budget</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3 xl:grid-cols-5"><label className="text-xs">Scope<select name="scopeType" className={fieldClass}><option value="scope">Environment</option><option value="agent">Agent</option><option value="user">End user</option></select></label><label className="text-xs">Target ID<input name="targetId" placeholder="blank for Environment; * for every user" className={fieldClass} /></label><label className="text-xs">Period<select name="period" className={fieldClass}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label><label className="text-xs">Cost limit, cents<input required type="number" min="0" name="limitCents" className={fieldClass} /></label><label className="text-xs">Completed Turn limit<input type="number" min="0" name="runsLimit" defaultValue="0" className={fieldClass} /></label><label className="text-xs">Lane<select name="tier" className={fieldClass}><option value="llm">LLM</option><option value="skill">Skill</option></select></label><label className="text-xs">Skill slug<input name="skillSlug" className={fieldClass} /></label><label className="text-xs">Agent filter<input name="agentId" className={fieldClass} /></label><label className="text-xs">Thresholds<input name="alertThresholds" defaultValue="50, 80, 100" className={fieldClass} /></label><label className="text-xs">Alert emails<input name="alertEmails" className={fieldClass} /></label></div>
        <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="enabled" defaultChecked /> Enforce this cap</label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Persist budget</button>
        <p className="mt-3 text-xs text-text-dimmed">The UI displays endpoint-provided spend and threshold state. It performs no billing or enforcement arithmetic.</p>
      </Form>
    </div>
  );
}

function Entities({ data, matrixData }: { data: unknown; matrixData: unknown }) {
  const root = asRecord(data);
  const entities = firstArray(root, "entities", "items");
  const matrix = firstArray(asRecord(matrixData), "rows", "tools", "items");
  if (entities.length) {
    return <Table headers={["Entity", "Kind", "Live connection", "Last connected", "Heartbeat", "Registry now"]} rows={entities.map((value) => { const entity = asRecord(value); const externalId = asString(entity.entityId, asString(entity.externalId, asString(entity.id))); const canonicalId = asString(entity.id, externalId); const toolCount = matrix.filter((toolValue) => { const tool = asRecord(toolValue); return [tool.sourceEntityId, tool.sourceEntity, tool.entityId].includes(externalId); }).length; return [<Link to={canonicalId} className="font-medium text-indigo-300 hover:underline">{asString(entity.displayName, externalId)}</Link>, asString(entity.connectionKind, "wire"), <Status value={asBoolean(entity.liveConnected) ? "Connected" : asString(entity.connectionStatus, "Disconnected")} />, asString(entity.lastConnectedAt, "Never"), asString(entity.lastHeartbeatAt, "—"), toolCount]; })} />;
  }
  const entity = Object.keys(asRecord(root.entity)).length ? asRecord(root.entity) : root;
  const externalId = asString(entity.entityId, asString(entity.externalId, asString(entity.id)));
  const tools = matrix.filter((toolValue) => { const tool = asRecord(toolValue); return [tool.sourceEntityId, tool.sourceEntity, tool.entityId].includes(externalId); });
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4"><Card title="Live connection" value={<Status value={asBoolean(entity.liveConnected) ? "Connected" : "Disconnected"} />} hint="Cached schemas do not imply health" /><Card title="Registry now" value={tools.length} hint="Same canonical Tool matrix" /><Card title="Last connected" value={<span className="text-sm">{asString(entity.lastConnectedAt, "Never")}</span>} /><Card title="Heartbeat" value={<span className="text-sm">{asString(entity.lastHeartbeatAt, "No heartbeat")}</span>} /></div>
      <Table headers={["Tool", "Dispatchability", "Health", "Environment ACL"]} rows={tools.map((value) => { const tool = asRecord(value); const enabled = asBoolean(tool.enabled); const sourceEntity = asString(tool.sourceEntityId, externalId); const toolName = asString(tool.toolName, tool.name as string); return [<code>{toolName}</code>, <Status value={asBoolean(tool.dispatchable) ? "Dispatchable" : "Broken / undispatchable"} />, asString(asRecord(tool.health).lastStatus, asString(tool.lastStatus, "unknown")), <Form method="post"><input type="hidden" name="intent" value="tool-acl" /><input type="hidden" name="sourceEntity" value={sourceEntity} /><input type="hidden" name="toolName" value={toolName} /><input type="hidden" name="enabled" value={enabled ? "false" : "true"} /><button className="text-xs text-indigo-300">{enabled ? "Disable in Environment" : "Enable in Environment"}</button></Form>]; })} />
      <div className="grid gap-4 lg:grid-cols-2"><Form method="post" className={panelClass}><input type="hidden" name="intent" value="origins" /><h2 className="font-semibold">Browser origins</h2><p className="mt-1 text-xs text-text-dimmed">Bare HTTP(S) origins only; no globs or paths.</p><textarea name="allowedOrigins" defaultValue={asArray(entity.allowedOrigins).join("\n")} className={`${fieldClass} min-h-28 font-mono text-xs`} /><button className="mt-3 rounded border border-grid-bright px-3 py-2 text-sm">Save origins</button></Form><section className={panelClass}><h2 className="font-semibold">Runtime operations</h2><p className="mt-1 text-xs text-text-dimmed">Entity-level Agent allow-lists are not a canonical runtime feature; per-Environment Tool ACLs above are authoritative.</p><div className="mt-4 flex flex-wrap gap-3"><Form method="post"><input type="hidden" name="intent" value="refresh-discovery" /><button className="rounded border border-grid-bright px-3 py-2 text-sm">Refresh MCP discovery</button></Form><Link to="wire-test" className="rounded border border-grid-bright px-3 py-2 text-sm">Run Wire test</Link><Link to="initial-secret" className="rounded border border-grid-bright px-3 py-2 text-sm">Rotate secret</Link></div></section></div>
      <Form method="post" className="rounded border border-red-500/40 bg-red-950/20 p-4"><input type="hidden" name="intent" value="delete" /><h2 className="font-semibold text-red-200">Delete Entity and registry residue</h2><p className="mt-1 text-sm text-red-200/80">Deletes the Entity and its Tool registrations, Environment mappings, MCP configuration and runtime connection. Verify callers before continuing.</p><button className="mt-3 rounded border border-red-500/50 px-3 py-2 text-sm text-red-200">Delete Entity</button></Form>
    </div>
  );
}

function EntityCreate() {
  return <Form method="post" className={panelClass}><h2 className="font-semibold">Register a runtime Entity</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs">Entity ID<input required name="entityId" pattern="[a-z0-9][a-z0-9\-]{0,63}" className={fieldClass} /></label><label className="text-xs">Display name<input required name="displayName" className={fieldClass} /></label><label className="text-xs">Connection kind<select name="connectionKind" className={fieldClass}><option value="wire">Wire — inbound platools WebSocket</option><option value="mcp">MCP — outbound client</option></select></label><label className="text-xs">MCP transport<select name="transport" className={fieldClass}><option value="remote-http">Remote HTTP</option><option value="remote-sse">Remote SSE</option><option value="hosted-composio">Hosted Composio</option><option value="hosted-linear">Hosted Linear</option></select></label><label className="text-xs">MCP URL<input name="url" className={fieldClass} /></label><label className="text-xs">Credential reference<input name="credsSecretKey" className={fieldClass} placeholder="same-Environment Credential name" /></label></div><label className="mt-3 block text-xs">Wire MCP URLs<textarea name="mcpUrls" className={`${fieldClass} min-h-20`} /></label><label className="mt-3 block text-xs">MCP headers template — JSON object<textarea name="headersTemplate" defaultValue="{}" className={`${fieldClass} min-h-24 font-mono text-xs`} /></label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Register and discover</button><p className="mt-3 text-xs text-text-dimmed">If the API creates a service secret, it appears once in the mutation result above and is never loaded again.</p></Form>;
}

function EntitySecret() {
  return <Form method="post" className={panelClass}><h2 className="font-semibold">Rotate Entity service secret</h2><p className="mt-2 text-sm text-text-dimmed">Rotation disconnects sessions authenticated with the old secret. The replacement is returned once in this browser response and is never persisted in loader data.</p><button className="mt-4 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Rotate and reveal once</button></Form>;
}

function WireTest() {
  return <Form method="post" className={panelClass}><h2 className="font-semibold">Runtime-equivalent Wire test</h2><label className="mt-3 block text-xs">Tool name<input name="toolName" defaultValue="ping" className={fieldClass} /></label><label className="mt-3 block text-xs">Parameters — JSON object<textarea name="params" defaultValue="{}" className={`${fieldClass} min-h-28 font-mono text-xs`} /></label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Dispatch through Tool executor</button></Form>;
}

function Governance({ data }: { data: unknown }) {
  const root = asRecord(data);
  const single = Object.keys(asRecord(root.approval)).length ? asRecord(root.approval) : root;
  const rows = firstArray(root, "approvals", "items");
  const approvals = rows.length ? rows : single.id ? [single] : [];
  return (
    <div className="space-y-5">
      <Table headers={["Approval", "Tool / event", "Requester", "Status", "Decision"]} rows={approvals.map((value) => { const approval = asRecord(value); const id = asString(approval.id, asString(approval.approvalId)); return [<Link className="text-indigo-300 hover:underline" to={id}>{id}</Link>, asString(approval.toolName, asString(approval.kind, asString(approval.action))), asString(approval.requestedBy, "system"), <Status value={approval.status} />, asString(approval.comment, "—")]; })} />
      {!rows.length && asString(single.status, "pending") === "pending" && <Form method="post" className={panelClass}><h2 className="font-semibold">Resolve exactly once</h2><p className="mt-1 text-xs text-text-dimmed">Repeated decisions return the persisted outcome; they do not execute a Tool twice.</p><label className="mt-3 block text-xs">Comment<textarea name="comment" className={`${fieldClass} min-h-20`} /></label><label className="mt-3 block text-xs">Approved Tool args — optional JSON object<textarea name="editedArgs" defaultValue="{}" className={`${fieldClass} min-h-24 font-mono text-xs`} /></label><div className="mt-3 flex gap-3"><button name="decision" value="approve" className="rounded bg-indigo-500 px-4 py-2 text-sm text-white">Approve</button><button name="decision" value="reject" className="rounded border border-red-500/50 px-4 py-2 text-sm text-red-200">Reject</button></div></Form>}
      {firstArray(root, "safetyEvents").length > 0 && <Table headers={["Safety event", "Severity", "Agent", "At"]} rows={firstArray(root, "safetyEvents").map((value) => { const event = asRecord(value); return [asString(event.action, asString(event.detector)), <Status value={event.severity} />, asString(event.agentId), asString(event.createdAt)]; })} />}
    </div>
  );
}

function Clusters({ data, agentsData }: { data: unknown; agentsData: unknown }) {
  const root = asRecord(data);
  const rows = firstArray(root, "clusters", "items");
  const cluster = asRecord(root.cluster);
  const members = firstArray(cluster, "agents", "members");
  const agents = firstArray(asRecord(agentsData), "agents", "items");
  if (rows.length) {
    return <div className="space-y-5"><div className="rounded border border-amber-400/40 bg-amber-950/20 p-4 text-sm text-amber-100">Adding an Agent widens the memory recall boundary across every cluster member. Review that consequence before saving.</div><Table headers={["Cluster", "Members", "Primary Agent", "Memory consequence"]} rows={rows.map((value) => { const item = asRecord(value); return [<Link to={asString(item.id)} className="text-indigo-300 hover:underline">{asString(item.name, item.slug as string)}</Link>, asNumber(item.agentCount, firstArray(item, "agents", "members").length), asString(item.primaryAgentId, "—"), "Shared recall scope"]})} /><Form method="post" className={panelClass}><h2 className="font-semibold">Create cluster</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs">Name<input required name="name" className={fieldClass} /></label><label className="text-xs">Slug<input required name="slug" className={fieldClass} /></label><label className="text-xs">Primary Agent ID<input name="primaryAgentId" className={fieldClass} /></label><label className="text-xs">Initial Agent IDs<input name="agentIds" className={fieldClass} placeholder="comma-separated" /></label></div><label className="mt-3 block text-xs">Description<textarea name="description" className={`${fieldClass} min-h-20`} /></label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Create widened memory scope</button></Form></div>;
  }
  return <div className="space-y-5"><div className="rounded border border-amber-400/40 bg-amber-950/20 p-4 text-sm text-amber-100">Every member can recall memory from this cluster scope. Adding an Agent immediately widens what it may retrieve at runtime.</div><Table headers={["Agent", "Role", "Remove"]} rows={members.map((value) => { const member = asRecord(value); const agent = asRecord(member.agent); const id = asString(member.agentId, asString(agent.id)); return [asString(agent.name, id), asString(member.role, "member"), <Form method="post"><input type="hidden" name="intent" value="remove-agent" /><input type="hidden" name="agentId" value={id} /><button className="text-xs text-red-300">Remove</button></Form>]; })} /><Form method="post" className={panelClass}><input type="hidden" name="intent" value="add-agent" /><h2 className="font-semibold">Add Agent and widen recall</h2><select required name="agentId" className={fieldClass}><option value="">Select Agent</option>{agents.map((value) => { const agent = asRecord(value); return <option key={asString(agent.id)} value={asString(agent.id)}>{asString(agent.name, asString(agent.id))}</option>; })}</select><input name="role" defaultValue="member" className={fieldClass} /><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Add Agent</button></Form><Form method="post" className={panelClass}><input type="hidden" name="intent" value="update" /><h2 className="font-semibold">Cluster metadata</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><input name="name" defaultValue={asString(cluster.name, "")} className={fieldClass} /><input name="slug" defaultValue={asString(cluster.slug, "")} className={fieldClass} /><input name="primaryAgentId" defaultValue={asString(cluster.primaryAgentId, "")} className={fieldClass} /><input name="description" defaultValue={asString(cluster.description, "")} className={fieldClass} /></div><button className="mt-3 rounded border border-grid-bright px-3 py-2 text-sm">Save cluster</button></Form></div>;
}

function Evals({ data, criteriaData, criteriaScreen }: { data: unknown; criteriaData: unknown; criteriaScreen: boolean }) {
  const root = asRecord(data);
  const evals = firstArray(root, "evals", "items", "rows");
  const criteria = criteriaScreen ? firstArray(root, "criteria", "items") : firstArray(asRecord(criteriaData), "criteria", "items");
  return <div className="space-y-5">{criteriaScreen ? <Table headers={["Criterion", "Agent", "Judge", "Scale", "State"]} rows={criteria.map((value) => { const criterion = asRecord(value); return [asString(criterion.name), asString(criterion.agentId, "Shared"), asString(criterion.judgeModel, "Default judge"), `${asNumber(criterion.scoreScaleMin)}–${asNumber(criterion.scoreScaleMax, 100)}`, <Status value={asBoolean(criterion.isActive) ? "Active" : "Inactive"} />]; })} /> : <Table headers={["Evaluation", "Criterion", "Agent version", "Score", "Judge lane cost"]} rows={evals.map((value) => { const evaluation = asRecord(value); return [asString(evaluation.id), asString(evaluation.criterionName, asString(evaluation.criterionId)), asString(evaluation.agentVersionId), asNumber(evaluation.score), moneyFromCents(evaluation.costCents ?? evaluation.judgeCostCents)]; })} />}{criteriaScreen ? <Form method="post" className={panelClass}><h2 className="font-semibold">Create evaluation criterion</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs">Name<input required name="name" className={fieldClass} /></label><label className="text-xs">Agent ID, optional<input name="agentId" className={fieldClass} /></label><label className="text-xs">Judge model<input name="judgeModel" className={fieldClass} /></label><label className="text-xs">Score range<div className="flex gap-2"><input type="number" name="scoreScaleMin" defaultValue="0" className={fieldClass} /><input type="number" name="scoreScaleMax" defaultValue="100" className={fieldClass} /></div></label></div><label className="mt-3 block text-xs">Judge prompt<textarea required name="judgePrompt" className={`${fieldClass} min-h-28`} /></label><label className="mt-3 block text-xs">Rubric<textarea name="rubric" className={`${fieldClass} min-h-20`} /></label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Create criterion</button></Form> : <Form method="post" className={panelClass}><h2 className="font-semibold">Run judge evaluation</h2><div className="mt-3 grid gap-3 md:grid-cols-3"><input required name="agentId" placeholder="Agent ID" className={fieldClass} /><input required name="threadId" placeholder="Thread ID" className={fieldClass} /><select required name="criterionId" className={fieldClass}><option value="">Criterion</option>{criteria.map((value) => { const criterion = asRecord(value); return <option key={asString(criterion.id)} value={asString(criterion.id)}>{asString(criterion.name)}</option>; })}</select></div><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Run in judge cost lane</button></Form>}</div>;
}

function Jobs({ data, create }: { data: unknown; create: boolean }) {
  const root = asRecord(data);
  const tasks = firstArray(root, "tasks", "jobs", "items");
  const task = asRecord(root.task);
  const form = (current: Record<string, unknown>, mode: "create" | "update") => <Form method="post" className={panelClass}><h2 className="font-semibold">{mode === "create" ? "Create Platos-native background Job" : "Edit Job"}</h2><p className="mt-1 text-xs text-text-dimmed">This is Platos background work. External Trigger tasks are infrastructure, not dashboard-owned domain Tasks.</p><div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{mode === "create" && <label className="text-xs">Job ID<input required name="taskId" pattern="[a-z0-9-]{1,64}" className={fieldClass} /></label>}<label className="text-xs">Display name<input required={mode === "create"} name="displayName" defaultValue={asString(current.displayName, "")} className={fieldClass} /></label><label className="text-xs">Trigger<select name="triggerType" defaultValue={asString(current.triggerType, "manual")} className={fieldClass}><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="webhook">Webhook</option></select></label><label className="text-xs">Schedule cron<input name="scheduleCron" defaultValue={asString(current.scheduleCron, "")} className={fieldClass} /></label><label className="text-xs">Timezone<input name="scheduleTimezone" defaultValue={asString(current.scheduleTimezone, "UTC")} className={fieldClass} /></label><label className="text-xs">Timeout seconds<input type="number" name="timeout" min="1" max="590" defaultValue={asNumber(current.timeout, 300)} className={fieldClass} /></label><label className="text-xs">Retries<input type="number" name="maxRetries" min="0" max="10" defaultValue={asNumber(current.maxRetries, 3)} className={fieldClass} /></label><label className="text-xs">Allowed Agent IDs<input name="allowedAgentIds" defaultValue={asArray(current.allowedAgentIds).join(", ")} className={fieldClass} /></label></div><label className="mt-3 block text-xs">Payload schema — JSON object<textarea name="payloadSchema" defaultValue={stableJson(asRecord(current.payloadSchema))} className={`${fieldClass} min-h-24 font-mono text-xs`} /></label><label className="mt-3 block text-xs">Handler source<textarea required={mode === "create"} name="handler" defaultValue={asString(current.handler, "return { ok: true, payload };")} className={`${fieldClass} min-h-36 font-mono text-xs`} /></label>{mode === "update" && <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="isActive" defaultChecked={asBoolean(current.isActive)} /> Active</label>}<button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Persist Job</button></Form>;
  if (create) return form({}, "create");
  if (Object.keys(task).length) return <div className="space-y-5"><div className="grid gap-3 md:grid-cols-3"><Card title="State" value={<Status value={asBoolean(task.isActive) ? "Active" : "Inactive"} />} /><Card title="Last run" value={<span className="text-sm">{asString(task.lastRunAt, "Never")}</span>} /><Card title="Schedule" value={<code className="text-sm">{asString(task.scheduleCron, "Manual")}</code>} /></div>{form(task, "update")}<Form method="post" className={panelClass}><input type="hidden" name="intent" value="run" /><label className="text-xs">Run payload<textarea name="runPayload" defaultValue="{}" className={`${fieldClass} min-h-20 font-mono text-xs`} /></label><button className="mt-3 rounded border border-grid-bright px-3 py-2 text-sm">Queue now</button></Form></div>;
  return <div className="space-y-5"><div className="flex justify-end"><Link to="new" className="rounded bg-indigo-500 px-4 py-2 text-sm text-white">Create Job</Link></div><Table headers={["Job", "Trigger", "State", "Last run", "Actions"]} rows={tasks.map((value) => { const item = asRecord(value); const id = asString(item.id); return [<Link to={id} className="text-indigo-300 hover:underline">{asString(item.displayName, asString(item.taskId))}</Link>, asString(item.triggerType, "manual"), <Status value={asBoolean(item.isActive) ? "Active" : "Inactive"} />, asString(item.lastRunAt, "Never"), <div className="flex gap-3"><Form method="post"><input type="hidden" name="taskId" value={id} /><input type="hidden" name="intent" value="run" /><input type="hidden" name="runPayload" value="{}" /><button className="text-xs text-indigo-300">Run</button></Form><Form method="post"><input type="hidden" name="taskId" value={id} /><input type="hidden" name="intent" value="delete" /><button className="text-xs text-red-300">Delete</button></Form></div>]; })} /></div>;
}

function Channels({ connectionData, appsData, channelsData }: { connectionData: unknown; appsData: unknown; channelsData: unknown }) {
  const apps = firstArray(asRecord(appsData), "apps", "items");
  const channels = firstArray(asRecord(channelsData), "channels", "items");
  const connect = asRecord(connectionData);
  const combined: Array<Record<string, unknown>> = [
    ...apps.map((value) => ({ ...asRecord(value), ownership: "Hosted OAuth ChannelApp" })),
    ...channels.map((value) => ({ ...asRecord(value), ownership: "Operator-owned ChannelConnection" })),
  ];
  return <div className="space-y-5"><div className="grid gap-3 md:grid-cols-2"><Card title="Hosted OAuth Channel Apps" value={apps.length} hint="Install URL and installation lifecycle" /><Card title="Operator-owned connections" value={channels.length} hint="BYO credentials and inbound webhook" /></div><Table headers={["Channel", "Ownership", "Provider", "Agent", "State"]} rows={combined.map((row) => [asString(row.displayName, asString(row.id)), asString(row.ownership), asString(row.provider, "slack"), asString(row.defaultAgentId, asString(row.agentId)), <Status value={row.status ?? (asBoolean(row.enabled) ? "Active" : "Configured")} />])} /><div className="grid gap-4 xl:grid-cols-2"><Form method="post" className={panelClass}><input type="hidden" name="intent" value="channel-app" /><h2 className="font-semibold">Create hosted OAuth Slack app</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><input name="displayName" placeholder="Display name" className={fieldClass} /><input required name="clientId" placeholder="Client ID" className={fieldClass} /><input required type="password" name="clientSecret" placeholder="Client secret" className={fieldClass} /><input required type="password" name="signingSecret" placeholder="Signing secret" className={fieldClass} /><input name="scopes" defaultValue="assistant:write, im:history, chat:write, app_mentions:read" className={fieldClass} /><input name="defaultAgentId" placeholder="Default Agent ID" className={fieldClass} /></div><input type="hidden" name="distribution" value="private" /><input type="hidden" name="linking" value="none" /><input type="hidden" name="agentRouting" value="[]" /><label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="aiAppsSurface" /> Slack Agents &amp; AI Apps surface</label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Create OAuth app</button></Form><Form method="post" className={panelClass}><input type="hidden" name="intent" value="installation-import" /><h2 className="font-semibold">Import operator-owned Slack installation</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><input required name="appId" placeholder="Channel App ID" className={fieldClass} /><input name="teamId" placeholder="Slack team ID" className={fieldClass} /><input name="enterpriseId" placeholder="Enterprise ID" className={fieldClass} /><input name="teamName" placeholder="Team name" className={fieldClass} /><input required type="password" name="botToken" placeholder="Bot token" className={fieldClass} /><input name="agentId" placeholder="Agent ID" className={fieldClass} /></div><input type="hidden" name="agentRouting" value="[]" /><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Import installation</button></Form></div><details className={panelClass}><summary className="font-semibold">Custom frontend connection contract</summary><pre className="mt-3 max-h-64 overflow-auto rounded bg-charcoal-950 p-3 text-xs">{stableJson(connect)}</pre></details><p className="text-xs text-text-dimmed">Session tokens are minted by the operator with @platosdev/token-mint and the Entity service secret. This dashboard does not mint identity-bearing session tokens.</p></div>;
}

function Skills({ data, install }: { data: unknown; install: boolean }) {
  const skills = firstArray(asRecord(data), "skills", "items");
  if (install) {
    return <Form method="post" className={panelClass}><h2 className="font-semibold">Import a custom Skill package</h2><p className="mt-1 text-sm text-text-dimmed">The agent fetches and parses the manifest from this URL, then stores the effective configuration in the scoped registry.</p><label className="mt-3 block text-xs">Skill URL<input required name="url" type="url" placeholder="https://example.com/SKILL.md" className={fieldClass} /></label><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Import and validate</button></Form>;
  }
  return <div className="space-y-4"><div className="flex justify-end"><Link to="new" className="rounded bg-indigo-500 px-4 py-2 text-sm text-white">Import Skill</Link></div><Table headers={["Skill", "Origin", "Environment", "Effective configuration"]} rows={skills.map((value) => { const skill = asRecord(value); return [asString(skill.name, asString(skill.id)), asBoolean(skill.isOfficial) ? "Embedded official" : asString(skill.origin, "custom"), <Status value={asBoolean(skill.envReady) ? "Ready" : "Missing environment references"} />, <details><summary className="cursor-pointer text-xs text-indigo-300">Inspect seeded config</summary><pre className="mt-2 max-h-64 max-w-xl overflow-auto whitespace-pre-wrap rounded bg-charcoal-950 p-3 text-xs">{stableJson(skill.effectiveConfig ?? skill.manifest ?? skill)}</pre></details>]; })} /><p className="text-xs text-text-dimmed">Enable or disable Skills from an Agent’s Effective Skills screen. Those controls invalidate the prompt cache so the next Turn uses the persisted selection.</p></div>;
}

function PostmanTemplates({ data }: { data: unknown }) {
  const templates = firstArray(asRecord(data), "templates", "items");
  const form = (template?: Record<string, unknown>) => {
    const id = asString(template?.id, "");
    return <Form method="post" className={panelClass}><input type="hidden" name="intent" value={id ? "update" : "create"} />{id && <input type="hidden" name="templateId" value={id} />}<h2 className="font-semibold">{id ? `Edit ${asString(template?.name, id)}` : "Create debug identity template"}</h2><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs">Name<input required name="name" defaultValue={asString(template?.name, "")} className={fieldClass} /></label><label className="text-xs">Simulated user ID<input required name="simulateUserId" defaultValue={asString(template?.simulateUserId, "")} className={fieldClass} /></label></div><label className="mt-3 block text-xs">Session Context — JSON object<textarea name="sessionContext" defaultValue={stableJson(asRecord(template?.sessionContext))} className={`${fieldClass} min-h-24 font-mono text-xs`} /></label><label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="isDefault" defaultChecked={asBoolean(template?.isDefault)} /> Default for this Agent</label><div className="mt-3 flex gap-3"><button className="rounded bg-indigo-500 px-4 py-2 text-sm text-white">{id ? "Update template" : "Create template"}</button>{id && <button name="intent" value="delete" className="rounded border border-red-500/50 px-4 py-2 text-sm text-red-200">Delete</button>}</div></Form>;
  };
  return <div className="space-y-4"><div className="grid gap-4 xl:grid-cols-2">{templates.map((value) => <div key={asString(asRecord(value).id)}>{form(asRecord(value))}</div>)}</div>{form()}<p className="text-xs text-text-dimmed">Templates select a real scoped user identity for debugging. They do not mint or bridge dashboard identities.</p></div>;
}

function McpConfig({ data }: { data: unknown }) {
  const config = asRecord(data);
  return <div className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><Card title="Gateway" value={<Status value={asBoolean(config.enabled) ? "Enabled" : "Disabled"} />} /><Card title="Identity" value={asString(config.identityMode, "bearer")} /><Card title="Active bearer tokens" value={asNumber(config.bearerTokenCount)} /></div><Form method="post" className={panelClass}><h2 className="font-semibold">Persist MCP gateway configuration</h2><div className="mt-3 grid gap-3 md:grid-cols-3"><label className="text-xs">Identity mode<select name="identityMode" defaultValue={asString(config.identityMode, "bearer")} className={fieldClass}><option value="bearer">Bearer</option><option value="oidc">OIDC</option><option value="anonymous">Anonymous</option></select></label><label className="text-xs">Rate limit / minute<input name="rateLimitPerMinute" type="number" min="1" max="10000" defaultValue={asNumber(config.rateLimitPerMinute, 60)} className={fieldClass} /></label><label className="mt-6 flex items-center gap-2 text-xs"><input type="checkbox" name="enabled" defaultChecked={asBoolean(config.enabled)} /> Enable gateway</label></div><div className="mt-3 grid gap-3 lg:grid-cols-2"><label className="text-xs">Identity providers — JSON object<textarea name="identityProviders" defaultValue={stableJson(asRecord(config.identityProviders))} className={`${fieldClass} min-h-28 font-mono text-xs`} /></label><label className="text-xs">Branding — JSON object<textarea name="branding" defaultValue={stableJson(asRecord(config.branding))} className={`${fieldClass} min-h-28 font-mono text-xs`} /></label><label className="text-xs">Tool allow-list<textarea name="toolAllowlist" defaultValue={asArray(config.toolAllowlist).join("\n")} className={`${fieldClass} min-h-24 font-mono text-xs`} /></label><label className="text-xs">Redirect URI allow-list<textarea name="redirectUriAllowlist" defaultValue={asArray(config.redirectUriAllowlist).join("\n")} className={`${fieldClass} min-h-24 font-mono text-xs`} /></label></div><button className="mt-3 rounded bg-indigo-500 px-4 py-2 text-sm text-white">Save typed MCP config</button></Form></div>;
}

function Generic({ data }: { data: unknown }) {
  const root = asRecord(data);
  const rows = Object.entries(root).find(([, value]) => Array.isArray(value))?.[1];
  if (Array.isArray(rows)) return <Table headers={["Name", "Status", "Details"]} rows={rows.map((value) => { const row = asRecord(value); return [asString(row.name, asString(row.slug, asString(row.id))), <Status value={row.status ?? row.enabled} />, <code className="text-xs">{stableJson(row).slice(0, 300)}</code>]; })} />;
  return <pre className="max-h-[65vh] overflow-auto rounded-lg border border-grid-bright bg-background-bright p-4 text-xs">{stableJson(data)}</pre>;
}

export function M4Surface({ data }: { data: SurfaceData }) {
  const navigation = useNavigation();
  const actionData = useActionData<MutationData>();
  const content = data.panel.ok ? data.panel.data : null;
  const secondary = data.secondary?.ok ? data.secondary.data : null;
  const supporting = data.supporting?.ok ? data.supporting.data : null;
  let body: ReactNode;
  if (!data.panel.ok) body = <Failure error={data.panel.error} />;
  else if (data.surface === "agents") body = <Agents data={content} />;
  else if (data.surface === "agent-tools") body = <AgentTools data={content} />;
  else if (data.surface === "tools") body = <Registry data={content} testable />;
  else if (data.surface === "entities") body = <Entities data={content} matrixData={secondary} />;
  else if (data.surface === "monitoring") body = <Monitoring data={content} />;
  else if (data.surface === "context") body = <Context data={content} />;
  else if (data.surface === "conversations") body = <Conversations data={content} />;
  else if (data.surface === "trace") body = <Trace data={content} />;
  else if (data.surface === "thread") body = <Thread data={content} />;
  else if (data.surface === "canary") body = <Canary data={content} versionsData={secondary} />;
  else if (data.surface === "versions") body = <Versions data={content} />;
  else if (data.surface === "budgets") body = <Budgets data={content} capsData={secondary} />;
  else if (data.surface === "governance") body = <Governance data={content} />;
  else if (data.surface === "clusters") body = <Clusters data={content} agentsData={secondary} />;
  else if (data.surface === "evals") body = <Evals data={content} criteriaData={secondary} criteriaScreen={/criteria/i.test(data.title)} />;
  else if (data.surface === "jobs") body = <Jobs data={content} create={/create/i.test(data.title)} />;
  else if (data.surface === "channels") body = <Channels connectionData={content} appsData={secondary} channelsData={supporting} />;
  else if (data.surface === "skills") body = <Skills data={content} install={/install/i.test(data.title)} />;
  else if (data.surface === "postman") body = <PostmanTemplates data={content} />;
  else if (data.surface === "mcp-config") body = <McpConfig data={content} />;
  else if (data.surface === "entity-create") body = <EntityCreate />;
  else if (data.surface === "entity-secret") body = <EntitySecret />;
  else if (data.surface === "wire-test") body = <WireTest />;
  else body = <Generic data={content} />;

  const secondaryConsumed = ["canary", "entities", "budgets", "clusters", "evals", "channels"].includes(data.surface);
  return (
    <Page>
      <header className="mb-6 flex items-start justify-between"><div><div className="text-xs uppercase tracking-widest text-text-dimmed">Platos / M4</div><h1 className="mt-1 text-2xl font-semibold">{data.title}</h1><p className="mt-1 max-w-3xl text-sm text-text-dimmed">{data.description}</p></div><Form method="get"><button className="rounded border border-grid-bright bg-background-bright px-3 py-2 text-sm" disabled={navigation.state !== "idle"}>{navigation.state === "idle" ? "Refresh" : "Loading…"}</button></Form></header>
      <ActionFeedback data={actionData} />
      {body}
      {data.surface === "agent-create" && <AgentConfigForm data={null} create />}
      {data.surface === "agent-config" && <AgentConfigForm data={content} create={false} />}
      {data.secondary && !secondaryConsumed && <div className="mt-5">{data.secondary.ok ? <Generic data={data.secondary.data} /> : <Failure error={data.secondary.error} />}</div>}
      {data.provenance && <p className="mt-4 text-xs text-text-dimmed">{data.provenance}</p>}
    </Page>
  );
}
