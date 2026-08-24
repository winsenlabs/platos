import { Form, Link, useSearchParams } from "@remix-run/react";
import { useState, type ReactNode } from "react";
import { asArray, asBoolean, asNumber, asRecord, asString, firstArray } from "../safe";
import { Alert, Button, CollectionSearch, DataTable, EmptyState, PaginationRange, Panel, SectionHeader, StatTile, Toolbar } from "../ProductPrimitives";
import { fieldClass, Status, type SurfaceProps } from "./SurfaceCommon";

function displayDate(value: unknown) {
  const text = asString(value);
  if (!text) return "—";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
}

function displayBytes(value: unknown) {
  const bytes = asNumber(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ClustersSurface({ data }: SurfaceProps) {
  const root = asRecord(data);
  const rows = firstArray(root, "clusters", "items");
  const cluster = asRecord(root.cluster);
  const members = firstArray(cluster, "agents", "members");
  const total = asNumber(asRecord(root.pagination).total, rows.length);
  const [searchParams] = useSearchParams();
  if (rows.length) return <div className="space-y-5"><Alert tone="warning" title="Shared recall boundary">Adding an Agent widens memory recall across every cluster member.</Alert><Toolbar><CollectionSearch label="Search clusters" placeholder="Search all clusters" /></Toolbar><DataTable headers={["Cluster", "Members", "Primary Agent", "Memory consequence"]} rowKeys={rows.map((value, index) => asString(asRecord(value).id, `cluster-${index}`))} rows={rows.map((value) => { const row = asRecord(value); return [<Link to={asString(row.id)} className="text-[var(--accent)]">{asString(row.name, row.slug as string)}</Link>, asNumber(row.agentCount, firstArray(row, "agents", "members").length), asString(row.primaryAgentId, "—"), "Shared recall scope"]; })} /><PaginationRange data={root} label="Cluster pagination" /><Form method="post"><Panel><SectionHeader title="Create cluster" /><div className="grid gap-3 md:grid-cols-2"><input required name="name" placeholder="Name" className={fieldClass} /><input required name="slug" placeholder="Slug" className={fieldClass} /><input name="primaryAgentId" placeholder="Primary Agent ID" className={fieldClass} /><input name="agentIds" placeholder="Agent IDs, comma-separated" className={fieldClass} /></div><textarea name="description" placeholder="Description" className={`${fieldClass} min-h-20`} /><Button type="submit" tone="primary" className="mt-3">Create widened memory scope</Button></Panel></Form></div>;
  if (Object.keys(cluster).length) return <div className="space-y-5"><Alert tone="warning">Every member can recall memory from this cluster scope.</Alert><DataTable headers={["Agent", "Role", "Remove"]} rowKeys={members.map((value, index) => asString(asRecord(value).agentId, `member-${index}`))} rows={members.map((value) => { const member = asRecord(value); const agent = asRecord(member.agent); const id = asString(member.agentId, asString(agent.id)); return [asString(agent.name, id), asString(member.role, "member"), <Form method="post"><input type="hidden" name="intent" value="remove-agent" /><input type="hidden" name="agentId" value={id} /><button className="text-xs text-[var(--danger)]">Remove</button></Form>]; })} /><Form method="post"><Panel><input type="hidden" name="intent" value="add-agent" /><SectionHeader title="Add Agent and widen recall" description="Enter the immutable Agent ID; this form does not present a partial Agent selector as complete." /><input required name="agentId" placeholder="Agent ID" className={fieldClass} /><input name="role" defaultValue="member" className={fieldClass} /><Button type="submit" className="mt-3">Add Agent</Button></Panel></Form></div>;
  return <div className="space-y-4"><Toolbar><CollectionSearch label="Search clusters" placeholder="Search all clusters" /></Toolbar><EmptyState title={total > 0 ? "No clusters on this page" : searchParams.get("search") ? "No matching clusters" : "No clusters"} description={total > 0 ? "This page is past the end of the cluster registry. Use Previous to return to available results." : searchParams.get("search") ? "No clusters match the current server-side search." : "No canonical cluster rows exist in this Environment."} /><PaginationRange data={root} label="Cluster pagination" /></div>;
}

export function JobsSurface({ data, title }: SurfaceProps) {
  const root = asRecord(data);
  const tasks = firstArray(root, "tasks", "jobs", "items");
  const task = asRecord(root.task);
  const create = title.toLowerCase().includes("create");
  const current = Object.keys(task).length ? task : {};
  const pagination = asRecord(root.pagination);
  const total = asNumber(pagination.total, asNumber(root.total, tasks.length));
  const [searchParams] = useSearchParams();
  const hasFilters = Boolean(searchParams.get("search") || searchParams.get("status"));
  const form = <Form method="post"><Panel><SectionHeader title={create ? "Create Platos-native background Job" : "Edit Job"} description="External Trigger tasks are infrastructure, not dashboard-owned domain Jobs." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{create && <input required name="taskId" pattern="[a-z0-9-]{1,64}" placeholder="Job ID" className={fieldClass} />}<input required={create} name="displayName" defaultValue={asString(current.displayName, "")} placeholder="Display name" className={fieldClass} /><select name="triggerType" defaultValue={asString(current.triggerType, "manual")} className={fieldClass}><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="webhook">Webhook</option></select><input name="scheduleCron" defaultValue={asString(current.scheduleCron, "")} placeholder="Schedule cron" className={fieldClass} /></div><Button type="submit" tone="primary" className="mt-3">{create ? "Create Job" : "Save Job"}</Button></Panel></Form>;
  if (create || Object.keys(task).length) return <div className="space-y-4">{Object.keys(task).length && <><div className="grid gap-3 md:grid-cols-3"><StatTile title="State" value={<Status value={asBoolean(task.isActive) ? "active" : "inactive"} />} /><StatTile title="Last run" value={displayDate(task.lastRunAt)} /><StatTile title="Schedule" value={asString(task.scheduleCron, "Manual")} /></div><Form method="post"><input type="hidden" name="intent" value="run" /><Button type="submit" tone="primary">Run now</Button></Form></>}{form}</div>;
  const preserved = Array.from(searchParams.entries()).filter(([name]) => !["status", "page"].includes(name));
  return <div className="space-y-4">
    <div className="flex justify-end"><Link to="new"><Button type="button" tone="primary">Create Job</Button></Link></div>
    <Toolbar>
      <CollectionSearch label="Search Jobs" placeholder="Search Jobs" />
      <Form method="get" className="flex flex-wrap items-center gap-2">
        {preserved.map(([name, value]) => <input key={`${name}-${value}`} type="hidden" name={name} value={value} />)}
        <label className="text-xs text-text-dimmed">State <select name="status" defaultValue={searchParams.get("status") ?? ""} className="ml-2 min-h-9 rounded-md border border-grid-bright bg-background-bright px-2 text-sm text-text-bright"><option value="">All</option><option value="ACTIVE">Active</option><option value="PENDING">Pending</option><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed</option><option value="CANCELLED">Cancelled</option></select></label>
        <Button type="submit">Apply</Button>
      </Form>
    </Toolbar>
    {!tasks.length ? <EmptyState
      title={total > 0 ? "No Jobs on this page" : hasFilters ? "No matching Jobs" : "No background Jobs"}
      description={total > 0 ? "This page is past the end of the Job list. Use Previous to return to available results." : hasFilters ? "No Platos-native Jobs match the current server-side filters." : "Create a Platos-native Job to schedule or manually queue background work."}
    /> : <DataTable
      headers={["Job", "Trigger", "State", "Last run"]}
      rowKeys={tasks.map((value, index) => asString(asRecord(value).id, `job-${index}`))}
      rows={tasks.map((value) => { const row = asRecord(value); return [<Link to={asString(row.id)} className="text-[var(--accent)]">{asString(row.displayName, asString(row.taskId))}</Link>, asString(row.triggerType, "manual"), <Status value={row.status ?? (asBoolean(row.isActive) ? "active" : "inactive")} />, displayDate(row.lastRunAt)]; })}
    />}
    <PaginationRange data={root} label="Job pagination" />
  </div>;
}

function ChannelConnectionRows({ channels, total, filtered }: { channels: unknown[]; total: number; filtered: boolean }) {
  return <DataTable headers={["Connection", "Provider", "Agent", "Credentials", "State", "Lifecycle"]} rowKeys={channels.map((value, index) => asString(asRecord(value).id, `channel-${index}`))} rows={channels.map((value) => { const row = asRecord(value); const id = asString(row.id); return [asString(row.displayName, id), asString(row.provider, "slack"), asString(row.defaultAgentId, "Unbound"), asBoolean(row.hasCredentials) ? "Stored" : "Missing", <Status value={asBoolean(row.enabled) ? "active" : "disabled"} />, <div className="flex flex-wrap gap-2"><Form method="post"><input type="hidden" name="intent" value="connection-toggle" /><input type="hidden" name="id" value={id} /><input type="hidden" name="agentId" value={asString(row.defaultAgentId)} /><input type="hidden" name="enabled" value={asBoolean(row.enabled) ? "false" : "true"} /><button className="text-xs text-[var(--accent)]">{asBoolean(row.enabled) ? "Disable" : "Enable"}</button></Form><Form method="post"><input type="hidden" name="intent" value="connection-rotate" /><input type="hidden" name="id" value={id} /><button className="text-xs text-[var(--warn)]">Rotate webhook</button></Form><Form method="post"><input type="hidden" name="intent" value="connection-delete" /><input type="hidden" name="id" value={id} /><button className="text-xs text-[var(--danger)]">Delete</button></Form></div>]; })} empty={<EmptyState title={total > 0 ? "No ChannelConnections on this page" : filtered ? "No matching ChannelConnections" : "No operator-owned connections"} description={total > 0 ? "This page is past the end of the ChannelConnection list. Use Previous to return to available results." : filtered ? "No operator-owned connections match the current server-side search." : "Create a provider connection or mint a Slack manifest below."} />} />;
}

export function ChannelsSurface({ data, secondary, supporting }: SurfaceProps) {
  const appsRoot = asRecord(secondary);
  const apps = firstArray(appsRoot, "apps", "items");
  const channelsRoot = asRecord(supporting);
  const channels = firstArray(channelsRoot, "channels", "items");
  const connect = asRecord(data);
  const websocket = asRecord(connect.websocket);
  const rest = asRecord(connect.rest);
  const installationStatuses = asRecord(appsRoot.installationStatuses);
  const [searchParams] = useSearchParams();
  const filtered = Boolean(searchParams.get("search"));
  const appTotal = asNumber(asRecord(appsRoot.pagination).total, apps.length);
  const channelTotal = asNumber(asRecord(channelsRoot.pagination).total, channels.length);
  return <div className="space-y-5">
    <Toolbar><CollectionSearch label="Search channels and apps" placeholder="Search all channels and apps" /></Toolbar>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><StatTile title="Matching hosted OAuth apps" value={appTotal} /><StatTile title="Matching operator connections" value={channelTotal} /><StatTile title="REST transport" value={asString(rest.baseUrl) ? "Ready" : "Unavailable"} /><StatTile title="WebSocket transport" value={asString(websocket.url) ? "Ready" : "Unavailable"} /></div>
    <Panel><SectionHeader title="Runtime connection contract" description="Typed transport metadata from the canonical Connect endpoint." /><DataTable headers={["Transport", "Endpoint", "Authentication"]} rows={[["REST", asString(rest.baseUrl, "Not configured"), "Scoped headers or signed session token"], ["WebSocket", asString(websocket.url, "Not configured"), "Authenticated handshake"]]} /></Panel>
    <SectionHeader title="Operator-owned ChannelConnections" description="Credentials remain in referenced envelopes. Rotated webhook URLs are revealed once." />
    <ChannelConnectionRows channels={channels} total={channelTotal} filtered={filtered} />
    <PaginationRange data={channelsRoot} label="ChannelConnection pagination" />
    <div className="grid gap-4 xl:grid-cols-2"><Form method="post"><Panel><input type="hidden" name="intent" value="connection-create" /><SectionHeader title="Create provider connection" /><select name="provider" className={fieldClass}><option value="slack">Slack</option><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option><option value="discord">Discord</option></select><input required name="agentId" placeholder="Agent ID" className={fieldClass} /><input name="displayName" placeholder="Display name" className={fieldClass} /><textarea name="credentials" placeholder="Provider credentials — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><textarea name="config" placeholder="Provider config — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><Button type="submit" tone="primary" className="mt-3">Create connection</Button></Panel></Form><Form method="post"><Panel tone="accent"><input type="hidden" name="intent" value="connection-mint" /><SectionHeader title="Mint Slack app from manifest" description="Slack configuration tokens are sent once and are never persisted or logged." /><input required name="agentId" placeholder="Agent ID" className={fieldClass} /><input name="displayName" placeholder="Slack app name" className={fieldClass} /><input required type="password" name="configToken" placeholder="Slack App Configuration Token" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Mint Slack app</Button></Panel></Form></div>
    <SectionHeader title="Hosted OAuth ChannelApps" description="Secrets are represented only by safe presence metadata." />
    <DataTable headers={["App", "Distribution", "Default Agent", "Secrets", "Installations", "Lifecycle"]} rowKeys={apps.map((value, index) => asString(asRecord(value).id, `channel-app-${index}`))} rows={apps.map((value) => { const row = asRecord(value); const id = asString(row.id); const statuses = firstArray(asRecord(installationStatuses[id]), "installations"); return [asString(row.displayName, id), asString(row.distribution, "private"), asString(row.defaultAgentId, "Unbound"), asBoolean(row.hasClientSecret) && asBoolean(row.hasSigningSecret) ? "Ready" : "Incomplete", statuses.length ? statuses.map((item) => { const status = asRecord(item); return <div key={asString(status.installationId)} className="mb-2 last:mb-0"><Status value={status.status} /> <span className="text-xs">{asString(status.teamName, asString(status.teamId, "Workspace"))}</span><div className="mt-1 flex gap-2"><Form method="post"><input type="hidden" name="intent" value="installation-bind" /><input type="hidden" name="appId" value={id} /><input type="hidden" name="installationId" value={asString(status.installationId)} /><input name="agentId" aria-label="Agent ID" placeholder="Agent ID" className="w-28 rounded border border-grid-bright bg-background-bright px-2 py-1 text-xs" /><button className="text-xs text-[var(--accent)]">Bind</button></Form><Form method="post"><input type="hidden" name="intent" value="installation-revoke" /><input type="hidden" name="appId" value={id} /><input type="hidden" name="installationId" value={asString(status.installationId)} /><button className="text-xs text-[var(--danger)]">Revoke</button></Form></div></div>; }) : "None", <div className="flex gap-2"><Form method="post"><input type="hidden" name="intent" value="app-toggle-ai" /><input type="hidden" name="appId" value={id} /><input type="hidden" name="aiAppsSurface" value={asBoolean(row.aiAppsSurface) ? "false" : "true"} /><button className="text-xs text-[var(--accent)]">{asBoolean(row.aiAppsSurface) ? "Disable AI surface" : "Enable AI surface"}</button></Form><Form method="post"><input type="hidden" name="intent" value="app-delete" /><input type="hidden" name="appId" value={id} /><button className="text-xs text-[var(--danger)]">Delete</button></Form></div>]; })} empty={<EmptyState title={appTotal > 0 ? "No ChannelApps on this page" : filtered ? "No matching ChannelApps" : "No hosted ChannelApps"} description={appTotal > 0 ? "This page is past the end of the ChannelApp list. Use Previous to return to available results." : filtered ? "No hosted OAuth apps match the current server-side search." : "Create an OAuth app to manage one Slack identity across installations."} />} />
    <PaginationRange data={appsRoot} label="ChannelApp pagination" />
    <div className="grid gap-4 xl:grid-cols-2"><Form method="post"><Panel><input type="hidden" name="intent" value="channel-app" /><SectionHeader title="Create hosted OAuth Slack app" /><input name="displayName" placeholder="Display name" className={fieldClass} /><input required name="clientId" placeholder="Client ID" className={fieldClass} /><input required type="password" name="clientSecret" placeholder="Client secret" className={fieldClass} /><input required type="password" name="signingSecret" placeholder="Signing secret" className={fieldClass} /><input name="scopes" defaultValue="assistant:write, chat:write, im:history, app_mentions:read" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Create OAuth app</Button></Panel></Form><Form method="post"><Panel><input type="hidden" name="intent" value="installation-import" /><SectionHeader title="Import operator-owned Slack installation" description="Choose an existing ChannelApp and identify its workspace." /><select required name="appId" className={fieldClass}><option value="">Select ChannelApp</option>{apps.map((value) => { const app = asRecord(value); return <option key={asString(app.id)} value={asString(app.id)}>{asString(app.displayName, asString(app.id))}</option>; })}</select><input name="teamId" placeholder="Team ID (or enterprise ID below)" className={fieldClass} /><input name="enterpriseId" placeholder="Enterprise ID" className={fieldClass} /><input name="teamName" placeholder="Workspace name" className={fieldClass} /><input required name="botToken" type="password" placeholder="Bot token" className={fieldClass} /><input name="grantedScopes" placeholder="Granted scopes, comma-separated" className={fieldClass} /><input name="agentId" placeholder="Optional Agent ID" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Import installation</Button></Panel></Form></div>
    <div className="grid gap-4 xl:grid-cols-2"><details className="rounded-lg border border-grid-bright bg-background-bright p-4"><summary className="cursor-pointer font-medium">Update a ChannelConnection</summary><Form method="post" className="mt-3"><input type="hidden" name="intent" value="connection-update" /><input required name="id" placeholder="Connection ID" className={fieldClass} /><input name="displayName" placeholder="New display name" className={fieldClass} /><input name="agentId" placeholder="New default Agent ID" className={fieldClass} /><textarea name="agentRouting" placeholder="Optional routing — JSON array" className={`${fieldClass} min-h-20 font-mono`} /><textarea name="config" placeholder="Optional config — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><textarea name="credentials" placeholder="Optional replacement credentials — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><Button type="submit" className="mt-3">Update connection</Button></Form></details><details className="rounded-lg border border-grid-bright bg-background-bright p-4"><summary className="cursor-pointer font-medium">Update a ChannelApp</summary><Form method="post" className="mt-3"><input type="hidden" name="intent" value="app-update" /><input required name="appId" placeholder="ChannelApp ID" className={fieldClass} /><input name="displayName" placeholder="New display name" className={fieldClass} /><input name="clientId" placeholder="New public client ID" className={fieldClass} /><input name="clientSecret" type="password" placeholder="Optional replacement client secret" className={fieldClass} /><input name="signingSecret" type="password" placeholder="Optional replacement signing secret" className={fieldClass} /><input name="scopes" placeholder="Scopes, comma-separated" className={fieldClass} /><select name="distribution" defaultValue="" className={fieldClass}><option value="">Keep distribution</option><option value="private">Private</option><option value="public">Public</option></select><select name="linking" defaultValue="" className={fieldClass}><option value="">Keep linking policy</option><option value="none">None</option><option value="optional">Optional</option><option value="required">Required</option></select><input name="defaultAgentId" placeholder="New default Agent ID" className={fieldClass} /><textarea name="agentRouting" placeholder="Optional routing — JSON array" className={`${fieldClass} min-h-20 font-mono`} /><Button type="submit" className="mt-3">Update app</Button></Form></details></div>
    <p className="text-xs text-text-dimmed">The dashboard does not mint identity-bearing session tokens. Runtime identity starts from Entity or public guest authentication.</p>
  </div>;
}

function MemoryAgentSelector({ userId, agentId, agentsRoot, selection }: { userId: string; agentId: string; agentsRoot: unknown; selection?: unknown }) {
  const [searchParams] = useSearchParams();
  const root = asRecord(agentsRoot);
  const pageAgents = firstArray(root, "agents", "items");
  const selectedAgent = Object.keys(asRecord(selection)).length
    ? asRecord(selection)
    : pageAgents.map(asRecord).find((agent) => asString(agent.id) === agentId);
  const selectedId = asString(selectedAgent?.id);
  const agents = selectedId && !pageAgents.some((value) => asString(asRecord(value).id) === selectedId)
    ? [selectedAgent, ...pageAgents]
    : pageAgents;
  const preservedParams = Array.from(searchParams.entries()).filter(([key]) => key !== "userId" && key !== "agentId");
  return <div className="min-w-72 space-y-2">
    <Toolbar><CollectionSearch label="Search Memory Agent scopes" placeholder="Search all Agents" searchParam="agentSearch" pageParam="agentPage" /></Toolbar>
    <Form method="get" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="userId" value={userId} />
      {preservedParams.map(([key, value], index) => <input key={`${key}-${index}`} type="hidden" name={key} value={value} />)}
      <label className="min-w-72 flex-1 text-xs">Memory Agent / AgentCluster
        <select required name="agentId" value={agentId} onChange={(event) => event.currentTarget.form?.requestSubmit()} className={fieldClass}>
          <option value="">Select an Agent scope</option>
          {agents.map((value) => { const agent = asRecord(value); const id = asString(agent.id); const clusterId = asString(agent.clusteringId); return <option key={id} value={id}>{asString(agent.name, id)}{clusterId ? ` · cluster ${clusterId}` : " · standalone"}</option>; })}
        </select>
      </label>
      <Button type="submit">Apply Agent scope</Button>
    </Form>
    {!pageAgents.length && <p className="text-xs text-text-dimmed">No Agents match this selector page and search.</p>}
    <PaginationRange data={root} label="Memory Agent selector pagination" pageParam="agentPage" pageSizeParam="agentPageSize" />
  </div>;
}

function metadataText(metadata: unknown) {
  return JSON.stringify(metadata && typeof metadata === "object" ? metadata : {}, null, 2);
}

function MemoryEditorFields({ memory }: { memory?: Record<string, unknown> }) {
  const metadata = asRecord(memory?.metadata);
  const initialKind = asString(memory?.kind, "fact");
  const [kind, setKind] = useState(initialKind);
  return <>
    <textarea
      required
      name="content"
      defaultValue={asString(memory?.content, "")}
      placeholder="Durable memory content"
      className={`${fieldClass} min-h-24`}
    />
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs">Kind
        <select name="kind" value={kind} onChange={(event) => setKind(event.currentTarget.value)} className={fieldClass}>
          <option value="fact">Fact</option>
          <option value="preference">Preference</option>
          <option value="event">Event</option>
          <option value="relationship">Relationship</option>
          <option value="profile">Profile</option>
        </select>
      </label>
      <label className="text-xs">Visibility
        <select name="visibility" defaultValue={asString(memory?.visibility, "private")} className={fieldClass}>
          <option value="agent_visible">Agent visible</option>
          <option value="hidden">Hidden from Agent recall</option>
          <option value="private">Private</option>
        </select>
      </label>
    </div>
    {kind === "fact" && <div className="grid gap-2 sm:grid-cols-2">
      <input name="subject" defaultValue={asString(metadata.subject, "")} placeholder="Subject (optional)" className={fieldClass} />
      <input name="topic" defaultValue={asString(metadata.topic, "")} placeholder="Topic (optional)" className={fieldClass} />
    </div>}
    {kind === "preference" && <div className="grid gap-2 sm:grid-cols-2">
      <input name="over" defaultValue={asArray(metadata.over).map((value) => asString(value)).filter(Boolean).join(", ")} placeholder="Compared values, comma-separated" className={fieldClass} />
      <input name="ordering" defaultValue={asString(metadata.ordering, "")} placeholder="Ordering (optional)" className={fieldClass} />
    </div>}
    {kind === "event" && <div className="grid gap-2 sm:grid-cols-3">
      <input name="at" defaultValue={asString(metadata.at, "")} placeholder="ISO timestamp (optional)" className={fieldClass} />
      <input name="location" defaultValue={asString(metadata.location, "")} placeholder="Location (optional)" className={fieldClass} />
      <input name="participants" defaultValue={asArray(metadata.participants).map((value) => asString(value)).filter(Boolean).join(", ")} placeholder="Participants, comma-separated" className={fieldClass} />
    </div>}
    {kind === "relationship" && <div className="grid gap-2 sm:grid-cols-3">
      <input required name="from" defaultValue={asString(metadata.from, "")} placeholder="From" className={fieldClass} />
      <input required name="to" defaultValue={asString(metadata.to, "")} placeholder="To" className={fieldClass} />
      <input required name="type" defaultValue={asString(metadata.type, "")} placeholder="Relationship type" className={fieldClass} />
    </div>}
    {kind === "profile" && <input required name="profileKey" defaultValue={asString(metadata.profileKey, "")} placeholder="Profile key" className={fieldClass} />}
    <details>
      <summary className="cursor-pointer text-xs text-text-dimmed">Additional metadata JSON</summary>
      <textarea name="metadata" defaultValue={metadataText(memory?.metadata)} className={`${fieldClass} mt-2 min-h-20 font-mono`} />
    </details>
  </>;
}

export function MemorySurface({ data, secondary, selection }: SurfaceProps) {
  const root = asRecord(data);
  const agentsRoot = asRecord(secondary);
  const agents = firstArray(agentsRoot, "agents", "items");
  const [searchParams] = useSearchParams();
  const userId = searchParams.get("userId")?.trim() ?? "";
  const agentId = searchParams.get("agentId")?.trim() ?? "";
  if (!userId || asBoolean(root.requiresEndUserContext)) {
    return <EmptyState title="Choose an end-user memory context" description="Select a canonical EndUser from Accounts. The operator identity is never substituted for an end-user memory scope." action={<Link to="../agent-accounts"><Button type="button">Open end users</Button></Link>} />;
  }
  if (!agentId || asBoolean(root.requiresAgentContext)) {
    const agentTotal = asNumber(asRecord(agentsRoot.pagination).total, agents.length);
    return agentTotal > 0 || searchParams.get("agentSearch")
      ? <EmptyState title="Choose an Agent memory scope" description="Memory must be pinned to one canonical Environment Agent. A clustered Agent automatically uses its persisted AgentCluster boundary." action={<MemoryAgentSelector userId={userId} agentId={agentId} agentsRoot={agentsRoot} selection={selection} />} />
      : <EmptyState title="No Agent bindings" description="Create and bind an Agent in this Environment before reading or writing Memory." />;
  }

  const memories = firstArray(root, "memories", "hits");
  const selectedAgent = Object.keys(asRecord(selection)).length
    ? asRecord(selection)
    : agents.map(asRecord).find((agent) => asString(agent.id) === agentId);
  const clusterId = asString(selectedAgent?.clusteringId);
  const queryContext = new URLSearchParams(searchParams);
  queryContext.set("userId", userId);
  queryContext.set("agentId", agentId);
  const contextInputs = <><input type="hidden" name="userId" value={userId} /><input type="hidden" name="agentId" value={agentId} /></>;
  const isSearch = Boolean(searchParams.get("q")?.trim());
  const limit = asNumber(root.limit, Number(searchParams.get("limit")) || 50);
  const offset = asNumber(root.offset, Number(searchParams.get("offset")) || 0);
  const pageHref = (nextOffset: number) => {
    const query = new URLSearchParams(searchParams);
    query.set("userId", userId);
    query.set("agentId", agentId);
    query.set("limit", String(limit));
    query.set("offset", String(Math.max(0, nextOffset)));
    return `?${query}`;
  };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <MemoryAgentSelector userId={userId} agentId={agentId} agentsRoot={agentsRoot} selection={selection} />
      <div className="flex flex-wrap gap-2">
        <Link to={`export?${queryContext}`} reloadDocument><Button type="button">Export complete bundle</Button></Link>
        <Link to={`graph?${queryContext}`}><Button type="button">Open knowledge graph</Button></Link>
      </div>
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      <StatTile title={isSearch ? "Search results" : "Persisted memories"} value={isSearch ? asNumber(root.resultCount, memories.length) : asNumber(root.total)} />
      <StatTile title="Visibility boundary" value="Selected EndUser" hint={userId} />
      <StatTile title="Agent boundary" value={clusterId ? "AgentCluster" : "Agent"} hint={clusterId || agentId} />
    </div>
    <Alert title="Visibility contract">Agent visible permits recall only inside persisted Agent or AgentCluster ownership. Hidden and Private are both excluded from Agent recall; cluster sharing is never a visibility value.</Alert>
    <Form method="get"><Panel>
      <SectionHeader title="Search and filter memory" description="Semantic search stays server-side. Search result counts are not presented as persisted totals." />
      {contextInputs}
      <input type="hidden" name="limit" value={limit} />
      <div className="grid gap-2 md:grid-cols-5">
        <input name="q" defaultValue={searchParams.get("q") ?? ""} placeholder="Semantic search" className={fieldClass} />
        <select name="kind" defaultValue={searchParams.get("kind") ?? ""} className={fieldClass}>
          <option value="">All kinds</option><option value="fact">Fact</option><option value="preference">Preference</option><option value="event">Event</option><option value="relationship">Relationship</option><option value="profile">Profile</option>
        </select>
        <select name="source" defaultValue={searchParams.get("source") ?? ""} className={fieldClass}>
          <option value="">All sources</option><option value="manual">Manual</option><option value="extracted">Extracted</option><option value="imported">Imported</option><option value="rag">RAG</option>
        </select>
        <select name="archiveState" defaultValue={searchParams.get("archiveState") ?? "active"} className={fieldClass}>
          <option value="active">Active</option><option value="archived">Archived</option><option value="all">Active and archived</option>
        </select>
        <Button type="submit" className="mt-1">Apply</Button>
      </div>
    </Panel></Form>
    <DataTable headers={["Memory", "Kind", "Visibility", "Source", "Updated", "Lifecycle"]} rows={memories.map((value) => {
      const row = asRecord(value);
      const nested = asRecord(row.memory);
      const memory = Object.keys(nested).length ? nested : row;
      const id = asString(memory.id);
      const archived = Boolean(memory.archivedAt);
      return [
        <details className="max-w-xl"><summary className="cursor-pointer whitespace-pre-wrap">{asString(memory.content, "Empty memory")}</summary><Form method="post" className="mt-3 space-y-2"><input type="hidden" name="intent" value="memory-update" /><input type="hidden" name="id" value={id} />{contextInputs}<MemoryEditorFields memory={memory} /><Button type="submit">Save complete memory</Button></Form></details>,
        asString(memory.kind, "fact"),
        asString(memory.visibility),
        asString(memory.source, "manual"),
        displayDate(memory.updatedAt ?? memory.createdAt),
        <div className="flex flex-wrap gap-2">
          <Form method="post"><input type="hidden" name="intent" value="memory-visibility" /><input type="hidden" name="id" value={id} />{contextInputs}<select aria-label={`Visibility for ${id}`} name="visibility" defaultValue={asString(memory.visibility)} className="rounded border border-grid-bright bg-background-bright px-2 py-1 text-xs"><option value="agent_visible">Agent visible</option><option value="hidden">Hidden</option><option value="private">Private</option></select><button type="submit" className="ml-1 text-xs text-[var(--accent)]">Set</button></Form>
          <Form method="post"><input type="hidden" name="intent" value={archived ? "memory-restore" : "memory-archive"} /><input type="hidden" name="id" value={id} />{contextInputs}<button type="submit" className={`text-xs ${archived ? "text-[var(--accent)]" : "text-[var(--danger)]"}`}>{archived ? "Restore" : "Archive"}</button></Form>
        </div>,
      ];
    })} empty={<EmptyState title={isSearch ? "No matching memories" : "No memories"} description={isSearch ? "No scoped semantic results matched the current query and filters." : "Create a scoped memory or extract durable facts from an existing Thread."} />} />
    {!isSearch && <div className="flex items-center justify-between">
      <span className="text-xs text-text-dimmed">Showing {memories.length ? offset + 1 : 0}–{offset + memories.length} of {asNumber(root.total)}</span>
      <div className="flex gap-2">{offset > 0 && <Link to={pageHref(offset - limit)}><Button type="button">Previous</Button></Link>}{asBoolean(root.hasNext) && <Link to={pageHref(offset + limit)}><Button type="button">Next</Button></Link>}</div>
    </div>}
    <div className="grid gap-4 xl:grid-cols-2">
      <Form method="post"><Panel>{contextInputs}<input type="hidden" name="intent" value="memory-create" /><SectionHeader title="Create memory" /><div className="space-y-2"><MemoryEditorFields /><Button type="submit" tone="primary">Persist memory</Button></div></Panel></Form>
      <Form method="post"><Panel>{contextInputs}<input type="hidden" name="intent" value="memory-extract" /><SectionHeader title="Extract from Thread" description="Runs manual extraction only when the Thread belongs to the selected EndUser and Agent scope." /><input required name="threadId" placeholder="Thread ID" className={fieldClass} /><Button type="submit" className="mt-3">Run extraction</Button></Panel></Form>
    </div>
    <Form method="post"><Panel>{contextInputs}<input type="hidden" name="intent" value="memory-import" /><SectionHeader title="Import memory bundle" description="Bundle identity and Agent fields are ignored; imported data is forced into the validated selected contexts." /><select name="mode" className={`${fieldClass} sm:max-w-60`}><option value="merge">Merge</option><option value="replace">Replace selected user data</option></select><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" name="confirmReplace" value="true" /> I understand replace permanently deletes the selected scoped memories, entities, and relationships before import.</label><textarea required name="bundle" placeholder='{"version":2,"memories":[],"entities":[],"relationships":[]}' className={`${fieldClass} min-h-28 font-mono`} /><Button type="submit" className="mt-3">Import bundle</Button></Panel></Form>
  </div>;
}

export function MemoryGraphSurface({ data, secondary, supporting, selection }: SurfaceProps) {
  const root = asRecord(data);
  const operation = asRecord(supporting);
  const agentsRoot = asRecord(secondary);
  const agents = firstArray(agentsRoot, "agents", "items");
  const [searchParams] = useSearchParams();
  const userId = searchParams.get("userId")?.trim() ?? "";
  const agentId = searchParams.get("agentId")?.trim() ?? "";
  if (!userId || asBoolean(root.requiresEndUserContext)) {
    return <EmptyState title="Choose an end-user memory context" description="Select a canonical EndUser from Accounts. The operator session is never substituted for graph traversal." action={<Link to="../agent-accounts"><Button type="button">Open end users</Button></Link>} />;
  }
  if (!agentId || asBoolean(root.requiresAgentContext)) {
    const agentTotal = asNumber(asRecord(agentsRoot.pagination).total, agents.length);
    return agentTotal > 0 || searchParams.get("agentSearch")
      ? <EmptyState title="Choose an Agent graph scope" description="Select the canonical Agent whose persisted binding defines the standalone or AgentCluster graph boundary." action={<MemoryAgentSelector userId={userId} agentId={agentId} agentsRoot={agentsRoot} selection={selection} />} />
      : <EmptyState title="No Agent bindings" description="Create and bind an Agent in this Environment before traversing Memory." />;
  }
  const entities = firstArray(root, "entities", "items");
  const neighborhood = [...firstArray(operation, "outbound"), ...firstArray(operation, "inbound")];
  const preservedGraphParams = Array.from(searchParams.entries()).filter(([key]) => !["userId", "agentId", "entityId", "from", "to", "maxHops", "entityQ", "entityOffset"].includes(key));
  const contextInputs = <><input type="hidden" name="userId" value={userId} /><input type="hidden" name="agentId" value={agentId} />{preservedGraphParams.map(([key, value], index) => <input key={`${key}-${index}`} type="hidden" name={key} value={value} />)}</>;
  const queryContext = new URLSearchParams(searchParams);
  queryContext.set("userId", userId);
  queryContext.set("agentId", agentId);
  const limit = asNumber(root.limit, Number(searchParams.get("entityLimit")) || 50);
  const offset = asNumber(root.offset, Number(searchParams.get("entityOffset")) || 0);
  const entityOptions = entities.map(asRecord);
  const hasPath = Object.prototype.hasOwnProperty.call(operation, "path");
  const pageHref = (nextOffset: number) => {
    const query = new URLSearchParams(searchParams);
    query.delete("entityId"); query.delete("from"); query.delete("to"); query.delete("maxHops");
    query.set("userId", userId); query.set("agentId", agentId); query.set("entityLimit", String(limit)); query.set("entityOffset", String(Math.max(0, nextOffset)));
    return `?${query}`;
  };
  const entityReference = (name: string, label: string, useKey = false) => <label className="text-xs">{label}<input required list={`entities-${useKey ? "keys" : "references"}`} name={name} defaultValue={searchParams.get(name) ?? ""} placeholder={useKey ? "Entity key" : "Entity ID or key"} className={fieldClass} /></label>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><MemoryAgentSelector userId={userId} agentId={agentId} agentsRoot={agentsRoot} selection={selection} /><Link to={`../memories?${queryContext}`}><Button type="button">Back to memories</Button></Link></div>
    <Alert title="Selected EndUser knowledge graph">Neighborhood, path traversal, and relationship creation stay bound to <code>{userId}</code> through validated Agent pin <code>{agentId}</code>.</Alert>
    <datalist id="entities-references">{entityOptions.flatMap((entity) => [<option key={`id-${asString(entity.id)}`} value={asString(entity.id)}>{asString(entity.label, asString(entity.entityKey))}</option>, <option key={`key-${asString(entity.id)}`} value={asString(entity.entityKey)}>{asString(entity.label, asString(entity.entityKey))}</option>])}</datalist>
    <datalist id="entities-keys">{entityOptions.map((entity) => <option key={`rel-${asString(entity.id)}`} value={asString(entity.entityKey)}>{asString(entity.label, asString(entity.id))}</option>)}</datalist>
    <Form method="get"><Panel>{contextInputs}<SectionHeader title="Find graph entities" description="Search server-side by entity key or paste an ID/key from any entity page into an operation." /><input name="entityQ" defaultValue={searchParams.get("entityQ") ?? ""} placeholder="Entity key or ID" className={fieldClass} /><input type="hidden" name="entityOffset" value="0" /><Button type="submit" className="mt-3">Search entities</Button></Panel></Form>
    {entities.length > 0 && <StatTile title="Graph entities" value={asNumber(root.total)} hint={`Showing ${offset + 1}–${offset + entities.length}`} />}
    <DataTable headers={["Entity", "ID", "Type", "Aliases", "Updated"]} rows={entities.map((value) => { const row = asRecord(value); return [<div><div className="font-medium">{asString(row.label, asString(row.entityKey))}</div><code className="text-xs text-text-dimmed">{asString(row.entityKey)}</code></div>, <code className="text-xs">{asString(row.id)}</code>, asString(row.entityType, "other"), asArray(row.aliases).map((alias) => asString(alias)).filter(Boolean).join(", ") || "—", displayDate(row.updatedAt ?? row.createdAt)]; })} empty={neighborhood.length || Array.isArray(operation.path) ? undefined : <EmptyState title="No graph entities" description="The selected scope has an empty graph. Relationships appear after extraction or an explicit relate action." />} />
    {entities.length > 0 && <div className="flex justify-end gap-2">{offset > 0 && <Link to={pageHref(offset - limit)}><Button type="button">Previous</Button></Link>}{asBoolean(root.hasNext) && <Link to={pageHref(offset + limit)}><Button type="button">Next</Button></Link>}</div>}
    <div className="grid gap-4 xl:grid-cols-3">
      <Form method="get"><Panel>{contextInputs}<SectionHeader title="Relationship neighborhood" />{entityReference("entityId", "Entity")}<Button type="submit" className="mt-3">Inspect neighborhood</Button></Panel></Form>
      <Form method="get"><Panel>{contextInputs}<SectionHeader title="Shortest path" />{entityReference("from", "From entity")}{entityReference("to", "To entity")}<input name="maxHops" type="number" min="1" max="6" defaultValue="4" className={fieldClass} /><Button type="submit" className="mt-3">Find path</Button></Panel></Form>
      <Form method="post"><Panel>{contextInputs}<input type="hidden" name="intent" value="memory-relate" /><SectionHeader title="Create relationship" />{entityReference("fromEntityKey", "From entity key", true)}{entityReference("toEntityKey", "To entity key", true)}<input required name="relationshipType" placeholder="Relationship type" className={fieldClass} /><input name="weight" type="number" min="0" max="1" step="0.01" placeholder="Optional weight" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Create relationship</Button></Panel></Form>
    </div>
    {neighborhood.length > 0 && <Panel><SectionHeader title="Relationship neighborhood" /><DataTable headers={["Direction", "Relationship", "Entity", "Weight"]} rows={neighborhood.map((value) => { const row = asRecord(value); const relationship = asRecord(row.relationship); const entity = Object.keys(asRecord(row.to)).length ? asRecord(row.to) : asRecord(row.from); return [Object.keys(asRecord(row.to)).length ? "Outbound" : "Inbound", asString(relationship.relationshipType, asString(row.relationshipType)), asString(entity.label, asString(entity.entityKey, asString(entity.id))), asString(relationship.weight, "—")]; })} /></Panel>}
    {hasPath && <Panel><SectionHeader title={operation.path === null ? "No path found in the selected scope" : "Resolved path"} /><ol className="space-y-2">{asArray(operation.path).map((value, index) => { const hop = asRecord(value); const entity = asRecord(hop.entity); return <li key={index} className="rounded border border-grid-bright px-3 py-2 text-sm">{asString(entity.label, asString(entity.entityKey, `Hop ${index + 1}`))}</li>; })}</ol></Panel>}
  </div>;
}

function FilesCollection({
  data,
  itemsKey,
  label,
  emptyTitle,
  emptyDescription,
  headers,
  rowKey,
  row,
  mimeFilter = false,
}: {
  data: unknown;
  itemsKey: string;
  label: string;
  emptyTitle: string;
  emptyDescription: string;
  headers: string[];
  rowKey: (value: unknown, index: number) => string;
  row: (value: unknown) => ReactNode[];
  mimeFilter?: boolean;
}) {
  const root = asRecord(data);
  const items = firstArray(root, itemsKey, "items");
  const pagination = asRecord(root.pagination);
  const total = asNumber(pagination.total, asNumber(root.total, items.length));
  const [searchParams] = useSearchParams();
  const hasFilters = Boolean(searchParams.get("search") || searchParams.get("mime"));
  const preserved = Array.from(searchParams.entries()).filter(([name]) => !["mime", "page"].includes(name));
  return <div className="space-y-4">
    <Toolbar>
      <CollectionSearch label={`Search ${label}`} placeholder={`Search ${label}`} />
      {mimeFilter && <Form method="get" className="flex flex-wrap items-center gap-2">
        {preserved.map(([name, value]) => <input key={`${name}-${value}`} type="hidden" name={name} value={value} />)}
        <label className="text-xs text-text-dimmed">MIME prefix <input name="mime" defaultValue={searchParams.get("mime") ?? ""} placeholder="image/" className="ml-2 min-h-9 rounded-md border border-grid-bright bg-background-bright px-2 text-sm text-text-bright" /></label>
        <Button type="submit">Apply</Button>
      </Form>}
    </Toolbar>
    {!items.length ? <EmptyState
      title={total > 0 ? `No ${label} on this page` : hasFilters ? `No matching ${label}` : emptyTitle}
      description={total > 0 ? "This page is past the end of the collection. Use Previous to return to available results." : hasFilters ? `No ${label} match the current server-side filters.` : emptyDescription}
    /> : <DataTable headers={headers} rowKeys={items.map(rowKey)} rows={items.map(row)} />}
    <PaginationRange data={root} label={`${label} pagination`} />
  </div>;
}

export function FilesSurface({ data }: SurfaceProps) {
  return <FilesCollection
    data={data}
    itemsKey="agents"
    label="Agents with files"
    emptyTitle="No files"
    emptyDescription="Attachments appear here only after an Agent Turn persists a file in this Environment."
    headers={["Agent", "Attachments", "Latest attachment", "Browse"]}
    rowKey={(value, index) => asString(asRecord(value).agentId, `file-agent-${index}`)}
    row={(value) => { const item = asRecord(value); const id = asString(item.agentId); return [asString(item.name, id), asNumber(item.attachmentCount), displayDate(item.lastAttachmentAt), <Link to={`${encodeURIComponent(id)}/users`} className="text-[var(--accent)]">View users</Link>]; }}
  />;
}

export function FilesUsersSurface({ data }: SurfaceProps) {
  return <FilesCollection
    data={data}
    itemsKey="users"
    label="users with attachments"
    emptyTitle="No users with attachments"
    emptyDescription="This Agent has no scoped user attachment activity."
    headers={["End user", "Conversations", "Attachments", "Latest attachment", "Browse"]}
    rowKey={(value, index) => asString(asRecord(value).userId, `file-user-${index}`)}
    row={(value) => { const item = asRecord(value); const id = asString(item.userId); return [<code className="text-xs">{id}</code>, asNumber(item.distinctThreads), asNumber(item.attachmentCount), displayDate(item.lastAttachmentAt), <Link to={`${encodeURIComponent(id)}/conversations`} className="text-[var(--accent)]">View conversations</Link>]; }}
  />;
}

export function FilesConversationsSurface({ data }: SurfaceProps) {
  return <FilesCollection
    data={data}
    itemsKey="conversations"
    label="conversations with attachments"
    emptyTitle="No conversations with attachments"
    emptyDescription="This user has no file-bearing conversations with the selected Agent."
    headers={["Conversation", "Attachments", "Latest activity", "Browse"]}
    rowKey={(value, index) => asString(asRecord(value).threadId, `file-thread-${index}`)}
    row={(value) => { const item = asRecord(value); const id = asString(item.threadId); return [<div><div>{asString(item.title, "Untitled conversation")}</div><code className="text-xs text-text-dimmed">{id}</code></div>, asNumber(item.attachmentCount), displayDate(item.lastActivityAt), <Link to={`${encodeURIComponent(id)}/attachments`} className="text-[var(--accent)]">View attachments</Link>]; }}
  />;
}

export function FilesAttachmentsSurface({ data }: SurfaceProps) {
  return <FilesCollection
    data={data}
    itemsKey="attachments"
    label="attachments"
    emptyTitle="No attachments"
    emptyDescription="No persisted attachments were found for this Thread."
    headers={["File", "Type", "Kind", "Size", "Uploaded", "Download"]}
    mimeFilter
    rowKey={(value, index) => asString(asRecord(value).id, `attachment-${index}`)}
    row={(value) => { const item = asRecord(value); const url = asString(item.downloadUrl); return [asString(item.filename, asString(item.id)), asString(item.mimeType, "unknown"), asString(item.kind, "attachment"), displayBytes(item.bytes), displayDate(item.uploadedAt), url ? <a href={url} className="text-[var(--accent)]" rel="noreferrer">Download</a> : <Status value="unavailable" />]; }}
  />;
}

export function VariablesSurface({ data }: SurfaceProps) {
  const variables = firstArray(asRecord(data), "variables");
  return <div className="space-y-4"><div className="flex justify-end"><Link to="new"><Button type="button" tone="primary">New plain variable</Button></Link></div><DataTable headers={["Key", "Kind", "Value state", "Version", "Updated"]} rows={variables.map((value) => { const row = asRecord(value); const credentialBacked = Boolean(row.credentialId); return [<code>{asString(row.key)}</code>, credentialBacked ? "Credential reference" : asString(row.kind, "plain"), credentialBacked ? <Status value="stored" /> : asBoolean(row.present) ? "Configured" : <Status value="missing" />, asNumber(row.version), displayDate(row.updatedAt)]; })} empty={<EmptyState title="No environment variables" description="Create a plain value here. Provider and integration secrets belong in Credential-backed screens." />} /><Alert tone="warning" title="Secret boundary">Credential-backed values are redacted before loader serialization and cannot be revealed from this list.</Alert></div>;
}

export function SettingsSurface({ data, secondary }: SurfaceProps) {
  const observability = asRecord(data);
  const secrets = asRecord(secondary);
  const scalarRows = (record: Record<string, unknown>) => Object.entries(record).filter(([, value]) => typeof value !== "object").map(([key, value]) => [key, <Status value={value} />]);
  return <div className="grid gap-4 lg:grid-cols-2"><Panel><SectionHeader title="Runtime observability" /><DataTable headers={["Capability", "State"]} rows={scalarRows(observability)} empty={<EmptyState title="No observability status" description="The Agent did not return scalar runtime readiness metadata." />} /></Panel><Panel><SectionHeader title="Credential store" description="Safe status only; envelopes and key material are never serialized." /><DataTable headers={["Capability", "State"]} rows={scalarRows(secrets)} empty={<EmptyState title="Credential status unavailable" description="No safe credential readiness metadata was returned." />} /></Panel></div>;
}

export function AccountsSurface({ data }: SurfaceProps) {
  const root = asRecord(data);
  const users = firstArray(root, "users", "items");
  const pagination = asRecord(root.pagination);
  const total = asNumber(pagination.total, asNumber(root.total, users.length));
  const [searchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "all";
  const hasFilters = Boolean(searchParams.get("search") || searchParams.get("status"));
  return <div className="space-y-4">
    <Toolbar>
      <CollectionSearch label="Search EndUser accounts" placeholder="Search EndUsers" />
      <div className="flex gap-2">{[["all", "All"], ["active", "Active"], ["disabled", "Disabled"]].map(([value, label]) => { const params = new URLSearchParams(searchParams); params.delete("page"); if (value === "all") params.delete("status"); else params.set("status", value); return <Link key={value} to={`?${params}`} className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium ${status === value ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-grid-bright text-text-dimmed"}`}>{label}</Link>; })}</div>
    </Toolbar>
    {!users.length ? <EmptyState
      title={total > 0 ? "No EndUsers on this page" : hasFilters ? "No matching EndUsers" : "No end-user accounts"}
      description={total > 0 ? "This page is past the end of the EndUser collection." : hasFilters ? "No Organization-scoped EndUser matches the current server-side filters." : "End users remain a distinct principal tier from operator memberships and public guests."}
    /> : <DataTable
      headers={["End user", "Identities", "Verification", "State", "Created", "Memory"]}
      rowKeys={users.map((value, index) => asString(asRecord(value).id, `end-user-${index}`))}
      rows={users.map((value) => { const row = asRecord(value); const identities = asArray(row.identities).map(asRecord); const id = asString(row.id); return [<div><div>{asString(row.displayName, "Unnamed end user")}</div><code className="text-xs text-text-dimmed">{id}</code></div>, identities.map((identity) => `${asString(identity.issuer, "issuer")}:${asString(identity.channel, "channel")}`).join(", ") || "None", identities.some((identity) => Boolean(identity.verifiedAt)) ? <Status value="verified" /> : <Status value="unverified" />, row.disabledAt ? <Status value="disabled" /> : <Status value="active" />, displayDate(row.createdAt), <Link to={`../memories?userId=${encodeURIComponent(id)}`} className="text-[var(--accent)]">Open memory</Link>]; })}
    />}
    <PaginationRange data={root} label="EndUser account pagination" />
  </div>;
}
