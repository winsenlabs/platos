import {
  KeyIcon,
  CheckCircleIcon,
  XCircleIcon,
  ExclamationTriangleIcon,
  ArrowTopRightOnSquareIcon,
  LinkIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, Link, useFetcher, useNavigation, type MetaFunction } from "@remix-run/react";
import { useState } from "react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { requireUserId } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3NewEnvironmentVariablesPath,
  v3EnvironmentVariablesPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Providers | Platos" }];

// NOTE: `process.env.PLATOS_AGENT_API_URL` is resolved INSIDE `loader` /
// `action` — keeping it at module scope throws `ReferenceError: process is not
// defined` during Remix's client-side route-module evaluation on SPA
// navigation, tearing down the in-flight nav and bouncing to the previous page.
type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

type ProviderState = {
  id: string;
  displayName: string;
  description: string;
  requiredEnv: Array<{ name: string; set: boolean }>;
  optionalEnv: string[];
  envReady: boolean;
  enabled: boolean;
  linked: boolean;
  linkedAt: string | null;
  models: string[];
};

// PIFSP-14 — named API keys per provider.
type ProviderKey = {
  id: string;
  provider: string;
  label: string;
  envVarName: string;
  isDefault: boolean;
  envVarSet: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

/**
 * Fallback manifests used only when the agent service is unreachable so the
 * page still renders instead of bouncing the user back to the agents list
 * (the historical "nav loop" — B.3). Source of truth remains
 * apps/agent/src/providers/manifests/index.ts.
 */
const FALLBACK_MANIFESTS: ProviderState[] = [
  {
    id: "anthropic",
    displayName: "Anthropic Claude",
    description: "Claude Sonnet / Opus / Haiku via Anthropic's API.",
    requiredEnv: [{ name: "ANTHROPIC_API_KEY", set: false }],
    optionalEnv: [],
    envReady: false,
    enabled: false,
    linked: false,
    linkedAt: null,
    models: [
      "anthropic:claude-sonnet-4-6",
      "anthropic:claude-opus-4-6",
      "anthropic:claude-haiku-4-5-20251001",
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    description: "GPT-4.1, GPT-4o and GPT-OSS models via OpenAI's API.",
    requiredEnv: [{ name: "OPENAI_API_KEY", set: false }],
    optionalEnv: ["OPENAI_BASE_URL"],
    envReady: false,
    enabled: false,
    linked: false,
    linkedAt: null,
    models: ["openai:gpt-4.1", "openai:gpt-4.1-mini", "openai:gpt-4o", "openai:gpt-oss-120b"],
  },
  {
    id: "google",
    displayName: "Google AI (Gemini)",
    description: "Gemini 2.5 Pro / Flash via Google AI's generative API.",
    requiredEnv: [{ name: "GOOGLE_GENERATIVE_AI_API_KEY", set: false }],
    optionalEnv: [],
    envReady: false,
    enabled: false,
    linked: false,
    linkedAt: null,
    models: ["google:gemini-2.5-pro", "google:gemini-2.5-flash"],
  },
  {
    id: "google-vertex",
    displayName: "Google Vertex AI (GCP)",
    description:
      "Gemini + GLM models on Vertex AI. Paste the full contents of a GCP service account JSON file as GOOGLE_VERTEX_CREDENTIALS. " +
      "Download from GCP Console → IAM → Service Accounts → Keys → Create key (JSON).",
    requiredEnv: [{ name: "GOOGLE_VERTEX_CREDENTIALS", set: false }],
    optionalEnv: ["GOOGLE_VERTEX_LOCATION"],
    envReady: false,
    enabled: false,
    linked: false,
    linkedAt: null,
    models: [
      "google-vertex:gemini-2.5-pro",
      "google-vertex:gemini-2.5-flash",
      "google-vertex:gemini-3-flash-preview",
      "google-vertex:zai-org/glm-5-maas",
    ],
  },
];

async function agentFetch<T>(path: string, scope: Scope, opts?: { method?: string; body?: unknown }): Promise<T> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const res = await fetch(`${AGENT_API_URL}${path}`, {
    method: opts?.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
    },
    ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return (await res.json()) as T;
}

async function scopeFromRequest(
  request: Request,
  params: Record<string, string | undefined>,
): Promise<{
  scope: Scope;
  organization: { id: string; slug: string };
  project: { id: string; slug: string };
  environment: { id: string; slug: string; parentEnvironmentId: string | null };
}> {
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

  return {
    scope: {
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      userId,
    },
    organization: { id: project.organizationId, slug: organizationSlug },
    project: { id: project.id, slug: projectParam },
    environment: {
      id: environment.id,
      slug: envParam,
      parentEnvironmentId: (environment as { parentEnvironmentId?: string | null }).parentEnvironmentId ?? null,
    },
  };
}

/**
 * Loader strategy:
 *   1) Read provider manifests + PlatosProviderEnabled rows from the agent service
 *      — this carries the "linked / enabled" state.
 *   2) Read the trigger.dev env-var table directly for this (project, env) so we
 *      know which required env-vars the user has actually set. The agent service
 *      can only see `process.env` in its own container; the webapp is the
 *      authoritative source for the per-scope env-var set.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { scope, organization, project, environment } = await scopeFromRequest(request, params);

  let providers: ProviderState[] = [];
  let agentReachable = false;

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      agentReachable = true;
      const json = await agentFetch<{ providers: ProviderState[] }>("/api/v1/agent/providers", scope);
      providers = json.providers ?? [];
    }
  } catch {
    // swallow — agentReachable stays false
  }

  // Fallback so the page still renders something useful when the agent
  // service is unreachable. Without this the original route silently
  // returned `providers: []` and some UI paths bounced the user back to
  // /agents (the B.3 "nav loop" bug).
  if (providers.length === 0) {
    providers = FALLBACK_MANIFESTS;
  }

  // Read env-var presence from trigger.dev's store — webapp has direct access.
  const repo = new EnvironmentVariablesRepository(prisma);
  const envVars = await repo.getEnvironment(
    project.id,
    environment.id,
    environment.parentEnvironmentId ?? undefined,
  );
  const setEnvKeys = new Set(envVars.map((v) => v.key));

  // PIFSP-14 — fetch named keys first so we can use them when decorating
  // envReady below (a default key with envVarSet=true counts as ready even
  // when the canonical env var name isn't in the table).
  let providerKeys: ProviderKey[] = [];
  if (agentReachable) {
    try {
      const keysJson = await agentFetch<{ keys: ProviderKey[] }>("/api/v1/agent/providers/keys", scope);
      providerKeys = keysJson.keys ?? [];
    } catch {
      // non-fatal
    }
  }

  // Build a lookup: providerId → has ANY key with envVarSet=true (not just default).
  // Having any registered key with a valid env var is enough for the provider to be ready.
  const anyKeyReady = new Map<string, boolean>();
  for (const k of providerKeys) {
    if ((k as any).envVarSet) {
      anyKeyReady.set(k.provider, true);
    }
  }

  // Re-decorate each provider's requiredEnv with webapp-side truth.
  const decorated: ProviderState[] = providers.map((p) => {
    const requiredEnv = p.requiredEnv.map((e) => ({
      name: e.name,
      set: setEnvKeys.has(e.name),
    }));
    // envReady: canonical env var set OR ANY PlatosProviderKey for this provider is ready.
    const envReady = requiredEnv.every((e) => e.set) || !!anyKeyReady.get(p.id);
    return { ...p, requiredEnv, envReady };
  });

  // Pass sorted env var names so the AddKeyForm can show a dropdown instead
  // of a free-text box.
  const availableEnvVarNames = Array.from(setEnvKeys).sort();

  return typedjson({
    providers: decorated,
    providerKeys,
    availableEnvVarNames,
    agentReachable,
    envVarsPath: v3EnvironmentVariablesPath(
      { slug: organization.slug },
      { slug: project.slug },
      { slug: environment.slug },
    ),
    newEnvVarPath: v3NewEnvironmentVariablesPath(
      { slug: organization.slug },
      { slug: project.slug },
      { slug: environment.slug },
    ),
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { scope } = await scopeFromRequest(request, params);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const providerId = String(formData.get("provider") ?? "");

  if (!providerId) {
    return typedjson({ error: "Missing provider id" }, { status: 400 });
  }

  if (intent === "link") {
    await agentFetch(`/api/v1/agent/providers/${providerId}/link`, scope, { method: "POST" });
    return typedjson({ ok: true });
  }

  if (intent === "unlink") {
    await agentFetch(`/api/v1/agent/providers/${providerId}/link`, scope, { method: "DELETE" });
    return typedjson({ ok: true });
  }

  if (intent === "toggle") {
    const enabled = String(formData.get("enabled") ?? "") === "true";
    await agentFetch(`/api/v1/agent/providers/${providerId}`, scope, {
      method: "PATCH",
      body: { enabled },
    });
    return typedjson({ ok: true });
  }

  if (intent === "test") {
    const result = await agentFetch(`/api/v1/agent/providers/${providerId}/health`, scope);
    return typedjson({ testResult: result });
  }

  // PIFSP-14 — provider key CRUD
  if (intent === "create_key") {
    const provider = String(formData.get("provider") ?? "");
    const label = String(formData.get("label") ?? "").trim();
    const envVarName = String(formData.get("envVarName") ?? "").trim().toUpperCase();
    const isDefault = formData.get("isDefault") === "true";
    if (!provider || !label || !envVarName) {
      return typedjson({ error: "provider, label, and envVarName are required" }, { status: 400 });
    }
    await agentFetch("/api/v1/agent/providers/keys", scope, {
      method: "POST",
      body: { provider, label, envVarName, isDefault },
    });
    return typedjson({ ok: true });
  }

  if (intent === "set_default_key") {
    const keyId = String(formData.get("keyId") ?? "");
    if (!keyId) return typedjson({ error: "keyId required" }, { status: 400 });
    await agentFetch(`/api/v1/agent/providers/keys/${keyId}`, scope, {
      method: "PATCH",
      body: { isDefault: true },
    });
    return typedjson({ ok: true });
  }

  if (intent === "delete_key") {
    const keyId = String(formData.get("keyId") ?? "");
    if (!keyId) return typedjson({ error: "keyId required" }, { status: 400 });
    const res = await agentFetch<{ deleted?: boolean; error?: string }>(`/api/v1/agent/providers/keys/${keyId}`, scope, {
      method: "DELETE",
    });
    const body = res as any;
    if (body?.error) return typedjson({ error: body.error }, { status: 409 });
    return typedjson({ ok: true });
  }

  return typedjson({ error: `Unknown intent: ${intent}` }, { status: 400 });
}

/**
 * Per-provider Test button using a fetcher so the result renders inline
 * below the row without re-running the page loader. The parent action
 * handles the `intent=test` POST and returns { testResult: ... }.
 */
function TestProviderButton({ providerId }: { providerId: string }) {
  const fetcher = useFetcher<{ testResult?: any; error?: string }>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const result = data?.testResult as
    | {
        status?: "healthy" | "invalid_key" | "error" | "not_configured";
        latencyMs?: number;
        model?: string;
        error?: string;
      }
    | undefined;
  const ok = result?.status === "healthy";

  return (
    <div className="flex items-center gap-2">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="test" />
        <input type="hidden" name="provider" value={providerId} />
        <Button type="submit" variant="tertiary/small" disabled={busy}>
          {busy ? "Testing…" : "Test"}
        </Button>
      </fetcher.Form>
      {!busy && result && (
        <span
          className={
            ok
              ? "inline-flex items-center gap-1 text-[11px] text-emerald-300"
              : "inline-flex items-center gap-1 text-[11px] text-rose-300"
          }
        >
          {ok ? (
            <>
              <CheckCircleIcon className="size-3.5 text-emerald-400" />
              Healthy{typeof result.latencyMs === "number" ? ` · ${result.latencyMs}ms` : ""}
              {result.model ? ` · ${result.model}` : ""}
            </>
          ) : (
            <>
              <XCircleIcon className="size-3.5 text-rose-400" />
              {result.status === "not_configured"
                ? "No key set"
                : result.status === "invalid_key"
                ? "Invalid key"
                : result.error || "Failed"}
            </>
          )}
        </span>
      )}
      {!busy && !result && data?.error && (
        <span className="inline-flex items-center gap-1 text-[11px] text-rose-300">
          <XCircleIcon className="size-3.5 text-rose-400" />
          {data.error}
        </span>
      )}
    </div>
  );
}

/**
 * Pill for provider readiness state. Custom inline-flex layout (not Badge)
 * because the shared Badge uses a fixed `h-4 / h-5` grid cell and its
 * uppercase children were overflowing vertically on longer strings like
 * "Env not linked".
 */
function StatusPill({ ready, enabled }: { ready: boolean; enabled: boolean }) {
  if (!ready) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/60 px-2 py-0.5 text-[11px] text-amber-300 whitespace-nowrap">
        <ExclamationTriangleIcon className="size-3 text-amber-400" />
        Env not linked
      </span>
    );
  }
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-charcoal-600 px-2 py-0.5 text-[11px] text-text-dimmed whitespace-nowrap">
        Disabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-700 bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300 whitespace-nowrap">
      <CheckCircleIcon className="size-3 text-emerald-400" />
      Ready
    </span>
  );
}

