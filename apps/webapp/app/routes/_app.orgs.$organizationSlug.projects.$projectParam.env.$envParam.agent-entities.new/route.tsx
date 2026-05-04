import {
  BuildingOffice2Icon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation, type MetaFunction } from "@remix-run/react";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { storeInitialSecret } from "~/services/initialSecretStorage.server";
import { telemetry } from "~/services/telemetry.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Connect Entity | Platos" }];

// PIFSP-3 Deliverable 1 — canonical entity-id regex. Lowercase letters,
// digits, hyphens; 1-64 chars; no leading/trailing hyphen. Keep this in
// sync with `AgentController.ENTITY_ID_REGEX` on the server — both sides
// must agree or the live check says "available" + the POST then 400s.
const ENTITY_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$|^[a-z0-9]$/;

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUserId(request);
  // Resolve params so we 404 on bad URLs, even though the loader doesn't
  // currently need the resolved scope.
  EnvironmentParamSchema.parse(params);
  return typedjson({
    agentApiUrl: process.env.PLATOS_AGENT_API_URL || "http://localhost:3100",
    // Public WS URL for the entity to connect from its backend (platools SDK).
    // In dev this is localhost; in prod this should be your public hostname.
    agentWsUrl: process.env.PLATOS_AGENT_PUBLIC_WS_URL || process.env.PLATOS_AGENT_API_URL || "http://localhost:3100",
  });
}

type ActionResponse = { success: false; error: string };

export async function action({ request, params }: ActionFunctionArgs): Promise<Response> {
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

  const formData = await request.formData();

  const entityId = ((formData.get("entityId") as string | null) ?? (formData.get("orgId") as string | null))?.trim();
  const displayName = (formData.get("displayName") as string | null)?.trim();
  const mcpUrlsRaw = (formData.get("mcpUrls") as string | null) || "";
  // PIFSP-3: MCP headers + arguments + customParams were dropped from the
  // entity form. Per-tool MCP headers/arguments move to the
  // agent-configuration editor (next ticket) where they actually belong;
  // customParams was a redundant injection vector that duplicated the
  // agent's MCP-arguments feature.

  if (!entityId || !displayName) {
    return typedjson<ActionResponse>({ success: false, error: "entityId and displayName are required" }, { status: 400 });
  }
  // PIFSP-3 Deliverable 1 — stricter server-side regex (mirrors client).
  if (!ENTITY_ID_REGEX.test(entityId)) {
    return typedjson<ActionResponse>(
      {
        success: false,
        error:
          "Entity IDs must be 1-64 characters, lowercase letters/digits/hyphens, " +
          "with no leading or trailing hyphen.",
      },
      { status: 400 },
    );
  }

  const mcpUrls = mcpUrlsRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  try {
    const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
    const res = await fetch(`${AGENT_API_URL}/api/v1/agent/entities`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      },
      body: JSON.stringify({
        entityId,
        displayName,
        mcpUrls,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.text();
      return typedjson<ActionResponse>({ success: false, error: err || `HTTP ${res.status}` }, { status: res.status });
    }
    const entity = (await res.json()) as {
      entityId: string;
      displayName: string;
      plaintextSecret: string;
      mcpUrls?: string[];
    };

    void telemetry.platos.entityConnected({ organizationId: scope.organizationId, entityId: entity.entityId });
    // PPR-70: flash the plaintext through Redis so we never embed it in the
    // action-data JSON. The browser's `useActionData()` therefore never sees
    // the secret — only the dedicated `initial-secret` page (which renders
    // plain HTML with `Cache-Control: no-store`) does, and only once. See
    // `apps/webapp/app/services/initialSecretStorage.server.ts`.
    try {
      const token = await storeInitialSecret(entity.plaintextSecret);
      return redirect(
        `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/agent-entities/${entity.entityId}/initial-secret?token=${token}`,
      );
    } catch (err: any) {
      // Redis misconfigured → we can't flash. Fail loudly rather than
      // fall back to embedding the secret in action data.
      return typedjson<ActionResponse>({
        success: false,
        error: `Entity registered but initial-secret storage failed (${err?.message ?? "unknown"}). Use the Regenerate button on the entity detail page to mint a fresh secret.`,
      }, { status: 500 });
    }
  } catch (err: any) {
    return typedjson<ActionResponse>({ success: false, error: err?.message || "unknown error" }, { status: 500 });
  }
}

/**
 * PIFSP-3 Deliverable 1 — live availability indicator. Tracks idle ·
 * checking · available · taken · invalid_format. Debounces at 500ms;
 * cancels in-flight requests when a new keystroke arrives.
 *
 * Response shape matches `GET /api/v1/agent/entities/check-availability`.
 */
type AvailabilityState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken"; suggestions: string[] }
  | { kind: "invalid_format" }
  | { kind: "error"; message: string };

function useEntityAvailability(input: string) {
  const [state, setState] = useState<AvailabilityState>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runCheck = useCallback(async (value: string) => {
    if (!value) {
      setState({ kind: "idle" });
      return;
    }
    if (!ENTITY_ID_REGEX.test(value)) {
      setState({ kind: "invalid_format" });
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: "checking" });
    try {
      const res = await fetch(
        `entities/check-availability?entityId=${encodeURIComponent(value)}`,
        { signal: ac.signal },
      );
      if (ac.signal.aborted) return;
      if (!res.ok) {
        setState({
          kind: "error",
          message: `Availability check failed (HTTP ${res.status})`,
        });
        return;
      }
      const payload = (await res.json()) as {
        entityId: string;
        available: boolean;
        error?: "invalid_format" | "missing_entity_id";
        suggestions?: string[];
      };
      if (payload.available) {
        setState({ kind: "available" });
      } else if (payload.error === "invalid_format") {
        setState({ kind: "invalid_format" });
      } else {
        setState({ kind: "taken", suggestions: payload.suggestions ?? [] });
      }
    } catch (err: any) {
      if (err?.name === "AbortError") return;
      setState({
        kind: "error",
        message: err?.message ?? "Availability check failed.",
      });
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!input) {
      abortRef.current?.abort();
      setState({ kind: "idle" });
      return;
    }
    // Client-side invalid format is a zero-latency verdict — don't wait for
    // the network round-trip to tell the user about it.
    if (!ENTITY_ID_REGEX.test(input)) {
      abortRef.current?.abort();
      setState({ kind: "invalid_format" });
      return;
    }
    debounceRef.current = setTimeout(() => {
      runCheck(input);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input, runCheck]);

  // On blur — skip the debounce and fire immediately so paste → tab out
  // gets instant feedback.
  const checkNow = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    runCheck(input);
  }, [input, runCheck]);

  return { state, checkNow };
}

