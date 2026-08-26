import { Form, Link, useSearchParams } from "@remix-run/react";
import { asArray, asBoolean, asNumber, asRecord, asString, compactNumber, firstArray, moneyFromCents, percent, stableJson } from "../safe";
import { Alert, Button, CodeBlock, CollectionSearch, DataTable, EmptyState, PaginationRange, Panel, PanelFailure, ProgressBar, SectionHeader, StatTile, StatusChip, Toolbar } from "../ProductPrimitives";
import { fieldClass, Status, type SurfaceProps } from "./SurfaceCommon";

export function HomeSurface({ data }: SurfaceProps) {
  const root = asRecord(data);
  const panel = (key: string) => asRecord(root[key]);
  const value = (key: string) => panel(key).ok === true ? panel(key).data : null;
  const error = (key: string) => panel(key).ok === false ? asRecord(panel(key).error) : null;
  const agents = firstArray(asRecord(value("agents")), "agents", "items");
  const tools = firstArray(asRecord(value("tools")), "rows", "tools", "items");
  const approvals = firstArray(asRecord(value("approvals")), "approvals", "items");
  const cards = firstArray(asRecord(value("monitoring")), "cards");
  const agentsRoot = asRecord(value("agents"));
  const toolsRoot = asRecord(value("tools"));
  const approvalsRoot = asRecord(value("approvals"));
  const agentTotal = asNumber(asRecord(agentsRoot.pagination).total, asNumber(agentsRoot.total, agents.length));
  const toolTotal = asNumber(asRecord(toolsRoot.pagination).total, asNumber(toolsRoot.total, tools.length));
  const approvalTotal = asNumber(asRecord(approvalsRoot.pagination).total, asNumber(approvalsRoot.total, approvals.length));
  const unavailableTools = asNumber(asRecord(toolsRoot.aggregates).unavailable, tools.filter((entry) => !asBoolean(asRecord(entry).dispatchable)).length);
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><StatTile title="Agents" value={agentTotal} /><StatTile title="Tools" value={toolTotal} hint={`${unavailableTools} undispatchable`} /><StatTile title="Waiting approvals" value={approvalTotal} /><StatTile title="Runtime snapshot" value={cards.length ? asString(asRecord(cards[0]).label, "Available") : "Quiet"} /></div>
    {(unavailableTools > 0 || approvalTotal > 0) && <Alert tone={unavailableTools > 0 ? "danger" : "warning"} title="Operator attention required">{unavailableTools > 0 ? `${unavailableTools} canonical Tool rows are not dispatchable.` : `${approvalTotal} Tool Calls are waiting for approval.`}</Alert>}
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel><SectionHeader title="Build" description="Reachable production surfaces." /><div className="grid gap-2 sm:grid-cols-2"><Link to="agents" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Agents <span className="block text-xs text-text-dimmed">Configure and test runtime workers</span></Link><Link to="agent-tools" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Tool registry <span className="block text-xs text-text-dimmed">Dispatchability and source Entities</span></Link><Link to="agent-entities" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Entities <span className="block text-xs text-text-dimmed">Connection and discovery diagnostics</span></Link><Link to="agent-providers" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Providers <span className="block text-xs text-text-dimmed">Credentials and model routes</span></Link></div></Panel>
      <Panel><SectionHeader title="Observe and govern" description="Only routes backed by canonical endpoints." /><div className="grid gap-2 sm:grid-cols-2"><Link to="threads" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Threads <span className="block text-xs text-text-dimmed">Global Environment history</span></Link><Link to="agent-monitoring" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Monitoring <span className="block text-xs text-text-dimmed">Incidents and affected scope</span></Link><Link to="cost" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Cost <span className="block text-xs text-text-dimmed">Usage-ledger provenance</span></Link><Link to="audit" className="rounded-md border border-grid-bright p-3 text-sm hover:bg-[var(--surface-2)]">Audit log <span className="block text-xs text-text-dimmed">Tool Call ground truth</span></Link></div></Panel>
    </div>
    {(["agents", "monitoring", "tools", "approvals"] as const).map((key) => { const failure = error(key); return failure ? <PanelFailure key={key} error={{ code: asString(failure.code, "PANEL_UNAVAILABLE"), message: asString(failure.message, `${key} panel unavailable`) }} /> : null; })}
  </div>;
}

