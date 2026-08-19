/**
 * OAuth consent UI backed by an opaque, signed, one-time agent transaction.
 * The browser never carries mutable client, redirect, PKCE, scope, entity, or
 * tenancy authority fields.
 */

import {
  json,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { Form, useLoaderData } from "@remix-run/react";
import { env } from "~/env.server";
import { requireUser } from "~/services/session.server";

type IdentityFlow = "platform" | "entity_oidc" | "entity_anonymous" | "entity_bearer";

interface ConsentDetails {
  transaction: string;
  flow: IdentityFlow;
  client: {
    clientId: string;
    clientName: string;
    redirectUri: string;
  };
  entity: {
    entityPk: string;
    entityId: string;
    displayName: string;
    branding: { primaryColor?: string; tagline?: string } | null;
  } | null;
  environment: { id: string; name: string; slug: string };
  effectiveScopes: string[];
}

function agentBase(): string {
  return process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
}

async function loadConsent(transaction: string): Promise<ConsentDetails> {
  const response = await fetch(
    `${agentBase()}/oauth/consent?transaction=${encodeURIComponent(transaction)}`,
    { signal: AbortSignal.timeout(4000) }
  );
  if (!response.ok) {
    throw new Response("Consent transaction is invalid, expired, or already used", {
      status: response.status === 410 ? 410 : 400,
    });
  }
  return response.json() as Promise<ConsentDetails>;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const transaction = url.searchParams.get("transaction");
  if (!transaction) throw new Response("Missing consent transaction", { status: 400 });
  const consent = await loadConsent(transaction);

  if (consent.flow === "platform") {
    try {
      await requireUser(request);
    } catch {
      const redirectTo = `${url.pathname}?transaction=${encodeURIComponent(transaction)}`;
      throw redirect(`/login?${new URLSearchParams({ redirectTo })}`);
    }
  }

  return json(consent);
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const transaction = form.get("transaction");
  const action = form.get("action") === "deny" ? "deny" : "approve";
  if (typeof transaction !== "string" || !transaction) {
    return json({ error: "Missing consent transaction" }, { status: 400 });
  }

  const consent = await loadConsent(transaction);
  let userId = "consent-denied";
  if (action === "approve") {
    if (consent.flow !== "platform") {
      return json({ error: "This consent flow is completed by the entity" }, { status: 400 });
    }
    userId = (await requireUser(request)).id;
  }

  const internalToken = env.PLATOS_INTERNAL_AUTH_TOKEN;
  if (!internalToken) {
    return json({ error: "Internal consent authentication is not configured" }, { status: 503 });
  }
  const response = await fetch(`${agentBase()}/oauth/authorize/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Internal-Token": internalToken,
    },
    body: JSON.stringify({ transaction, userId, action }),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    return json(
      { error: `Consent could not be completed: ${response.status} ${message}` },
      { status: 502 }
    );
  }
  const payload = (await response.json()) as { redirectTo?: string };
  if (!payload.redirectTo) {
    return json({ error: "Consent callback returned no redirect" }, { status: 502 });
  }
  return Response.redirect(payload.redirectTo, 302);
}

function ScopeSummary({ scopes }: { scopes: string[] }) {
  return (
    <div className="rounded border border-charcoal-700 bg-charcoal-900 p-3 text-xs text-charcoal-400">
      Effective scopes: <code className="text-charcoal-200">{scopes.join(" ")}</code>
    </div>
  );
}

export default function OAuthConsent() {
  const consent = useLoaderData<typeof loader>();
  const { flow, client, entity, environment, effectiveScopes, transaction } = consent;
  const accentColor = entity?.branding?.primaryColor ?? "#6366f1";
  const publicAgentBase =
    typeof window !== "undefined"
      ? window.location.origin.replace(":3030", ":3100")
      : "http://localhost:3100";

  if (flow === "entity_oidc" && entity) {
    const oidcUrl = new URL(
      `/oauth/entity/${encodeURIComponent(entity.entityId)}/oidc-redirect`,
      publicAgentBase
    );
    oidcUrl.searchParams.set("transaction", transaction);
    return (
      <ConsentCard title={`Connect to ${entity.displayName}`} accentColor={accentColor}>
        <p className="text-sm text-charcoal-300">
          <strong className="text-white">{client.clientName}</strong> wants to access{" "}
          {entity.displayName} in {environment.name}. You will sign in with the entity provider.
        </p>
        <ScopeSummary scopes={effectiveScopes} />
        <a
          href={oidcUrl.toString()}
          className="flex w-full justify-center rounded-lg px-4 py-3 text-sm font-medium text-white"
          style={{ backgroundColor: accentColor }}
        >
          Sign in with {entity.displayName}
        </a>
        <DenyForm transaction={transaction} />
      </ConsentCard>
    );
  }

  if (flow === "entity_anonymous" && entity) {
    const anonymousUrl = `${publicAgentBase}/oauth/entity/${encodeURIComponent(
      entity.entityId
    )}/authorize/anonymous`;
    return (
      <ConsentCard title={`Connect to ${entity.displayName}`} accentColor={accentColor}>
        <p className="text-sm text-charcoal-300">
          <strong className="text-white">{client.clientName}</strong> will connect anonymously to{" "}
          {entity.displayName} in {environment.name}.
        </p>
        <ScopeSummary scopes={effectiveScopes} />
        <form method="POST" action={anonymousUrl}>
          <input type="hidden" name="transaction" value={transaction} />
          <button
            type="submit"
            className="flex w-full justify-center rounded-lg px-4 py-3 text-sm font-medium text-white"
            style={{ backgroundColor: accentColor }}
          >
            Continue without signing in
          </button>
        </form>
        <DenyForm transaction={transaction} />
      </ConsentCard>
    );
  }

  if (flow === "entity_bearer" && entity) {
    return (
      <ConsentCard title="Bearer authentication" accentColor={accentColor}>
        <p className="text-sm text-charcoal-300">
          {entity.displayName} uses an operator-managed bearer token; no browser authorization is
          available.
        </p>
        <DenyForm transaction={transaction} label="Close" />
      </ConsentCard>
    );
  }

  return (
    <ConsentCard title={`Authorize ${client.clientName}`} accentColor={accentColor} wide>
      <p className="text-sm text-charcoal-300">
        This application wants to access your Platos agents in {environment.name}.
      </p>
      <ScopeSummary scopes={effectiveScopes} />
      <Form method="post" className="flex justify-end gap-2">
        <input type="hidden" name="transaction" value={transaction} />
        <button
          type="submit"
          name="action"
          value="deny"
          className="rounded border border-charcoal-600 px-4 py-2 text-sm text-charcoal-200"
        >
          Deny
        </button>
        <button
          type="submit"
          name="action"
          value="approve"
          className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
        >
          Authorize
        </button>
      </Form>
    </ConsentCard>
  );
}

function DenyForm({ transaction, label = "Cancel" }: { transaction: string; label?: string }) {
  return (
    <Form method="post">
      <input type="hidden" name="transaction" value={transaction} />
      <button
        type="submit"
        name="action"
        value="deny"
        className="flex w-full justify-center rounded-lg border border-charcoal-600 px-4 py-2 text-sm text-charcoal-300"
      >
        {label}
      </button>
    </Form>
  );
}

function ConsentCard({
  title,
  accentColor,
  wide = false,
  children,
}: {
  title: string;
  accentColor: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`mx-auto flex min-h-screen ${wide ? "max-w-xl" : "max-w-sm"} items-center p-6`}>
      <div className="w-full space-y-5 rounded-xl border border-charcoal-700 bg-charcoal-800 p-8 shadow-xl">
        <h1 className="text-lg font-semibold text-white" style={{ color: accentColor }}>
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}
