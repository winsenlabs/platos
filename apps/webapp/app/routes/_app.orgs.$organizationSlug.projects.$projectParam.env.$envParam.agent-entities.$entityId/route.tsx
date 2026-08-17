import {
  ArrowPathIcon,
  BuildingOffice2Icon,
  CheckCircleIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  InformationCircleIcon,
  KeyIcon,
  PencilIcon,
  PlusIcon,
  ServerStackIcon,
  ShareIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useActionData, useFetcher, useNavigation, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, agentMcpEntityPath } from "~/utils/pathBuilder";

// PIFSP-3 Deliverable 9 — header-name regex enforced on both client +
// server (mirrors the RFC 7230 token grammar in
// `AgentController.patchEntity`). Kept here so the UI can show a live
// validation error instead of waiting for the 400 round-trip.
const TEST_CRED_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const TEST_CRED_MAX_HEADERS = 32;
const TEST_CRED_MAX_VALUE_LEN = 4096;

export const meta: MetaFunction = () => [{ title: "Entity Details | Platos" }];

function scopeHeaders(scope: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
}) {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const entityId = params.entityId!;
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const agentWsUrl = process.env.PLATOS_AGENT_PUBLIC_WS_URL || AGENT_API_URL;

  let entity: any = null;
  let toolCount = 0;
  // PIFSP-3 Deliverable 9 — decrypted test-credentials stash (or null).
  type TestCredsShape = {
    headers: Array<{ name: string; value: string }>;
    userId?: string;
    updatedAt?: string;
    updatedByUserId?: string;
  };
  let testCredentials: TestCredsShape | null = null;
  // EOBD.79 — tool rows now include health data (lastCalledAt, avgLatencyMs,
  // totalCalls, lastStatus) so the UI can render a proper "tool health" panel.
  type ToolRow = {
    toolName: string;
    toolId: string;
    enabled: boolean;
    category: string | null;
    lastStatus: string | null;
    lastCalledAt: string | null;
    totalCalls: number;
    totalFailures: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
  };
  let tools: ToolRow[] = [];
  // Theme EA — list of agents in scope so the LinkedAgentsPanel multi-select
  // has something to pick from. Slim shape (id + name) is all the pill UI
  // needs; agent-side `/agents` supports the scope-headers auth already.
  let scopeAgents: Array<{ id: string; name: string; slug?: string }> = [];
  try {
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/entities/${entityId}`, {
      headers: scopeHeaders(scope),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      entity = await res.json();
    }

    const agentsRes = await fetch(`${AGENT_API_URL}/api/v1/agent/agents`, {
      headers: scopeHeaders(scope),
      signal: AbortSignal.timeout(5000),
    });
    if (agentsRes.ok) {
      const payload = (await agentsRes.json()) as {
        agents?: Array<{ id: string; name: string; slug?: string }>;
      };
      scopeAgents = (payload.agents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
      }));
    }

    // EOBD.79 — pull the rich tool matrix (registry + PlatosToolHealth joined)
    // and filter to this entity's rows. `/tools/matrix` is scope-scoped by the
    // agent service; the entityId filter here is the human-readable slug,
    // which matches `entityId` in the matrix payload.
    const matrixRes = await fetch(
      `${AGENT_API_URL}/api/v1/agent/tools/matrix`,
      {
        headers: scopeHeaders(scope),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (matrixRes.ok) {
      const data = (await matrixRes.json()) as {
        rows?: Array<Record<string, any>>;
      };
      tools = (data.rows || [])
        .filter((r: any) => r.entityId === entityId)
        .map((r: any) => ({
          toolName: r.toolName || r.name,
          toolId: r.toolId,
          enabled: r.enabled !== false,
          category: r.category || null,
          lastStatus: r.health?.lastStatus ?? null,
          lastCalledAt: r.health?.lastCalledAt ?? null,
          totalCalls: r.health?.totalCalls ?? 0,
          totalFailures: r.health?.totalFailures ?? 0,
          avgLatencyMs: r.health?.avgLatencyMs ?? null,
          p95LatencyMs: r.health?.p95LatencyMs ?? null,
        }));
      toolCount = tools.length;
    }

    // PIFSP-3 Deliverable 9 — fetch decrypted test credentials (204 when
    // absent). Failure to load is non-fatal: the panel just shows the
    // empty state, which is exactly what a fresh entity looks like.
    try {
      const credRes = await fetch(
        `${AGENT_API_URL}/api/v1/agent/entities/${encodeURIComponent(
          entityId,
        )}/test-credentials`,
        {
          headers: scopeHeaders(scope),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (credRes.ok) {
        const payload = (await credRes.json()) as TestCredsShape;
        if (payload && Array.isArray(payload.headers)) {
          testCredentials = payload;
        }
      }
    } catch {
      // leave testCredentials = null
    }
  } catch {}

  return typedjson({
    entity,
    tools,
    toolCount,
    agentApiUrl: AGENT_API_URL,
    agentWsUrl,
    scopeAgents,
    testCredentials,
    slugs: { organizationSlug, projectParam, envParam },
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const entityId = params.entityId!;
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = scopeHeaders(scope);

  if (intent === "regenerate") {
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/entities/${entityId}/regenerate-secret`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return typedjson({ error: `Regenerate failed: HTTP ${res.status}` }, { status: res.status });
    const data = (await res.json()) as { serviceSecret?: string };
    return typedjson({ regenerated: true, serviceSecret: data.serviceSecret });
  }

  if (intent === "delete") {
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/entities/${entityId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return typedjson({ error: `Delete failed: HTTP ${res.status}` }, { status: res.status });
    return redirect("..");
  }

  // UNIT D (MCP consumption) — manual outbound-discovery refresh for a
  // connectionKind="mcp" entity. Re-runs tools/list against the external MCP
  // server across every project env and re-stamps connectionStatus +
  // lastDiscoveryAt/discoveryError. Operator-only server-side. Discovery
  // reaches an external endpoint, so give it a longer timeout than the other
  // intents. Returns the `DiscoveryResult` shape { envs, registered, pruned,
  // error }.
  if (intent === "refresh-discovery") {
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/entities/${encodeURIComponent(entityId)}/refresh-discovery`,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return typedjson(
        { error: `Discovery refresh failed: ${text || res.status}` },
        { status: res.status },
      );
    }
    const data = (await res.json()) as {
      envs?: number;
      registered?: number;
      pruned?: number;
      error?: string;
    };
    return typedjson({ discovered: true, discovery: data });
  }

  // EOBD.79 — flip a single tool mapping's enabled flag for this (entity,
  // env). Agent service already exposes `PATCH /tools/:entityId/:toolName/enabled`
  // and writes scope-safe via tool-registry.
  if (intent === "toggle-tool") {
    const toolName = String(formData.get("toolName") ?? "");
    const enabled = String(formData.get("enabled") ?? "") === "true";
    if (!toolName) {
      return typedjson({ error: "toolName is required" }, { status: 400 });
    }
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/tools/${encodeURIComponent(entityId)}/${encodeURIComponent(
        toolName,
      )}/enabled`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return typedjson(
        { error: `Toggle failed: ${text || res.status}` },
        { status: res.status },
      );
    }
    return typedjson({ toggled: true, toolName, enabled });
  }

  // Theme EA — save the per-entity agent allow-list. Body is a JSON array
  // of agent IDs (possibly empty, which reverts to "unrestricted"). The
  // agent service validates every id lives in the same scope and
  // refreshes the tool-matrix cache in-process after the DB write.
  if (intent === "save-linked-agents") {
    const raw = String(formData.get("linkedAgentIds") ?? "[]");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return typedjson({ error: "linkedAgentIds must be valid JSON" }, { status: 400 });
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      return typedjson({ error: "linkedAgentIds must be a string array" }, { status: 400 });
    }
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/entities/${encodeURIComponent(entityId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ linkedAgentIds: parsed }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return typedjson(
        { error: `Save failed: ${text || res.status}` },
        { status: res.status },
      );
    }
    return typedjson({ linkedAgentsSaved: true, count: parsed.length });
  }

  // PIFSP-3 Deliverable 9 — save test credentials. Body carries either a
  // JSON-stringified `{ headers, userId }` stash or an explicit `"null"`
  // to clear. We forward the decoded payload to the agent which is the
  // authoritative validator + encryptor.
  if (intent === "save-test-credentials") {
    const raw = String(formData.get("testCredentials") ?? "");
    let payload: unknown;
    if (raw === "null") {
      payload = null;
    } else {
      try {
        payload = JSON.parse(raw);
      } catch {
        return typedjson(
          { error: "testCredentials must be valid JSON" },
          { status: 400 },
        );
      }
    }
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/entities/${encodeURIComponent(entityId)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ testCredentials: payload }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return typedjson(
        { error: `Save failed: ${text || res.status}` },
        { status: res.status },
      );
    }
    return typedjson({ testCredentialsSaved: true, cleared: payload === null });
  }

  return typedjson({ error: "Unknown action" }, { status: 400 });
}

