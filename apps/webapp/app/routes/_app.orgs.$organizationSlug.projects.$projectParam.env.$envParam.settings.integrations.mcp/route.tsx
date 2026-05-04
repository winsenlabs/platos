/**
 * Theme K.7 — Project settings → Integrations → MCP tab.
 *
 * Mint / list / revoke PLATOS_MCP_TOKENs. The raw token is returned
 * ONCE at mint — after that, only metadata (name, permissions,
 * expires, lastUsed, revoked) is visible.
 *
 * Lives under `/settings/integrations/mcp` as a sibling tab to the
 * default Apps tab (Git + Vercel + Build settings). The old route
 * `/settings/mcp-tokens` now 307-redirects here.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { Form, useActionData } from "@remix-run/react";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Button } from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

function scopeHeaders(scope: Scope): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": scope.organizationId,
    "X-Platos-Project-Id": scope.projectId,
    "X-Platos-Environment-Id": scope.environmentId,
    "X-Platos-User-Id": scope.userId,
  };
}

async function agentFetch<T>(
  path: string,
  scope: Scope,
  opts?: { method?: string; body?: unknown },
): Promise<T | null> {
  const AGENT_API_URL =
    process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: opts?.method || "GET",
      headers: scopeHeaders(scope),
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type TokenRow = {
  id: string;
  name: string;
  permissions: string[];
  /** K.18 — "scope" (default) | "admin". Older rows may lack this field. */
  tier?: "scope" | "admin";
  mintedByUserId: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404 });

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const res = await agentFetch<{ tokens: TokenRow[] }>(
    "/mcp/platform/tokens",
    scope,
  );
  const tokens = res?.tokens ?? [];

  // K.18 — only org ADMINs see the "Admin tier (cross-scope)" mint
  // checkbox. Agent-side mint enforcement is authoritative; the UI flag
  // just prevents a non-admin from seeing a control they can't use.
  const membership = await prisma.orgMember.findFirst({
    where: { organizationId: project.organizationId, userId },
    select: { role: true },
  });
  const isOrgAdmin = membership?.role === "ADMIN";

  // The public MCP URL always lives at `${APP_ORIGIN}/mcp/platform` —
  // Caddy reverse-proxies that prefix to the agent service. The
  // `PLATOS_AGENT_*_URL` envs are for internal service traffic and
  // resolve to `http://agent:3100`, unreachable from the operator's
  // laptop.
  const publicOrigin =
    process.env.PLATOS_AGENT_PUBLIC_API_URL ||
    process.env.APP_ORIGIN ||
    "http://localhost:3030";
  const mcpUrl = `${publicOrigin.replace(/\/+$/, "")}/mcp/platform`;

  return typedjson({ tokens, mcpUrl, isOrgAdmin });
}

type ActionResult =
  | {
      ok: true;
      minted: {
        id: string;
        token: string;
        name: string;
        permissions: string[];
        expiresAt: string | null;
      };
    }
  | { ok: true; revoked: string }
  | { error: string };

