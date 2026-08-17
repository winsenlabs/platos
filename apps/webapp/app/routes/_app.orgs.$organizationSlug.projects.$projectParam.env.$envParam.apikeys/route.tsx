import { BookOpenIcon, KeyIcon, ShieldCheckIcon } from "@heroicons/react/20/solid";
import { useFetcher, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { InlineCode } from "~/components/code/InlineCode";
import {
  EnvironmentCombo,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  safeMutationResult,
  sanitizeAccessKeyPayload,
  type SafeAccessKey,
} from "~/services/platosSecretPayloads.server";
import { generateAccessKey } from "~/utils/accessKey.client";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `API keys | Platos`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  try {
    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) throw new Response("Project not found", { status: 404 });
    const environment = await findEnvironmentById(envParam, userId);
    if (environment?.projectId !== project.id) throw new Response("Environment not found", { status: 404 });
    if (!environment) throw new Response("Environment not found", { status: 404 });

    // Fetch Platos agent access key — non-fatal
    let platosKey: SafeAccessKey | null = null;
    let retiringPlatosKey: SafeAccessKey | null = null;
    try {
      const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key`, {
        headers: {
          "X-Platos-Organization-Id": project.organizationId,
          "X-Platos-Project-Id": project.id,
          "X-Platos-Environment-Id": environment.id,
          "X-Platos-User-Id": userId,
        },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = sanitizeAccessKeyPayload(await res.json());
        platosKey = data.key;
        retiringPlatosKey = data.retiringKey;
      }
    } catch {
      // agent service unavailable — show empty state
    }

    return typedjson({
      environment,
      platosKey,
      retiringPlatosKey,
    });
  } catch {
    console.error("API keys loader failed");
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) return { ok: false as const, error: "Project not found" };
  const environment = await findEnvironmentById(envParam, userId);
  if (environment?.projectId !== project.id) return { ok: false as const, error: "Environment not found" };
  if (!environment) return { ok: false as const, error: "Environment not found" };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const scopeHeaders = {
    "X-Platos-Organization-Id": project.organizationId,
    "X-Platos-Project-Id": project.id,
    "X-Platos-Environment-Id": environment.id,
    "X-Platos-User-Id": userId,
  };

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  if (intent === "create-or-rotate-platos-key") {
    if (fd.has("rawKey") || fd.has("key") || fd.has("accessKey")) {
      return { ok: false as const, error: "Raw access keys are not accepted by this action." };
    }
    const keyHash = String(fd.get("keyHash") || "");
    const keyPrefix = String(fd.get("keyPrefix") || "");
    if (!/^[a-f0-9]{64}$/.test(keyHash) || !/^platos_live_[A-Za-z0-9_-]{1,12}$/.test(keyPrefix)) {
      return { ok: false as const, error: "Invalid access key material." };
    }
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key`, {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({ keyHash, keyPrefix }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return safeMutationResult(intent, await res.json());
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  if (intent === "delete-platos-key") {
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key`, {
        method: "DELETE",
        headers: scopeHeaders,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return safeMutationResult(intent);
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  if (intent === "update-origins") {
    const raw = String(fd.get("allowedOrigins") || "");
    const origins = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key/origins`, {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({ origins }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return safeMutationResult(intent, await res.json());
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  return { ok: false as const, error: "Unknown access key operation." };
};

// ─── Platos Access Key section ───────────────────────────────────────────────

type AccessKeyActionData = {
  ok: boolean;
  error?: string;
  intent?: string;
  key?: SafeAccessKey;
  retiringKey?: SafeAccessKey;
};

function PlatosAccessKeySection({
  initialKey,
  retiringKey,
}: {
  initialKey: SafeAccessKey | null;
  retiringKey: SafeAccessKey | null;
}) {
  const fetcher = useFetcher<AccessKeyActionData>();
  const isBusy = fetcher.state !== "idle";
  const [pendingRawKey, setPendingRawKey] = useState<string | null>(null);
  const [revealApproved, setRevealApproved] = useState(false);
  const [generationPending, setGenerationPending] = useState(false);
  const [originsText, setOriginsText] = useState(initialKey?.allowedOrigins.join("\n") ?? "");

  const actionData = fetcher.data;
  const completedIntent = actionData?.intent ?? null;
  const isDeleted = actionData?.ok === true && completedIntent === "delete-platos-key";
  const currentKey = isDeleted ? null : actionData?.key ?? initialKey;
  const currentRetiringKey = actionData?.retiringKey ?? retiringKey;

  useEffect(() => {
    if (!generationPending || fetcher.state !== "idle" || !actionData) return;
    if (actionData.ok && completedIntent === "create-or-rotate-platos-key") {
      setRevealApproved(true);
    } else {
      setPendingRawKey(null);
    }
    setGenerationPending(false);
  }, [actionData, completedIntent, fetcher.state, generationPending]);

  async function createOrRotateKey() {
    setRevealApproved(false);
    const generated = await generateAccessKey();
    setPendingRawKey(generated.rawKey);
    setGenerationPending(true);
    fetcher.submit(
      {
        intent: "create-or-rotate-platos-key",
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
      },
      { method: "post" }
    );
  }

  const revealedKey = revealApproved ? pendingRawKey : null;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-charcoal-700 bg-charcoal-900/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-emerald-500" />
            <Header3 className="text-sm font-semibold text-text-bright">
              Platos Agent Access Key
            </Header3>
            {currentKey && (
              <span className="rounded-full border border-emerald-700 bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-300">
                Active
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-text-dimmed">
            Environment access keys authenticate external consumers and the{" "}
            <InlineCode variant="extra-small">@platosdev/client</InlineCode>. Platos stores only a
            SHA-256 hash; the raw key cannot be recovered later.
          </p>
        </div>
        {currentKey && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void createOrRotateKey()}
              className="rounded border border-amber-500/40 px-2.5 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
            >
              {generationPending ? "Rotating…" : "Rotate key"}
            </button>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="delete-platos-key" />
              <button
                type="submit"
                disabled={isBusy}
                onClick={(event) => {
                  if (
                    !confirm(
                      "Revoke this access key? Consumers using it will be unable to authenticate."
                    )
                  ) {
                    event.preventDefault();
                  }
                }}
                className="rounded border border-rose-500/40 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
              >
                Revoke
              </button>
            </fetcher.Form>
          </div>
        )}
      </div>

      {revealedKey && (
        <div
          className="flex flex-col gap-3 rounded border border-amber-500/40 bg-amber-500/10 p-3"
          data-secret-safe-state="client-memory-one-time-reveal"
        >
          <div>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
              <KeyIcon className="size-3.5" />
              Access key created — copy it now
            </p>
            <p className="mt-1 text-[11px] text-text-dimmed">
              This value exists only in this browser tab's memory. Store it in your secrets manager
              before leaving this state.
            </p>
          </div>
          <ClipboardField
            className="w-full max-w-none font-mono"
            value={revealedKey}
            variant="secondary/small"
          />
          <button
            type="button"
            onClick={() => {
              setPendingRawKey(null);
              setRevealApproved(false);
            }}
            className="self-end rounded border border-charcoal-600 px-3 py-1.5 text-xs text-text-bright hover:bg-charcoal-700"
          >
            Done, I've saved it
          </button>
        </div>
      )}

      {fetcher.data && "error" in fetcher.data && (
        <p className="text-xs text-rose-400">{fetcher.data.error}</p>
      )}

      {currentKey ? (
        <div className="flex flex-col gap-4" data-secret-safe-state="hash-only-metadata">
          <div className="grid gap-px overflow-hidden rounded border border-charcoal-700 bg-charcoal-700 sm:grid-cols-3">
            <AccessKeyMetadata label="Key prefix" value={`${currentKey.keyPrefix}••••••••`} mono />
            <AccessKeyMetadata label="Created" value={formatKeyDate(currentKey.createdAt)} />
            <AccessKeyMetadata
              label="Last used"
              value={currentKey.lastUsedAt ? formatKeyDate(currentKey.lastUsedAt) : "Never"}
            />
          </div>

          {currentRetiringKey?.validUntil && (
            <div className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Previous key prefix{" "}
              <span className="font-mono">{currentRetiringKey.keyPrefix}••••</span> remains valid
              only until {formatKeyDate(currentRetiringKey.validUntil)} for bounded rotation
              overlap.
            </div>
          )}

          <fetcher.Form method="post" className="flex flex-col gap-2">
            <input type="hidden" name="intent" value="update-origins" />
            <InputGroup fullWidth>
              <Label>Allowed Origins</Label>
              <textarea
                name="allowedOrigins"
                rows={3}
                value={originsText}
                onChange={(event) => setOriginsText(event.target.value)}
                placeholder={"https://yourapp.com\nhttps://staging.yourapp.com"}
                className="w-full rounded border border-charcoal-600 bg-charcoal-800 px-2 py-1.5 font-mono text-xs text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <Hint>
                One exact origin per line. Leave blank only when browser-origin restrictions are not
                required.
              </Hint>
            </InputGroup>
            <button
              type="submit"
              disabled={isBusy}
              className="self-start rounded bg-charcoal-700 px-3 py-1.5 text-xs text-text-bright hover:bg-charcoal-600 disabled:opacity-50"
            >
              {isBusy && fetcher.formData?.get("intent") === "update-origins"
                ? "Saving…"
                : "Save origins"}
            </button>
          </fetcher.Form>
        </div>
      ) : (
        !revealedKey && (
          <button
            type="button"
            disabled={isBusy || generationPending}
            onClick={() => void createOrRotateKey()}
            className="inline-flex items-center gap-2 self-start rounded bg-emerald-700 px-4 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            <KeyIcon className="size-4" />
            {generationPending ? "Creating…" : "Create Access Key"}
          </button>
        )
      )}
    </div>
  );
}

function AccessKeyMetadata({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-charcoal-850 p-3">
      <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{label}</div>
      <div className={cn("mt-1 text-xs text-text-bright", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function formatKeyDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Page() {
  const { environment, platosKey, retiringPlatosKey } = useTypedLoaderData<typeof loader>();

  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API keys" />
        <PageAccessories>
          <DocsLink slug="auth-modes" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <MainHorizontallyCenteredContainer>
          <div className="mb-3 border-b border-grid-dimmed pb-1">
            <Header2
              className={cn(
                "inline-flex items-center gap-1 font-normal",
                environmentTextClassName(environment)
              )}
            >
              <EnvironmentCombo
                environment={environment}
                className="text-base"
                iconClassName="size-5"
              />
              API keys
            </Header2>
          </div>
          <div className="flex flex-col gap-6">
            {/* Platos Agent Access Key section */}
            <PlatosAccessKeySection initialKey={platosKey} retiringKey={retiringPlatosKey} />
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
