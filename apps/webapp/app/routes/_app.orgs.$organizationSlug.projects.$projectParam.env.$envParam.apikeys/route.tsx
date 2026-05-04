import { BookOpenIcon, KeyIcon, ShieldCheckIcon } from "@heroicons/react/20/solid";
import { useFetcher, type MetaFunction } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import {
  EnvironmentCombo,
  environmentFullTitle,
  environmentTextClassName,
} from "~/components/environments/EnvironmentLabel";
import { RegenerateApiKeyModal } from "~/components/environments/RegenerateApiKeyModal";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import * as Property from "~/components/primitives/PropertyTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ApiKeysPresenter } from "~/presenters/v3/ApiKeysPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `API keys | Platos`,
    },
  ];
};

type PlatosKey = {
  keyPrefix: string;
  allowedOrigins: string[];
  lastUsedAt: string | null;
  createdAt: string;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  try {
    const presenter = new ApiKeysPresenter();
    const { environment, hasVercelIntegration } = await presenter.call({
      userId,
      projectSlug: projectParam,
      environmentSlug: envParam,
    });

    // Fetch Platos agent access key — non-fatal
    let platosKey: PlatosKey | null = null;
    try {
      const project = await findProjectBySlug(organizationSlug, projectParam, userId);
      if (project) {
        const env = await findEnvironmentBySlug(project.id, envParam, userId);
        if (env) {
          const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
          const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key`, {
            headers: {
              "X-Platos-Organization-Id": project.organizationId,
              "X-Platos-Project-Id": project.id,
              "X-Platos-Environment-Id": env.id,
              "X-Platos-User-Id": userId,
            },
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const data = (await res.json()) as { key: PlatosKey };
            platosKey = data.key ?? null;
          }
        }
      }
    } catch {
      // agent service unavailable — show empty state
    }

    return typedjson({
      environment,
      hasVercelIntegration,
      platosKey,
    });
  } catch (error) {
    console.error(error);
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
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) return { ok: false as const, error: "Environment not found" };

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const scopeHeaders = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": project.organizationId,
    "X-Platos-Project-Id": project.id,
    "X-Platos-Environment-Id": environment.id,
    "X-Platos-User-Id": userId,
  };

  const fd = await request.formData();
  const intent = String(fd.get("intent") || "");

  if (intent === "generate-platos-key") {
    try {
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key`, {
        method: "POST",
        headers: scopeHeaders,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      const data = (await res.json()) as { rawKey?: string };
      return { ok: true as const, rawKey: data.rawKey ?? null };
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
      return { ok: true as const, rawKey: null };
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
      const res = await fetch(`${AGENT_API_URL}/api/v1/agent/access-key`, {
        method: "PATCH",
        headers: scopeHeaders,
        body: JSON.stringify({ allowedOrigins: origins }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { ok: false as const, error: `Agent error ${res.status}` };
      return { ok: true as const, rawKey: null };
    } catch {
      return { ok: false as const, error: "Agent service unavailable" };
    }
  }

  return { ok: false as const, error: `Unknown intent: ${intent}` };
};

// ─── Platos Access Key section ───────────────────────────────────────────────

function PlatosAccessKeySection({ initialKey }: { initialKey: PlatosKey | null }) {
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";

  // After generate, the raw key comes back once in action data
  const actionData = fetcher.data;
  const rawKey =
    actionData && "rawKey" in actionData && actionData.rawKey ? actionData.rawKey : null;
  const isDeleted =
    actionData && "ok" in actionData && actionData.ok && "rawKey" in actionData && actionData.rawKey === null && fetcher.formData?.get("intent") === "delete-platos-key";

  const currentKey = isDeleted ? null : initialKey;
  const [originsText, setOriginsText] = useState(
    initialKey?.allowedOrigins.join("\n") ?? "",
  );

  return (
    <div className="flex flex-col gap-4 rounded border border-charcoal-700 bg-charcoal-900/30 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4 text-emerald-500" />
        <Header3 className="text-sm font-semibold text-text-bright">
          Platos Agent Access Key
        </Header3>
      </div>
      <p className="text-xs text-text-dimmed">
        Used by external consumers and the <InlineCode variant="extra-small">@platos/client</InlineCode> SDK
        to authenticate with the Platos agent runtime via Bearer token. Scoped to this environment.
      </p>

      {/* Show the raw key ONCE after generation */}
      {rawKey && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 flex flex-col gap-2">
          <p className="text-xs font-semibold text-amber-300 flex items-center gap-1.5">
            <KeyIcon className="size-3.5" />
            New access key — copy it now. It will NOT be shown again.
          </p>
          <ClipboardField
            className="w-full max-w-none font-mono"
            value={rawKey}
            variant={"secondary/small"}
          />
        </div>
      )}

      {fetcher.data && "error" in fetcher.data && (
        <p className="text-xs text-rose-400">{fetcher.data.error}</p>
      )}

      {currentKey ? (
        <div className="flex flex-col gap-4">
          {/* Key info row */}
          <InputGroup fullWidth>
            <Label>Access key</Label>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-text-bright bg-charcoal-800 border border-charcoal-600 rounded px-3 py-1.5 flex-1">
                {currentKey.keyPrefix}••••••••••••••••
              </span>
              <fetcher.Form method="post" className="flex gap-2">
                <input type="hidden" name="intent" value="generate-platos-key" />
                <button
                  type="submit"
                  disabled={isBusy}
                  className="text-xs text-amber-400 hover:text-amber-300 border border-amber-500/40 rounded px-2 py-1.5 disabled:opacity-50 whitespace-nowrap"
                >
                  Regenerate
                </button>
              </fetcher.Form>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="delete-platos-key" />
                <button
                  type="submit"
                  disabled={isBusy}
                  onClick={(e) => {
                    if (!confirm("Delete this access key? All consumers using it will be unable to authenticate.")) {
                      e.preventDefault();
                    }
                  }}
                  className="text-xs text-rose-400 hover:text-rose-300 border border-rose-500/40 rounded px-2 py-1.5 disabled:opacity-50"
                >
                  Delete
                </button>
              </fetcher.Form>
            </div>
            {currentKey.lastUsedAt && (
              <Hint>
                Last used{" "}
                {new Date(currentKey.lastUsedAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </Hint>
            )}
          </InputGroup>

          {/* Allowed origins */}
          <fetcher.Form method="post" className="flex flex-col gap-2">
            <input type="hidden" name="intent" value="update-origins" />
            <InputGroup fullWidth>
              <Label>Allowed Origins</Label>
              <textarea
                name="allowedOrigins"
                rows={3}
                value={originsText}
                onChange={(e) => setOriginsText(e.target.value)}
                placeholder={"https://yourapp.com\nhttps://staging.yourapp.com"}
                className="w-full rounded border border-charcoal-600 bg-charcoal-800 px-2 py-1.5 text-xs font-mono text-text-bright focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <Hint>
                One origin per line. Requests from unlisted origins are rejected (CORS). Leave
                blank to allow all origins (not recommended for production).
              </Hint>
            </InputGroup>
            <button
              type="submit"
              disabled={isBusy}
              className="self-start text-xs bg-charcoal-700 hover:bg-charcoal-600 text-text-bright rounded px-3 py-1.5 disabled:opacity-50"
            >
              {isBusy && fetcher.formData?.get("intent") === "update-origins" ? "Saving…" : "Save origins"}
            </button>
            {fetcher.data && "ok" in fetcher.data && fetcher.data.ok && fetcher.formData?.get("intent") === "update-origins" && (
              <span className="text-xs text-emerald-400">Saved</span>
            )}
          </fetcher.Form>
        </div>
      ) : (
        !rawKey && (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="generate-platos-key" />
            <button
              type="submit"
              disabled={isBusy}
              className="inline-flex items-center gap-2 text-sm bg-emerald-700 hover:bg-emerald-600 text-white rounded px-4 py-2 disabled:opacity-50"
            >
              <KeyIcon className="size-4" />
              {isBusy ? "Generating…" : "Generate Access Key"}
            </button>
          </fetcher.Form>
        )
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Page() {
  const { environment, hasVercelIntegration, platosKey } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  let envBlock = `TRIGGER_SECRET_KEY="${environment.apiKey}"`;
  if (environment.branchName) {
    envBlock += `\nTRIGGER_PREVIEW_BRANCH="${environment.branchName}"`;
  }

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="API keys" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item key={environment.id}>
                <Property.Label>{environment.slug}</Property.Label>
                <Property.Value>{environment.id}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>

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
            <InputGroup fullWidth>
              <div className="flex w-full items-center justify-between">
                <Label>Secret key</Label>
                <RegenerateApiKeyModal
                  id={environment.parentEnvironment?.id ?? environment.id}
                  title={environmentFullTitle(environment)}
                  hasVercelIntegration={hasVercelIntegration}
                  isDevelopment={environment.type === "DEVELOPMENT"}
                />
              </div>
              <ClipboardField
                className="w-full max-w-none"
                secure={`tr_${environment.apiKey.split("_")[1]}_••••••••`}
                value={environment.apiKey}
                variant={"secondary/small"}
              />
              <Hint>
                Set this as your <InlineCode variant="extra-small">TRIGGER_SECRET_KEY</InlineCode>{" "}
                env var in your backend.
              </Hint>
            </InputGroup>
            {environment.branchName && (
              <InputGroup fullWidth>
                <Label>Branch name</Label>
                <ClipboardField
                  className="w-full max-w-none"
                  value={environment.branchName}
                  variant={"secondary/small"}
                />
                <Hint>
                  Set this as your{" "}
                  <InlineCode variant="extra-small">TRIGGER_PREVIEW_BRANCH</InlineCode> env var in
                  your backend.
                </Hint>
              </InputGroup>
            )}
            {environment.type === "DEVELOPMENT" && (
              <Callout variant="info">
                Every team member gets their own dev Secret key. Make sure you're using the one
                above otherwise you will trigger runs on your team member's machine.
              </Callout>
            )}

            <Accordion type="single" collapsible>
              <AccordionItem value="item-1">
                <AccordionTrigger>How to set these environment variables</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-2">
                    <div>
                      You need to set these environment variables in your backend. This allows the
                      SDK to authenticate with Platos.
                    </div>
                    <CodeBlock
                      language="javascript"
                      code={envBlock}
                      showOpenInModal={false}
                      showLineNumbers={false}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* Platos Agent Access Key section */}
            <PlatosAccessKeySection initialKey={platosKey} />
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
