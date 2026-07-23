import {
  BuildingOffice2Icon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigation, type MetaFunction } from "@remix-run/react";
import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// UNIT D (MCP consumption) — the outbound transports the register form
// offers. hosted-* variants exist server-side but are provisioned by a
// different flow, so the dashboard only offers the two remote transports
// that require a caller-supplied URL. Mirrors the server validation in
// `AgentController.registerEntity` (remote-http/remote-sse require a url).
const MCP_TRANSPORTS = [
  { value: "remote-http", label: "Streamable HTTP (remote-http)" },
  { value: "remote-sse", label: "Server-Sent Events (remote-sse)" },
] as const;
type McpTransport = (typeof MCP_TRANSPORTS)[number]["value"];

// HTTP header-name grammar (RFC 7230 token) — validate the key/value editor
// client-side so a bad header name is caught before the POST round-trip.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

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
  // UNIT D — connection-kind discriminator. "wire" = classic inbound platools
  // WebSocket relationship (unchanged); "mcp" = OUTBOUND MCP client (Composio
  // et al.) where Platos consumes an external MCP server.
  const connectionKind = (formData.get("connectionKind") as string | null) === "mcp" ? "mcp" : "wire";

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

  // Wire entities keep the newline-split mcpUrls list; mcp entities ride
  // mcpClient.url instead and legitimately register with an empty mcpUrls.
  const mcpUrls =
    connectionKind === "wire"
      ? mcpUrlsRaw.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];

  // UNIT D — build the outbound transport config for mcp entities. Validated
  // both here and server-side (defence-in-depth); the agent is authoritative.
  let mcpClient:
    | {
        transport: McpTransport;
        url: string;
        credsSecretKey?: string;
        headersTemplate?: Record<string, string>;
      }
    | undefined;
  if (connectionKind === "mcp") {
    const transport = ((formData.get("transport") as string | null) || "").trim() as McpTransport;
    const url = ((formData.get("mcpUrl") as string | null) || "").trim();
    const credsSecretKey = ((formData.get("credsSecretKey") as string | null) || "").trim();
    const headersRaw = (formData.get("headersTemplate") as string | null) || "{}";

    if (transport !== "remote-http" && transport !== "remote-sse") {
      return typedjson<ActionResponse>(
        { success: false, error: "Choose an MCP transport (remote-http or remote-sse)." },
        { status: 400 },
      );
    }
    if (!url) {
      return typedjson<ActionResponse>(
        { success: false, error: `An MCP URL is required for transport "${transport}".` },
        { status: 400 },
      );
    }

    let headersTemplate: Record<string, string> = {};
    try {
      const parsed = JSON.parse(headersRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          const name = String(k).trim();
          if (!name) continue;
          if (!HEADER_NAME_RE.test(name)) {
            return typedjson<ActionResponse>(
              { success: false, error: `"${name}" is not a valid HTTP header name.` },
              { status: 400 },
            );
          }
          headersTemplate[name] = String(v);
        }
      }
    } catch {
      return typedjson<ActionResponse>(
        { success: false, error: "Header template must be valid JSON." },
        { status: 400 },
      );
    }

    mcpClient = {
      transport,
      url,
      ...(credsSecretKey ? { credsSecretKey } : {}),
      ...(Object.keys(headersTemplate).length > 0 ? { headersTemplate } : {}),
    };
  }

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
        connectionKind,
        ...(mcpClient ? { mcpClient } : {}),
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      }),
      signal: AbortSignal.timeout(15000),
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

    // UNIT D — an mcp entity's auto-minted serviceSecret is never used (outbound
    // dispatch isn't HMAC-signed WS), so skip the initial-secret flash — showing
    // "save this secret forever" copy for a secret the operator never needs is
    // misleading. Land them on the entity detail page instead, where the MCP
    // transport config + discovery status (kicked server-side on register)
    // render. Matches the "Register & Discover Tools" button.
    if (connectionKind === "mcp") {
      return redirect(
        `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/agent-entities/${entity.entityId}`,
      );
    }

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

// UNIT D — one editable header row for the mcp headers-template editor.
type HeaderRow = { id: string; name: string; value: string };
function nextHeaderId(): string {
  return `h-${Math.random().toString(36).slice(2, 10)}`;
}

