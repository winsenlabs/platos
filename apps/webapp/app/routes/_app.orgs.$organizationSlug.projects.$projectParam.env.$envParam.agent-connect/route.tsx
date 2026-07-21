import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ClipboardIcon,
  CpuChipIcon,
  GlobeAltIcon,
  KeyIcon,
  LinkIcon,
  PlusIcon,
  Squares2X2Icon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Link, useFetcher, useSearchParams, type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { DocsLink } from "~/components/primitives/DocsLink";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { isAgentServiceAvailable, listEntities } from "~/services/platosAgent.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ChannelSetupGuide, ChannelWebhookGuide } from "./ChannelSetupGuide";
import {
  agentConnectChannelsPath,
  agentMcpEntityPath,
  agentSharePath,
  agentsPath,
  EnvironmentParamSchema,
  v3ApiKeysPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Connect | Platos" }];

// ── Loader payload types ────────────────────────────────────────────────────

type AgentSummary = {
  id: string;
  name: string;
  slug: string;
  visibility: string;
};

type ChannelRow = {
  id: string;
  provider: string;
  displayName: string | null;
  agentId: string;
  enabled: boolean;
  hasCredentials?: boolean;
  createdAt?: string;
};

type McpEntitySummary = {
  entityId: string;
  displayName: string;
  mcpEnabled: boolean;
  unrestricted: boolean;
};

type ConnectionDetails = {
  websocket?: { url?: string };
  rest?: {
    baseUrl?: string;
    auth?: { headers?: Record<string, string> };
  };
};

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
  } as const;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  // Agents (+ visibility) straight from Postgres — mirrors the share route's
  // prisma read. This works even when the agent service is offline and gives
  // the Web card its visibility badge without an extra round-trip.
  const agentRows = await prisma.platosAgent.findMany({
    where: {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
    select: { id: true, name: true, slug: true, visibility: true },
    orderBy: { createdAt: "asc" },
  });
  const agents: AgentSummary[] = agentRows.map((a) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    visibility: a.visibility,
  }));

  const url = new URL(request.url);
  const requestedAgentId = url.searchParams.get("agentId");
  const selectedAgent =
    (requestedAgentId ? agents.find((a) => a.id === requestedAgentId) : undefined) ??
    agents[0] ??
    null;
  const selectedAgentId = selectedAgent?.id ?? null;

  let connectionDetails: ConnectionDetails | null = null;
  let channels: ChannelRow[] = [];
  let mcpEntities: McpEntitySummary[] = [];
  let agentServiceAvailable = false;

  try {
    if (await isAgentServiceAvailable()) {
      agentServiceAvailable = true;
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const headers = scopeHeaders(scope);

      const [connRes, chanRes, entitiesResult] = await Promise.all([
        fetch(`${AGENT_API_URL}/api/v1/agent/connect`, {
          headers,
          signal: AbortSignal.timeout(5000),
        }).catch(() => null),
        fetch(`${AGENT_API_URL}/api/v1/agent/channels`, {
          headers,
          signal: AbortSignal.timeout(5000),
        }).catch(() => null),
        listEntities(scope).catch(() => ({ entities: [] as any[] })),
      ]);

      if (connRes?.ok) {
        connectionDetails = (await connRes.json()) as ConnectionDetails;
      }

      if (chanRes?.ok) {
        const data = (await chanRes.json()) as { channels?: ChannelRow[] };
        const all = Array.isArray(data.channels) ? data.channels : [];
        // Filter to the selected agent client-side of the agent API (the list
        // endpoint returns every channel in scope).
        channels = selectedAgentId ? all.filter((c) => c.agentId === selectedAgentId) : [];
      }

      const allEntities = Array.isArray((entitiesResult as any)?.entities)
        ? ((entitiesResult as any).entities as any[])
        : [];
      if (selectedAgentId) {
        mcpEntities = allEntities
          .filter((e) => {
            const linked = Array.isArray(e.linkedAgentIds) ? (e.linkedAgentIds as string[]) : [];
            // Empty allow-list = visible to every agent in scope (runtime
            // semantics); otherwise the agent must be explicitly listed.
            return linked.length === 0 || linked.includes(selectedAgentId);
          })
          .map((e) => ({
            entityId: e.entityId,
            displayName: e.displayName || e.entityId,
            mcpEnabled: !!(e.mcpConfig && e.mcpConfig.enabled),
            unrestricted:
              !Array.isArray(e.linkedAgentIds) || (e.linkedAgentIds as string[]).length === 0,
          }));
      }
    }
  } catch {
    // Agent service offline — degrade to empty payloads. Agents + visibility
    // still render from the prisma read above.
  }

  const appOrigin = env.APP_ORIGIN.replace(/\/$/, "");
  const embedUrl = selectedAgentId
    ? `${appOrigin}/embed/${encodeURIComponent(selectedAgentId)}`
    : "";

  const devMintEnabled = process.env.PLATOS_TEST_MODE === "true";

  // Origin for provider-facing inbound webhook URLs. /connect's rest.baseUrl
  // is the *service* URL, which defaults to http://localhost:3100 (or is empty
  // when the /connect fetch failed) — providers can never reach that. Prefer
  // the operator-set public origin and tell the UI whether what we have is
  // actually reachable from the outside, so it can warn instead of handing the
  // user a dead URL.
  const rawWebhookOrigin =
    process.env.PLATOS_AGENT_PUBLIC_API_URL ||
    (connectionDetails?.rest?.baseUrl || "").replace(/\/api\/v1\/agent$/, "");
  const webhookOrigin = rawWebhookOrigin.replace(/\/+$/, "");
  const webhookOriginIsPublic =
    /^https?:\/\//i.test(webhookOrigin) &&
    !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?$/i.test(webhookOrigin);

  return typedjson({
    scope,
    agents,
    selectedAgentId,
    selectedAgent,
    connectionDetails,
    channels,
    mcpEntities,
    agentServiceAvailable,
    appOrigin,
    embedUrl,
    devMintEnabled,
    webhookOrigin,
    webhookOriginIsPublic,
  });
}

