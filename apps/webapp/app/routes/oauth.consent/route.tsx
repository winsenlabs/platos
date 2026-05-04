/**
 * Theme K.10 — OAuth 2.1 + DCR consent screen.
 *
 * Three distinct flows depending on context:
 *
 * 1. Platform OAuth (no entity_id) — Platos-user logs in, picks org/project/env scope.
 *    Submits to /oauth/authorize/callback.
 *
 * 2. Entity OIDC (entity_id + identityMode includes "oidc") — "Sign in with [Entity]"
 *    button. Redirects to /oauth/entity/:entityId/oidc-redirect which bounces the user
 *    to the entity's own OAuth server. Entity backend owns all auth (Google, email, etc.).
 *
 * 3. Entity anonymous (entity_id + identityMode includes "anonymous") — "Continue without
 *    signing in" button. Posts to /oauth/entity/:entityId/authorize/anonymous which mints
 *    a PlatosMcpAnonSession and returns an auth code directly.
 *
 * The entity_id, entity_pk, organization_id, project_id query params are injected by
 * /oauth/entity/:entityId/authorize on the agent side.
 */

import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Form, useLoaderData } from "@remix-run/react";
import * as crypto from "node:crypto";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireUser } from "~/services/session.server";

interface ConsentScope {
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentLabel: string;
  value: string;
}

type IdentityFlow = "platform" | "entity_oidc" | "entity_anonymous" | "entity_bearer";

interface LoaderData {
  flow: IdentityFlow;
  client: {
    clientId: string;
    clientName: string;
    redirectUri: string;
  };
  entity: {
    entityId: string;
    entityPk: string;
    organizationId: string;
    projectId: string;
    displayName: string;
    branding: { primaryColor?: string; tagline?: string } | null;
  } | null;
  scopes: ConsentScope[];
  query: {
    client_id: string;
    redirect_uri: string;
    state: string | undefined;
    scope: string | undefined;
    code_challenge: string;
    code_challenge_method: string;
  };
}