export function MonitoringSurface({ data, secondary }: SurfaceProps) {
  const root = asRecord(data); const cards = firstArray(root, "cards"); const failures = firstArray(root, "failures", "failureCauses", "incidents"); const agentRows = firstArray(asRecord(secondary), "rows", "agents", "items"); const lanesValue = root.costByLane; const lanes = Array.isArray(lanesValue) ? lanesValue.map(asRecord) : Object.entries(asRecord(lanesValue)).map(([lane, value]) => ({ lane, costCents: typeof value === "number" ? value : asNumber(asRecord(value).costCents) })); const activeIncident = failures.find((value) => { const row = asRecord(value); return asNumber(row.count, 1) > 0 || ["active", "open", "failed"].includes(asString(row.status, "").toLowerCase()); });
  const hasData = cards.length || lanes.length || failures.length || agentRows.length;
  if (!hasData) return <EmptyState title="Nothing to monitor yet" description="Canonical Turns, traces, Tool failures and approvals will populate this screen after runtime activity." />;
  return <div className="space-y-5">{activeIncident !== undefined && <Alert tone="danger" title="Active incident">{asString(asRecord(activeIncident).message, asString(asRecord(activeIncident).cause, "Runtime failures require attention"))}</Alert>}<Toolbar><span className="text-xs font-medium">Is anything failing right now, and who does it affect?</span><div className="ml-auto flex gap-2"><span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs text-[var(--accent)]">24h</span><Link to="users" className="rounded-full border border-grid-bright px-3 py-1 text-xs">By user</Link></div></Toolbar><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map((value, index) => { const card = asRecord(value); const unit = asString(card.unit); return <StatTile key={asString(card.id, `${index}`)} title={asString(card.label, asString(card.id))} value={unit === "cents" ? moneyFromCents(card.value) : compactNumber(card.value)} hint={asString(card.id) === "tasks_7d" ? "One task is one completed Turn" : unit} />; })}</div>{failures.length > 0 && <Panel><SectionHeader title="Failures by cause · 24h" description="Canonical attribution from dispatch and provider status fields." /><DataTable headers={["Cause", "Affected scope", "Count", "State"]} rows={failures.map((value) => { const row = asRecord(value); return [asString(row.cause, asString(row.name, asString(row.message))), asString(row.affectedScope, asString(row.agentId, asString(row.threadId, "Environment"))), compactNumber(row.count ?? row.total), <Status value={row.status ?? "failed"} />]; })} /></Panel>}<Panel><SectionHeader title="Usage-ledger cost lanes" description="Provider usage reconciled at completion; pricing catalogue version is historically pinned." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{lanes.map((lane, index) => <StatTile key={asString(lane.lane, `${index}`)} title={asString(lane.lane, asString(asRecord(lane).name))} value={moneyFromCents(lane.costCents)} />)}</div><p className="mt-4 text-xs text-text-dimmed">The dashboard formats endpoint values and performs no cost or task classification.</p></Panel>{agentRows.length > 0 && <Panel><SectionHeader title="Affected Agents" /><DataTable headers={["Agent", "Turns", "Failures", "Cost", "p95"]} rows={agentRows.map((value) => { const row = asRecord(value); return [asString(row.agentName, asString(row.agentId)), compactNumber(row.turns ?? row.turnCount), compactNumber(row.failures ?? row.errorCount), moneyFromCents(row.costCents ?? row.totalCostCents), `${asNumber(row.p95LatencyMs)}ms`]; })} /></Panel>}</div>;
}

