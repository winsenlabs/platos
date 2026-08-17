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
import { useState, type CSSProperties } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Button } from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { verifyProjectAccess } from "~/services/platos/scopeVerify.server";
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

// MCPF-K.22 — full tool catalog that powers the visual permission
// picker. Served by the agent at GET /mcp/platform/catalog.
type CatalogTool = {
  name: string;
  description: string;
  requiresAdminTier: boolean;
};
type CatalogCategory = {
  category: string;
  count: number;
  adminTier: boolean;
  tools: CatalogTool[];
};
type Catalog = {
  totalTools: number;
  totalCategories: number;
  categories: CatalogCategory[];
};

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);
  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404 });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404 });
  if (
    !(await verifyProjectAccess(
      { organizationId: project.organizationId, projectId: project.id },
      userId,
      "read",
    ))
  ) {
    throw new Response("Forbidden", { status: 403 });
  }

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

  // MCPF-K.22 — the full tool catalog feeds the visual permission
  // picker. If the agent is unreachable we fall back to an empty catalog
  // and the UI degrades to a plain free-text patterns box.
  const catalogRes = await agentFetch<Catalog>("/mcp/platform/catalog", scope);
  const catalog: Catalog =
    catalogRes ?? { totalTools: 0, totalCategories: 0, categories: [] };

  // K.18 — Project ADMIN and Organization OWNER/ADMIN can mint either tier.
  // Agent-side canonical membership enforcement remains authoritative.
  const membership = await prisma.organizationMembership.findFirst({
    where: { organizationId: project.organizationId, userId, deactivatedAt: null },
    select: { id: true, role: true },
  });
  const projectMembership = membership
    ? await prisma.projectMembership.findUnique({
        where: {
          projectId_organizationMembershipId: {
            projectId: project.id,
            organizationMembershipId: membership.id,
          },
        },
        select: { role: true },
      })
    : null;
  const isOrgAdmin =
    membership?.role === "OWNER" ||
    membership?.role === "ADMIN" ||
    projectMembership?.role === "ADMIN";

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

  return typedjson({ tokens, mcpUrl, isOrgAdmin, catalog });
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
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) return { error: "environment not found" };
  if (
    !(await verifyProjectAccess(
      { organizationId: project.organizationId, projectId: project.id },
      userId,
      "mutate",
    ))
  ) {
    throw new Response("Forbidden", { status: 403 });
  }

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
  const { tokens, mcpUrl, isOrgAdmin, catalog } =
    useTypedLoaderData<typeof loader>();
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
              // Streamable HTTP — the agent serves JSON-RPC at this path
              // (via Caddy). `transport: "sse"` was wrong: the SSE
              // transport lives at `/mcp/platform/sse`, and modern MCP
              // clients (Claude Code/Desktop, Cursor) want `type: "http"`.
              type: "http",
              url: mcpUrl,
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
      <MintTokenForm catalog={catalog} isOrgAdmin={isOrgAdmin} />

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

// ── MCPF-K.22 — visual permission picker ────────────────────────────
// Replaces the free-text "permissions" textarea. The operator toggles
// tool categories (or picks a preset) and we emit the SAME `category.*`
// / exact tool-name patterns that PlatosMCPTokenService.allows()
// matches — the permission engine is unchanged; this is pure UX over
// the wildcard model.

const READ_VERBS = new Set([
  "list", "get", "census", "explain", "diff", "simulate", "whoami",
  "search", "traverse", "nodes", "overview",
]);

/**
 * Best-effort: is this a read-only tool? Deliberately conservative —
 * under-grants rather than risk sweeping a mutation into the read-only
 * preset. The operator sees the resolved patterns before minting.
 */
function isReadTool(name: string): boolean {
  const seg = name.split(".").pop() || name;
  if (READ_VERBS.has(seg)) return true;
  if (/^(list|get)_/.test(seg)) return true;
  if (/_(daily|range|stats|list|get)$/.test(seg)) return true;
  return false;
}

type Preset = "readonly" | "operator" | "full" | "admin";

