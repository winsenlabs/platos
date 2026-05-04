/**
 * Initial-secret render page (PPR-70).
 *
 * The `agent-entities/new` action flashes the plaintext service secret
 * into Redis via `storeInitialSecret()` and redirects here with a
 * short-lived `?token=<T>` query param. The loader consumes the token
 * (atomic `GETDEL`) so the secret is rendered exactly once and never
 * reachable via refresh, back button, or cache.
 *
 * The `Cache-Control: no-store` headers on the loader response make
 * sure no intermediary, no browser bfcache, and no disk cache retains
 * the rendered HTML. Once the token is consumed, every subsequent hit
 * on this URL renders the "Secret already shown" fallback and points
 * the operator at the Regenerate button.
 *
 * See `apps/webapp/app/services/initialSecretStorage.server.ts` for
 * the storage contract and rationale.
 */

import {
  CheckCircleIcon,
  ClipboardIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { consumeInitialSecret } from "~/services/initialSecretStorage.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Initial Secret | Platos" }];

// Applied via the loader's `headers` return so the "copy once" page is
// never cacheable — browser, CDN, or bfcache.
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUserId(request);
  EnvironmentParamSchema.parse(params);
  const entityId = params.entityId!;

  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  const plaintext = token ? await consumeInitialSecret(token) : null;

  const agentWsUrl =
    process.env.PLATOS_AGENT_PUBLIC_WS_URL ||
    process.env.PLATOS_AGENT_API_URL ||
    "http://localhost:3100";

  return typedjson(
    {
      entityId,
      plaintextSecret: plaintext,
      agentWsUrl,
    },
    { headers: NO_STORE_HEADERS },
  );
}

export const headers = () => NO_STORE_HEADERS;

export default function InitialSecretPage() {
  const { entityId, plaintextSecret, agentWsUrl } = useTypedLoaderData<typeof loader>();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {}
  };

  if (!plaintextSecret) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle
            title="Secret already shown"
            icon={<ExclamationTriangleIcon className="size-5 text-amber-400" />}
          />
        </NavBar>
        <PageBody>
          <div className="max-w-2xl space-y-4">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 flex items-start gap-2">
              <ExclamationTriangleIcon className="size-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-300">
                  This initial-secret link has already been consumed (or has
                  expired).
                </p>
                <p className="text-amber-200/80 mt-1">
                  Platos shows a newly-minted service secret exactly once.
                  If you didn't capture it in time, open the entity detail
                  page and use the Regenerate button to mint a fresh one —
                  the old secret becomes invalid the moment you regenerate.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <LinkButton to=".." relative="path" variant="primary/medium">
                Open Entity Details
              </LinkButton>
              <LinkButton to="../.." relative="path" variant="tertiary/medium">
                Back to list
              </LinkButton>
            </div>
          </div>
        </PageBody>
      </PageContainer>
    );
  }

  const wsUrl = agentWsUrl.replace(/^http/, "ws") + "/tools/sync";
  const tsSnippet = `import { connectTools } from "@platos/platools";

await connectTools({
  wsUrl: "${wsUrl}",
  entityId: "${entityId}",
  serviceSecret: "${plaintextSecret}",
  tools: [/* your tool definitions */],
});`;

  const pySnippet = `from platools import connect_tools

connect_tools(
    ws_url="${wsUrl}",
    entity_id="${entityId}",
    service_secret="${plaintextSecret}",
    tools=[...],
)`;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Entity Registered"
          icon={<CheckCircleIcon className="size-5 text-emerald-500" />}
        />
      </NavBar>
      <PageBody>
        <div className="max-w-3xl space-y-6">
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 flex items-start gap-2">
            <ExclamationTriangleIcon className="size-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-amber-300">
                Save the secret now — this page shows it only once.
              </p>
              <p className="text-amber-200/80 mt-1">
                Refreshing or navigating away discards the plaintext. If you
                lose it, use the Regenerate button on the entity detail page
                — the old secret becomes invalid the moment you regenerate.
              </p>
            </div>
          </div>

          <section>
            <Header3>Registered</Header3>
            <div className="mt-3 rounded-lg border border-charcoal-700 bg-charcoal-850 divide-y divide-charcoal-700">
              <Row
                label="Entity ID"
                value={entityId}
                onCopy={() => copy("entityId", entityId)}
                copied={copied === "entityId"}
              />
              <Row
                label="Service Secret"
                value={plaintextSecret}
                mono
                onCopy={() => copy("secret", plaintextSecret)}
                copied={copied === "secret"}
              />
              <Row
                label="WebSocket URL"
                value={wsUrl}
                mono
                onCopy={() => copy("wsUrl", wsUrl)}
                copied={copied === "wsUrl"}
              />
            </div>
          </section>

          <section>
            <Header3>Connect from your backend</Header3>
            <p className="text-xs text-text-dimmed mt-1 mb-3">
              Paste this into your backend startup code. The SDK auto-reconnects
              on network drops and re-syncs all tools.
            </p>
            <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 overflow-hidden">
              <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2 bg-charcoal-750">
                <span className="text-xs font-medium text-text-bright">TypeScript</span>
                <button
                  onClick={() => copy("ts", tsSnippet)}
                  className="text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1"
                >
                  <ClipboardIcon className="size-3.5" />
                  {copied === "ts" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="text-xs text-text-bright p-3 overflow-x-auto font-mono">
                {tsSnippet}
              </pre>
            </div>
            <div className="mt-3 rounded-lg border border-charcoal-700 bg-charcoal-850 overflow-hidden">
              <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-2 bg-charcoal-750">
                <span className="text-xs font-medium text-text-bright">Python</span>
                <button
                  onClick={() => copy("py", pySnippet)}
                  className="text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1"
                >
                  <ClipboardIcon className="size-3.5" />
                  {copied === "py" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="text-xs text-text-bright p-3 overflow-x-auto font-mono">
                {pySnippet}
              </pre>
            </div>
          </section>

          <div className="flex items-center gap-3">
            <LinkButton to=".." relative="path" variant="primary/medium">
              View Entity Details
            </LinkButton>
            <LinkButton to="../.." relative="path" variant="tertiary/medium">
              Back to list
            </LinkButton>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function Row({
  label,
  value,
  mono,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  mono?: boolean;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-xs text-text-dimmed font-medium w-36 shrink-0">{label}</span>
      <span className={`flex-1 text-sm text-text-bright ${mono ? "font-mono break-all" : ""}`}>
        {value}
      </span>
      {onCopy && (
        <button
          onClick={onCopy}
          className="ml-3 text-xs text-text-dimmed hover:text-text-bright flex items-center gap-1"
        >
          <ClipboardIcon className="size-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}