export function MonitoringUsersSurface({ data }: SurfaceProps) { const root = asRecord(data); const users = asArray(root.users); const nextCursor = asString(root.nextCursor, ""); const fetchedAt = asString(root.fetchedAt, ""); const [searchParams] = useSearchParams(); const cursor = searchParams.get("cursor") ?? ""; const trail = searchParams.getAll("from").slice(-10); const nextParams = new URLSearchParams(searchParams); if (nextCursor) { nextParams.set("cursor", nextCursor); nextParams.append("from", cursor || "__first"); } const previousParams = new URLSearchParams(searchParams); const previousCursor = trail.at(-1); previousParams.delete("from"); for (const entry of trail.slice(0, -1)) previousParams.append("from", entry); if (!previousCursor || previousCursor === "__first") previousParams.delete("cursor"); else previousParams.set("cursor", previousCursor); const link = (params: URLSearchParams) => params.toString() ? `?${params}` : "?"; if (!users.length && !cursor) return <EmptyState title="No end-user activity" description="Completed Turns appear when attributed to canonical EndUsers in this Environment." />; return <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><StatTile title="Users on this page" value={users.length} hint="Maximum 100 per request" /><StatTile title="Snapshot" value={<span className="text-sm">{fetchedAt || "Current"}</span>} hint="Agent-provided aggregation time" /></div><DataTable headers={["User", "Conversations", "Agents", "Turns", "Cost · 7d", "Risk", "Last active"]} rows={users.map((value) => { const user = asRecord(value); const id = asString(user.userId, "unknown"); return [<div><div className="font-medium">{asString(user.alias, asString(user.externalUserId, id))}</div><code className="text-[11px] text-text-dimmed">{id}</code></div>, compactNumber(user.totalConversations), compactNumber(user.agentsTouched), compactNumber(user.totalTurns), moneyFromCents(user.cost7dCents), <StatusChip tone={asNumber(user.riskFlagCount) > 0 ? "danger" : "good"}>{asNumber(user.riskFlagCount)} flags</StatusChip>, asString(user.lastActiveAt, "—")]; })} /><div className="flex justify-between">{trail.length > 0 ? <Link to={link(previousParams)} className="rounded-md border border-grid-bright px-3 py-2 text-sm">Previous page</Link> : <span />}{nextCursor && <Link to={link(nextParams)} className="rounded-md bg-primary px-3 py-2 text-sm text-white">Next page</Link>}</div></div>; }