// ── Provider field schema (client-only) ─────────────────────────────────────
// All listed fields land in the encrypted `credentials` envelope (bucket
// "cred"); non-secret extras go to plaintext `config` (bucket "cfg"). The
// resource route buckets by the `cred_`/`cfg_` name prefix, so the schema lives
// here and nowhere else.

type ProviderField = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
};

type ProviderSpec = {
  label: string;
  tile: string;
  glyph: string;
  credentials: ProviderField[];
  config: ProviderField[];
};

const PROVIDER_META: Record<string, ProviderSpec> = {
  slack: {
    label: "Slack",
    tile: "bg-violet-500/15 text-violet-300 border border-violet-500/30",
    glyph: "Sl",
    credentials: [
      { key: "botToken", label: "Bot token", placeholder: "xoxb-…", secret: true },
      { key: "signingSecret", label: "Signing secret", secret: true },
    ],
    config: [{ key: "teamId", label: "Team ID (optional)", placeholder: "T01234567" }],
  },
  telegram: {
    label: "Telegram",
    tile: "bg-sky-500/15 text-sky-300 border border-sky-500/30",
    glyph: "Tg",
    credentials: [
      { key: "botToken", label: "Bot token", placeholder: "123456:ABC-DEF…", secret: true },
      { key: "webhookSecretToken", label: "Webhook secret token", secret: true },
    ],
    config: [],
  },
  whatsapp: {
    label: "WhatsApp",
    tile: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
    glyph: "Wa",
    credentials: [
      { key: "accessToken", label: "Access token", secret: true },
      { key: "appSecret", label: "App secret", secret: true },
      { key: "phoneNumberId", label: "Phone number ID", secret: true },
      { key: "verifyToken", label: "Verify token", secret: true },
    ],
    config: [{ key: "businessAccountId", label: "Business account ID (optional)" }],
  },
  discord: {
    label: "Discord",
    tile: "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30",
    glyph: "Dc",
    credentials: [
      { key: "botToken", label: "Bot token", secret: true },
      { key: "publicKey", label: "Public key", secret: true },
      { key: "applicationId", label: "Application ID", secret: true },
    ],
    config: [{ key: "guildId", label: "Guild ID (optional)" }],
  },
};

const PROVIDER_ORDER = ["slack", "telegram", "whatsapp", "discord"] as const;

function providerSpec(provider: string): ProviderSpec {
  return (
    PROVIDER_META[provider] ?? {
      label: provider,
      tile: "bg-charcoal-700 text-text-dimmed border border-charcoal-600",
      glyph: provider.slice(0, 2) || "?",
      credentials: [],
      config: [],
    }
  );
}

// ── Small shared UI bits ─────────────────────────────────────────────────────