function MintTokenForm({
  catalog,
  isOrgAdmin,
}: {
  catalog: Catalog;
  isOrgAdmin: boolean;
}) {
  const categories = catalog.categories;
  const nonAdmin = categories.filter((c) => !c.adminTier);
  const totalNonAdmin = nonAdmin.reduce((n, c) => n + c.count, 0);

  const [full, setFull] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [adminTier, setAdminTier] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(nonAdmin.map((c) => c.category)),
  );
  const [showPatterns, setShowPatterns] = useState(false);

  const readCount = (c: CatalogCategory) =>
    c.tools.filter((t) => isReadTool(t.name)).length;

  // The permission strings we'll POST — the wildcard grammar the agent's
  // allows() understands (`*`, exact name, `category.*`).
  const permissions: string[] = full
    ? ["*"]
    : categories.flatMap((c) => {
        if (c.adminTier && !adminTier) return [];
        if (!checked.has(c.category)) return [];
        return readOnly
          ? c.tools.filter((t) => isReadTool(t.name)).map((t) => t.name)
          : [`${c.category}.*`];
      });

  // Live "sees N tools" preview. `*` grants everything, but admin-tier
  // tools stay blocked at the tools/call tier gate unless this is an
  // admin token — reflect that in the count.
  const seesCount = full
    ? adminTier
      ? catalog.totalTools
      : totalNonAdmin
    : categories.reduce((n, c) => {
        if (c.adminTier && !adminTier) return n;
        if (!checked.has(c.category)) return n;
        return n + (readOnly ? readCount(c) : c.count);
      }, 0);

  const selectedCatCount = full
    ? adminTier
      ? categories.length
      : nonAdmin.length
    : categories.filter(
        (c) => checked.has(c.category) && (!c.adminTier || adminTier),
      ).length;

  function applyPreset(p: Preset) {
    if (p === "readonly") {
      setFull(false);
      setReadOnly(true);
      setAdminTier(false);
      setChecked(new Set(nonAdmin.map((c) => c.category)));
    } else if (p === "operator") {
      setFull(false);
      setReadOnly(false);
      setAdminTier(false);
      setChecked(new Set(nonAdmin.map((c) => c.category)));
    } else if (p === "full") {
      setFull(true);
      setReadOnly(false);
      setAdminTier(false);
    } else if (p === "admin") {
      setFull(true);
      setReadOnly(false);
      setAdminTier(true);
    }
  }

  function toggleCategory(cat: string) {
    setFull(false);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  // Degraded fallback — agent unreachable, empty catalog. Keep the plain
  // textarea so token minting still works.
  const noCatalog = categories.length === 0;

  return (
    <Form method="post" style={{ display: "grid", gap: 14, maxWidth: 760 }}>
      <input type="hidden" name="intent" value="mint" />
      <input
        type="hidden"
        name="tier"
        value={adminTier && isOrgAdmin ? "admin" : "scope"}
      />
      {!noCatalog && (
        <input type="hidden" name="permissions" value={permissions.join(",")} />
      )}

      <label>
        Name
        <input
          name="name"
          required
          maxLength={80}
          placeholder="Alice's laptop"
          style={inputStyle}
        />
      </label>

      {noCatalog ? (
        <label>
          Permissions (comma / newline-separated patterns; <code>*</code> = all)
          <textarea
            name="permissions"
            rows={3}
            defaultValue="agents.*, threads.*, messages.*, monitoring.*, platos.*"
            style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12 }}
          />
        </label>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {/* Presets */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#9ca3af" }}>Preset:</span>
            <PresetChip label="Read-only" onClick={() => applyPreset("readonly")} active={!full && readOnly} />
            <PresetChip label="Operator" onClick={() => applyPreset("operator")} active={!full && !readOnly} />
            <PresetChip label="Full access (*)" onClick={() => applyPreset("full")} active={full && !adminTier} />
            {isOrgAdmin && (
              <PresetChip label="Admin (cross-scope)" onClick={() => applyPreset("admin")} active={full && adminTier} />
            )}
          </div>

          {/* Live preview */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 6,
              background: "rgba(99,102,241,0.08)",
              border: "1px solid rgba(99,102,241,0.35)",
              fontSize: 13,
            }}
          >
            <strong style={{ color: "#a5b4fc" }}>
              This token will see {seesCount} tool{seesCount === 1 ? "" : "s"}
            </strong>
            <span style={{ color: "#9ca3af" }}>
              across {selectedCatCount} categor{selectedCatCount === 1 ? "y" : "ies"}
              {readOnly && " · read-only"}
              {full && " · full access"}
            </span>
            <button type="button" onClick={() => setShowPatterns((s) => !s)} style={linkBtnStyle}>
              {showPatterns ? "hide" : "show"} patterns
            </button>
          </div>

          {showPatterns && (
            <pre style={patternsStyle}>
              {permissions.length ? permissions.join("\n") : "(none selected)"}
            </pre>
          )}

          {/* Category grid — dimmed + inert while a `*` preset is on */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 8,
              opacity: full ? 0.5 : 1,
              pointerEvents: full ? "none" : "auto",
            }}
          >
            {nonAdmin.map((c) => (
              <CategoryCard
                key={c.category}
                category={c}
                checked={checked.has(c.category)}
                count={readOnly ? readCount(c) : c.count}
                readOnly={readOnly}
                onToggle={() => toggleCategory(c.category)}
              />
            ))}
          </div>

          {/* Admin-tier section — org admins only */}
          {isOrgAdmin && categories.some((c) => c.adminTier) && (
            <div
              style={{
                marginTop: 4,
                padding: 12,
                borderRadius: 6,
                border: "1px solid #7c2d12",
                background: "rgba(124,45,18,0.12)",
              }}
            >
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={adminTier}
                  onChange={(e) => {
                    setAdminTier(e.target.checked);
                    if (e.target.checked) setFull(false);
                  }}
                />
                <span style={{ fontSize: 13 }}>
                  <strong style={{ color: "#fca5a5" }}>Admin tier (cross-scope)</strong>{" "}
                  — unlocks{" "}
                  {categories.filter((c) => c.adminTier).map((c) => c.category).join(", ")}.
                  Every non-read call from an admin-tier token requires human
                  approval.
                </span>
              </label>
              {adminTier && !full && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                    gap: 8,
                    marginTop: 10,
                  }}
                >
                  {categories
                    .filter((c) => c.adminTier)
                    .map((c) => (
                      <CategoryCard
                        key={c.category}
                        category={c}
                        checked={checked.has(c.category)}
                        count={readOnly ? readCount(c) : c.count}
                        readOnly={readOnly}
                        onToggle={() => toggleCategory(c.category)}
                      />
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <label>
        TTL (days) — 0 for a non-expiring token
        <input
          name="ttlDays"
          type="number"
          min={0}
          max={365}
          defaultValue={90}
          style={{ ...inputStyle, width: 120 }}
        />
      </label>

      <Button variant="primary/medium" type="submit">
        Mint token
      </Button>
    </Form>
  );
}

function PresetChip({
  label,
  onClick,
  active,
}: {
  label: string;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        cursor: "pointer",
        border: active ? "1px solid #6366f1" : "1px solid #374151",
        background: active ? "rgba(99,102,241,0.18)" : "transparent",
        color: active ? "#c7d2fe" : "#d1d5db",
      }}
    >
      {label}
    </button>
  );
}

function CategoryCard({
  category,
  checked,
  count,
  readOnly,
  onToggle,
}: {
  category: CatalogCategory;
  checked: boolean;
  count: number;
  readOnly: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={category.tools.map((t) => t.name).join("\n")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 6,
        cursor: "pointer",
        textAlign: "left",
        border: checked ? "1px solid #10b981" : "1px solid #374151",
        background: checked ? "rgba(16,185,129,0.1)" : "transparent",
        color: "#e5e7eb",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={checked} readOnly tabIndex={-1} />
        <span style={{ fontFamily: "monospace", fontSize: 13 }}>{category.category}</span>
      </span>
      <span
        style={{
          fontSize: 11,
          color: checked ? "#6ee7b7" : "#9ca3af",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
        {readOnly ? " read" : ""}
      </span>
    </button>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #374151",
  marginTop: 4,
};

const linkBtnStyle: CSSProperties = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  color: "#93c5fd",
  cursor: "pointer",
  fontSize: 12,
  textDecoration: "underline",
};

const patternsStyle: CSSProperties = {
  margin: 0,
  padding: 10,
  borderRadius: 6,
  background: "rgba(0,0,0,0.3)",
  fontFamily: "monospace",
  fontSize: 11,
  color: "#d1d5db",
  maxHeight: 160,
  overflowY: "auto",
};