export default function NewEntityPage() {
  const { agentWsUrl } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData() as ActionResponse | undefined;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [entityId, setEntityId] = useState("");
  const { state: availability, checkNow } = useEntityAvailability(entityId);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Connect Entity" icon={<BuildingOffice2Icon className="size-5 text-blue-500" />} />
        <PageAccessories>
          <DocsLink slug="connect-entity-platools-ts" kind="guides" label="Guide" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Form method="post" className="max-w-2xl">
          <div className="space-y-6">
            {actionData && actionData.success === false && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 flex items-start gap-2">
                <ExclamationTriangleIcon className="size-5 text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-400">{actionData.error}</p>
              </div>
            )}

            <section>
              <Header3>What is a Connected Entity?</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                A Connected Entity is an external backend that pushes tools to Platos via WebSocket and accepts HMAC-signed tool-call requests from agents.
                When you register an entity here, Platos mints a service secret. Your backend uses that secret + the WS URL ({agentWsUrl}) to connect.
              </Paragraph>
            </section>

            <section>
              <Header3>Entity Identity</Header3>
              <div className="mt-3 space-y-4">
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Entity ID (unique identifier, lowercase, no spaces)</label>
                  <Input
                    name="entityId"
                    placeholder="winsen-prod"
                    required
                    autoFocus
                    value={entityId}
                    onChange={(e) => setEntityId(e.currentTarget.value.trim())}
                    onBlur={checkNow}
                  />
                  {/* PIFSP-3 Deliverable 1 — reserved helper row (24px).
                      Height is fixed even in `idle` to prevent layout jump
                      while the user types. */}
                  <AvailabilityIndicator
                    state={availability}
                    onPickSuggestion={(suggestion) => setEntityId(suggestion)}
                  />
                </Fieldset>
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Display Name</label>
                  <Input name="displayName" placeholder="Winsen Production" required />
                </Fieldset>
              </div>
            </section>

            <section>
              <Header3>MCP URLs (optional)</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                One URL per line. Used only if the entity has multiple MCP endpoints it wants Platos to reference directly. Leave empty if all tool execution goes through the WebSocket sync.
              </Paragraph>
              <Fieldset>
                <textarea
                  name="mcpUrls"
                  rows={3}
                  className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright font-mono resize-y"
                  placeholder={"https://api.winsen.app/mcp\nhttps://billing.winsen.app/mcp"}
                />
              </Fieldset>
            </section>

            {/*
              PIFSP-3 Deliverable 3 — "Custom Params" JSON block removed.
              Per-agent arg injection lives on the agent-configuration
              editor ("MCP arguments") where it belongs. Also drops the
              MCP headers section (Deliverable 4) that some branches had
              added here.
              TODO(PIFSP agent-config ticket): build the "MCP headers"
              and "MCP arguments" editor there. These fields are intentionally
              NOT part of the entity form anymore.
            */}

            <div className="flex items-center gap-3">
              <Button
                type="submit"
                variant="primary/medium"
                disabled={
                  isSubmitting ||
                  availability.kind === "checking" ||
                  availability.kind === "invalid_format"
                }
              >
                {isSubmitting ? "Registering..." : "Generate Secret & Register"}
              </Button>
              <LinkButton to=".." variant="tertiary/medium">Cancel</LinkButton>
            </div>
          </div>
        </Form>
      </PageBody>
    </PageContainer>
  );
}

