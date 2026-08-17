/**
 * PIFSP-23/24/25 — MCP entity detail page.
 * Tabs: Overview | Tokens | Tools | Branding | Identity
 */
import {
  ShareIcon, ClipboardDocumentIcon, PlusIcon, TrashIcon,
  EyeIcon, EyeSlashIcon, ShieldCheckIcon,
} from "@heroicons/react/20/solid";
import { useFetcher, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
} from "~/components/primitives/Table";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "MCP Entity | Platos" }];

const ParamSchema = EnvironmentParamSchema.extend({ entityId: z.string() });

type BearerToken = { id: string; label: string; mcpUserId: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null };
type ToolAclRow = { id: string; toolName: string; exposed: boolean; minIdentityMode: string };

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, entityId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  let config: Record<string, unknown> | null = null;
  let tokens: BearerToken[] = [];
  let tools: ToolAclRow[] = [];

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      const [cfgRes, tokRes, toolRes] = await Promise.all([
        fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/config`, { headers, signal: AbortSignal.timeout(5000) }),
        fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/tokens`, { headers, signal: AbortSignal.timeout(5000) }),
        fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/tool-acl?limit=200`, { headers, signal: AbortSignal.timeout(5000) }),
      ]);
      if (cfgRes.ok) config = ((await cfgRes.json()) as { config: Record<string, unknown> }).config;
      if (tokRes.ok) tokens = ((await tokRes.json()) as { tokens: BearerToken[] }).tokens;
      if (toolRes.ok) tools = ((await toolRes.json()) as { tools: ToolAclRow[] }).tools;
    }
  } catch { /* agent unreachable */ }

  return typedjson({
    entityId,
    config,
    tokens,
    tools,
    scope: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, entityId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "generate-token") {
    const label = formData.get("label") as string;
    const res = await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: label || "New token" }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { id: string; raw: string; mcpUserId: string };
      return typedjson({ newToken: data.raw, tokenId: data.id });
    }
    return typedjson({ error: "Failed to generate token" });
  }

  if (intent === "revoke-token") {
    const tokenId = formData.get("tokenId") as string;
    await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/tokens/${tokenId}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(5000),
    });
    return typedjson({ revoked: true });
  }

  if (intent === "toggle-tool") {
    const toolId = formData.get("toolId") as string;
    const exposed = formData.get("exposed") === "true";
    await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/tool-acl/${toolId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ exposed }),
      signal: AbortSignal.timeout(5000),
    });
    return typedjson({ ok: true });
  }

  if (intent === "save-branding") {
    const branding = JSON.parse(formData.get("branding") as string || "{}");
    await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/branding`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(branding),
      signal: AbortSignal.timeout(5000),
    });
    return typedjson({ ok: true });
  }

  if (intent === "save-identity") {
    const identityMode = formData.get("identityMode") as string;
    const identityProvidersRaw = formData.get("identityProviders") as string | null;
    let identityProviders: unknown = undefined;
    if (identityProvidersRaw) {
      try { identityProviders = JSON.parse(identityProvidersRaw); } catch { /* ignore parse error */ }
    }
    await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/identity`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ identityMode, identityProviders }),
      signal: AbortSignal.timeout(5000),
    });
    return typedjson({ ok: true });
  }

  if (intent === "set-enabled") {
    const enabled = formData.get("enabled") === "true";
    await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/enabled`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(5000),
    });
    return typedjson({ ok: true, enabled });
  }

  if (intent === "set-inject-context") {
    const injectMcpContext = formData.get("injectMcpContext") === "true";
    await fetch(`${AGENT_API_URL}/mcp/entity/${entityId}/inject-context`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ injectMcpContext }),
      signal: AbortSignal.timeout(5000),
    });
    return typedjson({ ok: true, injectMcpContext });
  }

  return typedjson({ error: "Unknown intent" }, { status: 400 });
}

type Tab = "tokens" | "tools" | "branding" | "identity" | "overview";