function requireQueryParam(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (!v) throw new Response(`Missing query param: ${name}`, { status: 400 });
  return v;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  const clientIdParam = requireQueryParam(url, "client_id");
  const redirectUriParam = requireQueryParam(url, "redirect_uri");
  const codeChallenge = requireQueryParam(url, "code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
  const scope = url.searchParams.get("scope") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;

  // Entity-scoped params — injected by entityAuthorize on the agent.
  const entityId = url.searchParams.get("entity_id") ?? null;
  const entityPk = url.searchParams.get("entity_pk") ?? null;
  const organizationId = url.searchParams.get("organization_id") ?? null;
  const projectId = url.searchParams.get("project_id") ?? null;

  const client = await prisma.platosOAuthClient.findUnique({
    where: { clientId: clientIdParam },
    select: { clientId: true, clientName: true, redirectUris: true, deletedAt: true },
  });
  if (!client) throw new Response("Unknown client_id", { status: 400 });
  // MCPF-W3 — soft-deleted clients can't mint new tokens; reject at consent
  // before the user wastes time approving.
  if (client.deletedAt) throw new Response("Client has been deleted", { status: 400 });
  if (!client.redirectUris.includes(redirectUriParam)) {
    throw new Response("redirect_uri not registered for this client", { status: 400 });
  }

  const queryShape = {
    client_id: clientIdParam,
    redirect_uri: redirectUriParam,
    state,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
  };

  // ── Entity flows (OIDC / anonymous) ──────────────────────────────────
  if (entityId && entityPk && organizationId && projectId) {
    // Fetch identity mode + branding from the agent backend.
    let identityMode = "bearer";
    let branding: { primaryColor?: string; tagline?: string } | null = null;
    let displayName = entityId;
    try {
      const agentBase = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const cfgRes = await fetch(
        `${agentBase}/mcp/entity/${encodeURIComponent(entityId)}/config`,
        {
          headers: {
            "X-Platos-Organization-Id": organizationId,
            "X-Platos-Project-Id": projectId,
            "X-Platos-Environment-Id": "mcp",
            "X-Platos-User-Id": "consent-loader",
          },
          signal: AbortSignal.timeout(4000),
        }
      );
      if (cfgRes.ok) {
        const data = (await cfgRes.json()) as {
          config?: { identityMode?: string; branding?: Record<string, unknown> };
          entityId?: string;
        };
        identityMode = (data.config?.identityMode as string) ?? "bearer";
        branding = (data.config?.branding as { primaryColor?: string; tagline?: string } | null) ?? null;
        displayName = (data.entityId as string) ?? entityId;
      }
    } catch {
      // Proceed with defaults if agent unreachable.
    }

    const modes = identityMode.split("+").map((m) => m.trim());
    let flow: IdentityFlow = "entity_bearer";
    if (modes.includes("oidc")) flow = "entity_oidc";
    else if (modes.includes("anonymous")) flow = "entity_anonymous";

    return json<LoaderData>({
      flow,
      client: {
        clientId: client.clientId,
        clientName: client.clientName,
        redirectUri: redirectUriParam,
      },
      entity: {
        entityId,
        entityPk,
        organizationId,
        projectId,
        displayName,
        branding,
      },
      scopes: [],
      query: queryShape,
    });
  }

  // ── Platform flow — requires logged-in Platos user ────────���──────────
  let user;
  try {
    user = await requireUser(request);
  } catch {
    const searchParams = new URLSearchParams([["redirectTo", `${url.pathname}${url.search}`]]);
    throw redirect(`/login?${searchParams}`);
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId: user.id },
    select: {
      organization: {
        select: {
          id: true,
          title: true,
          projects: {
            where: { deletedAt: null },
            select: {
              id: true,
              name: true,
              environments: {
                select: {
                  id: true,
                  slug: true,
                  type: true,
                  orgMember: { select: { userId: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const scopes: ConsentScope[] = [];
  for (const m of memberships) {
    for (const project of m.organization.projects) {
      for (const envRow of project.environments) {
        if (envRow.orgMember && envRow.orgMember.userId !== user.id) continue;
        scopes.push({
          organizationId: m.organization.id,
          organizationName: m.organization.title,
          projectId: project.id,
          projectName: project.name,
          environmentId: envRow.id,
          environmentLabel: `${envRow.slug} (${envRow.type.toLowerCase()})`,
          value: `${m.organization.id}|${project.id}|${envRow.id}`,
        });
      }
    }
  }

  return json<LoaderData>({
    flow: "platform",
    client: {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: redirectUriParam,
    },
    entity: null,
    scopes,
    query: queryShape,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const action = form.get("action") as string;
  const clientId = form.get("client_id") as string;
  const redirectUri = form.get("redirect_uri") as string;
  const codeChallenge = form.get("code_challenge") as string;
  const scope = form.get("scope") as string | null;
  const state = form.get("state") as string | null;
  const scopeValue = form.get("scope_tuple") as string | null;

  if (!clientId || !redirectUri || !codeChallenge) {
    return json({ error: "Missing required fields" }, { status: 400 });
  }

  if (action === "deny") {
    const r = new URL(redirectUri);
    r.searchParams.set("error", "access_denied");
    r.searchParams.set("error_description", "User denied the authorization request.");
    if (state) r.searchParams.set("state", state);
    return Response.redirect(r.toString(), 302);
  }

  if (!scopeValue || !scopeValue.includes("|")) {
    return json({ error: "Select a scope to authorize" }, { status: 400 });
  }
  const [organizationId, projectId, environmentId] = scopeValue.split("|");
  if (!organizationId || !projectId || !environmentId) {
    return json({ error: "Invalid scope" }, { status: 400 });
  }

  const secret = env.PLATOS_SESSION_SECRET;
  if (!secret) {
    return json({ error: "PLATOS_SESSION_SECRET not configured on webapp" }, { status: 500 });
  }

  const ts = Math.floor(Date.now() / 1000);
  const canonical = [
    clientId,
    redirectUri,
    user.id,
    organizationId,
    projectId,
    environmentId,
    codeChallenge,
    scope ?? "",
    state ?? "",
    String(ts),
  ].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(canonical).digest("base64url");

  const agentBase = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const resp = await fetch(`${agentBase}/oauth/authorize/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Consent-Signature": signature,
    },
    body: JSON.stringify({
      clientId,
      redirectUri,
      userId: user.id,
      organizationId,
      projectId,
      environmentId,
      codeChallenge,
      codeChallengeMethod: "S256",
      ...(scope ? { scope } : {}),
      ...(state ? { state } : {}),
      ts,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return json({ error: `Agent callback failed: ${resp.status} ${text}` }, { status: 502 });
  }
  const payload = (await resp.json()) as { redirectTo?: string };
  if (!payload.redirectTo) {
    return json({ error: "Agent callback returned no redirect" }, { status: 502 });
  }
  return Response.redirect(payload.redirectTo, 302);
}

export default function OAuthConsent() {
  const data = useLoaderData<typeof loader>();
  const { flow, client, entity, query } = data;

  const agentBase =
    typeof window !== "undefined"
      ? window.location.origin.replace(":3030", ":3100")
      : "http://localhost:3100";

  const accentColor = entity?.branding?.primaryColor ?? "#6366f1";

  // ── Entity OIDC flow ──────────────────────────────────────────────────
  if (flow === "entity_oidc" && entity) {
    const oidcRedirectUrl = new URL(
      `/oauth/entity/${encodeURIComponent(entity.entityId)}/oidc-redirect`,
      agentBase,
    );
    oidcRedirectUrl.searchParams.set("client_id", query.client_id);
    oidcRedirectUrl.searchParams.set("redirect_uri", query.redirect_uri);
    oidcRedirectUrl.searchParams.set("code_challenge", query.code_challenge);
    oidcRedirectUrl.searchParams.set("code_challenge_method", query.code_challenge_method);
    if (query.scope) oidcRedirectUrl.searchParams.set("scope", query.scope);
    if (query.state) oidcRedirectUrl.searchParams.set("state", query.state);

    return (
      <div className="mx-auto flex min-h-screen max-w-sm items-center justify-center p-6">
        <div className="w-full rounded-xl border border-charcoal-700 bg-charcoal-800 p-8 shadow-xl text-center space-y-6">
          <div>
            <div
              className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-white text-xl font-bold"
              style={{ backgroundColor: accentColor }}
            >
              {entity.displayName.slice(0, 1).toUpperCase()}
            </div>
            <h1 className="text-lg font-semibold text-white">
              Connect to <span style={{ color: accentColor }}>{entity.displayName}</span>
            </h1>
            {entity.branding?.tagline && (
              <p className="mt-1 text-sm text-charcoal-400">{entity.branding.tagline}</p>
            )}
          </div>

          <p className="text-sm text-charcoal-300">
            <strong className="text-white">{client.clientName}</strong> wants to access{" "}
            <strong style={{ color: accentColor }}>{entity.displayName}</strong> on your behalf.
            You will be redirected to sign in with your existing account.
          </p>

          <div className="text-xs text-charcoal-500 rounded border border-charcoal-700 bg-charcoal-900 p-2">
            Redirect back to:{" "}
            <code className="text-charcoal-300">{client.redirectUri}</code>
          </div>

          <div className="space-y-2">
            <a
              href={oidcRedirectUrl.toString()}
              className="flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: accentColor }}
            >
              Sign in with {entity.displayName}
            </a>
            <a
              href={`${query.redirect_uri}?error=access_denied${query.state ? `&state=${encodeURIComponent(query.state)}` : ""}`}
              className="flex w-full items-center justify-center rounded-lg border border-charcoal-600 px-4 py-2 text-sm text-charcoal-300 hover:bg-charcoal-700"
            >
              Cancel
            </a>
          </div>
        </div>
      </div>
    );
  }

  // ── Entity anonymous flow ─────────────────────────────────────────────
  if (flow === "entity_anonymous" && entity) {
    const anonUrl = `${agentBase}/oauth/entity/${encodeURIComponent(entity.entityId)}/authorize/anonymous`;

    return (
      <div className="mx-auto flex min-h-screen max-w-sm items-center justify-center p-6">
        <div className="w-full rounded-xl border border-charcoal-700 bg-charcoal-800 p-8 shadow-xl text-center space-y-6">
          <div>
            <div
              className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-white text-xl font-bold"
              style={{ backgroundColor: accentColor }}
            >
              {entity.displayName.slice(0, 1).toUpperCase()}
            </div>
            <h1 className="text-lg font-semibold text-white">
              Connect to <span style={{ color: accentColor }}>{entity.displayName}</span>
            </h1>
          </div>

          <p className="text-sm text-charcoal-300">
            <strong className="text-white">{client.clientName}</strong> wants to access{" "}
            <strong style={{ color: accentColor }}>{entity.displayName}</strong>. No account
            required — you will be connected as an anonymous session.
          </p>

          <form method="POST" action={anonUrl} className="space-y-2">
            <input type="hidden" name="client_id" value={query.client_id} />
            <input type="hidden" name="redirect_uri" value={query.redirect_uri} />
            <input type="hidden" name="code_challenge" value={query.code_challenge} />
            <input type="hidden" name="code_challenge_method" value={query.code_challenge_method} />
            {query.scope && <input type="hidden" name="scope" value={query.scope} />}
            {query.state && <input type="hidden" name="state" value={query.state} />}
            <button
              type="submit"
              className="flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: accentColor }}
            >
              Continue without signing in
            </button>
          </form>
          <a
            href={`${query.redirect_uri}?error=access_denied${query.state ? `&state=${encodeURIComponent(query.state)}` : ""}`}
            className="flex w-full items-center justify-center rounded-lg border border-charcoal-600 px-4 py-2 text-sm text-charcoal-300 hover:bg-charcoal-700"
          >
            Cancel
          </a>
        </div>
      </div>
    );
  }

  // ─�� Entity bearer — bearer tokens are operator-managed, not user-facing ──
  if (flow === "entity_bearer" && entity) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm items-center justify-center p-6">
        <div className="w-full rounded-xl border border-charcoal-700 bg-charcoal-800 p-8 shadow-xl text-center space-y-4">
          <h1 className="text-lg font-semibold text-white">Bearer authentication</h1>
          <p className="text-sm text-charcoal-300">
            <strong style={{ color: accentColor }}>{entity.displayName}</strong> uses bearer
            token authentication. Your administrator will provide a Personal Access Token to
            configure in{" "}
            <strong className="text-white">{client.clientName}</strong>. No browser login is
            required.
          </p>
          <a
            href={`${query.redirect_uri}?error=access_denied${query.state ? `&state=${encodeURIComponent(query.state)}` : ""}`}
            className="inline-block rounded border border-charcoal-600 px-4 py-2 text-sm text-charcoal-300 hover:bg-charcoal-700"
          >
            Close
          </a>
        </div>
      </div>
    );
  }

  // ── Platform flow (default) ───────────────────────────────────────────
  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center p-6">
      <div className="w-full rounded-lg border border-charcoal-700 bg-charcoal-800 p-8 shadow-xl">
        <h1 className="text-xl font-semibold text-white">
          Authorize <span className="text-indigo-400">{client.clientName}</span>
        </h1>
        <p className="mt-2 text-sm text-charcoal-300">
          This application wants to access your Platos agents on your behalf. It will be able to
          call tools and read conversation history for the scope you select below.
        </p>

        <Form method="post" className="mt-6 space-y-4">
          <input type="hidden" name="client_id" value={query.client_id} />
          <input type="hidden" name="redirect_uri" value={query.redirect_uri} />
          <input type="hidden" name="code_challenge" value={query.code_challenge} />
          {query.scope ? <input type="hidden" name="scope" value={query.scope} /> : null}
          {query.state ? <input type="hidden" name="state" value={query.state} /> : null}

          <label className="block text-sm text-charcoal-200">
            Select scope (org / project / environment):
            <select
              name="scope_tuple"
              required
              className="mt-1 block w-full rounded border border-charcoal-600 bg-charcoal-900 px-3 py-2 text-white"
            >
              <option value="">— pick one —</option>
              {data.scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.organizationName} / {s.projectName} / {s.environmentLabel}
                </option>
              ))}
            </select>
          </label>

          <div className="rounded border border-charcoal-700 bg-charcoal-900 p-3 text-xs text-charcoal-400">
            Redirect: <code className="text-charcoal-200">{client.redirectUri}</code>
            <br />
            Requested scopes:{" "}
            <code className="text-charcoal-200">{query.scope ?? "mcp:read mcp:write"}</code>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              name="action"
              value="deny"
              className="rounded border border-charcoal-600 px-4 py-2 text-sm text-charcoal-200 hover:bg-charcoal-700"
            >
              Deny
            </button>
            <button
              type="submit"
              name="action"
              value="allow"
              className="rounded bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400"
            >
              Authorize
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
}