function ProviderTile({ provider, className }: { provider: string; className?: string }) {
  const spec = providerSpec(provider);
  return (
    <div
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg text-xs font-semibold uppercase",
        spec.tile,
        className
      )}
    >
      {spec.glyph}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="rounded p-1.5 transition-colors hover:bg-charcoal-700"
      title="Copy"
    >
      {copied ? (
        <CheckIcon className="size-4 text-emerald-400" />
      ) : (
        <ClipboardIcon className="size-4 text-text-dimmed" />
      )}
    </button>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
      <div className="flex items-center justify-between border-b border-charcoal-700 bg-charcoal-850 px-3 py-1.5">
        <span className="text-xs text-text-dimmed">{language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-sm text-text-bright">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CapabilityCard({
  title,
  description,
  icon,
  accent,
  action,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  accent: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-charcoal-700 bg-charcoal-850">
      <div className="flex items-start justify-between gap-3 border-b border-charcoal-700 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", accent)}>
            {icon}
          </span>
          <div>
            <h3 className="text-sm font-medium text-text-bright">{title}</h3>
            <p className="mt-0.5 text-xs text-text-dimmed">{description}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

const inputClass =
  "w-full rounded-lg border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-sm text-text-bright placeholder:text-text-dimmed focus:border-charcoal-600 focus:outline-none";

// ── Web (Widget / Embed) card ────────────────────────────────────────────────