export default function McpEntityDetailPage() {
  const { entityId, config, tokens, tools } = useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);
  const [brandingJson, setBrandingJson] = useState(() =>
    JSON.stringify((config as any)?.branding ?? {}, null, 2),
  );
  const [identityMode, setIdentityMode] = useState<string>(
    (config as any)?.identityMode ?? "anonymous",
  );
  const [identityProvidersJson, setIdentityProvidersJson] = useState<string>(() =>
    JSON.stringify((config as any)?.identityProviders ?? {}, null, 2),
  );

  // Show newly generated token
  const actionData = fetcher.data as any;
  if (actionData?.newToken && !newTokenValue) {
    setNewTokenValue(actionData.newToken);
  }

  const mcpUrl = `/mcp/entity/${entityId}`;
  const enabled = !!(config as any)?.enabled;
  const injectMcpContext = !!(config as any)?.injectMcpContext;

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "tokens", label: "Tokens" },
    { id: "tools", label: "Tools" },
    { id: "branding", label: "Branding" },
    { id: "identity", label: "Identity" },
  ];

  const TAB_BASE = "px-3 py-2 text-sm transition-colors whitespace-nowrap";
  const TAB_ACTIVE = "border-b-2 border-emerald-400 text-emerald-400 font-medium";
  const TAB_INACTIVE = "border-b-2 border-transparent text-text-dimmed hover:text-text-bright";

  return (
    <PageContainer>
      {/* NavBar + tab strip in one auto-height header row */}
      <div className="flex-none">
        <NavBar>
          <PageTitle title={`MCP: ${entityId}`} />
          <div className="flex items-center gap-2 ml-2">
            <Badge variant={enabled ? "success" : "outline-rounded"}>{enabled ? "Enabled" : "Disabled"}</Badge>
            <div className="flex items-center gap-1 text-xs text-text-dimmed">
              <code className="font-mono">{mcpUrl}</code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(mcpUrl)}
                className="hover:text-text-bright"
              >
                <ClipboardDocumentIcon className="size-3.5" />
              </button>
            </div>
          </div>
          <div className="ml-auto">
            <DocsLink slug="mcp-gateway" />
          </div>
        </NavBar>

        {/* Tab strip */}
        <div className="flex border-b border-charcoal-700 px-4">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`${TAB_BASE} ${activeTab === tab.id ? TAB_ACTIVE : TAB_INACTIVE}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <PageBody>
        {/* Overview */}
        {activeTab === "overview" && (
          <div className="space-y-4">
            {/* Enable / disable toggle */}
            <div className="rounded border border-charcoal-700 bg-charcoal-800/30 p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-text-bright">MCP Enabled</p>
                <Paragraph variant="small" className="text-text-dimmed mt-0.5">
                  When disabled, all tool calls to this endpoint return 403.
                </Paragraph>
              </div>
              <button
                type="button"
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "set-enabled");
                  fd.set("enabled", String(!enabled));
                  fetcher.submit(fd, { method: "POST" });
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  enabled ? "bg-emerald-500" : "bg-charcoal-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    enabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <div className="rounded border border-charcoal-700 bg-charcoal-800/30 p-4">
              <p className="text-sm font-medium text-text-bright mb-2">MCP Endpoint</p>
              <code className="text-xs text-emerald-400 font-mono block">
                {mcpUrl}
              </code>
              <Paragraph variant="small" className="mt-2 text-text-dimmed">
                Use this URL in Claude Desktop or any MCP-compatible client.
                Add to your MCP config as <code>type: http</code>.
              </Paragraph>
            </div>
            {/* MCPF-followup: per-entity opt-in for `_context` envelope. */}
            <div className="rounded border border-charcoal-700 bg-charcoal-800/30 p-4 flex items-center justify-between">
              <div className="pr-4">
                <p className="text-sm font-medium text-text-bright">
                  Inject MCP context (<code className="font-mono text-xs">_context</code>) into tool calls
                </p>
                <Paragraph variant="small" className="text-text-dimmed mt-0.5">
                  <strong className="text-text-bright">Recommended: ON.</strong>{" "}
                  Required for MCP user identity (<code className="font-mono text-xs">source</code>,{" "}
                  <code className="font-mono text-xs">mcpUserId</code>,{" "}
                  <code className="font-mono text-xs">mcpClientId</code>) to flow to your entity backend.
                  Your backend must use a recent{" "}
                  <code className="font-mono text-xs">platools</code> (Python ≥ 0.2.0) or{" "}
                  <code className="font-mono text-xs">@platosdev/platools-sdk</code> (JS ≥ 0.2.0) — these
                  SDKs pop <code className="font-mono text-xs">_context</code> from tool kwargs
                  before your handler runs and expose it via{" "}
                  <code className="font-mono text-xs">current_context()</code> /{" "}
                  <code className="font-mono text-xs">currentContext()</code>.{" "}
                  Default <strong>ON for new entities</strong>; entities created before the SDK
                  upgrade default to OFF — flip to ON once you redeploy with the latest SDK.
                  If toggling ON breaks tool calls with{" "}
                  <code className="font-mono text-xs">TypeError: got an unexpected keyword argument '_context'</code>,
                  your backend isn't on the new SDK yet — toggle back OFF and redeploy.
                </Paragraph>
              </div>
              <button
                type="button"
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "set-inject-context");
                  fd.set("injectMcpContext", String(!injectMcpContext));
                  fetcher.submit(fd, { method: "POST" });
                }}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${
                  injectMcpContext ? "bg-emerald-500" : "bg-charcoal-600"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    injectMcpContext ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Active tokens" value={tokens.filter((t) => !t.revokedAt).length} />
              <StatCard label="Exposed tools" value={tools.filter((t) => t.exposed).length} />
              <StatCard label="Identity mode" value={(config as any)?.identityMode ?? "anonymous"} />
            </div>
          </div>
        )}

        {/* Tokens */}
        {activeTab === "tokens" && (
          <div className="space-y-4">
            {newTokenValue && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4">
                <p className="text-xs font-semibold text-amber-300 mb-1">
                  New token — copy it now, you won't see it again!
                </p>
                <code className="text-xs text-amber-200 font-mono break-all block bg-charcoal-800 rounded p-2">
                  {newTokenValue}
                </code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(newTokenValue)}
                  className="mt-2 text-xs text-amber-300 hover:text-amber-200 underline"
                >
                  Copy to clipboard
                </button>
                <button
                  type="button"
                  onClick={() => setNewTokenValue(null)}
                  className="ml-4 mt-2 text-xs text-text-dimmed hover:text-text-bright"
                >
                  Dismiss
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                placeholder="Token label (e.g. CI bot)"
                value={newTokenLabel}
                onChange={(e) => setNewTokenLabel(e.target.value)}
                className="w-64"
              />
              <Button
                variant="primary/small"
                onClick={() => {
                  const fd = new FormData();
                  fd.set("intent", "generate-token");
                  fd.set("label", newTokenLabel || "New token");
                  fetcher.submit(fd, { method: "POST" });
                  setNewTokenLabel("");
                }}
              >
                <PlusIcon className="size-3.5 mr-1" /> Generate
              </Button>
            </div>
            {tokens.length === 0 ? (
              <Paragraph variant="small" className="text-text-dimmed">No tokens yet.</Paragraph>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Label</TableHeaderCell>
                    <TableHeaderCell>User ID</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell>Last used</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell></TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>{t.label}</TableCell>
                      <TableCell><code className="text-xs font-mono text-text-dimmed">{t.mcpUserId}</code></TableCell>
                      <TableCell className="text-xs text-text-dimmed">{new Date(t.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-xs text-text-dimmed">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : "Never"}</TableCell>
                      <TableCell>
                        <Badge variant={t.revokedAt ? "error" : "success"}>{t.revokedAt ? "Revoked" : "Active"}</Badge>
                      </TableCell>
                      <TableCell>
                        {!t.revokedAt && (
                          <button
                            type="button"
                            onClick={() => {
                              const fd = new FormData();
                              fd.set("intent", "revoke-token");
                              fd.set("tokenId", t.id);
                              fetcher.submit(fd, { method: "POST" });
                            }}
                            className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1"
                          >
                            <TrashIcon className="size-3.5" /> Revoke
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {/* Tools */}
        {activeTab === "tools" && (
          <div className="space-y-3">
            <Paragraph variant="small" className="text-text-dimmed">
              By default, no tools are exposed. Toggle tools to expose them via MCP.
            </Paragraph>
            {tools.length === 0 ? (
              <Paragraph variant="small" className="text-text-dimmed">No tools registered for this entity.</Paragraph>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Tool</TableHeaderCell>
                    <TableHeaderCell>Exposed</TableHeaderCell>
                    <TableHeaderCell>Min identity</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tools.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell><code className="text-xs font-mono">{t.toolName}</code></TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("intent", "toggle-tool");
                            fd.set("toolId", t.id);
                            fd.set("exposed", String(!t.exposed));
                            fetcher.submit(fd, { method: "POST" });
                          }}
                          className={`flex items-center gap-1 text-xs ${t.exposed ? "text-emerald-400 hover:text-emerald-300" : "text-text-dimmed hover:text-text-bright"}`}
                        >
                          {t.exposed ? <EyeIcon className="size-3.5" /> : <EyeSlashIcon className="size-3.5" />}
                          {t.exposed ? "Exposed" : "Hidden"}
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-text-dimmed">{t.minIdentityMode}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}

        {/* Branding */}
        {activeTab === "branding" && (
          <div className="space-y-4 max-w-xl">
            <Paragraph variant="small" className="text-text-dimmed">
              Customize how this MCP endpoint appears to end-users on the OAuth consent screen.
            </Paragraph>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text-dimmed">Branding JSON</span>
              <textarea
                value={brandingJson}
                onChange={(e) => setBrandingJson(e.target.value)}
                rows={12}
                className="bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono resize-y"
                placeholder='{"displayName": "My Entity", "primaryColor": "#6366F1", "tagline": "..."}'
              />
            </label>
            <Button
              variant="primary/small"
              onClick={() => {
                const fd = new FormData();
                fd.set("intent", "save-branding");
                fd.set("branding", brandingJson);
                fetcher.submit(fd, { method: "POST" });
              }}
            >
              Save branding
            </Button>
          </div>
        )}

        {/* Identity */}
        {activeTab === "identity" && (
          <div className="space-y-5 max-w-xl">
            <Paragraph variant="small" className="text-text-dimmed">
              Controls how MCP clients authenticate against this endpoint. Choose based on your entity backend's auth system.
            </Paragraph>

            <div>
              <p className="text-xs font-medium text-text-dimmed mb-2">Identity mode</p>
              <div className="space-y-2">
                {(
                  [
                    { mode: "anonymous", desc: "No auth — anyone with the URL can call tools. Use only for public demo endpoints." },
                    { mode: "bearer", desc: "Platos-issued Personal Access Tokens (PATs). Operators create tokens on the Tokens tab; users attach them as Bearer headers." },
                    { mode: "oidc", desc: "OAuth 2.1 PKCE delegated to your entity backend. Configure identityProviders below so Platos knows where to redirect users for login." },
                    { mode: "oidc+bearer", desc: "OIDC preferred, Bearer PAT as fallback. Good for migration." },
                    { mode: "anonymous+bearer", desc: "Anonymous allowed but Bearer PATs can also be used for elevated access." },
                  ] as const
                ).map(({ mode, desc }) => (
                  <label key={mode} className="flex items-start gap-2.5 cursor-pointer rounded border border-charcoal-700 bg-charcoal-800/30 px-3 py-2.5 hover:border-charcoal-600 transition-colors">
                    <input
                      type="radio"
                      name="identityMode"
                      value={mode}
                      checked={identityMode === mode}
                      onChange={() => setIdentityMode(mode)}
                      className="accent-emerald-500 mt-0.5 shrink-0"
                    />
                    <div>
                      <span className="text-sm text-text-bright font-mono">{mode}</span>
                      <p className="text-xs text-text-dimmed mt-0.5">{desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {(identityMode === "oidc" || identityMode === "oidc+bearer") && (
              <div>
                <p className="text-xs font-medium text-text-dimmed mb-1">
                  Identity provider config <span className="text-text-dimmed/50">(JSON)</span>
                </p>
                <Paragraph variant="small" className="text-text-dimmed mb-2">
                  Platos uses this to redirect users to your auth server and exchange codes for tokens.
                  The access token is forwarded as <code className="font-mono text-xs">X-Platos-Entity-Token</code> on every tool call so your backend can verify it.
                </Paragraph>
                <div className="rounded border border-charcoal-600 bg-charcoal-900 p-2 mb-2">
                  <p className="text-xs text-text-dimmed font-mono leading-relaxed whitespace-pre">{`{
  "type": "oauth2_pkce",
  "authorizationUrl": "https://your-entity.com/oauth/authorize",
  "tokenUrl": "https://your-entity.com/oauth/token",
  "clientId": "platos-mcp",
  "scopes": ["api:read", "api:write"]
}`}</p>
                </div>
                <textarea
                  value={identityProvidersJson}
                  onChange={(e) => setIdentityProvidersJson(e.target.value)}
                  rows={10}
                  className="w-full bg-charcoal-800 border border-charcoal-600 text-text-bright text-xs rounded px-2 py-1.5 font-mono resize-y"
                  placeholder="Paste your identity provider config JSON here"
                />
              </div>
            )}

            <Button
              variant="primary/small"
              onClick={() => {
                const fd = new FormData();
                fd.set("intent", "save-identity");
                fd.set("identityMode", identityMode);
                if (identityMode === "oidc" || identityMode === "oidc+bearer") {
                  fd.set("identityProviders", identityProvidersJson);
                }
                fetcher.submit(fd, { method: "POST" });
              }}
            >
              <ShieldCheckIcon className="size-3.5 mr-1" /> Save identity config
            </Button>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-charcoal-700 bg-charcoal-800/30 p-3">
      <p className="text-xs text-text-dimmed">{label}</p>
      <p className="text-2xl font-bold text-text-bright mt-1">{value}</p>
    </div>
  );
}