export default function ProvidersPage() {
  const { providers, providerKeys, availableEnvVarNames, agentReachable, envVarsPath, newEnvVarPath } =
    useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Providers" icon={<KeyIcon className="size-5 text-amber-500" />} />
        <PageAccessories>
          <DocsLink slug="providers" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Paragraph variant="small" className="mb-5">
          Platos does not store API keys. Provider credentials live in the project's{" "}
          <Link to={envVarsPath} className="underline text-text-bright">
            Environment Variables
          </Link>{" "}
          table — Platos's run engine injects them into the agent container for the selected
          environment. Link a provider here to make its models available to your agents.
        </Paragraph>

        {!agentReachable && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            <ExclamationTriangleIcon className="size-4 inline mr-1.5" />
            Agent service is not reachable. Provider link state may be stale until it comes back online.
          </div>
        )}

        <Header3>LLM Providers</Header3>
        <div className="mt-3 flex flex-col gap-3">
          {providers.length === 0 ? (
            <div className="text-center py-10 text-text-dimmed">
              <KeyIcon className="size-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No providers available.</p>
            </div>
          ) : (
            providers.map((p) => {
              const missing = p.requiredEnv.filter((e) => !e.set).map((e) => e.name);
              const linkNewEnvUrl =
                missing.length > 0
                  ? `${newEnvVarPath}?key=${encodeURIComponent(missing[0])}`
                  : null;

              return (
                <div
                  key={p.id}
                  className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold text-text-bright">{p.displayName}</h4>
                        <StatusPill ready={p.envReady} enabled={p.enabled} />
                      </div>
                      <p className="mt-1 text-xs text-text-dimmed">{p.description}</p>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {p.requiredEnv.map((e) => (
                          <span
                            key={e.name}
                            className="inline-flex items-center gap-1 rounded border border-charcoal-700 px-2 py-0.5 text-[11px] font-mono"
                          >
                            {e.set ? (
                              <CheckCircleIcon className="size-3 text-green-500" />
                            ) : (
                              <XCircleIcon className="size-3 text-red-500" />
                            )}
                            {e.name}
                          </span>
                        ))}
                        {p.optionalEnv.length > 0 && (
                          <span className="text-[11px] text-text-dimmed italic">
                            Optional: {p.optionalEnv.join(", ")}
                          </span>
                        )}
                      </div>

                      <div className="mt-2 text-[11px] text-text-dimmed">
                        {p.models.length} model{p.models.length === 1 ? "" : "s"} exposed when enabled
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      {linkNewEnvUrl && (
                        <LinkButton
                          variant="primary/small"
                          TrailingIcon={ArrowTopRightOnSquareIcon}
                          LeadingIcon={LinkIcon}
                          to={linkNewEnvUrl}
                        >
                          Link env
                        </LinkButton>
                      )}

                      {p.envReady && (
                        <>
                          {!p.linked ? (
                            <Form method="post">
                              <input type="hidden" name="intent" value="link" />
                              <input type="hidden" name="provider" value={p.id} />
                              <Button type="submit" variant="primary/small" disabled={busy}>
                                Enable
                              </Button>
                            </Form>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Form method="post">
                                <input type="hidden" name="intent" value="toggle" />
                                <input type="hidden" name="provider" value={p.id} />
                                <input type="hidden" name="enabled" value={p.enabled ? "false" : "true"} />
                                <Button type="submit" variant="tertiary/small" disabled={busy}>
                                  {p.enabled ? "Disable" : "Enable"}
                                </Button>
                              </Form>
                              <Form method="post">
                                <input type="hidden" name="intent" value="unlink" />
                                <input type="hidden" name="provider" value={p.id} />
                                <Button type="submit" variant="danger/small" disabled={busy}>
                                  Unlink
                                </Button>
                              </Form>
                            </div>
                          )}

                          <TestProviderButton providerId={p.id} />
                        </>
                      )}
                    </div>
                  </div>

                  {/* PIFSP-14 — per-provider key list */}
                  <ProviderKeySection
                    providerId={p.id}
                    keys={providerKeys.filter((k) => k.provider === p.id)}
                    availableEnvVarNames={availableEnvVarNames}
                    busy={busy}
                  />
                </div>
              );
            })
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

// ─── PIFSP-14 — Provider key management section ──────────────────────────────

function ProviderKeySection({
  providerId,
  keys,
  availableEnvVarNames,
  busy,
}: {
  providerId: string;
  keys: ProviderKey[];
  availableEnvVarNames: string[];
  busy: boolean;
}) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="mt-3 border-t border-charcoal-700 pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-text-dimmed">API Keys ({keys.length})</span>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-text-dimmed hover:text-text-bright"
        >
          <PlusIcon className="size-3" /> Add key
        </button>
      </div>

      {showAdd && (
        <AddKeyForm
          providerId={providerId}
          availableEnvVarNames={availableEnvVarNames}
          onDone={() => setShowAdd(false)}
        />
      )}

      {keys.length === 0 ? (
        <p className="text-[11px] text-text-dimmed italic">No named keys yet. Add one to enable multi-key routing.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center gap-2 rounded border border-charcoal-700 bg-charcoal-800/60 px-2 py-1.5"
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium text-text-bright truncate">{k.label}</span>
                  {k.isDefault && (
                    <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">default</span>
                  )}
                  {k.envVarSet ? (
                    <CheckCircleIcon className="size-3 flex-shrink-0 text-emerald-400" />
                  ) : (
                    <XCircleIcon className="size-3 flex-shrink-0 text-rose-400" title="Env var not set" />
                  )}
                </div>
                <span className="font-mono text-[10px] text-text-dimmed">{k.envVarName}</span>
                {k.lastUsedAt && (
                  <span className="text-[10px] text-charcoal-400">
                    last used {new Date(k.lastUsedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                {!k.isDefault && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="set_default_key" />
                    <input type="hidden" name="keyId" value={k.id} />
                    <button
                      type="submit"
                      disabled={busy}
                      title="Set as default"
                      className="rounded p-1 text-text-dimmed hover:bg-charcoal-700 hover:text-amber-300 disabled:opacity-50"
                    >
                      <StarIcon className="size-3.5" />
                    </button>
                  </Form>
                )}
                <Form method="post">
                  <input type="hidden" name="intent" value="delete_key" />
                  <input type="hidden" name="keyId" value={k.id} />
                  <button
                    type="submit"
                    disabled={busy}
                    title="Delete key"
                    className="rounded p-1 text-text-dimmed hover:bg-charcoal-700 hover:text-rose-300 disabled:opacity-50"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </Form>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddKeyForm({
  providerId,
  availableEnvVarNames,
  onDone,
}: {
  providerId: string;
  availableEnvVarNames: string[];
  onDone: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  return (
    <fetcher.Form
      method="post"
      onSubmit={() => setTimeout(onDone, 300)}
      className="mb-2 rounded border border-charcoal-600 bg-charcoal-800/80 p-2"
    >
      <input type="hidden" name="intent" value="create_key" />
      <input type="hidden" name="provider" value={providerId} />
      <div className="flex flex-col gap-1.5">
        <input
          name="label"
          placeholder="Label (e.g. Production Key)"
          required
          className="rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 text-xs text-text-bright placeholder:text-text-dimmed focus:outline-none"
        />
        {availableEnvVarNames.length > 0 ? (
          <select
            name="envVarName"
            required
            defaultValue=""
            className="rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 font-mono text-xs text-text-bright focus:outline-none"
          >
            <option value="" disabled>Select environment variable…</option>
            {availableEnvVarNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        ) : (
          <>
            <input
              name="envVarName"
              placeholder="Env var name (e.g. ANTHROPIC_API_KEY)"
              required
              className="rounded border border-charcoal-600 bg-charcoal-900 px-2 py-1 font-mono text-xs text-text-bright placeholder:text-text-dimmed focus:outline-none"
            />
            <p className="text-[10px] text-amber-400">
              No environment variables set yet.{" "}
              <a href="#" className="underline" onClick={onDone}>
                Add one in Environment Variables first.
              </a>
            </p>
          </>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-text-dimmed cursor-pointer">
          <input type="checkbox" name="isDefault" value="true" className="size-3 accent-emerald-500" />
          Set as default key for this provider
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onDone}
            className="text-[11px] text-text-dimmed hover:text-text-bright"
          >
            Cancel
          </button>
          <Button variant="primary/small" type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add key"}
          </Button>
        </div>
      </div>
    </fetcher.Form>
  );
}
