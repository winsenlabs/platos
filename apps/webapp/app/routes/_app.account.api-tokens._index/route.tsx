/**
 * Theme K.9 — Platos PAT (Personal Access Token) settings page.
 *
 * URL: `/account/api-tokens`
 *
 * Follows the K.7 MCP-tokens page UX:
 *   - list the user's PATs (hash never exposed, obfuscated only)
 *   - "Mint new token" action
 *   - raw token is shown ONCE, right after mint, then gone forever
 *   - revoke per row
 *
 * Distinct from `/account/tokens`, which manages the legacy `tr_pat_`
 * family for the engine / CLI surface. Platos PATs (`plt_pat_...`)
 * authenticate against the full webapp REST API as the minting user.
 */

import {
  Form,
  useActionData,
  type MetaFunction,
} from "@remix-run/react";
import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Button } from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import {
  NavBar,
  PageTitle,
} from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  listPATs,
  mintPAT,
  revokePAT,
  type PATRole,
} from "~/services/patService.server";
import { requireUserId } from "~/services/session.server";

export const meta: MetaFunction = () => {
  return [{ title: "API Tokens | Platos" }];
};

type LoaderRow = {
  id: string;
  name: string;
  role: PATRole;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const rows = await listPATs(userId);
  const tokens: LoaderRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    organizationId: r.organizationId,
    projectId: r.projectId,
    environmentId: r.environmentId,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
  return typedjson({ tokens });
}

type ActionResult =
  | {
      ok: true;
      minted: {
        id: string;
        token: string;
        name: string;
        role: PATRole;
        expiresAt: string | null;
      };
    }
  | { ok: true; revoked: string }
  | { error: string };

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  if (intent === "mint") {
    const name = String(fd.get("name") || "").trim();
    const roleRaw = String(fd.get("role") || "write");
    const role: PATRole =
      roleRaw === "admin" || roleRaw === "read" ? (roleRaw as PATRole) : "write";
    const ttlDaysRaw = parseInt(String(fd.get("ttlDays") || "0"), 10);
    const ttlSeconds =
      Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 ? ttlDaysRaw * 86400 : 0;

    if (!name) {
      return json<ActionResult>({ error: "name is required" }, { status: 400 });
    }
    if (name.length > 80) {
      return json<ActionResult>(
        { error: "name must be 80 chars or fewer" },
        { status: 400 },
      );
    }

    const minted = await mintPAT({
      userId,
      name,
      role,
      ttlSeconds,
    });

    return json<ActionResult>({
      ok: true,
      minted: {
        id: minted.id,
        token: minted.token,
        name: minted.name,
        role: minted.role,
        expiresAt: minted.expiresAt ? minted.expiresAt.toISOString() : null,
      },
    });
  }

  if (intent === "revoke") {
    const id = String(fd.get("id") || "");
    if (!id) {
      return json<ActionResult>({ error: "id is required" }, { status: 400 });
    }
    const res = await revokePAT(id, userId);
    if (!res.ok) {
      return json<ActionResult>(
        { error: "PAT not found or already revoked" },
        { status: 404 },
      );
    }
    return json<ActionResult>({ ok: true, revoked: id });
  }

  return json<ActionResult>({ error: `unknown intent: ${intent}` }, { status: 400 });
}

function formatDate(d: string | null): string {
  return d ? new Date(d).toLocaleString() : "—";
}

function obfuscate(raw: string): string {
  // `plt_pat_xxxx...xxxx` — only used after mint in the "copy this now"
  // panel; we also use this on re-render if the user mints twice.
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 12)}•••${raw.slice(-4)}`;
}

export default function PlatosApiTokensPage() {
  const { tokens } = useTypedLoaderData<typeof loader>();
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

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API Tokens" />
      </NavBar>
      <PageBody>
        <Paragraph>
          Platos API tokens authenticate scripts, CI pipelines, and
          non-interactive callers against the Platos webapp REST API. Each
          token grants the same access as your login session — treat them
          like passwords. Tokens are SHA-256 hashed at rest; the raw value
          is returned once at mint and is not recoverable.
        </Paragraph>

        {newlyMinted && (
          <div
            style={{
              marginTop: 16,
              padding: 16,
              borderRadius: 8,
              border: "1px solid #6366f1",
              background: "rgba(99, 102, 241, 0.1)",
            }}
          >
            <Header3>Token minted — copy it now</Header3>
            <Paragraph>
              This value will not be shown again. Store it in your secrets
              manager immediately.
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
                userSelect: "all",
              }}
            >
              {newlyMinted.token}
            </pre>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button
                variant="secondary/medium"
                onClick={() => copy(newlyMinted.token)}
              >
                {copied ? "Copied!" : "Copy token"}
              </Button>
              <Paragraph>
                <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {obfuscate(newlyMinted.token)}
                </span>
              </Paragraph>
            </div>
          </div>
        )}

        {actionData && "error" in actionData && (
          <Paragraph>
            <span style={{ color: "#ef4444" }}>Error: {actionData.error}</span>
          </Paragraph>
        )}

        <Header2 className="mt-8">Mint a new token</Header2>
        <Form
          method="post"
          style={{ display: "grid", gap: 12, maxWidth: 680 }}
        >
          <input type="hidden" name="intent" value="mint" />
          <label>
            Name
            <input
              name="name"
              required
              maxLength={80}
              placeholder="CI deploy bot"
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
            Role
            <select
              name="role"
              defaultValue="write"
              style={{
                width: 200,
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid #374151",
                marginTop: 4,
              }}
            >
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label>
            TTL (days) — 0 for no expiry
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
              <tr
                style={{
                  borderBottom: "1px solid #374151",
                  textAlign: "left",
                }}
              >
                <th style={{ padding: "8px 4px" }}>Name</th>
                <th style={{ padding: "8px 4px" }}>Role</th>
                <th style={{ padding: "8px 4px" }}>Created</th>
                <th style={{ padding: "8px 4px" }}>Last used</th>
                <th style={{ padding: "8px 4px" }}>Expires</th>
                <th style={{ padding: "8px 4px" }}>Status</th>
                <th style={{ padding: "8px 4px" }} />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const expired =
                  t.expiresAt && new Date(t.expiresAt).getTime() < Date.now();
                return (
                  <tr key={t.id} style={{ borderBottom: "1px solid #1f2937" }}>
                    <td style={{ padding: "8px 4px" }}>{t.name}</td>
                    <td style={{ padding: "8px 4px" }}>{t.role}</td>
                    <td style={{ padding: "8px 4px" }}>{formatDate(t.createdAt)}</td>
                    <td style={{ padding: "8px 4px" }}>{formatDate(t.lastUsedAt)}</td>
                    <td style={{ padding: "8px 4px" }}>{formatDate(t.expiresAt)}</td>
                    <td style={{ padding: "8px 4px" }}>
                      {t.revokedAt ? (
                        <span style={{ color: "#ef4444" }}>revoked</span>
                      ) : expired ? (
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
                );
              })}
            </tbody>
          </table>
        )}
      </PageBody>
    </PageContainer>
  );
}