export function CostSurface({ data, secondary, supporting }: SurfaceProps) {
  const daily = asRecord(data);
  const agentRoot = asRecord(secondary);
  const modelRoot = asRecord(supporting);
  const agents = firstArray(agentRoot, "rows", "agents", "items");
  const models = firstArray(modelRoot, "rows", "models", "items");
  const lanesValue = daily.costByLane ?? daily.lanes;
  const lanes = Array.isArray(lanesValue)
    ? lanesValue.map(asRecord)
    : Object.entries(asRecord(lanesValue)).map(([lane, value]) => ({ lane, costCents: typeof value === "number" ? value : asNumber(asRecord(value).costCents), tokens: asNumber(asRecord(value).tokens) }));
  const total = asNumber(daily.totalCostCents, asNumber(daily.costCents, lanes.reduce((sum, lane) => sum + asNumber(lane.costCents), 0)));
  const turns = asNumber(daily.turns, asNumber(daily.tasks, asNumber(daily.runs)));
  const agentTotal = asNumber(asRecord(agentRoot.pagination).total, asNumber(agentRoot.total, agents.length));
  const modelPagination = asRecord(modelRoot.pagination);
  const modelTotal = asNumber(modelPagination.total, asNumber(modelRoot.total, models.length));
  if (!total && !turns && !lanes.length && !agentTotal && !modelTotal) return <EmptyState title="No spend yet" description="The canonical usage ledger has no cost rows for this scope and date. No pricing classes are inferred from aggregate totals." />;
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><StatTile title="Spend" value={moneyFromCents(total)} hint={asString(daily.date, "Selected UTC day")} /><StatTile title="Turns" value={compactNumber(turns)} hint="Headline activity unit" /><StatTile title="Input tokens" value={compactNumber(daily.inputTokens)} /><StatTile title="Output tokens" value={compactNumber(daily.outputTokens)} /></div>
    <Panel><SectionHeader title="Four lanes" description="Only canonical endpoint lanes are shown; absent cache classes remain absent." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{lanes.map((lane, index) => <StatTile key={asString(lane.lane, `${index}`)} title={asString(lane.lane, asString(asRecord(lane).name))} value={moneyFromCents(lane.costCents)} hint={`${compactNumber(lane.tokens)} tokens`} />)}</div></Panel>
    <Panel>
      <SectionHeader title="By Agent" description="Search and pagination apply to the complete scoped 30-day Agent rollup." />
      <Toolbar><CollectionSearch label="Search Agent cost rows" placeholder="Search Agents" /></Toolbar>
      {agents.length ? <DataTable
        headers={["Agent", "Turns", "Input", "Output", "Cost"]}
        rowKeys={agents.map((value, index) => asString(asRecord(value).agentId, `cost-agent-${index}`))}
        rows={agents.map((value) => { const row = asRecord(value); return [asString(row.agentName, asString(row.agentId)), compactNumber(row.turns ?? row.tasks ?? row.turnCount), compactNumber(row.inputTokens), compactNumber(row.outputTokens), moneyFromCents(row.costCents ?? row.totalCostCents)]; })}
      /> : <EmptyState title={agentTotal > 0 ? "No Agent cost rows on this page" : "No matching Agent cost rows"} description={agentTotal > 0 ? "This page is past the end of the Agent cost rollup." : "No Agent cost rows match the complete scoped search."} />}
      <PaginationRange data={agentRoot} label="Agent cost pagination" />
    </Panel>
    {modelTotal > 0 && <Panel><SectionHeader title="By model" description={`Bounded supporting summary · showing ${asNumber(modelPagination.from, models.length ? 1 : 0)}–${asNumber(modelPagination.to, models.length)} of ${modelTotal.toLocaleString()} models.`} /><DataTable headers={["Model", "Provider", "Turns", "Tokens", "Cost"]} rowKeys={models.map((value, index) => asString(asRecord(value).model, asString(asRecord(value).modelId, `cost-model-${index}`)))} rows={models.map((value) => { const row = asRecord(value); return [asString(row.model, asString(row.modelId)), asString(row.provider, "—"), compactNumber(row.turns ?? row.tasks ?? row.turnCount), `${compactNumber(row.inputTokens)} in / ${compactNumber(row.outputTokens)} out`, moneyFromCents(row.costCents ?? row.totalCostCents)]; })} /></Panel>}
    <Panel><SectionHeader title="Provenance" /><p className="text-sm text-text-dimmed">Immutable Turn and Step usage snapshots · provider usage reconciled at completion · historical model rate card pinned by the Agent service. The dashboard does not classify, reprice, or extrapolate costs.</p></Panel>
  </div>;
}

