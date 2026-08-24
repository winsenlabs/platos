import { Form, Link, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import { asArray, asBoolean, asNumber, asRecord, asString, firstArray } from "../safe";
import { Alert, Button, DataTable, EmptyState, Panel, SectionHeader, StatTile } from "../ProductPrimitives";
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

export function ClustersSurface({ data, secondary }: SurfaceProps) {
  const root = asRecord(data);
  const rows = firstArray(root, "clusters", "items");
  const cluster = asRecord(root.cluster);
  const members = firstArray(cluster, "agents", "members");
  const agents = firstArray(asRecord(secondary), "agents", "items");
  if (rows.length) return <div className="space-y-5"><Alert tone="warning" title="Shared recall boundary">Adding an Agent widens memory recall across every cluster member.</Alert><DataTable headers={["Cluster", "Members", "Primary Agent", "Memory consequence"]} rows={rows.map((value) => { const row = asRecord(value); return [<Link to={asString(row.id)} className="text-[var(--accent)]">{asString(row.name, row.slug as string)}</Link>, asNumber(row.agentCount, firstArray(row, "agents", "members").length), asString(row.primaryAgentId, "—"), "Shared recall scope"]; })} /><Form method="post"><Panel><SectionHeader title="Create cluster" /><div className="grid gap-3 md:grid-cols-2"><input required name="name" placeholder="Name" className={fieldClass} /><input required name="slug" placeholder="Slug" className={fieldClass} /><input name="primaryAgentId" placeholder="Primary Agent ID" className={fieldClass} /><input name="agentIds" placeholder="Agent IDs, comma-separated" className={fieldClass} /></div><textarea name="description" placeholder="Description" className={`${fieldClass} min-h-20`} /><Button type="submit" tone="primary" className="mt-3">Create widened memory scope</Button></Panel></Form></div>;
  if (Object.keys(cluster).length) return <div className="space-y-5"><Alert tone="warning">Every member can recall memory from this cluster scope.</Alert><DataTable headers={["Agent", "Role", "Remove"]} rows={members.map((value) => { const member = asRecord(value); const agent = asRecord(member.agent); const id = asString(member.agentId, asString(agent.id)); return [asString(agent.name, id), asString(member.role, "member"), <Form method="post"><input type="hidden" name="intent" value="remove-agent" /><input type="hidden" name="agentId" value={id} /><button className="text-xs text-[var(--danger)]">Remove</button></Form>]; })} /><Form method="post"><Panel><input type="hidden" name="intent" value="add-agent" /><SectionHeader title="Add Agent and widen recall" /><select required name="agentId" className={fieldClass}><option value="">Select Agent</option>{agents.map((value) => { const agent = asRecord(value); return <option key={asString(agent.id)} value={asString(agent.id)}>{asString(agent.name, asString(agent.id))}</option>; })}</select><input name="role" defaultValue="member" className={fieldClass} /><Button type="submit" className="mt-3">Add Agent</Button></Panel></Form></div>;
  return <EmptyState title="No clusters" description="No canonical cluster rows exist in this Environment." />;
}

export function JobsSurface({ data, title }: SurfaceProps) {
  const root = asRecord(data);
  const tasks = firstArray(root, "tasks", "jobs", "items");
  const task = asRecord(root.task);
  const create = title.toLowerCase().includes("create");
  const current = Object.keys(task).length ? task : {};
  const form = <Form method="post"><Panel><SectionHeader title={create ? "Create Platos-native background Job" : "Edit Job"} description="External Trigger tasks are infrastructure, not dashboard-owned domain Jobs." /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{create && <input required name="taskId" pattern="[a-z0-9-]{1,64}" placeholder="Job ID" className={fieldClass} />}<input required={create} name="displayName" defaultValue={asString(current.displayName, "")} placeholder="Display name" className={fieldClass} /><select name="triggerType" defaultValue={asString(current.triggerType, "manual")} className={fieldClass}><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="webhook">Webhook</option></select><input name="scheduleCron" defaultValue={asString(current.scheduleCron, "")} placeholder="Schedule cron" className={fieldClass} /></div><Button type="submit" tone="primary" className="mt-3">{create ? "Create Job" : "Save Job"}</Button></Panel></Form>;
  if (create || Object.keys(task).length) return <div className="space-y-4">{Object.keys(task).length && <><div className="grid gap-3 md:grid-cols-3"><StatTile title="State" value={<Status value={asBoolean(task.isActive) ? "active" : "inactive"} />} /><StatTile title="Last run" value={displayDate(task.lastRunAt)} /><StatTile title="Schedule" value={asString(task.scheduleCron, "Manual")} /></div><Form method="post"><input type="hidden" name="intent" value="run" /><Button type="submit" tone="primary">Run now</Button></Form></>}{form}</div>;
  return <div className="space-y-4"><div className="flex justify-end"><Link to="new"><Button type="button" tone="primary">Create Job</Button></Link></div><DataTable headers={["Job", "Trigger", "State", "Last run"]} rows={tasks.map((value) => { const row = asRecord(value); return [<Link to={asString(row.id)} className="text-[var(--accent)]">{asString(row.displayName, asString(row.taskId))}</Link>, asString(row.triggerType, "manual"), <Status value={asBoolean(row.isActive) ? "active" : "inactive"} />, displayDate(row.lastRunAt)]; })} empty={<EmptyState title="No background Jobs" description="Create a Platos-native Job to schedule or manually queue background work." />} /></div>;
}

function ChannelConnectionRows({ channels }: { channels: unknown[] }) {
  return <DataTable headers={["Connection", "Provider", "Agent", "Credentials", "State", "Lifecycle"]} rows={channels.map((value) => { const row = asRecord(value); const id = asString(row.id); return [asString(row.displayName, id), asString(row.provider, "slack"), asString(row.defaultAgentId, "Unbound"), asBoolean(row.hasCredentials) ? "Stored" : "Missing", <Status value={asBoolean(row.enabled) ? "active" : "disabled"} />, <div className="flex flex-wrap gap-2"><Form method="post"><input type="hidden" name="intent" value="connection-toggle" /><input type="hidden" name="id" value={id} /><input type="hidden" name="agentId" value={asString(row.defaultAgentId)} /><input type="hidden" name="enabled" value={asBoolean(row.enabled) ? "false" : "true"} /><button className="text-xs text-[var(--accent)]">{asBoolean(row.enabled) ? "Disable" : "Enable"}</button></Form><Form method="post"><input type="hidden" name="intent" value="connection-rotate" /><input type="hidden" name="id" value={id} /><button className="text-xs text-[var(--warn)]">Rotate webhook</button></Form><Form method="post"><input type="hidden" name="intent" value="connection-delete" /><input type="hidden" name="id" value={id} /><button className="text-xs text-[var(--danger)]">Delete</button></Form></div>]; })} empty={<EmptyState title="No operator-owned connections" description="Create a provider connection or mint a Slack manifest below." />} />;
}

export function ChannelsSurface({ data, secondary, supporting }: SurfaceProps) {
  const appsRoot = asRecord(secondary);
  const apps = firstArray(appsRoot, "apps", "items");
  const channels = firstArray(asRecord(supporting), "channels", "items");
  const connect = asRecord(data);
  const websocket = asRecord(connect.websocket);
  const rest = asRecord(connect.rest);
  const installationStatuses = asRecord(appsRoot.installationStatuses);
  return <div className="space-y-5">
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><StatTile title="Hosted OAuth apps" value={apps.length} /><StatTile title="Operator connections" value={channels.length} /><StatTile title="REST transport" value={asString(rest.baseUrl) ? "Ready" : "Unavailable"} /><StatTile title="WebSocket transport" value={asString(websocket.url) ? "Ready" : "Unavailable"} /></div>
    <Panel><SectionHeader title="Runtime connection contract" description="Typed transport metadata from the canonical Connect endpoint." /><DataTable headers={["Transport", "Endpoint", "Authentication"]} rows={[["REST", asString(rest.baseUrl, "Not configured"), "Scoped headers or signed session token"], ["WebSocket", asString(websocket.url, "Not configured"), "Authenticated handshake"]]} /></Panel>
    <SectionHeader title="Operator-owned ChannelConnections" description="Credentials remain in referenced envelopes. Rotated webhook URLs are revealed once." />
    <ChannelConnectionRows channels={channels} />
    <div className="grid gap-4 xl:grid-cols-2"><Form method="post"><Panel><input type="hidden" name="intent" value="connection-create" /><SectionHeader title="Create provider connection" /><select name="provider" className={fieldClass}><option value="slack">Slack</option><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option><option value="discord">Discord</option></select><input required name="agentId" placeholder="Agent ID" className={fieldClass} /><input name="displayName" placeholder="Display name" className={fieldClass} /><textarea name="credentials" placeholder="Provider credentials — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><textarea name="config" placeholder="Provider config — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><Button type="submit" tone="primary" className="mt-3">Create connection</Button></Panel></Form><Form method="post"><Panel tone="accent"><input type="hidden" name="intent" value="connection-mint" /><SectionHeader title="Mint Slack app from manifest" description="Slack configuration tokens are sent once and are never persisted or logged." /><input required name="agentId" placeholder="Agent ID" className={fieldClass} /><input name="displayName" placeholder="Slack app name" className={fieldClass} /><input required type="password" name="configToken" placeholder="Slack App Configuration Token" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Mint Slack app</Button></Panel></Form></div>
    <SectionHeader title="Hosted OAuth ChannelApps" description="Secrets are represented only by safe presence metadata." />
    <DataTable headers={["App", "Distribution", "Default Agent", "Secrets", "Installations", "Lifecycle"]} rows={apps.map((value) => { const row = asRecord(value); const id = asString(row.id); const statuses = firstArray(asRecord(installationStatuses[id]), "installations"); return [asString(row.displayName, id), asString(row.distribution, "private"), asString(row.defaultAgentId, "Unbound"), asBoolean(row.hasClientSecret) && asBoolean(row.hasSigningSecret) ? "Ready" : "Incomplete", statuses.length ? statuses.map((item) => { const status = asRecord(item); return <div key={asString(status.installationId)} className="mb-2 last:mb-0"><Status value={status.status} /> <span className="text-xs">{asString(status.teamName, asString(status.teamId, "Workspace"))}</span><div className="mt-1 flex gap-2"><Form method="post"><input type="hidden" name="intent" value="installation-bind" /><input type="hidden" name="appId" value={id} /><input type="hidden" name="installationId" value={asString(status.installationId)} /><input name="agentId" aria-label="Agent ID" placeholder="Agent ID" className="w-28 rounded border border-grid-bright bg-background-bright px-2 py-1 text-xs" /><button className="text-xs text-[var(--accent)]">Bind</button></Form><Form method="post"><input type="hidden" name="intent" value="installation-revoke" /><input type="hidden" name="appId" value={id} /><input type="hidden" name="installationId" value={asString(status.installationId)} /><button className="text-xs text-[var(--danger)]">Revoke</button></Form></div></div>; }) : "None", <div className="flex gap-2"><Form method="post"><input type="hidden" name="intent" value="app-toggle-ai" /><input type="hidden" name="appId" value={id} /><input type="hidden" name="aiAppsSurface" value={asBoolean(row.aiAppsSurface) ? "false" : "true"} /><button className="text-xs text-[var(--accent)]">{asBoolean(row.aiAppsSurface) ? "Disable AI surface" : "Enable AI surface"}</button></Form><Form method="post"><input type="hidden" name="intent" value="app-delete" /><input type="hidden" name="appId" value={id} /><button className="text-xs text-[var(--danger)]">Delete</button></Form></div>]; })} empty={<EmptyState title="No hosted ChannelApps" description="Create an OAuth app to manage one Slack identity across installations." />} />
    <div className="grid gap-4 xl:grid-cols-2"><Form method="post"><Panel><input type="hidden" name="intent" value="channel-app" /><SectionHeader title="Create hosted OAuth Slack app" /><input name="displayName" placeholder="Display name" className={fieldClass} /><input required name="clientId" placeholder="Client ID" className={fieldClass} /><input required type="password" name="clientSecret" placeholder="Client secret" className={fieldClass} /><input required type="password" name="signingSecret" placeholder="Signing secret" className={fieldClass} /><input name="scopes" defaultValue="assistant:write, chat:write, im:history, app_mentions:read" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Create OAuth app</Button></Panel></Form><Form method="post"><Panel><input type="hidden" name="intent" value="installation-import" /><SectionHeader title="Import operator-owned Slack installation" description="Choose an existing ChannelApp and identify its workspace." /><select required name="appId" className={fieldClass}><option value="">Select ChannelApp</option>{apps.map((value) => { const app = asRecord(value); return <option key={asString(app.id)} value={asString(app.id)}>{asString(app.displayName, asString(app.id))}</option>; })}</select><input name="teamId" placeholder="Team ID (or enterprise ID below)" className={fieldClass} /><input name="enterpriseId" placeholder="Enterprise ID" className={fieldClass} /><input name="teamName" placeholder="Workspace name" className={fieldClass} /><input required name="botToken" type="password" placeholder="Bot token" className={fieldClass} /><input name="grantedScopes" placeholder="Granted scopes, comma-separated" className={fieldClass} /><input name="agentId" placeholder="Optional Agent ID" className={fieldClass} /><Button type="submit" tone="primary" className="mt-3">Import installation</Button></Panel></Form></div>
    <div className="grid gap-4 xl:grid-cols-2"><details className="rounded-lg border border-grid-bright bg-background-bright p-4"><summary className="cursor-pointer font-medium">Update a ChannelConnection</summary><Form method="post" className="mt-3"><input type="hidden" name="intent" value="connection-update" /><input required name="id" placeholder="Connection ID" className={fieldClass} /><input name="displayName" placeholder="New display name" className={fieldClass} /><input name="agentId" placeholder="New default Agent ID" className={fieldClass} /><textarea name="agentRouting" placeholder="Optional routing — JSON array" className={`${fieldClass} min-h-20 font-mono`} /><textarea name="config" placeholder="Optional config — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><textarea name="credentials" placeholder="Optional replacement credentials — JSON object" className={`${fieldClass} min-h-20 font-mono`} /><Button type="submit" className="mt-3">Update connection</Button></Form></details><details className="rounded-lg border border-grid-bright bg-background-bright p-4"><summary className="cursor-pointer font-medium">Update a ChannelApp</summary><Form method="post" className="mt-3"><input type="hidden" name="intent" value="app-update" /><input required name="appId" placeholder="ChannelApp ID" className={fieldClass} /><input name="displayName" placeholder="New display name" className={fieldClass} /><input name="clientId" placeholder="New public client ID" className={fieldClass} /><input name="clientSecret" type="password" placeholder="Optional replacement client secret" className={fieldClass} /><input name="signingSecret" type="password" placeholder="Optional replacement signing secret" className={fieldClass} /><input name="scopes" placeholder="Scopes, comma-separated" className={fieldClass} /><select name="distribution" defaultValue="" className={fieldClass}><option value="">Keep distribution</option><option value="private">Private</option><option value="public">Public</option></select><select name="linking" defaultValue="" className={fieldClass}><option value="">Keep linking policy</option><option value="none">None</option><option value="optional">Optional</option><option value="required">Required</option></select><input name="defaultAgentId" placeholder="New default Agent ID" className={fieldClass} /><textarea name="agentRouting" placeholder="Optional routing — JSON array" className={`${fieldClass} min-h-20 font-mono`} /><Button type="submit" className="mt-3">Update app</Button></Form></details></div>
    <p className="text-xs text-text-dimmed">The dashboard does not mint identity-bearing session tokens. Runtime identity starts from Entity or public guest authentication.</p>
  </div>;
}

function MemoryAgentSelector({ userId, agentId, agents }: { userId: string; agentId: string; agents: unknown[] }) {
  const [searchParams] = useSearchParams();
  const preservedParams = Array.from(searchParams.entries()).filter(([key]) => key !== "userId" && key !== "agentId");
  return <Form method="get" className="flex flex-wrap items-end gap-2">
    <input type="hidden" name="userId" value={userId} />
    {preservedParams.map(([key, value], index) => <input key={`${key}-${index}`} type="hidden" name={key} value={value} />)}
    <label className="min-w-72 text-xs">Memory Agent / AgentCluster
      <select required name="agentId" value={agentId} onChange={(event) => event.currentTarget.form?.requestSubmit()} className={fieldClass}>
        <option value="">Select an Agent scope</option>
        {agents.map((value) => { const agent = asRecord(value); const id = asString(agent.id); const clusterId = asString(agent.clusteringId); return <option key={id} value={id}>{asString(agent.name, id)}{clusterId ? ` · cluster ${clusterId}` : " · standalone"}</option>; })}
      </select>
    </label>
    <Button type="submit">Apply Agent scope</Button>
  </Form>;
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

export function MemorySurface({ data, secondary }: SurfaceProps) {
  const root = asRecord(data);
  const agents = firstArray(asRecord(secondary), "agents", "items");
  const [searchParams] = useSearchParams();
  const userId = searchParams.get("userId")?.trim() ?? "";
  const agentId = searchParams.get("agentId")?.trim() ?? "";
  if (!userId || asBoolean(root.requiresEndUserContext)) {
    return <EmptyState title="Choose an end-user memory context" description="Select a canonical EndUser from Accounts. The operator identity is never substituted for an end-user memory scope." action={<Link to="../agent-accounts"><Button type="button">Open end users</Button></Link>} />;
  }
  if (!agentId || asBoolean(root.requiresAgentContext)) {
    return agents.length
      ? <EmptyState title="Choose an Agent memory scope" description="Memory must be pinned to one canonical Environment Agent. A clustered Agent automatically uses its persisted AgentCluster boundary." action={<MemoryAgentSelector userId={userId} agentId={agentId} agents={agents} />} />
      : <EmptyState title="No Agent bindings" description="Create and bind an Agent in this Environment before reading or writing Memory." />;
  }

  const memories = firstArray(root, "memories", "hits");
  const selectedAgent = agents.map(asRecord).find((agent) => asString(agent.id) === agentId);
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
      <MemoryAgentSelector userId={userId} agentId={agentId} agents={agents} />
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

export function MemoryGraphSurface({ data, secondary, supporting }: SurfaceProps) {
  const root = asRecord(data);
  const operation = asRecord(supporting);
  const agents = firstArray(asRecord(secondary), "agents", "items");
  const [searchParams] = useSearchParams();
  const userId = searchParams.get("userId")?.trim() ?? "";
  const agentId = searchParams.get("agentId")?.trim() ?? "";
  if (!userId || asBoolean(root.requiresEndUserContext)) {
    return <EmptyState title="Choose an end-user memory context" description="Select a canonical EndUser from Accounts. The operator session is never substituted for graph traversal." action={<Link to="../agent-accounts"><Button type="button">Open end users</Button></Link>} />;
  }
  if (!agentId || asBoolean(root.requiresAgentContext)) {
    return agents.length
      ? <EmptyState title="Choose an Agent graph scope" description="Select the canonical Agent whose persisted binding defines the standalone or AgentCluster graph boundary." action={<MemoryAgentSelector userId={userId} agentId={agentId} agents={agents} />} />
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
    <div className="flex flex-wrap items-end justify-between gap-3"><MemoryAgentSelector userId={userId} agentId={agentId} agents={agents} /><Link to={`../memories?${queryContext}`}><Button type="button">Back to memories</Button></Link></div>
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

export function FilesSurface({ data }: SurfaceProps) {
  const agents = firstArray(asRecord(data), "agents");
  return <DataTable headers={["Agent", "Attachments", "Latest attachment", "Browse"]} rows={agents.map((value) => { const row = asRecord(value); const id = asString(row.agentId); return [asString(row.name, id), asNumber(row.attachmentCount), displayDate(row.lastAttachmentAt), <Link to={`${encodeURIComponent(id)}/users`} className="text-[var(--accent)]">View users</Link>]; })} empty={<EmptyState title="No files" description="Attachments appear here only after an Agent Turn persists a file in this Environment." />} />;
}

export function FilesUsersSurface({ data }: SurfaceProps) {
  const users = firstArray(asRecord(data), "users");
  return <DataTable headers={["End user", "Conversations", "Attachments", "Latest attachment", "Browse"]} rows={users.map((value) => { const row = asRecord(value); const id = asString(row.userId); return [<code className="text-xs">{id}</code>, asNumber(row.distinctThreads), asNumber(row.attachmentCount), displayDate(row.lastAttachmentAt), <Link to={`${encodeURIComponent(id)}/conversations`} className="text-[var(--accent)]">View conversations</Link>]; })} empty={<EmptyState title="No users with attachments" description="This Agent has no scoped user attachment activity." />} />;
}

export function FilesConversationsSurface({ data }: SurfaceProps) {
  const conversations = firstArray(asRecord(data), "conversations");
  return <DataTable headers={["Conversation", "Attachments", "Latest activity", "Browse"]} rows={conversations.map((value) => { const row = asRecord(value); const id = asString(row.threadId); return [<div><div>{asString(row.title, "Untitled conversation")}</div><code className="text-xs text-text-dimmed">{id}</code></div>, asNumber(row.attachmentCount), displayDate(row.lastActivityAt), <Link to={`${encodeURIComponent(id)}/attachments`} className="text-[var(--accent)]">View attachments</Link>]; })} empty={<EmptyState title="No conversations with attachments" description="This user has no file-bearing conversations with the selected Agent." />} />;
}

export function FilesAttachmentsSurface({ data }: SurfaceProps) {
  const attachments = firstArray(asRecord(data), "attachments");
  return <DataTable headers={["File", "Type", "Kind", "Size", "Uploaded", "Download"]} rows={attachments.map((value) => { const row = asRecord(value); const url = asString(row.downloadUrl); return [asString(row.filename, asString(row.id)), asString(row.mimeType, "unknown"), asString(row.kind, "attachment"), displayBytes(row.bytes), displayDate(row.uploadedAt), url ? <a href={url} className="text-[var(--accent)]" rel="noreferrer">Download</a> : <Status value="unavailable" />]; })} empty={<EmptyState title="No attachments" description="No persisted attachments were found for this Thread, or object storage is unavailable." />} />;
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
  const users = firstArray(asRecord(data), "users");
  return <DataTable headers={["End user", "Identities", "Verification", "State", "Created", "Memory"]} rows={users.map((value) => { const row = asRecord(value); const identities = asArray(row.identities).map(asRecord); const id = asString(row.id); return [<div><div>{asString(row.displayName, "Unnamed end user")}</div><code className="text-xs text-text-dimmed">{id}</code></div>, identities.map((identity) => `${asString(identity.issuer, "issuer")}:${asString(identity.channel, "channel")}`).join(", ") || "None", identities.some((identity) => Boolean(identity.verifiedAt)) ? <Status value="verified" /> : <Status value="unverified" />, row.disabledAt ? <Status value="disabled" /> : <Status value="active" />, displayDate(row.createdAt), <Link to={`../memories?userId=${encodeURIComponent(id)}`} className="text-[var(--accent)]">Open memory</Link>]; })} empty={<EmptyState title="No end-user accounts" description="End users remain a distinct principal tier from operator memberships and public guests." />} />;
}