/**
 * PIFSP-3 Deliverable 1 — visual availability indicator. Height stays
 * fixed at 28px (`h-7`) so the surrounding layout never shifts as the
 * state transitions idle → checking → available/taken/invalid.
 */
function AvailabilityIndicator({
  state,
  onPickSuggestion,
}: {
  state: AvailabilityState;
  onPickSuggestion: (value: string) => void;
}) {
  return (
    <div className="mt-1 h-7 flex items-center text-xs">
      {state.kind === "idle" && <span className="text-text-dimmed/0">·</span>}
      {state.kind === "checking" && (
        <span className="text-text-dimmed flex items-center gap-1.5">
          <span
            className="inline-block size-3 rounded-full border-2 border-text-dimmed/40 border-t-text-dimmed animate-spin"
            aria-hidden
          />
          Checking availability…
        </span>
      )}
      {state.kind === "available" && (
        <span className="text-emerald-400 flex items-center gap-1.5">
          <CheckCircleIcon className="size-4" />
          Available
        </span>
      )}
      {state.kind === "invalid_format" && (
        <span className="text-amber-400 flex items-center gap-1.5">
          <ExclamationTriangleIcon className="size-4" />
          Entity IDs must be lowercase letters, digits, and dashes. 1-64
          chars. No leading or trailing hyphen.
        </span>
      )}
      {state.kind === "taken" && (
        <span className="text-red-400 flex items-center gap-1.5 flex-wrap">
          <ExclamationCircleIcon className="size-4" />
          That ID is already in this project.
          {state.suggestions.length > 0 && (
            <>
              <span className="text-text-dimmed">Try one of:</span>
              {state.suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onPickSuggestion(s)}
                  className="px-1.5 py-0.5 rounded border border-charcoal-600 bg-charcoal-800 text-text-bright font-mono hover:border-blue-500/50"
                >
                  {s}
                </button>
              ))}
            </>
          )}
        </span>
      )}
      {state.kind === "error" && (
        <span className="text-text-dimmed flex items-center gap-1.5">
          <ExclamationTriangleIcon className="size-4 text-amber-400" />
          {state.message}
        </span>
      )}
    </div>
  );
}