export function BudgetsSurface({ data, secondary }: SurfaceProps) {
  const statusRoot = asRecord(data); const statuses = firstArray(statusRoot, "caps", "items"); const capsRoot = asRecord(secondary); const caps = firstArray(capsRoot, "caps", "items"); const breached = statuses.filter((value) => asBoolean(asRecord(value).blocked)); const statusTotal = asNumber(asRecord(statusRoot.pagination).total, statuses.length);
  return <div className="space-y-5">{breached.length > 0 && <Alert tone="danger" title={`${breached.length} budget${breached.length === 1 ? " is" : "s are"} breached on this page`}>Enforcement state comes from the canonical budget-status endpoint. Use a bounded override only after reviewing affected Turns.</Alert>}<div className="grid gap-3 md:grid-cols-3"><StatTile title="Enforcement" value={<Status value={asBoolean(statusRoot.blocked) ? "blocked" : "available"} />} hint={asString(statusRoot.reason, "Cache-aware ledger spend")} /><StatTile title="Matching evaluated budgets" value={statusTotal} /><StatTile title="Activity unit" value="Completed Turn" /></div><Panel><SectionHeader title="Budget progress" /><div className="space-y-4">{statuses.map((value, index) => { const status = asRecord(value); const cap = asRecord(status.cap); const spent = asNumber(status.spentCents); const limit = asNumber(cap.limitCents); const ratio = limit > 0 ? spent / limit : 0; return <div key={asString(cap.id, `${index}`)} className="rounded-md border border-grid-bright p-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><span className="font-medium">{asString(cap.scopeType)}/{asString(cap.targetId, "Environment")}</span><span className="ml-2 text-xs text-text-dimmed">{asString(cap.period)}</span></div><Status value={asBoolean(status.blocked) ? "blocked" : asBoolean(status.overrideActive) ? "override active" : "active"} /></div><ProgressBar value={spent} max={limit || 1} tone={asBoolean(status.blocked) ? "danger" : ratio >= .8 ? "warning" : "good"} label={`${moneyFromCents(spent)} of ${moneyFromCents(limit)} · ${compactNumber(status.runs)} / ${compactNumber(cap.runsLimit)} Turns`} /></div>; })}{!statuses.length && <EmptyState title={statusTotal > 0 ? "No budget statuses on this page" : "No budgets set"} description={statusTotal > 0 ? "This page is past the end of the evaluated budget statuses. Use Previous to return to available results." : "Create an Environment, Agent, or End-user budget below. Enforcement remains server-authoritative."} />}</div></Panel><PaginationRange data={statusRoot} label="Budget status pagination" />{caps.length > 0 && <DataTable headers={["Configured budget", "Lane", "Thresholds", "Override", "Actions"]} rowKeys={caps.map((value, index) => asString(asRecord(value).id, `budget-${index}`))} rows={caps.map((value) => { const cap = asRecord(value); const id = asString(cap.id); return [`${asString(cap.scopeType)}/${asString(cap.period)} · ${moneyFromCents(cap.limitCents)}`, `${asString(cap.tier, "llm")}${asString(cap.skillSlug, "") ? `/${asString(cap.skillSlug)}` : ""}`, asArray(cap.alertThresholds).join(", "), asString(cap.overrideUntil, "—"), <div className="flex gap-3"><Form method="post"><input type="hidden" name="intent" value="override" /><input type="hidden" name="capId" value={id} /><input type="hidden" name="minutes" value="60" /><button className="text-xs text-[var(--accent)]">Raise once · 60m</button></Form><Form method="post"><input type="hidden" name="intent" value="delete" /><input type="hidden" name="capId" value={id} /><button className="text-xs text-[var(--danger)]">Delete</button></Form></div>]; })} />}{!caps.length && <EmptyState title={asNumber(asRecord(capsRoot.pagination).total) > 0 ? "No configured budgets on this page" : "No configured budgets"} description={asNumber(asRecord(capsRoot.pagination).total) > 0 ? "This page is past the end of the configured budget list. Use Previous to return to available results." : "Create an Environment, Agent, or End-user budget below."} />}<PaginationRange data={capsRoot} label="Configured budget pagination" /><Form method="post"><Panel><input type="hidden" name="intent" value="save" /><SectionHeader title="Set Environment budget" description="Display and enforcement use the same endpoint-provided cap status." /><div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5"><label className="text-xs">Scope<select name="scopeType" className={fieldClass}><option value="scope">Environment</option><option value="agent">Agent</option><option value="user">End user</option></select></label><label className="text-xs">Target ID<input name="targetId" placeholder="blank for Environment" className={fieldClass} /></label><label className="text-xs">Period<select name="period" className={fieldClass}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label><label className="text-xs">Cost limit, cents<input required type="number" min="0" name="limitCents" className={fieldClass} /></label><label className="text-xs">Turn limit<input type="number" min="0" name="runsLimit" defaultValue="0" className={fieldClass} /></label><label className="text-xs">Lane<select name="tier" className={fieldClass}><option value="llm">LLM</option><option value="skill">Skill</option></select></label><label className="text-xs">Skill slug<input name="skillSlug" className={fieldClass} /></label><label className="text-xs">Agent filter<input name="agentId" className={fieldClass} /></label><label className="text-xs">Thresholds<input name="alertThresholds" defaultValue="50, 80, 100" className={fieldClass} /></label><label className="text-xs">Alert emails<input name="alertEmails" className={fieldClass} /></label></div><label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" name="enabled" defaultChecked /> Enforce this budget</label><Button type="submit" tone="primary" className="mt-3">Persist budget</Button><p className="mt-3 text-xs text-text-dimmed">The UI performs no billing or enforcement classification.</p></Panel></Form></div>;
}

export function GovernanceSurface({ data, secondary, title }: SurfaceProps) {
  const root = asRecord(data);
  const detail = Object.keys(asRecord(root.approval)).length ? asRecord(root.approval) : root;
  const rows = firstArray(root, "approvals", "items");
  const isApproval = title.toLowerCase().includes("approval");
  const safetyRoot = asRecord(secondary);
  const safetyEvents = firstArray(safetyRoot, "safetyEvents", "events", "items", "rows");
  const rules = firstArray(root, "rules", "policies");
  const pagination = asRecord(root.pagination);
  const total = asNumber(pagination.total, asNumber(root.total, rows.length));
  const [searchParams] = useSearchParams();
  const hasFilters = Boolean(searchParams.get("search") || searchParams.get("status") || searchParams.get("source") || searchParams.get("agentId") || searchParams.get("threadId") || searchParams.get("sinceDays"));
  const safetyTotal = asNumber(asRecord(safetyRoot.pagination).total, safetyEvents.length);

  if (isApproval) {
    const approvals = rows.length ? rows : detail.id ? [detail] : [];
    const isDetail = !rows.length && Boolean(detail.id);
    if (!approvals.length) {
      return <div className="space-y-4">
        <Toolbar><CollectionSearch label="Search approvals" placeholder="Search approvals" /></Toolbar>
        <EmptyState
          title={total > 0 ? "No approvals on this page" : hasFilters ? "No matching approvals" : "Queue is clear"}
          description={total > 0 ? "This page is past the end of the approval queue. Use Previous to return to available results." : hasFilters ? "No canonical approvals match the current server-side filters." : "No canonical approval is waiting for an operator decision."}
        />
        <PaginationRange data={root} label="Approval pagination" />
      </div>;
    }
    return <div className="space-y-5">
      {!isDetail && <Toolbar><CollectionSearch label="Search approvals" placeholder="Search approvals" /></Toolbar>}
      <DataTable
        headers={["Approval", "Tool", "Requester", "Waiting", "Risk", "Status"]}
        rowKeys={approvals.map((value, index) => asString(asRecord(value).id, asString(asRecord(value).approvalId, `approval-${index}`)))}
        rows={approvals.map((value) => {
          const approval = asRecord(value);
          const id = asString(approval.id, asString(approval.approvalId));
          return [<Link className="font-medium text-[var(--accent)] hover:underline" to={rows.length ? id : "."}>{id}</Link>, asString(approval.toolName, asString(approval.kind, asString(approval.action))), asString(approval.requestedBy, "system"), asString(approval.waitingDuration, asString(approval.createdAt, "—")), <Status value={approval.risk ?? approval.severity ?? "review"} />, <Status value={approval.status} />];
        })}
      />
      {!isDetail && <PaginationRange data={root} label="Approval pagination" />}
      {isDetail && asString(detail.status, "pending") === "pending" && <Form method="post"><Panel tone="warning"><SectionHeader title="Resolve exactly once" description="Repeated decisions return the persisted outcome; they do not execute a Tool twice." /><CodeBlock label="Requested Tool arguments">{stableJson(detail.args ?? detail.arguments ?? {})}</CodeBlock><label className="mt-3 block text-xs">Comment<textarea name="comment" className={`${fieldClass} min-h-20`} /></label><details className="mt-3"><summary className="cursor-pointer text-xs text-[var(--accent)]">Approve with edited arguments</summary><textarea name="editedArgs" defaultValue={stableJson(detail.args ?? {})} className={`${fieldClass} min-h-24 font-mono text-xs`} /></details><div className="mt-3 flex gap-3"><Button type="submit" name="decision" value="approve" tone="primary">Approve</Button><Button type="submit" name="decision" value="reject" tone="danger">Reject</Button></div></Panel></Form>}
      {isDetail && asString(detail.status) !== "pending" && <Alert tone="good" title="Immutable decision recorded">{asString(detail.comment, "This approval has already been resolved.")}</Alert>}
    </div>;
  }
  return <div className="space-y-5"><Toolbar><CollectionSearch label="Search safety events" placeholder="Search all safety events" /></Toolbar>{rows.length > 0 && <Alert tone="warning" title={`${rows.length} approval${rows.length === 1 ? "" : "s"} waiting on this page`}>Blocking Tool Calls remain paused until resolved.</Alert>}<Panel><SectionHeader title="Recent safety events" description="Search and range metadata apply to the complete scoped safety-event ledger before pagination." />{safetyEvents.length ? <DataTable headers={["Event", "Severity", "Scope", "Agent", "At"]} rowKeys={safetyEvents.map((value, index) => asString(asRecord(value).id, `safety-${index}`))} rows={safetyEvents.map((value) => { const event = asRecord(value); return [asString(event.action, asString(event.detector, asString(event.kind))), <Status value={event.severity} />, asString(event.scope, asString(event.environmentId, "Environment")), asString(event.agentId, "—"), asString(event.createdAt)]; })} /> : <EmptyState title={safetyTotal > 0 ? "No safety events on this page" : searchParams.get("search") ? "No matching safety events" : "No recent safety events"} description={safetyTotal > 0 ? "This page is past the end of the safety-event ledger. Use Previous to return to available results." : searchParams.get("search") ? "No safety events match the current server-side search." : "Governance remains quiet until the canonical safety pipeline records an event."} />}<PaginationRange data={safetyRoot} label="Safety event pagination" /></Panel><Panel><SectionHeader title="Rules" description="Only endpoint-provided policies are displayed; the dashboard does not invent baseline rules." /><DataTable headers={["Rule", "Scope", "State", "Updated"]} rowKeys={rules.map((value, index) => asString(asRecord(value).id, `rule-${index}`))} rows={rules.map((value) => { const rule = asRecord(value); return [asString(rule.name, asString(rule.id)), asString(rule.scope, "Environment"), <Status value={rule.status ?? (asBoolean(rule.enabled) ? "enabled" : "disabled")} />, asString(rule.updatedAt, "—")]; })} empty={<EmptyState title="No governance rules" description="No canonical rules endpoint data was returned." />} /></Panel></div>;
}

export function EvalsSurface({ data, secondary, title }: SurfaceProps) {
  const root = asRecord(data);
  const evals = firstArray(root, "evals", "items", "rows");
  const criteriaScreen = title.toLowerCase().includes("criteria");
  const criteria = criteriaScreen ? firstArray(root, "criteria", "items") : firstArray(asRecord(secondary), "criteria", "items");
  const collection = criteriaScreen ? criteria : evals;
  const pagination = asRecord(root.pagination);
  const total = asNumber(pagination.total, asNumber(root.total, collection.length));
  const [searchParams] = useSearchParams();
  const hasFilters = Array.from(searchParams.keys()).some((name) => !["page", "pageSize"].includes(name));
  const empty = collection.length === 0;
  return <div className="space-y-5">
    <Toolbar><CollectionSearch label={criteriaScreen ? "Search evaluation criteria" : "Search evaluations"} placeholder={criteriaScreen ? "Search criteria" : "Search evaluations"} /></Toolbar>
    {empty ? <EmptyState
      title={total > 0 ? `No ${criteriaScreen ? "criteria" : "evaluations"} on this page` : hasFilters ? `No matching ${criteriaScreen ? "criteria" : "evaluations"}` : criteriaScreen ? "No evaluation criteria" : "No eval runs"}
      description={total > 0 ? "This page is past the end of the collection. Use Previous to return to available results." : hasFilters ? "No canonical rows match the current server-side filters." : criteriaScreen ? "Create a criterion below to define a canonical judge outcome." : "Run an evaluation against a persisted AgentVersion to create criterion outcomes and judge-lane cost."}
    /> : criteriaScreen ? <DataTable
      headers={["Criterion", "Agent", "Judge", "Scale", "State"]}
      rowKeys={criteria.map((value, index) => asString(asRecord(value).id, `criterion-${index}`))}
      rows={criteria.map((value) => { const row = asRecord(value); return [asString(row.name), asString(row.agentId, "Shared"), asString(row.judgeModel, "Default judge"), `${asNumber(row.scoreScaleMin)}–${asNumber(row.scoreScaleMax, 100)}`, <Status value={asBoolean(row.isActive) ? "active" : "inactive"} />]; })}
    /> : <DataTable
      headers={["Evaluation", "Criterion", "Agent version", "Score", "Judge cost"]}
      rowKeys={evals.map((value, index) => asString(asRecord(value).id, `eval-${index}`))}
      rows={evals.map((value) => { const row = asRecord(value); return [asString(row.id), asString(row.criterionName, asString(row.criterionId)), asString(row.agentVersionId), asNumber(row.score), moneyFromCents(row.costCents ?? row.judgeCostCents)]; })}
    />}
    <PaginationRange data={root} label={criteriaScreen ? "Evaluation criterion pagination" : "Evaluation pagination"} />
    {criteriaScreen ? <Form method="post"><Panel><SectionHeader title="Create evaluation criterion" /><div className="grid gap-3 md:grid-cols-2"><label className="text-xs">Name<input required name="name" className={fieldClass} /></label><label className="text-xs">Agent ID, optional<input name="agentId" className={fieldClass} /></label><label className="text-xs">Judge model<input name="judgeModel" className={fieldClass} /></label><label className="text-xs">Score range<div className="flex gap-2"><input type="number" name="scoreScaleMin" defaultValue="0" className={fieldClass} /><input type="number" name="scoreScaleMax" defaultValue="100" className={fieldClass} /></div></label></div><label className="mt-3 block text-xs">Judge prompt<textarea required name="judgePrompt" className={`${fieldClass} min-h-28`} /></label><label className="mt-3 block text-xs">Rubric<textarea name="rubric" className={`${fieldClass} min-h-20`} /></label><Button type="submit" tone="primary" className="mt-3">Create criterion</Button></Panel></Form> : <Panel><SectionHeader title="Criteria" description="Supporting criteria are explicitly bounded and are not included in the evaluation total." /><DataTable headers={["Criterion", "Judge", "Scale"]} rowKeys={criteria.map((value, index) => asString(asRecord(value).id, `supporting-criterion-${index}`))} rows={criteria.map((value) => { const row = asRecord(value); return [asString(row.name, asString(row.id)), asString(row.judgeModel, "Default"), `${asNumber(row.scoreScaleMin)}–${asNumber(row.scoreScaleMax, 100)}`]; })} /></Panel>}
  </div>;
}

export function AuditSurface({ data }: SurfaceProps) {
  const root = asRecord(data);
  const rows = firstArray(root, "items", "calls", "toolCalls", "rows");
  const pagination = asRecord(root.pagination);
  const total = asNumber(pagination.total, asNumber(root.total, rows.length));
  const [searchParams] = useSearchParams();
  const hasFilters = Array.from(searchParams.keys()).some((name) => !["page", "pageSize"].includes(name));
  return <div className="space-y-4">
    <Toolbar><CollectionSearch label="Search the Tool audit log" placeholder="Search audit entries" /><span className="text-xs text-text-dimmed">Immutable runtime audit · Tool Call ground truth</span></Toolbar>
    {!rows.length ? <EmptyState
      title={total > 0 ? "No audit entries on this page" : hasFilters ? "No matching audit entries" : "Log is empty"}
      description={total > 0 ? "This page is past the end of the audit log. Use Previous to return to available results." : hasFilters ? "No canonical Tool audit entries match the current server-side filters." : "No canonical Tool audit entries exist for this Environment and filter window."}
    /> : <DataTable
      headers={["Call", "Tool", "Agent / Thread", "Dispatch", "Provider", "Latency", "At"]}
      rowKeys={rows.map((value, index) => asString(asRecord(value).id, asString(asRecord(value).callId, `audit-${index}`)))}
      rows={rows.map((value) => {
        const row = asRecord(value);
        const failed = ["failed", "error"].includes(asString(row.status, asString(row.dispatchStatus, "")).toLowerCase());
        return [<code className={failed ? "border-l-2 border-[var(--danger)] pl-2 text-xs" : "pl-2 text-xs"}>{asString(row.id, asString(row.callId))}</code>, asString(row.toolName, asString(row.name)), <div className="text-xs"><div>{asString(row.agentId, "—")}</div><code className="text-[9px] text-text-dimmed">{asString(row.threadId, "—")}</code></div>, <Status value={row.dispatchStatus ?? row.status} />, <Status value={row.providerStatus ?? (failed ? "failed" : "complete")} />, `${asNumber(row.latencyMs)}ms`, asString(row.createdAt, asString(row.startedAt, "—"))];
      })}
    />}
    <PaginationRange data={root} label="Audit log pagination" />
  </div>;
}