export default function EntityDetailPage() {
  const {
    entity,
    tools,
    toolCount,
    agentWsUrl,
    scopeAgents,
    testCredentials,
    slugs,
  } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<{
    regenerated?: boolean;
    serviceSecret?: string;
    error?: string;
    toggled?: boolean;
    toolName?: string;
    enabled?: boolean;
    linkedAgentsSaved?: boolean;
    count?: number;
    testCredentialsSaved?: boolean;
    cleared?: boolean;
  }>();
  const navigation = useNavigation();
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 2000); } catch {}
  };

  if (!entity) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Entity not found" icon={<ExclamationTriangleIcon className="size-5 text-red-500" />} />
        </NavBar>
        <PageBody>
          <Paragraph variant="base/bright">This entity doesn't exist or has been deleted.</Paragraph>
          <div className="mt-4"><LinkButton to=".." variant="secondary/medium">Back to Connected Entities</LinkButton></div>
        </PageBody>
      </PageContainer>
    );
  }

  // The agent API historically returns `orgId` — keep accepting either shape
  // while the backend stabilizes on `entityId`.
  const entityIdentifier: string = entity.entityId ?? entity.orgId ?? "";
  const wsUrl = agentWsUrl.replace(/^http/, "ws") + "/tools/sync";
  // UNIT D — mcp entities are OUTBOUND clients: there is no inbound WS, so
  // their status comes from the discovery sweep (persisted connectionStatus)
  // rather than the live WS `liveConnected` flag, and the WebSocket URL row is
  // irrelevant.
  const isMcp = entity.connectionKind === "mcp";
  const mcpConnected = entity.connectionStatus === "connected";
  const storedSecret = (actionData?.regenerated && actionData.serviceSecret) || entity.serviceSecret;
  const showFreshSecret = actionData?.regenerated === true;

  const mcpPath = agentMcpEntityPath(
    { slug: slugs.organizationSlug },
    { slug: slugs.projectParam },
    { id: slugs.envParam },
    entityIdentifier,
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={entity.displayName} icon={<BuildingOffice2Icon className="size-5 text-blue-500" />} />
        <div className="ml-auto flex items-center gap-2">
          <DocsLink slug="connected-entities" />
          <LinkButton to={mcpPath} variant="tertiary/small" LeadingIcon={ShareIcon}>
            Configure MCP
          </LinkButton>
        </div>
      </NavBar>
      <PageBody>
        <div className="max-w-3xl space-y-6">
          {actionData?.error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-400">{actionData.error}</p>
            </div>
          )}
          {showFreshSecret && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 flex items-start gap-2">
              <CheckCircleIcon className="size-5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-emerald-300">Secret regenerated.</p>
                <p className="text-emerald-200/80 mt-1">The old secret is invalid immediately. Update your backend with the new secret below, then reconnect.</p>
              </div>
            </div>
          )}

          {/* Identity + status */}
          <section>
            <Header3>Identity</Header3>
            <div className="mt-3 rounded-lg border border-charcoal-700 bg-charcoal-850 divide-y divide-charcoal-700">
              <RowItem label="Entity ID" value={entityIdentifier} mono onCopy={() => copy("entityId", entityIdentifier)} copied={copied === "entityId"} />
              <RowItem label="Display Name" value={entity.displayName} />
              {/* UNIT D — connection-kind row so the operator knows whether this
                  is an inbound wire relationship or an outbound MCP client. */}
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-xs text-text-dimmed font-medium w-36 shrink-0">Connection type</span>
                <Badge
                  variant="small"
                  className={
                    isMcp
                      ? "border-violet-500/40 bg-violet-500/10 text-violet-300"
                      : "border-charcoal-600 bg-charcoal-800 text-text-dimmed"
                  }
                >
                  {isMcp ? "MCP client (outbound)" : "Wire (inbound WebSocket)"}
                </Badge>
              </div>
              <RowItem label="Created" value={new Date(entity.createdAt).toLocaleString()} />
              <RowItem label="Last Connected" value={entity.lastConnectedAt ? new Date(entity.lastConnectedAt).toLocaleString() : "Never"} />
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-xs text-text-dimmed font-medium w-36 shrink-0">Status</span>
                {isMcp ? (
                  <Badge variant={mcpConnected ? "success" : "error"}>
                    <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${mcpConnected ? "bg-green-500" : "bg-red-500"}`} />
                    {mcpConnected ? "connected" : "disconnected"}
                  </Badge>
                ) : (
                  <Badge variant={entity.liveConnected ? "success" : "error"}>
                    <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${entity.liveConnected ? "bg-green-500" : "bg-red-500"}`} />
                    {entity.liveConnected ? "connected" : "disconnected"}
                  </Badge>
                )}
              </div>
              {!isMcp && !entity.liveConnected && entity.connectedInOtherEnv ? (
                <div className="px-4 py-3 text-xs text-amber-400">
                  This entity is connected to a different environment. Set the bridge's PLATOS_ENV (or env query param on /tools/sync) to this environment.
                </div>
              ) : null}
            </div>
          </section>

          {/* UNIT D — outbound MCP transport + discovery panel (mcp entities
              only). Replaces the wire "Service Secret / WebSocket URL" section,
              which is meaningless for an outbound client. */}
          {isMcp && (
            <McpClientPanel
              mcpClient={entity.mcpClient ?? null}
              connectionStatus={entity.connectionStatus ?? "disconnected"}
              toolCount={toolCount}
            />
          )}

          {/* Service secret (wire only — mcp dispatch is outbound, not HMAC WS) */}
          {!isMcp && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <Header3>Service Secret</Header3>
              <Form method="post">
                <input type="hidden" name="intent" value="regenerate" />
                <Button type="submit" variant="tertiary/small" LeadingIcon={ArrowPathIcon} disabled={navigation.state === "submitting"}>
                  {navigation.state === "submitting" ? "Regenerating..." : "Regenerate"}
                </Button>
              </Form>
            </div>
            <Paragraph variant="small" className="mb-3">
              Used by your backend to authenticate WebSocket connections and verify HMAC signatures on tool calls.
            </Paragraph>
            <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 divide-y divide-charcoal-700">
              <div className="flex items-start justify-between gap-3 px-4 py-3">
                <span className="text-xs text-text-dimmed font-medium w-36 shrink-0 mt-1">Secret</span>
                <div className="flex-1 min-w-0">
                  {storedSecret ? (
                    <>
                      <span className="block text-sm text-text-bright font-mono break-all">
                        {secretRevealed || showFreshSecret ? storedSecret : "•".repeat(Math.min(50, storedSecret.length || 64))}
                      </span>
                      {showFreshSecret && (
                        <p className="mt-2 text-[11px] text-amber-400 leading-relaxed">
                          Copy this now. Platos will not show it again. The
                          DB stores it for HMAC verification, not for
                          retrieval. If you lose it, click Regenerate to
                          mint a new one (and update every consumer that
                          uses the old value).
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="block text-sm text-text-dimmed font-mono italic">
                        Not retrievable.
                      </span>
                      <p className="mt-2 text-[11px] text-text-dimmed leading-relaxed">
                        The plaintext secret was shown once on creation
                        and is never returned via the dashboard API after
                        that (security policy). Click Regenerate above to
                        mint a fresh secret if you do not have it on
                        hand. The fresh value will display once here, and
                        anything still using the old secret will need to
                        be re-pointed.
                      </p>
                    </>
                  )}
                </div>
                <div className="ml-3 flex items-center gap-2 shrink-0 mt-1">
                  {storedSecret ? (
                    <>
                      <button type="button" onClick={() => setSecretRevealed((v) => !v)} className="text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1">
                        {secretRevealed ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                        {secretRevealed ? "Hide" : "Reveal"}
                      </button>
                      <button type="button" onClick={() => copy("secret", storedSecret)} className="text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1">
                        <ClipboardIcon className="size-3.5" />{copied === "secret" ? "Copied" : "Copy"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <RowItem label="WebSocket URL" value={wsUrl} mono onCopy={() => copy("ws", wsUrl)} copied={copied === "ws"} />
            </div>
          </section>
          )}

          {/* Theme EA — per-entity agent allow-list (pills + add dropdown).
              Works identically for wire + mcp entities: the allow-list is a
              PATCH on linkedAgentIds regardless of transport. This is Surface 3
              (agent-linking) — link/unlink an entity to specific agents. */}
          <LinkedAgentsPanel
            initialIds={Array.isArray(entity.linkedAgentIds) ? entity.linkedAgentIds : []}
            scopeAgents={scopeAgents}
          />

          {/* PIFSP-3 Deliverable 9 — test credentials stash used by the
              "Test" button on each tool and the PIFSP-4 Postman-style
              test sheet. Never used in production dispatch (that's HMAC-
              signed with the service secret above). */}
          {!isMcp && <TestCredentialsPanel initial={testCredentials ?? null} />}

          {/* EOBD.79 — Tools registered, with enabled toggle + health view.
              PIFSP-3 Deliverable 5 — ToolHealthRow below does NOT render
              the entity-id pill (context already implied by this page).
              Cross-entity matrix views keep their pill — that's where it
              adds information. */}
          <section>
            <Header3>Tools registered ({toolCount})</Header3>
            {toolCount === 0 ? (
              <Paragraph variant="small" className="mt-2">
                {isMcp
                  ? "No tools discovered yet. Use “Refresh discovery” above to run tools/list against the MCP server. If it keeps failing, check the URL, credentials secret key, and header template."
                  : "No tools pushed yet. Connect your backend via the platools SDK with the secret above and the tools will appear here."}
              </Paragraph>
            ) : (
              <div className="mt-3 rounded-lg border border-charcoal-700 bg-charcoal-850 divide-y divide-charcoal-700 max-h-[32rem] overflow-y-auto">
                {tools.map((t) => (
                  <ToolHealthRow key={t.toolName} tool={t} />
                ))}
              </div>
            )}
          </section>

          {/* PIFSP-3 Deliverable 3 — "Custom Params" block removed. The
              PlatosConnectedEntity.customParams column was dropped
              (migration 20260424010000_*). Per-tool param injection lives
              on the agent-configuration editor as "MCP arguments". */}

          {/* Danger zone */}
          <section className="border-t border-charcoal-700 pt-6 mt-8">
            <Header3>Danger Zone</Header3>
            <Paragraph variant="small" className="mt-1 mb-3">
              Deleting this entity removes its registration. Tools will stop flowing. Agents using these tools will error until a new entity is registered.
            </Paragraph>
            <Form method="post" onSubmit={(e) => { if (!confirm(`Delete entity ${entityIdentifier}? This cannot be undone.`)) e.preventDefault(); }}>
              <input type="hidden" name="intent" value="delete" />
              <Button type="submit" variant="danger/small" LeadingIcon={TrashIcon}>
                Delete Entity
              </Button>
            </Form>
          </section>
        </div>
      </PageBody>
    </PageContainer>
  );
}

// EOBD.79 — per-tool row rendering: enable toggle + health stats. Uses a
// Remix `useFetcher` so each row can POST its toggle without a full page
// reload. Optimistic enabled state reflects the submitted value while
// in-flight so the switch doesn't bounce back visually.
type ToolHealth = {
  toolName: string;
  toolId: string;
  enabled: boolean;
  category: string | null;
  lastStatus: string | null;
  lastCalledAt: string | null;
  totalCalls: number;
  totalFailures: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
};

function ToolHealthRow({ tool }: { tool: ToolHealth }) {
  const fetcher = useFetcher<{ toggled?: boolean; enabled?: boolean; error?: string }>();
  const pendingEnabled =
    fetcher.state !== "idle" && fetcher.formData
      ? fetcher.formData.get("enabled") === "true"
      : null;
  const enabled = pendingEnabled !== null ? pendingEnabled : tool.enabled;

  const submitToggle = (next: boolean) => {
    const fd = new FormData();
    fd.append("intent", "toggle-tool");
    fd.append("toolName", tool.toolName);
    fd.append("enabled", next ? "true" : "false");
    fetcher.submit(fd, { method: "post" });
  };

  const successRate =
    tool.totalCalls > 0
      ? Math.round(((tool.totalCalls - tool.totalFailures) / tool.totalCalls) * 100)
      : null;

  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-text-bright font-mono truncate">{tool.toolName}</span>
          {tool.category && <Badge variant="outline-rounded">{tool.category}</Badge>}
          {tool.lastStatus && (
            <Badge variant={tool.lastStatus === "success" ? "success" : "error"}>
              {tool.lastStatus}
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-dimmed">
          <span>
            Last call:{" "}
            <span className="text-text-bright">
              {tool.lastCalledAt ? new Date(tool.lastCalledAt).toLocaleString() : "never"}
            </span>
          </span>
          <span>
            Calls: <span className="text-text-bright">{tool.totalCalls}</span>
            {tool.totalCalls > 0 && tool.totalFailures > 0 ? (
              <>
                {" "}
                (<span className="text-red-400">{tool.totalFailures} failed</span>)
              </>
            ) : null}
          </span>
          {successRate !== null && (
            <span>
              Success: <span className="text-text-bright">{successRate}%</span>
            </span>
          )}
          {tool.avgLatencyMs !== null && (
            <span>
              Avg: <span className="text-text-bright">{Math.round(tool.avgLatencyMs)}ms</span>
            </span>
          )}
          {tool.p95LatencyMs !== null && (
            <span>
              p95: <span className="text-text-bright">{Math.round(tool.p95LatencyMs)}ms</span>
            </span>
          )}
        </div>
        {fetcher.data?.error && (
          <p className="mt-1 text-xs text-red-400">{fetcher.data.error}</p>
        )}
      </div>
      <div className="shrink-0">
        <Switch
          variant="secondary/small"
          checked={enabled}
          onCheckedChange={submitToggle}
          disabled={fetcher.state !== "idle"}
          label={enabled ? "enabled" : "disabled"}
          labelPosition="left"
        />
      </div>
    </div>
  );
}

// Theme EA — entity → agents allow-list panel. Shows currently-linked
// agents as removable pills; an "Add agent" dropdown picks from the
// remaining agents in scope. Empty pill list = unrestricted (every agent
// sees this entity's tools). Save is a single PATCH call that the agent
// service uses to validate + refresh the in-memory tool-matrix cache so
// the change is live on the next turn — no redeploy, no rebuild.
function LinkedAgentsPanel({
  initialIds,
  scopeAgents,
}: {
  initialIds: string[];
  scopeAgents: Array<{ id: string; name: string; slug?: string }>;
}) {
  const fetcher = useFetcher<{ linkedAgentsSaved?: boolean; error?: string }>();
  const [selected, setSelected] = useState<string[]>(() =>
    Array.isArray(initialIds) ? [...initialIds] : [],
  );
  const [pending, setPending] = useState<string>("");

  const nameById = new Map(scopeAgents.map((a) => [a.id, a.name]));
  const available = scopeAgents.filter((a) => !selected.includes(a.id));
  const dirty =
    selected.length !== (initialIds?.length ?? 0) ||
    selected.some((id, i) => id !== initialIds[i]);
  const saving = fetcher.state !== "idle";

  function addAgent(id: string) {
    if (!id || selected.includes(id)) return;
    setSelected((p) => [...p, id]);
    setPending("");
  }
  function removeAgent(id: string) {
    setSelected((p) => p.filter((x) => x !== id));
  }
  function save() {
    const fd = new FormData();
    fd.set("intent", "save-linked-agents");
    fd.set("linkedAgentIds", JSON.stringify(selected));
    fetcher.submit(fd, { method: "post" });
  }
  function reset() {
    setSelected(Array.isArray(initialIds) ? [...initialIds] : []);
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <Header3>Linked agents</Header3>
        {selected.length === 0 ? (
          <Badge variant="small">unrestricted</Badge>
        ) : (
          <Badge variant="small">{selected.length} linked</Badge>
        )}
      </div>
      <Paragraph variant="small" className="mb-3">
        When empty, every agent in this scope can see this entity's tools.
        Add one or more agents to restrict visibility — only the listed
        agents will see the tools from this entity via{" "}
        <code className="font-mono text-xs">find_tools</code> and the
        scoped matrix. Remove all agents to go back to unrestricted.
      </Paragraph>

      {fetcher.data?.linkedAgentsSaved ? (
        <div className="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
          Saved. The tool matrix cache refreshes immediately — the change
          takes effect on the next turn.
        </div>
      ) : null}
      {fetcher.data?.error ? (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {fetcher.data.error}
        </div>
      ) : null}

      <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-3">
        <div className="flex flex-wrap gap-2 min-h-[2rem]">
          {selected.length === 0 ? (
            <span className="text-xs text-text-dimmed italic">
              No agents linked — this entity is visible to every agent.
            </span>
          ) : (
            selected.map((id) => {
              const name = nameById.get(id) ?? id;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-charcoal-600 bg-charcoal-800 px-2.5 py-1 text-xs"
                >
                  <span className="text-text-bright">{name}</span>
                  <button
                    type="button"
                    onClick={() => removeAgent(id)}
                    aria-label={`remove ${name}`}
                    className="text-text-dimmed hover:text-red-400"
                  >
                    <TrashIcon className="size-3" />
                  </button>
                </span>
              );
            })
          )}
        </div>

        {available.length > 0 ? (
          <div className="mt-3 flex items-center gap-2">
            <select
              value={pending}
              onChange={(e) => {
                const id = e.target.value;
                if (id) addAgent(id);
              }}
              className="flex-1 rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1.5 text-sm text-text-bright"
            >
              <option value="">Add an agent…</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="mt-3 text-xs text-text-dimmed italic">
            All {scopeAgents.length} agents in this scope are linked.
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant="primary/small"
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : "Save linked agents"}
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="tertiary/small"
              onClick={reset}
              disabled={saving}
            >
              Cancel
            </Button>
          ) : null}
          {dirty ? (
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Unsaved changes.
            </Paragraph>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// UNIT D (MCP consumption / Surface 2) — outbound MCP transport + discovery
// panel. Renders the read-only transport config (transport / url /
// credsSecretKey / headersTemplate) surfaced by ENTITY_SAFE_SELECT.mcpClient,
// plus the last discovery timestamp / error, and a "Refresh discovery" button
// that POSTs `intent=refresh-discovery` (agent re-runs tools/list). Uses a
// `useFetcher` so the refresh doesn't blow away the rest of the page — mirrors
// the LinkedAgentsPanel / ToolHealthRow fetcher pattern.
type McpClientSlice = {
  transport: string;
  url: string | null;
  credsSecretKey: string | null;
  headersTemplate: unknown;
  lastDiscoveryAt: string | null;
  discoveryError: string | null;
};

function McpClientPanel({
  mcpClient,
  connectionStatus,
  toolCount,
}: {
  mcpClient: McpClientSlice | null;
  connectionStatus: string;
  toolCount: number;
}) {
  const fetcher = useFetcher<{
    discovered?: boolean;
    discovery?: { envs?: number; registered?: number; pruned?: number; error?: string };
    error?: string;
  }>();
  const refreshing = fetcher.state !== "idle";

  // headersTemplate is a Json column → normalise to displayable [key, value]
  // pairs. Tolerate a null/scalar shape (defensive — the column is Json?).
  const headerPairs: Array<[string, string]> =
    mcpClient?.headersTemplate &&
    typeof mcpClient.headersTemplate === "object" &&
    !Array.isArray(mcpClient.headersTemplate)
      ? Object.entries(mcpClient.headersTemplate as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)],
        )
      : [];

  const result = fetcher.data?.discovery;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ServerStackIcon className="size-4 text-violet-400" />
          <Header3>MCP transport &amp; discovery</Header3>
        </div>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="refresh-discovery" />
          <Button
            type="submit"
            variant="tertiary/small"
            LeadingIcon={ArrowPathIcon}
            disabled={refreshing}
          >
            {refreshing ? "Discovering…" : "Refresh discovery"}
          </Button>
        </fetcher.Form>
      </div>
      <Paragraph variant="small" className="mb-3">
        Platos connects OUT to this MCP server and dispatches tool calls to it.
        Discovery runs <code className="font-mono text-xs">tools/list</code>{" "}
        against the server across every environment and registers the results
        into the shared tool matrix.
      </Paragraph>

      {fetcher.data?.error ? (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {fetcher.data.error}
        </div>
      ) : null}
      {fetcher.data?.discovered ? (
        result?.error ? (
          <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
            Discovery completed with an error: {result.error}
            {typeof result.envs === "number" ? ` (${result.envs} env(s) swept)` : ""}
          </div>
        ) : (
          <div className="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
            Discovery complete — {result?.registered ?? 0} tool
            {(result?.registered ?? 0) === 1 ? "" : "s"} registered
            {typeof result?.pruned === "number" && result.pruned > 0
              ? `, ${result.pruned} pruned`
              : ""}{" "}
            across {result?.envs ?? 0} environment
            {(result?.envs ?? 0) === 1 ? "" : "s"}.
          </div>
        )
      ) : null}

      {!mcpClient ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
          This entity is registered as an MCP client but has no transport config
          on record. Re-register the entity with a transport + URL.
        </div>
      ) : (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 divide-y divide-charcoal-700">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-text-dimmed font-medium w-36 shrink-0">Transport</span>
            <Badge variant="outline-rounded">{mcpClient.transport}</Badge>
          </div>
          <RowItem label="URL" value={mcpClient.url || "—"} mono />
          <RowItem
            label="Creds secret key"
            value={mcpClient.credsSecretKey || "— (none)"}
            mono
          />
          <div className="px-4 py-3">
            <div className="text-xs text-text-dimmed font-medium mb-2">
              Header template ({headerPairs.length})
            </div>
            {headerPairs.length === 0 ? (
              <span className="text-sm text-text-dimmed italic">No headers configured.</span>
            ) : (
              <div className="space-y-1.5">
                {headerPairs.map(([name, value]) => (
                  <div key={name} className="flex items-start gap-2 text-sm">
                    <span className="text-text-bright font-mono shrink-0">{name}:</span>
                    <span className="text-text-dimmed font-mono break-all">{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-text-dimmed font-medium w-36 shrink-0">Discovery status</span>
            <Badge variant={connectionStatus === "connected" ? "success" : "error"}>
              <span
                className={`inline-block w-2 h-2 rounded-full mr-1.5 ${
                  connectionStatus === "connected" ? "bg-green-500" : "bg-red-500"
                }`}
              />
              {connectionStatus}
            </Badge>
          </div>
          <RowItem
            label="Last discovery"
            value={
              mcpClient.lastDiscoveryAt
                ? new Date(mcpClient.lastDiscoveryAt).toLocaleString()
                : "Never"
            }
          />
          <RowItem label="Discovered tools" value={`${toolCount}`} />
          {mcpClient.discoveryError ? (
            <div className="px-4 py-3">
              <div className="text-xs text-red-400 font-medium mb-1 flex items-center gap-1">
                <ExclamationTriangleIcon className="size-3.5" />
                Last discovery error
              </div>
              <p className="text-sm text-red-300/90 font-mono break-all">
                {mcpClient.discoveryError}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RowItem({ label, value, mono, onCopy, copied }: { label: string; value: string; mono?: boolean; onCopy?: () => void; copied?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-xs text-text-dimmed font-medium w-36 shrink-0">{label}</span>
      <span className={`flex-1 text-sm text-text-bright ${mono ? "font-mono break-all" : ""}`}>{value}</span>
      {onCopy && (
        <button type="button" onClick={onCopy} className="ml-3 text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1">
          <ClipboardIcon className="size-3.5" />{copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

/**
 * PIFSP-3 Deliverable 9 — test-credentials editor. Lists the current
 * headers with per-row mask/reveal + remove, lets the operator append
 * new rows, supports userId override, and saves the whole stash in one
 * POST. The agent service validates header-name regex + count + value
 * length on the server too — this UI is defence-in-depth, not the sole
 * gate.
 */
type TestCredRow = { id: string; name: string; value: string; revealed: boolean };
type TestCredsPayload = {
  headers: Array<{ name: string; value: string }>;
  userId?: string;
  updatedAt?: string;
  updatedByUserId?: string;
};

function nextRowId(): string {
  return `row-${Math.random().toString(36).slice(2, 10)}`;
}

function maskHeaderValue(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.max(6, value.length - 4))}${value.slice(-4)}`;
}

function TestCredentialsPanel({ initial }: { initial: TestCredsPayload | null }) {
  const fetcher = useFetcher<{
    testCredentialsSaved?: boolean;
    cleared?: boolean;
    error?: string;
  }>();

  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<TestCredRow[]>(() =>
    (initial?.headers ?? []).map((h) => ({
      id: nextRowId(),
      name: h.name,
      value: h.value,
      revealed: false,
    })),
  );
  const [userIdDraft, setUserIdDraft] = useState<string>(initial?.userId ?? "");
  const [confirmClear, setConfirmClear] = useState(false);

  // When the saved snapshot flips (e.g. another tab saved) reset local state
  // so the panel reflects server truth without a page reload.
  useEffect(() => {
    setRows(
      (initial?.headers ?? []).map((h) => ({
        id: nextRowId(),
        name: h.name,
        value: h.value,
        revealed: false,
      })),
    );
    setUserIdDraft(initial?.userId ?? "");
    setEditing(false);
    setConfirmClear(false);
  }, [initial?.updatedAt, initial?.headers.length, initial?.userId]);

  const saving = fetcher.state !== "idle";
  const has = rows.length > 0 || (initial?.headers.length ?? 0) > 0;

  const validationErrors: string[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue; // empty rows are ignored on save
    if (!TEST_CRED_HEADER_NAME_RE.test(name)) {
      validationErrors.push(`Header "${name}" is not a valid HTTP header name.`);
    }
    if (r.value.length > TEST_CRED_MAX_VALUE_LEN) {
      validationErrors.push(
        `Header "${name}" value exceeds ${TEST_CRED_MAX_VALUE_LEN} chars.`,
      );
    }
  }
  if (rows.length > TEST_CRED_MAX_HEADERS) {
    validationErrors.push(`Max ${TEST_CRED_MAX_HEADERS} headers per entity.`);
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { id: nextRowId(), name: "", value: "", revealed: true },
    ]);
    setEditing(true);
  }
  function updateRow(id: string, patch: Partial<TestCredRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }
  function discardEdits() {
    setRows(
      (initial?.headers ?? []).map((h) => ({
        id: nextRowId(),
        name: h.name,
        value: h.value,
        revealed: false,
      })),
    );
    setUserIdDraft(initial?.userId ?? "");
    setEditing(false);
  }
  function save() {
    if (validationErrors.length > 0) return;
    const headers = rows
      .map((r) => ({ name: r.name.trim(), value: r.value.trim() }))
      .filter((h) => h.name.length > 0);
    const payload: {
      headers: typeof headers;
      userId?: string;
    } = { headers };
    const uid = userIdDraft.trim();
    if (uid) payload.userId = uid;
    const fd = new FormData();
    fd.set("intent", "save-test-credentials");
    fd.set("testCredentials", JSON.stringify(payload));
    fetcher.submit(fd, { method: "post" });
  }
  function clearAll() {
    const fd = new FormData();
    fd.set("intent", "save-test-credentials");
    fd.set("testCredentials", "null");
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Header3>Test credentials</Header3>
          <span
            title="Applied to outbound tool-test calls from the dashboard. Never used in production."
            className="text-text-dimmed hover:text-text-bright cursor-help"
            aria-label="test credentials info"
          >
            <InformationCircleIcon className="size-4" />
          </span>
        </div>
        <div className="flex items-center gap-2">
          {has && !editing && (
            <Button
              type="button"
              variant="tertiary/small"
              LeadingIcon={PencilIcon}
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      {fetcher.data?.testCredentialsSaved ? (
        <div className="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-300">
          {fetcher.data.cleared
            ? "Test credentials cleared."
            : "Test credentials saved."}
        </div>
      ) : null}
      {fetcher.data?.error ? (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-400">
          {fetcher.data.error}
        </div>
      ) : null}

      {!has && !editing ? (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
          <Paragraph variant="small" className="mb-3">
            These headers get prepended to outbound test calls when you click{" "}
            <span className="font-mono text-text-bright">Test</span> on a tool.
            Your production tool calls don't use this — they're HMAC-signed with
            your service secret.
          </Paragraph>
          <Button
            type="button"
            variant="primary/small"
            LeadingIcon={PlusIcon}
            onClick={addRow}
          >
            Add first header
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 divide-y divide-charcoal-700">
          <div className="px-4 py-3">
            <div className="text-xs text-text-dimmed font-medium mb-2">
              Headers ({rows.length})
            </div>
            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    placeholder="Header name (e.g. Authorization)"
                    value={row.name}
                    disabled={!editing}
                    onChange={(e) =>
                      updateRow(row.id, { name: e.currentTarget.value })
                    }
                    className="w-56"
                  />
                  {editing ? (
                    <Input
                      type={row.revealed ? "text" : "password"}
                      placeholder="Header value"
                      value={row.value}
                      onChange={(e) =>
                        updateRow(row.id, { value: e.currentTarget.value })
                      }
                      className="flex-1 font-mono"
                    />
                  ) : (
                    <span className="flex-1 text-sm text-text-bright font-mono break-all">
                      {row.revealed ? row.value : maskHeaderValue(row.value)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      updateRow(row.id, { revealed: !row.revealed })
                    }
                    className="text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1 shrink-0"
                    aria-label={row.revealed ? "hide" : "reveal"}
                  >
                    {row.revealed ? (
                      <EyeSlashIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </button>
                  {editing && (
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      className="text-red-400 hover:text-red-300 shrink-0"
                      aria-label="remove header"
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  )}
                </div>
              ))}
              {editing && rows.length < TEST_CRED_MAX_HEADERS && (
                <Button
                  type="button"
                  variant="tertiary/small"
                  LeadingIcon={PlusIcon}
                  onClick={addRow}
                >
                  Add header
                </Button>
              )}
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="text-xs text-text-dimmed font-medium mb-2 flex items-center gap-1">
              <KeyIcon className="size-3.5" />
              User ID (optional)
            </div>
            {editing ? (
              <Input
                placeholder="user-id-for-your-auth-system"
                value={userIdDraft}
                onChange={(e) => setUserIdDraft(e.currentTarget.value)}
              />
            ) : (
              <span className="text-sm text-text-bright font-mono">
                {userIdDraft || "—"}
              </span>
            )}
          </div>

          {validationErrors.length > 0 && (
            <div className="px-4 py-3 text-xs text-red-400 space-y-1">
              {validationErrors.map((e, i) => (
                <div key={i}>• {e}</div>
              ))}
            </div>
          )}

          {initial?.updatedAt && (
            <div className="px-4 py-2 text-xs text-text-dimmed">
              Last edited {new Date(initial.updatedAt).toLocaleString()}
              {initial.updatedByUserId ? ` by ${initial.updatedByUserId}` : ""}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <div className="flex items-center gap-2">
              {editing && (
                <>
                  <Button
                    type="button"
                    variant="primary/small"
                    onClick={save}
                    disabled={saving || validationErrors.length > 0}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    variant="tertiary/small"
                    onClick={discardEdits}
                    disabled={saving}
                  >
                    Discard
                  </Button>
                </>
              )}
            </div>
            {has && (
              <div className="flex items-center gap-2">
                {confirmClear ? (
                  <>
                    <span className="text-xs text-red-400">
                      Clear all test credentials?
                    </span>
                    <Button
                      type="button"
                      variant="danger/small"
                      onClick={clearAll}
                      disabled={saving}
                    >
                      Confirm clear
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary/small"
                      onClick={() => setConfirmClear(false)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="tertiary/small"
                    LeadingIcon={TrashIcon}
                    onClick={() => setConfirmClear(true)}
                    disabled={saving}
                  >
                    Clear all
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