function WebCard({
  organization,
  project,
  environment,
  agent,
  embedUrl,
}: {
  organization: { slug: string };
  project: { slug: string };
  environment: { slug: string };
  agent: AgentSummary;
  embedUrl: string;
}) {
  const shareFetcher = useFetcher<{ ok?: boolean; visibility?: string; error?: string }>();
  const isPublic = agent.visibility === "public-guest";
  const busy = shareFetcher.state !== "idle";

  const embedScriptSrc = embedUrl.replace(/\/embed\/.+$/, "/embed.js");
  const embedBaseUrl = embedUrl.replace(/\/embed\/.+$/, "");
  const embedSnippet = `<script src="${embedScriptSrc}"></script>
<platos-agent
  base-url="${embedBaseUrl}"
  agent-id="${agent.id}"
  theme="auto"></platos-agent>`;

  return (
    <CapabilityCard
      title="Web widget & embed"
      description="Drop-in chat bubble for any website or web app."
      icon={<GlobeAltIcon className="size-5 text-emerald-400" />}
      accent="bg-emerald-500/10"
      action={
        <Badge variant={isPublic ? "success" : "outline-rounded"}>
          {isPublic ? "Public" : "Private"}
        </Badge>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Paragraph variant="small" className="text-text-dimmed">
            {isPublic
              ? "This agent accepts anonymous guest chat from the embedded widget. Guest traffic is rate-limited per IP and capped by the agent's budget."
              : "Make this agent public to enable the embeddable widget and share URL. Guest chat stays rate-limited and budget-capped."}
          </Paragraph>
          <shareFetcher.Form method="post" action={agentSharePath(organization, project, environment, agent.id)}>
            <input type="hidden" name="intent" value="set-visibility" />
            <input type="hidden" name="visibility" value={isPublic ? "private" : "public-guest"} />
            <Button type="submit" variant="secondary/small" disabled={busy}>
              {busy ? "Saving…" : isPublic ? "Make private" : "Make public"}
            </Button>
          </shareFetcher.Form>
        </div>

        {shareFetcher.data?.error && (
          <Callout variant="error">{shareFetcher.data.error}</Callout>
        )}

        {isPublic ? (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-xs text-text-dimmed">Share URL</div>
              <ClipboardField variant="secondary/medium" value={embedUrl} />
            </div>
            <div>
              <div className="mb-1 text-xs text-text-dimmed">Embed snippet</div>
              <CodeBlock language="HTML" code={embedSnippet} />
            </div>
          </div>
        ) : (
          <Callout variant="info">
            The share URL and embed snippet appear here once the agent is public.
          </Callout>
        )}
      </div>
    </CapabilityCard>
  );
}

// ── Channels card ────────────────────────────────────────────────────────────

type WebhookRevealData = { webhookSecret: string; webhookPath: string; webhookUrl?: string | null };

/**
 * One-time webhook secret reveal. Shown after create and rotate-secret. When
 * no public origin is configured (localhost/empty), we show the path plus a
 * warning instead of a copyable URL that providers could never reach.
 */
function WebhookRevealBlock({
  reveal,
  webhookOrigin,
  webhookOriginIsPublic,
  provider,
  onDone,
}: {
  reveal: WebhookRevealData;
  webhookOrigin: string;
  webhookOriginIsPublic: boolean;
  /** Provider of the just-created/rotated channel, used to render the wiring guide. */
  provider?: string;
  onDone: () => void;
}) {
  // Backend-sourced absolute URL wins (agent's PLATOS_PUBLIC_BASE_URL, returned
  // as reveal.webhookUrl on create/rotate); the client-side origin composition
  // is only the legacy fallback, and the shaped placeholder the last resort.
  const serverUrl = reveal.webhookUrl ?? null;
  const hasPublicUrl = !!serverUrl || webhookOriginIsPublic;
  const webhookUrl =
    serverUrl ??
    (webhookOriginIsPublic
      ? `${webhookOrigin}${reveal.webhookPath}`
      : `<YOUR_PUBLIC_ORIGIN>${reveal.webhookPath}`);
  return (
    <div className="space-y-3 pt-4">
      <Callout variant="warning">
        This inbound webhook URL contains a secret and is shown once. Copy it now and paste it into
        your provider's webhook settings. If you lose it, use the channel row's Rotate button to
        mint a new one — the current URL won't be shown again.
      </Callout>
      {hasPublicUrl ? (
        <div>
          <div className="mb-1 text-xs text-text-dimmed">Inbound webhook URL</div>
          <ClipboardField variant="secondary/medium" value={webhookUrl} />
        </div>
      ) : (
        <>
          <Callout variant="error">
            No public agent origin is configured
            {webhookOrigin ? (
              <>
                {" "}— <code>{webhookOrigin}</code> is not reachable by providers
              </>
            ) : null}
            . Set <code>PLATOS_AGENT_PUBLIC_API_URL</code> to your agent service's public https
            origin (and make sure your reverse proxy routes{" "}
            <code>/api/v1/channels/*</code> to it), then prepend that origin to the webhook path
            below.
          </Callout>
          <div>
            <div className="mb-1 text-xs text-text-dimmed">Webhook path</div>
            <ClipboardField variant="secondary/medium" value={reveal.webhookPath} />
          </div>
        </>
      )}
      <div>
        <div className="mb-1 text-xs text-text-dimmed">Webhook secret</div>
        <ClipboardField variant="secondary/medium" secure value={reveal.webhookSecret} />
      </div>
      {provider && (
        <ChannelWebhookGuide
          provider={provider}
          webhookUrl={webhookUrl}
          webhookUrlIsComplete={hasPublicUrl}
        />
      )}
      <DialogFooter className="pt-2">
        <span />
        <Button type="button" variant="primary/small" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * Per-row rotate-secret action — the recovery path the reveal copy promises.
 * Rotation mints a new webhook secret and shows it in a dismissal-guarded
 * dialog, same as create.
 */
function RotateSecretAction({
  channel,
  actionPath,
  webhookOrigin,
  webhookOriginIsPublic,
}: {
  channel: ChannelRow;
  actionPath: string;
  webhookOrigin: string;
  webhookOriginIsPublic: boolean;
}) {
  const fetcher = useFetcher<{ ok?: boolean; created?: WebhookRevealData; error?: string }>();
  const busy = fetcher.state !== "idle";
  const [reveal, setReveal] = useState<WebhookRevealData | null>(null);

  useEffect(() => {
    if (fetcher.data?.created?.webhookSecret && fetcher.data.created.webhookPath) {
      setReveal({
        webhookSecret: fetcher.data.created.webhookSecret,
        webhookPath: fetcher.data.created.webhookPath,
      });
    }
  }, [fetcher.data]);

  return (
    <>
      <fetcher.Form
        method="post"
        action={actionPath}
        onSubmit={(e) => {
          if (
            !window.confirm(
              "Rotate this channel's webhook secret? The current webhook URL stops working immediately and the new one is shown once."
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="intent" value="rotate-secret" />
        <input type="hidden" name="id" value={channel.id} />
        <Button
          type="submit"
          variant="minimal/small"
          disabled={busy}
          title={fetcher.data?.error ? `Rotate failed: ${fetcher.data.error}` : "Rotate webhook secret"}
        >
          {busy ? "Rotating…" : "Rotate"}
        </Button>
      </fetcher.Form>
      {/* While the one-time secret is on screen, only the explicit Done button
          closes the dialog — implicit dismissal would destroy the secret. */}
      <Dialog open={reveal !== null} onOpenChange={() => {}}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Webhook secret rotated</DialogTitle>
          </DialogHeader>
          {reveal && (
            <WebhookRevealBlock
              reveal={reveal}
              webhookOrigin={webhookOrigin}
              webhookOriginIsPublic={webhookOriginIsPublic}
              provider={channel.provider}
              onDone={() => setReveal(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChannelRowItem({
  channel,
  actionPath,
  webhookOrigin,
  webhookOriginIsPublic,
}: {
  channel: ChannelRow;
  actionPath: string;
  webhookOrigin: string;
  webhookOriginIsPublic: boolean;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const busy = fetcher.state !== "idle";
  const spec = providerSpec(channel.provider);

  // Optimistic enabled state while a toggle is in flight.
  const pendingEnabled = fetcher.formData?.get("intent") === "toggle" ? fetcher.formData.get("enabled") : null;
  const enabled = pendingEnabled != null ? String(pendingEnabled) === "true" : channel.enabled;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800 px-3 py-2.5">
      <ProviderTile provider={channel.provider} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-bright">{channel.displayName || spec.label}</div>
        <div className="text-xs capitalize text-text-dimmed">{channel.provider}</div>
      </div>
      <Badge variant={enabled ? "success" : "outline-rounded"}>
        {enabled ? "Enabled" : "Disabled"}
      </Badge>
      <RotateSecretAction
        channel={channel}
        actionPath={actionPath}
        webhookOrigin={webhookOrigin}
        webhookOriginIsPublic={webhookOriginIsPublic}
      />
      <fetcher.Form method="post" action={actionPath}>
        <input type="hidden" name="intent" value="toggle" />
        <input type="hidden" name="id" value={channel.id} />
        <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
        <Button type="submit" variant="minimal/small" disabled={busy}>
          {enabled ? "Disable" : "Enable"}
        </Button>
      </fetcher.Form>
      <fetcher.Form
        method="post"
        action={actionPath}
        onSubmit={(e) => {
          if (!window.confirm("Delete this channel connection? Its inbound webhook stops working immediately.")) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="id" value={channel.id} />
        <Button type="submit" variant="minimal/small" disabled={busy}>
          <TrashIcon className="size-4 text-rose-400" />
          <span className="sr-only">Delete channel</span>
        </Button>
      </fetcher.Form>
    </div>
  );
}

function ConnectChannelDialog({
  agentId,
  actionPath,
  webhookOrigin,
  webhookOriginIsPublic,
}: {
  agentId: string;
  actionPath: string;
  webhookOrigin: string;
  webhookOriginIsPublic: boolean;
}) {
  const fetcher = useFetcher<{
    ok?: boolean;
    created?: { webhookSecret: string; webhookPath: string; channel: { provider?: string } };
    error?: string;
  }>();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string>("slack");
  const [reveal, setReveal] = useState<WebhookRevealData | null>(null);

  useEffect(() => {
    if (fetcher.data?.created) {
      setReveal({
        webhookSecret: fetcher.data.created.webhookSecret,
        webhookPath: fetcher.data.created.webhookPath,
      });
    }
  }, [fetcher.data]);

  function reset() {
    setOpen(false);
    setReveal(null);
    setProvider("slack");
  }

  const spec = providerSpec(provider);
  const busy = fetcher.state !== "idle";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        // While the one-time secret is on screen, only the explicit Done
        // button closes the dialog — ESC / overlay-click / the X button would
        // irrecoverably destroy the secret.
        else if (!reveal) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary/small" LeadingIcon={PlusIcon} onClick={() => setOpen(true)}>
          Connect a channel
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={!reveal}
        onEscapeKeyDown={(e) => {
          if (reveal) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (reveal) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (reveal) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{reveal ? "Channel connected" : "Connect a messaging channel"}</DialogTitle>
        </DialogHeader>

        {reveal ? (
          <WebhookRevealBlock
            reveal={reveal}
            webhookOrigin={webhookOrigin}
            webhookOriginIsPublic={webhookOriginIsPublic}
            provider={provider}
            onDone={reset}
          />
        ) : (
          <fetcher.Form method="post" action={actionPath} className="space-y-3 pt-4">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="agentId" value={agentId} />

            <div>
              <label className="mb-1 block text-xs text-text-dimmed">Provider</label>
              <select
                name="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className={inputClass}
              >
                {PROVIDER_ORDER.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_META[p].label}
                  </option>
                ))}
              </select>
            </div>

            <ChannelSetupGuide provider={provider} />

            <div>
              <label className="mb-1 block text-xs text-text-dimmed">Display name</label>
              <input
                name="displayName"
                defaultValue={spec.label}
                key={`name-${provider}`}
                className={inputClass}
              />
            </div>

            {spec.credentials.map((field) => (
              <div key={`cred-${provider}-${field.key}`}>
                <label className="mb-1 block text-xs text-text-dimmed">{field.label}</label>
                <input
                  name={`cred_${field.key}`}
                  type={field.secret ? "password" : "text"}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
            ))}

            {spec.config.map((field) => (
              <div key={`cfg-${provider}-${field.key}`}>
                <label className="mb-1 block text-xs text-text-dimmed">{field.label}</label>
                <input
                  name={`cfg_${field.key}`}
                  type="text"
                  placeholder={field.placeholder}
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
            ))}

            {fetcher.data?.error && <Callout variant="error">{fetcher.data.error}</Callout>}

            <DialogFooter className="pt-2">
              <Button type="button" variant="minimal/small" onClick={reset}>
                Cancel
              </Button>
              <Button type="submit" variant="primary/small" disabled={busy}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </DialogFooter>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelsCard({
  agentId,
  channels,
  actionPath,
  webhookOrigin,
  webhookOriginIsPublic,
  agentServiceAvailable,
}: {
  agentId: string;
  channels: ChannelRow[];
  actionPath: string;
  webhookOrigin: string;
  webhookOriginIsPublic: boolean;
  agentServiceAvailable: boolean;
}) {
  return (
    <CapabilityCard
      title="Messaging channels"
      description="Route Slack, Telegram, WhatsApp & Discord messages to this agent."
      icon={<ChatBubbleLeftRightIcon className="size-5 text-blue-400" />}
      accent="bg-blue-500/10"
      action={
        agentServiceAvailable ? (
          <ConnectChannelDialog
            agentId={agentId}
            actionPath={actionPath}
            webhookOrigin={webhookOrigin}
            webhookOriginIsPublic={webhookOriginIsPublic}
          />
        ) : undefined
      }
    >
      {!agentServiceAvailable ? (
        <Callout variant="warning">
          The agent service is unreachable, so channel connections can't be listed or managed right
          now.
        </Callout>
      ) : channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-charcoal-700 px-4 py-8 text-center">
          <Paragraph variant="small" className="text-text-dimmed">
            No channels connected for this agent yet. Use{" "}
            <span className="text-text-bright">Connect a channel</span> to add Slack, Telegram,
            WhatsApp or Discord.
          </Paragraph>
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map((channel) => (
            <ChannelRowItem
              key={channel.id}
              channel={channel}
              actionPath={actionPath}
              webhookOrigin={webhookOrigin}
              webhookOriginIsPublic={webhookOriginIsPublic}
            />
          ))}
        </div>
      )}
    </CapabilityCard>
  );
}

// ── API / SDK card ───────────────────────────────────────────────────────────

function MintTokenButton() {
  const [state, setState] = useState<"idle" | "loading" | "minted" | "error">("idle");
  const [token, setToken] = useState<string | null>(null);

  async function onClick() {
    setState("loading");
    try {
      const res = await fetch("./mint-token", { method: "POST" });
      if (!res.ok) throw new Error("mint failed");
      const jsonBody = (await res.json()) as { token?: string };
      if (!jsonBody.token) throw new Error("no token");
      setToken(jsonBody.token);
      setState("minted");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="rounded-lg border border-indigo-700 bg-indigo-950/30 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-xs font-semibold text-indigo-300">
            Dev mode — mint a test session token
          </span>
          <p className="mt-1 text-xs text-text-dimmed">
            Returns a 5-minute session token signed with{" "}
            <code className="rounded bg-charcoal-700 px-1">PLATOS_SESSION_SECRET</code>. Paste it
            into <code className="rounded bg-charcoal-700 px-1">X-Platos-Session-Token</code> to poke
            the agent directly. Enabled only when{" "}
            <code className="rounded bg-charcoal-700 px-1">PLATOS_TEST_MODE=true</code>.
          </p>
        </div>
        <Button type="button" variant="secondary/small" onClick={onClick} disabled={state === "loading"}>
          {state === "loading" ? "Minting…" : state === "minted" ? "Re-mint" : "Mint"}
        </Button>
      </div>
      {token && (
        <div className="mt-3">
          <CodeBlock language="Session token (5 min)" code={token} />
        </div>
      )}
      {state === "error" && <p className="mt-2 text-xs text-rose-400">Mint failed — check the server logs.</p>}
    </div>
  );
}

function ApiSdkCard({
  agentId,
  connectionDetails,
  apiKeysHref,
  devMintEnabled,
}: {
  agentId: string;
  connectionDetails: ConnectionDetails | null;
  apiKeysHref: string;
  devMintEnabled: boolean;
}) {
  const httpUrl = connectionDetails?.rest?.baseUrl || "http://localhost:3100/api/v1/agent";
  const wsUrl = connectionDetails?.websocket?.url || "ws://localhost:3100/agent";
  const organizationId =
    connectionDetails?.rest?.auth?.headers?.["X-Platos-Organization-Id"] || "your-organization-id";
  const projectId =
    connectionDetails?.rest?.auth?.headers?.["X-Platos-Project-Id"] || "your-project-id";
  const environmentId =
    connectionDetails?.rest?.auth?.headers?.["X-Platos-Environment-Id"] || "your-environment-id";
  const baseUrl = httpUrl.replace(/\/api\/v1\/agent$/, "");

  const tsSnippet = `import { PlatosClient } from "@platosdev/client";

const client = new PlatosClient({
  baseUrl: "${baseUrl}",
  sessionToken: process.env.PLATOS_SESSION_TOKEN!, // mint on your backend
});

const thread = await client.threads.create(undefined, { agentId: "${agentId}" });
for await (const event of client.threads.send(thread.id, "Hello!")) {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "done") break;
}`;

  const pythonSnippet = `import asyncio, os
from platos_client import PlatosClient

async def main():
    async with PlatosClient(
        base_url="${baseUrl}",
        session_token=os.environ["PLATOS_SESSION_TOKEN"],
    ) as client:
        thread = await client.threads.create(agent_id="${agentId}")
        async for event in client.threads.send(thread["id"], "Hello!"):
            if event["type"] == "token":
                print(event["text"], end="", flush=True)
            if event["type"] == "done":
                break

asyncio.run(main())`;

  const wsSnippet = `import { io } from "socket.io-client";

const socket = io("${wsUrl}", {
  auth: {
    organizationId: "${organizationId}",
    projectId: "${projectId}",
    environmentId: "${environmentId}",
    userId: "your-user-id",
  },
  transports: ["websocket"],
});

socket.emit("message", { message: "Hello!", agentId: "${agentId}" });
socket.on("agent_event", (event) => {
  if (event.type === "token") process.stdout.write(event.text);
  if (event.type === "done") socket.disconnect();
});`;

  const curlSnippet = `curl -X POST ${httpUrl}/threads \\
  -H "Content-Type: application/json" \\
  -H "X-Platos-Organization-Id: ${organizationId}" \\
  -H "X-Platos-Project-Id: ${projectId}" \\
  -H "X-Platos-Environment-Id: ${environmentId}" \\
  -H "X-Platos-User-Id: your-user-id" \\
  -d '{"agentId": "${agentId}", "title": "My Conversation"}'`;

  const [tab, setTab] = useState<"ts" | "py" | "ws" | "curl">("ts");
  const tabs: Array<{ key: typeof tab; label: string; language: string; code: string }> = [
    { key: "ts", label: "TypeScript", language: "TypeScript", code: tsSnippet },
    { key: "py", label: "Python", language: "Python", code: pythonSnippet },
    { key: "ws", label: "WebSocket", language: "JavaScript", code: wsSnippet },
    { key: "curl", label: "cURL", language: "cURL", code: curlSnippet },
  ];
  const active = tabs.find((t) => t.key === tab) ?? tabs[0];

  return (
    <CapabilityCard
      title="API & SDKs"
      description="Call this agent from your own backend or frontend."
      icon={<KeyIcon className="size-5 text-amber-400" />}
      accent="bg-amber-500/10"
      action={
        <Link
          to={apiKeysHref}
          className="inline-flex items-center gap-1 text-xs text-blue-400 transition-colors hover:text-blue-300"
        >
          API keys <ArrowTopRightOnSquareIcon className="size-3.5" />
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                t.key === tab
                  ? "bg-charcoal-700 text-text-bright"
                  : "text-text-dimmed hover:text-text-bright"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CodeBlock language={active.language} code={active.code} />
        {devMintEnabled && <MintTokenButton />}
      </div>
    </CapabilityCard>
  );
}

// ── MCP card ─────────────────────────────────────────────────────────────────

function McpCard({
  organization,
  project,
  environment,
  entities,
  agentServiceAvailable,
}: {
  organization: { slug: string };
  project: { slug: string };
  environment: { slug: string };
  entities: McpEntitySummary[];
  agentServiceAvailable: boolean;
}) {
  return (
    <CapabilityCard
      title="MCP tools"
      description="Connected entities exposing tools to this agent over MCP."
      icon={<Squares2X2Icon className="size-5 text-violet-400" />}
      accent="bg-violet-500/10"
    >
      {!agentServiceAvailable ? (
        <Callout variant="warning">
          The agent service is unreachable, so linked MCP entities can't be listed right now.
        </Callout>
      ) : entities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-charcoal-700 px-4 py-8 text-center">
          <Paragraph variant="small" className="text-text-dimmed">
            No connected entities are linked to this agent. Link one on the MCPs page to expose its
            tools here.
          </Paragraph>
        </div>
      ) : (
        <div className="space-y-2">
          {entities.map((entity) => (
            <Link
              key={entity.entityId}
              to={agentMcpEntityPath(organization, project, environment, entity.entityId)}
              className="flex items-center gap-3 rounded-lg border border-charcoal-700 bg-charcoal-800 px-3 py-2.5 transition-colors hover:border-charcoal-600 hover:bg-charcoal-800/60"
            >
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-violet-500/30 bg-violet-500/15 text-xs font-semibold uppercase text-violet-300">
                {entity.displayName.slice(0, 2)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-text-bright">{entity.displayName}</div>
                <code className="text-xs text-text-dimmed">{entity.entityId}</code>
              </div>
              {entity.unrestricted && <Badge variant="outline-rounded">All agents</Badge>}
              <Badge variant={entity.mcpEnabled ? "success" : "outline-rounded"}>
                {entity.mcpEnabled ? "MCP on" : "MCP off"}
              </Badge>
              <ArrowTopRightOnSquareIcon className="size-4 shrink-0 text-text-dimmed" />
            </Link>
          ))}
        </div>
      )}
    </CapabilityCard>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ConnectPage() {
  const {
    agents,
    selectedAgentId,
    selectedAgent,
    connectionDetails,
    channels,
    mcpEntities,
    agentServiceAvailable,
    embedUrl,
    devMintEnabled,
    webhookOrigin,
    webhookOriginIsPublic,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [searchParams, setSearchParams] = useSearchParams();

  if (agents.length === 0 || !selectedAgent || !selectedAgentId) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Connect" icon={<LinkIcon className="size-5 text-blue-500" />} />
          <PageAccessories>
            <DocsLink slug="sdks" />
          </PageAccessories>
        </NavBar>
        <PageBody>
          <div className="mx-auto max-w-lg py-16 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-charcoal-800">
              <CpuChipIcon className="size-6 text-text-dimmed" />
            </div>
            <h2 className="text-base font-medium text-text-bright">No agents yet</h2>
            <Paragraph variant="small" className="mx-auto mt-2 max-w-sm text-text-dimmed">
              Create an agent first, then come back here to connect it to the web, messaging
              channels, your API, and MCP tools.
            </Paragraph>
            <div className="mt-5">
              <Link
                to={agentsPath(organization, project, environment)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-charcoal-600 bg-charcoal-800 px-4 py-2 text-sm text-text-bright transition-colors hover:bg-charcoal-700"
              >
                <PlusIcon className="size-4" /> Create an agent
              </Link>
            </div>
          </div>
        </PageBody>
      </PageContainer>
    );
  }

  function onSelectAgent(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set("agentId", id);
    setSearchParams(next, { replace: true });
  }

  const channelsActionPath = agentConnectChannelsPath(organization, project, environment);
  const apiKeysHref = v3ApiKeysPath(organization, project, environment);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Connect" icon={<LinkIcon className="size-5 text-blue-500" />} />
        <PageAccessories>
          <DocsLink slug="sdks" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Agent picker — drives the ?agentId= param the loader reads. */}
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="connect-agent-picker" className="text-sm text-text-dimmed">
              Agent
            </label>
            <select
              id="connect-agent-picker"
              value={selectedAgentId}
              onChange={(e) => onSelectAgent(e.target.value)}
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-text-bright"
              data-testid="agent-picker"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <code className="text-xs text-text-dimmed">agent_id = {selectedAgentId}</code>
            {!agentServiceAvailable && (
              <Badge variant="outline-rounded" className="border-amber-500 text-amber-400">
                Agent service offline
              </Badge>
            )}
          </div>

          {!agentServiceAvailable && (
            <Callout variant="warning">
              The agent service is unreachable. Visibility and code snippets still work, but live
              channel and MCP data is hidden and snippets fall back to placeholder host values.
            </Callout>
          )}

          <div className="space-y-4">
            <WebCard
              organization={organization}
              project={project}
              environment={environment}
              agent={selectedAgent}
              embedUrl={embedUrl}
            />
            <ChannelsCard
              agentId={selectedAgentId}
              channels={channels}
              actionPath={channelsActionPath}
              webhookOrigin={webhookOrigin}
              webhookOriginIsPublic={webhookOriginIsPublic}
              agentServiceAvailable={agentServiceAvailable}
            />
            <ApiSdkCard
              agentId={selectedAgentId}
              connectionDetails={connectionDetails}
              apiKeysHref={apiKeysHref}
              devMintEnabled={devMintEnabled}
            />
            <McpCard
              organization={organization}
              project={project}
              environment={environment}
              entities={mcpEntities}
              agentServiceAvailable={agentServiceAvailable}
            />
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}