export async function action({ params, request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return { error: "project not found" };
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return { error: "environment not found" };

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");
  if (intent === "mint") {
    const name = String(fd.get("name") || "").trim();
    const permsRaw = String(fd.get("permissions") || "").trim();
    const ttlDays = parseInt(String(fd.get("ttlDays") || "90"), 10);
    if (!name) return { error: "name is required" };
    const permissions = permsRaw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (permissions.length === 0) {
      return { error: "at least one permission pattern is required (use `*` for all)" };
    }
    const ttlSeconds = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400 : 0;
    // K.18 — optional admin tier. Agent-side check enforces org ADMIN.
    const tier = fd.get("tier") === "admin" ? "admin" : "scope";
    const minted = await agentFetch<{
      id: string;
      token: string;
      name: string;
      permissions: string[];
      tier?: "scope" | "admin";
      expiresAt: string | null;
    }>("/mcp/platform/tokens", scope, {
      method: "POST",
      body: { name, permissions, ttlSeconds, tier },
    });
    if (!minted) return { error: "mint failed (admin-tier requires org ADMIN role)" };
    return { ok: true as const, minted };
  }
  if (intent === "revoke") {
    const id = String(fd.get("id") || "");
    if (!id) return { error: "id missing" };
    const res = await agentFetch<{ ok: boolean }>(
      `/mcp/platform/tokens/${encodeURIComponent(id)}/revoke`,
      scope,
      { method: "POST", body: {} },
    );
    if (!res?.ok) return { error: "revoke failed" };
    return { ok: true as const, revoked: id };
  }
  return { error: `unknown intent: ${intent}` };
}

function formatDate(d: string | null): string {
  return d ? new Date(d).toLocaleString() : "—";
}

export default function McpTokensTab() {
  const { tokens, mcpUrl, isOrgAdmin } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const [copied, setCopied] = useState(false);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  const newlyMinted =
    actionData && "minted" in actionData ? actionData.minted : null;

  const claudeConfig = newlyMinted
    ? JSON.stringify(
        {
          mcpServers: {
            platos: {
              url: mcpUrl,
              transport: "sse",
              headers: {
                Authorization: `Bearer ${newlyMinted.token}`,
              },
            },
          },
        },
        null,
        2,
      )
    : null;

  return (
    <div>
      <Paragraph>
        Platos exposes a Platform MCP server at <code>{mcpUrl}</code>. Mint a
        token here and paste the JSON below into Claude Desktop (or any MCP
        client) to let it manage this scope&apos;s agents, threads, memories,
        skills, and Trigger runs. Tokens are pinned to the current scope at
        mint — they cannot be used against other orgs / projects / envs.
      </Paragraph>

      {newlyMinted && claudeConfig && (
        <div
          style={{
            marginTop: 16,
            padding: 16,
            borderRadius: 8,
            border: "1px solid #6366f1",
            background: "rgba(99, 102, 241, 0.1)",
          }}
        >
          <Header3>Token minted — save this now</Header3>
          <Paragraph>
            This token value won&apos;t be shown again. Copy it into your
            client config (Claude Desktop, Cursor, Continue.dev, etc.).
          </Paragraph>
          <pre
            style={{
              marginTop: 8,
              padding: 12,
              borderRadius: 6,
              background: "rgba(0,0,0,0.3)",
              overflowX: "auto",
              fontFamily: "monospace",
              fontSize: 12,
            }}
          >
            {claudeConfig}
          </pre>
          <Button
            variant="secondary/medium"
            onClick={() => copy(claudeConfig)}
          >
            {copied ? "Copied!" : "Copy config"}
          </Button>
        </div>
      )}

      {actionData && "error" in actionData && (
        <Paragraph>
          <span style={{ color: "#ef4444" }}>Error: {actionData.error}</span>
        </Paragraph>
      )}

      <Header2 className="mt-8">Mint a new token</Header2>
      <Form method="post" style={{ display: "grid", gap: 12, maxWidth: 680 }}>
        <input type="hidden" name="intent" value="mint" />
        <label>
          Name
          <input
            name="name"
            required
            maxLength={80}
            placeholder="Alice's laptop"
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #374151",
              marginTop: 4,
            }}
          />
        </label>
        <label>
          Permissions (comma or newline-separated tool patterns; use{" "}
          <code>*</code> for full access)
          <textarea
            name="permissions"
            rows={3}
            defaultValue="agents.*, threads.*, messages.*, monitoring.*, trigger.runs.list, trigger.runs.get, platos.*"
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #374151",
              marginTop: 4,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />
        </label>
        <label>
          TTL (days) — 0 for admin non-expiring token
          <input
            name="ttlDays"
            type="number"
            min={0}
            max={365}
            defaultValue={90}
            style={{
              width: 120,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #374151",
              marginTop: 4,
            }}
          />
        </label>
        {isOrgAdmin && (
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="tier" value="admin" />
            <span>
              <strong>Admin tier (cross-scope)</strong> — grants access to
              cross-scope tools like <code>scopes.list_all</code>,{" "}
              <code>audit.cross_scope_tool_calls</code>, and{" "}
              <code>gdpr.export_user_everywhere</code>. Every non-block call
              from an admin-tier token requires human approval.
            </span>
          </label>
        )}
        <Button variant="primary/medium" type="submit">
          Mint token
        </Button>
      </Form>

      <Header2 className="mt-8">Existing tokens</Header2>
      {tokens.length === 0 ? (
        <Paragraph>No tokens minted yet.</Paragraph>
      ) : (
        <table
          style={{
            marginTop: 8,
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid #374151", textAlign: "left" }}>
              <th style={{ padding: "8px 4px" }}>Name</th>
              <th style={{ padding: "8px 4px" }}>Permissions</th>
              <th style={{ padding: "8px 4px" }}>Created</th>
              <th style={{ padding: "8px 4px" }}>Last used</th>
              <th style={{ padding: "8px 4px" }}>Expires</th>
              <th style={{ padding: "8px 4px" }}>Status</th>
              <th style={{ padding: "8px 4px" }}></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid #1f2937" }}>
                <td style={{ padding: "8px 4px" }}>{t.name}</td>
                <td style={{ padding: "8px 4px", fontFamily: "monospace", fontSize: 11 }}>
                  {t.permissions.join(", ")}
                </td>
                <td style={{ padding: "8px 4px" }}>{formatDate(t.createdAt)}</td>
                <td style={{ padding: "8px 4px" }}>{formatDate(t.lastUsedAt)}</td>
                <td style={{ padding: "8px 4px" }}>{formatDate(t.expiresAt)}</td>
                <td style={{ padding: "8px 4px" }}>
                  {t.revokedAt ? (
                    <span style={{ color: "#ef4444" }}>revoked</span>
                  ) : t.expiresAt && new Date(t.expiresAt).getTime() < Date.now() ? (
                    <span style={{ color: "#f59e0b" }}>expired</span>
                  ) : (
                    <span style={{ color: "#10b981" }}>active</span>
                  )}
                </td>
                <td style={{ padding: "8px 4px" }}>
                  {!t.revokedAt && (
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="intent" value="revoke" />
                      <input type="hidden" name="id" value={t.id} />
                      <button
                        type="submit"
                        style={{
                          color: "#ef4444",
                          background: "transparent",
                          border: "1px solid #ef4444",
                          borderRadius: 4,
                          padding: "4px 8px",
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                      >
                        Revoke
                      </button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