export default function NewEntityPage() {
  const { agentWsUrl } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData() as ActionResponse | undefined;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [entityId, setEntityId] = useState("");
  const { state: availability, checkNow } = useEntityAvailability(entityId);

  // UNIT D — connection-kind toggle + mcp transport fields.
  const [connectionKind, setConnectionKind] = useState<"wire" | "mcp">("wire");
  const [transport, setTransport] = useState<McpTransport>("remote-http");
  const [mcpUrl, setMcpUrl] = useState("");
  const [credsSecretKey, setCredsSecretKey] = useState("");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([
    { id: nextHeaderId(), name: "Authorization", value: "Bearer {{secret}}" },
  ]);

  const isMcp = connectionKind === "mcp";

  // Serialize the header rows into the `{ header: valueTemplate }` object the
  // agent expects. Empty-named rows are dropped.
  const headersTemplateJson = useMemo(() => {
    const obj: Record<string, string> = {};
    for (const r of headerRows) {
      const name = r.name.trim();
      if (!name) continue;
      obj[name] = r.value;
    }
    return JSON.stringify(obj);
  }, [headerRows]);

  const headerNameErrors = headerRows.some(
    (r) => r.name.trim() !== "" && !HEADER_NAME_RE.test(r.name.trim()),
  );

  const addHeader = () =>
    setHeaderRows((prev) => [...prev, { id: nextHeaderId(), name: "", value: "" }]);
  const removeHeader = (id: string) =>
    setHeaderRows((prev) => prev.filter((r) => r.id !== id));
  const updateHeader = (id: string, patch: Partial<HeaderRow>) =>
    setHeaderRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const submitDisabled =
    isSubmitting ||
    availability.kind === "checking" ||
    availability.kind === "invalid_format" ||
    (isMcp && (!mcpUrl.trim() || headerNameErrors));

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
          {/* Hidden inputs mirror the controlled state so the action receives
              the mcp transport config even though the fields are conditionally
              rendered. */}
          <input type="hidden" name="connectionKind" value={connectionKind} />
          {isMcp && <input type="hidden" name="headersTemplate" value={headersTemplateJson} />}

          <div className="space-y-6">
            {actionData && actionData.success === false && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 flex items-start gap-2">
                <ExclamationTriangleIcon className="size-5 text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-400">{actionData.error}</p>
              </div>
            )}

            {/* UNIT D — connection-kind selector. Segmented control mirroring
                the app's button styling. */}
            <section>
              <Header3>Connection type</Header3>
              <Paragraph variant="small" className="mt-1 mb-3">
                Choose how Platos talks to this entity.
              </Paragraph>
              <div className="inline-flex rounded-lg border border-charcoal-700 bg-charcoal-850 p-1 gap-1">
                <button
                  type="button"
                  onClick={() => setConnectionKind("wire")}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    connectionKind === "wire"
                      ? "bg-charcoal-700 text-text-bright"
                      : "text-text-dimmed hover:text-text-bright"
                  }`}
                >
                  Wire (inbound WebSocket)
                </button>
                <button
                  type="button"
                  onClick={() => setConnectionKind("mcp")}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    connectionKind === "mcp"
                      ? "bg-charcoal-700 text-text-bright"
                      : "text-text-dimmed hover:text-text-bright"
                  }`}
                >
                  MCP (outbound client)
                </button>
              </div>
              <Paragraph variant="small" className="mt-3">
                {connectionKind === "wire"
                  ? "Your backend connects to Platos over WebSocket and pushes tools via the platools SDK. Platos mints a service secret it uses for HMAC-signed tool calls."
                  : `Platos connects OUT to an external MCP server (Composio, a hosted MCP endpoint, etc.), discovers its tools, and dispatches to it. The connection URL can embed {{endUserId}} for per-user binding. WS URL for reference: ${agentWsUrl}.`}
              </Paragraph>
            </section>

            <section>
              <Header3>Entity Identity</Header3>
              <div className="mt-3 space-y-4">
                <Fieldset>
                  <label className="text-xs text-text-dimmed font-medium">Entity ID (unique identifier, lowercase, no spaces)</label>
                  <Input
                    name="entityId"
                    placeholder={isMcp ? "composio-gmail" : "winsen-prod"}
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
                  <Input name="displayName" placeholder={isMcp ? "Gmail (Composio)" : "Winsen Production"} required />
                </Fieldset>
              </div>
            </section>

            {/* WIRE branch — MCP URLs list (unchanged behaviour). */}
            {!isMcp && (
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
            )}

            {/* MCP branch — outbound transport config. */}
            {isMcp && (
              <section>
                <Header3>MCP transport</Header3>
                <Paragraph variant="small" className="mt-1 mb-3">
                  How Platos reaches the external MCP server and authenticates each request.
                </Paragraph>
                <div className="space-y-4">
                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">Transport</label>
                    <select
                      name="transport"
                      value={transport}
                      onChange={(e) => setTransport(e.currentTarget.value as McpTransport)}
                      className="w-full rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2 text-sm text-text-bright"
                    >
                      {MCP_TRANSPORTS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </Fieldset>

                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">MCP URL</label>
                    <Input
                      name="mcpUrl"
                      value={mcpUrl}
                      onChange={(e) => setMcpUrl(e.currentTarget.value)}
                      placeholder="https://mcp.composio.dev/gmail/{{endUserId}}"
                      className="font-mono"
                      required
                    />
                    <p className="mt-1 text-[11px] text-text-dimmed leading-relaxed">
                      Embed{" "}
                      <code className="font-mono text-text-bright">{"{{endUserId}}"}</code>{" "}
                      to bind the connection per end-user (resolves to the
                      user's <span className="font-mono">linkedExternalId</span>{" "}
                      — the Composio user_id — when set, otherwise the opaque
                      external user id).
                    </p>
                  </Fieldset>

                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">
                      Credentials secret key (optional)
                    </label>
                    <Input
                      name="credsSecretKey"
                      value={credsSecretKey}
                      onChange={(e) => setCredsSecretKey(e.currentTarget.value)}
                      placeholder="COMPOSIO_API_KEY"
                      className="font-mono"
                    />
                    <p className="mt-1 text-[11px] text-text-dimmed leading-relaxed">
                      The <span className="font-mono">bare SecretStore variable name</span>{" "}
                      (not the secret itself) whose value is substituted for{" "}
                      <code className="font-mono text-text-bright">{"{{secret}}"}</code>{" "}
                      in the header templates below. Set the value under Environment
                      Secrets.
                    </p>
                  </Fieldset>

                  <Fieldset>
                    <label className="text-xs text-text-dimmed font-medium">Header template</label>
                    <p className="mb-2 text-[11px] text-text-dimmed leading-relaxed">
                      Sent on every outbound request. Values may embed{" "}
                      <code className="font-mono text-text-bright">{"{{secret}}"}</code>{" "}
                      and{" "}
                      <code className="font-mono text-text-bright">{"{{endUserId}}"}</code>.
                    </p>
                    <div className="space-y-2">
                      {headerRows.map((row) => {
                        const invalid =
                          row.name.trim() !== "" && !HEADER_NAME_RE.test(row.name.trim());
                        return (
                          <div key={row.id} className="flex items-center gap-2">
                            <Input
                              placeholder="Header name (e.g. Authorization)"
                              value={row.name}
                              onChange={(e) => updateHeader(row.id, { name: e.currentTarget.value })}
                              className={`w-56 ${invalid ? "border-red-500/50" : ""}`}
                            />
                            <Input
                              placeholder="Value (e.g. Bearer {{secret}})"
                              value={row.value}
                              onChange={(e) => updateHeader(row.id, { value: e.currentTarget.value })}
                              className="flex-1 font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => removeHeader(row.id)}
                              className="text-red-400 hover:text-red-300 shrink-0"
                              aria-label="remove header"
                            >
                              <TrashIcon className="size-4" />
                            </button>
                          </div>
                        );
                      })}
                      {headerNameErrors && (
                        <p className="text-xs text-red-400">
                          One or more header names are not valid HTTP header tokens.
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="tertiary/small"
                        LeadingIcon={PlusIcon}
                        onClick={addHeader}
                      >
                        Add header
                      </Button>
                    </div>
                  </Fieldset>
                </div>
              </section>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary/medium" disabled={submitDisabled}>
                {isSubmitting
                  ? "Registering..."
                  : isMcp
                    ? "Register & Discover Tools"
                    : "Generate Secret & Register"}
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
