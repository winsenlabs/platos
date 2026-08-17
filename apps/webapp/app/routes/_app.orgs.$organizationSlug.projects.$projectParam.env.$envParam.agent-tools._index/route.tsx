/**
 * PIFSP-4 — Tools module sweep.
 *
 * Delivers:
 *  1. Client-side search (200ms debounce, name + desc + entityId + category)
 *  2. URL-backed filters: entity, health, status, category + sort
 *  3. CSS content-visibility for smooth scroll through 400+ rows
 *  4. Postman-style test sheet — right-edge Sheet with Headers/Body/Response tabs
 *  5. POST /api/v1/agent/tools/:toolId/test backend endpoint (proxied via action)
 *  6. Keyboard shortcuts: / → search, Esc → close sheet, Cmd+Enter → Send
 *  7. Empty / degraded states
 */

import {
  BoltIcon,
  CheckCircleIcon,
  ClipboardIcon,
  FunnelIcon,
  MagnifyingGlassIcon,
  WrenchScrewdriverIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import {
  Link,
  useFetcher,
  useNavigate,
  useRevalidator,
  useSearchParams,
  type MetaFunction,
} from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Sheet,
  SheetContent,
  SheetHeader,
} from "~/components/primitives/Sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Agent Tools | Platos" }];

// ─── Types ────────────────────────────────────────────────────────────────────

type Scope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
};

type MatrixRow = {
  toolId: string;
  toolName: string;
  description: string;
  category: string | null;
  paramSchema: Record<string, unknown>;
  entityId: string;
  entityPk: string;
  callbackUrl: string;
  enabled: boolean;
  health: {
    lastStatus: string | null;
    failCount: number;
    totalCalls: number;
    totalFailures: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
    lastCalledAt: string | null;
  };
};

type LoaderData = {
  rows: MatrixRow[];
  environmentId: string;
  envSlug: string;
  fetchedAt: string;
  agentReachable: boolean;
  connectEntityPath: string;
};

type TestResult = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
  error?: string;
  upstreamStatus?: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function agentFetch<T>(path: string, scope: Scope): Promise<T> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const res = await fetch(`${AGENT_API_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Platos-Organization-Id": scope.organizationId,
      "X-Platos-Project-Id": scope.projectId,
      "X-Platos-Environment-Id": scope.environmentId,
      "X-Platos-User-Id": scope.userId,
    },
  });
  return (await res.json()) as T;
}

function formatUpdatedAgo(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function healthLabel(row: MatrixRow): "ok" | "degraded" | "error" | "unknown" {
  if (!row.enabled) return "unknown";
  if (row.health.failCount >= 3 || row.health.lastStatus === "failed") return "error";
  if (row.health.lastStatus === "timeout") return "degraded";
  if (row.health.totalCalls === 0) return "unknown";
  return "ok";
}

function fmtMs(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return `${n}ms`;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  const scope: Scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  let rows: MatrixRow[] = [];
  let environmentId = environment.id;
  let fetchedAt = new Date().toISOString();
  let agentReachable = false;

  try {
    const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
    if (await isAgentServiceAvailable()) {
      agentReachable = true;
      const result = await agentFetch<{ environmentId: string; rows: MatrixRow[]; fetchedAt: string }>(
        "/api/v1/agent/tools/matrix",
        scope,
      );
      rows = result.rows ?? [];
      environmentId = result.environmentId ?? environment.id;
      fetchedAt = result.fetchedAt ?? fetchedAt;
    }
  } catch {
    // swallow — renders the empty / unreachable state
  }

  const connectEntityPath = `${v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { id: envParam },
  )}/agent-connect`;

  return typedjson<LoaderData>({ rows, environmentId, envSlug: envParam, fetchedAt, agentReachable, connectEntityPath });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  const scopeHeaders = {
    "Content-Type": "application/json",
    "X-Platos-Organization-Id": project.organizationId,
    "X-Platos-Project-Id": project.id,
    "X-Platos-Environment-Id": environment.id,
    "X-Platos-User-Id": userId,
  };

  const contentType = request.headers.get("content-type") ?? "";

  try {
    // PIFSP-4 test_tool — JSON body with toolId + headers + params.
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as {
        intent: string;
        toolId?: string;
        sourceEntityId?: string;
        headers?: Record<string, string>;
        params?: Record<string, unknown>;
        entityId?: string;
        toolName?: string;
        enabled?: boolean;
      };

      if (body.intent === "test_tool_v2") {
        if (!body.toolId) {
          return typedjson({ ok: false, error: "toolId required" }, { status: 400 });
        }
        const res = await fetch(
          `${AGENT_API_URL}/api/v1/agent/tools/${encodeURIComponent(body.toolId)}/test`,
          {
            method: "POST",
            headers: scopeHeaders,
            body: JSON.stringify({
              sourceEntityId: body.sourceEntityId,
              headers: body.headers ?? {},
              params: body.params ?? {},
            }),
          },
        );
        const json = (await res.json().catch(() => ({ error: `agent returned ${res.status}` }))) as unknown;
        if (!res.ok) {
          return typedjson({ ok: false, ...(json as object) }, { status: res.status === 429 ? 429 : 502 });
        }
        return typedjson({ ok: true, result: json as TestResult });
      }

      return typedjson({ ok: false, error: "unknown intent" }, { status: 400 });
    }

    // Legacy form-data path (toggle_tool).
    const form = await request.formData();
    const intent = String(form.get("intent") || "");

    if (intent === "toggle_tool") {
      const entityId = String(form.get("entityId") || "");
      const toolName = String(form.get("toolName") || "");
      const enabled = form.get("enabled") === "true";
      if (!entityId || !toolName) {
        return typedjson({ ok: false, error: "entityId + toolName required" }, { status: 400 });
      }
      const res = await fetch(
        `${AGENT_API_URL}/api/v1/agent/tools/${encodeURIComponent(entityId)}/${encodeURIComponent(toolName)}/enabled`,
        { method: "PATCH", headers: scopeHeaders, body: JSON.stringify({ enabled }) },
      );
      const body2 = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        return typedjson({ ok: false, error: body2?.error || `agent returned ${res.status}` }, { status: 502 });
      }
      return typedjson({ ok: true, intent: "toggle_tool", enabled, toolName, entityId });
    }

    return typedjson({ ok: false, error: "unknown intent" }, { status: 400 });
  } catch (err) {
    return typedjson(
      { ok: false, error: err instanceof Error ? err.message : "fetch failed" },
      { status: 502 },
    );
  }
}

// ─── Filter / sort helpers ────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: "name-asc", label: "Name A→Z" },
  { value: "name-desc", label: "Name Z→A" },
  { value: "calls-desc", label: "Most called" },
  { value: "calls-asc", label: "Least called" },
  { value: "latency-desc", label: "Slowest (p95)" },
  { value: "failures-desc", label: "Most failures" },
  { value: "last-called-desc", label: "Recently used" },
] as const;

function applyFiltersAndSort(
  rows: MatrixRow[],
  q: string,
  entities: string[],
  healths: string[],
  statusFilter: string,
  categories: string[],
  sort: string,
): MatrixRow[] {
  let filtered = rows;

  // Search — case-insensitive substring on name | desc | entityId | category.
  if (q) {
    const lower = q.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.toolName.toLowerCase().includes(lower) ||
        r.description.toLowerCase().includes(lower) ||
        r.entityId.toLowerCase().includes(lower) ||
        (r.category ?? "").toLowerCase().includes(lower),
    );
  }

  if (entities.length > 0) {
    filtered = filtered.filter((r) => entities.includes(r.entityId));
  }
  if (healths.length > 0) {
    filtered = filtered.filter((r) => healths.includes(healthLabel(r)));
  }
  if (statusFilter === "enabled") filtered = filtered.filter((r) => r.enabled);
  if (statusFilter === "disabled") filtered = filtered.filter((r) => !r.enabled);
  if (categories.length > 0) {
    filtered = filtered.filter((r) => categories.includes(r.category ?? "uncategorized"));
  }

  return [...filtered].sort((a, b) => {
    switch (sort) {
      case "name-desc":
        return b.toolName.localeCompare(a.toolName);
      case "calls-desc":
        return b.health.totalCalls - a.health.totalCalls;
      case "calls-asc":
        return a.health.totalCalls - b.health.totalCalls;
      case "latency-desc":
        return (b.health.p95LatencyMs ?? 0) - (a.health.p95LatencyMs ?? 0);
      case "failures-desc":
        return b.health.totalFailures - a.health.totalFailures;
      case "last-called-desc": {
        const aT = a.health.lastCalledAt ? new Date(a.health.lastCalledAt).getTime() : 0;
        const bT = b.health.lastCalledAt ? new Date(b.health.lastCalledAt).getTime() : 0;
        return bT - aT;
      }
      default: // name-asc
        return a.toolName.localeCompare(b.toolName);
    }
  });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ row }: { row: MatrixRow }) {
  if (!row.enabled) return <Badge variant="outline-rounded">Disabled</Badge>;
  const h = healthLabel(row);
  if (h === "error") return <Badge variant="error">Failing</Badge>;
  if (h === "degraded") return <Badge variant="outline-rounded">Timeout</Badge>;
  if (row.health.totalCalls === 0) return <Badge variant="outline-rounded">Idle</Badge>;
  return <Badge variant="success">Healthy</Badge>;
}

// ─── Test Sheet ───────────────────────────────────────────────────────────────

type SheetTab = "headers" | "body" | "response";
type TestHeader = { name: string; value: string };

function TestSheet({
  tool,
  open,
  onClose,
}: {
  tool: MatrixRow | null;
  open: boolean;
  onClose: () => void;
}) {
  const testFetcher = useFetcher<{ ok: boolean; result?: TestResult; error?: string }>();
  const [tab, setTab] = useState<SheetTab>("body");
  const [customHeaders, setCustomHeaders] = useState<TestHeader[]>([]);
  const [entityHeaders, setEntityHeaders] = useState<TestHeader[]>([]);
  const [bodyValues, setBodyValues] = useState<Record<string, unknown>>({});
  const [rawBody, setRawBody] = useState<string>("");
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch entity test credentials when sheet opens.
  useEffect(() => {
    if (!open || !tool) {
      setEntityHeaders([]);
      setCustomHeaders([]);
      setBodyValues({});
      setRawBody("");
      setTab("body");
      return;
    }

    fetch(
      `?_toolTestCreds=${encodeURIComponent(tool.entityId)}`,
      // We proxy via the loader; the loader ignores this param currently.
      // Instead call the agent API via the resources/agent proxy.
    )
      .then(() => {})
      .catch(() => {});

    // Call through the resources/agent proxy.
    const PROXY = `/resources/agent?path=${encodeURIComponent(
      `/api/v1/agent/entities/${encodeURIComponent(tool.entityId)}/test-credentials`,
    )}`;
    fetch(PROXY)
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json()) as { headers?: TestHeader[] };
        setEntityHeaders(d.headers ?? []);
      })
      .catch(() => {});
  }, [open, tool?.entityId]);

  const isSending = testFetcher.state !== "idle";
  const testResult = testFetcher.data;

  // Build params from schema for the Body tab.
  const schemaProps = useMemo(() => {
    if (!tool) return {};
    const schema = tool.paramSchema as {
      properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
      required?: string[];
    };
    return schema.properties ?? {};
  }, [tool]);

  const schemaRequired = useMemo(() => {
    if (!tool) return new Set<string>();
    const schema = tool.paramSchema as { required?: string[] };
    return new Set(schema.required ?? []);
  }, [tool]);

  const currentParams = useMemo(() => {
    if (rawMode) {
      try { return JSON.parse(rawBody) as Record<string, unknown>; } catch { return {}; }
    }
    return bodyValues;
  }, [rawMode, rawBody, bodyValues]);

  // Cmd+Enter → Send.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isSending) {
        sendTest();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  function sendTest() {
    if (!tool || isSending) return;
    const allHeaders: Record<string, string> = {};
    for (const h of [...entityHeaders, ...customHeaders]) {
      if (h.name && h.value) allHeaders[h.name] = h.value;
    }
    testFetcher.submit(
      JSON.stringify({
        intent: "test_tool_v2",
        toolId: tool.toolId,
        sourceEntityId: tool.entityId,
        headers: allHeaders,
        params: currentParams,
      }),
      { method: "post", encType: "application/json" },
    );
    setTab("response");
  }

  function generateCurl() {
    if (!tool) return;
    const allHeaders: Record<string, string> = {};
    for (const h of [...entityHeaders, ...customHeaders]) {
      if (h.name && h.value) allHeaders[h.name] = h.value;
    }
    const headerStr = Object.entries(allHeaders)
      .map(([k, v]) => `-H '${k}: ${v}'`)
      .join(" ");
    const bodyStr = JSON.stringify(currentParams);
    const cmd = `curl -X POST '${tool.callbackUrl}' ${headerStr} -H 'Content-Type: application/json' -d '${bodyStr}'`;
    navigator.clipboard.writeText(cmd).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Missing required fields.
  const missingRequired = useMemo(
    () =>
      Array.from(schemaRequired).filter(
        (k) => currentParams[k] === undefined || currentParams[k] === "",
      ),
    [schemaRequired, currentParams],
  );

  if (!tool) return null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent position="right" className="w-[480px] flex flex-col overflow-hidden p-0">
        <SheetHeader className="px-4 pt-4 pb-2 border-b border-charcoal-700 flex-shrink-0">
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm truncate text-text-bright">Test: {tool.toolName}</span>
            <button type="button" onClick={onClose} className="ml-2 text-text-dimmed hover:text-text-bright">
              <XMarkIcon className="size-4" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1 mt-2">
            {(["headers", "body", "response"] as SheetTab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1 text-xs rounded capitalize ${
                  tab === t
                    ? "bg-charcoal-700 text-text-bright"
                    : "text-text-dimmed hover:text-text-bright"
                }`}
              >
                {t}
              </button>
            ))}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={generateCurl}
                className="inline-flex items-center gap-1 text-[11px] text-text-dimmed hover:text-text-bright"
                title="Copy as curl"
              >
                {copied ? (
                  <CheckCircleIcon className="size-3.5 text-emerald-400" />
                ) : (
                  <ClipboardIcon className="size-3.5" />
                )}
                {copied ? "Copied!" : "curl"}
              </button>
              <button
                type="button"
                disabled={isSending || missingRequired.length > 0}
                onClick={sendTest}
                className="inline-flex items-center gap-1 px-3 py-1 text-xs bg-amber-500 text-black rounded font-medium disabled:opacity-50 hover:bg-amber-400"
                title={missingRequired.length > 0 ? `Missing: ${missingRequired.join(", ")}` : "Cmd+Enter"}
              >
                <BoltIcon className="size-3" />
                {isSending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
          {missingRequired.length > 0 && (
            <p className="text-[10px] text-rose-300 mt-1">
              Required: {missingRequired.join(", ")}
            </p>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* ── Headers tab ─────────────────────────────────────── */}
          {tab === "headers" && (
            <div className="space-y-3">
              {entityHeaders.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-text-dimmed mb-1.5 uppercase tracking-wider">
                    From entity
                  </p>
                  <div className="rounded border border-charcoal-700 divide-y divide-charcoal-700">
                    {entityHeaders.map((h, i) => (
                      <div key={i} className="flex gap-2 px-2 py-1.5 text-xs">
                        <span className="w-40 truncate font-mono text-text-dimmed">{h.name}</span>
                        <span className="flex-1 truncate font-mono text-text-bright">
                          {h.value.length > 12 ? `•••••${h.value.slice(-4)}` : h.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  {entityHeaders.length === 0 && (
                    <p className="text-[11px] text-text-dimmed">
                      No test credentials configured —{" "}
                      <Link to={`../agent-entities/${tool.entityId}`} className="underline">
                        add them on the entity page
                      </Link>
                    </p>
                  )}
                </div>
              )}
              <div>
                <p className="text-[11px] font-medium text-text-dimmed mb-1.5 uppercase tracking-wider">
                  Custom (this call only)
                </p>
                <div className="space-y-1">
                  {customHeaders.map((h, i) => (
                    <div key={i} className="flex gap-1">
                      <input
                        type="text"
                        placeholder="Name"
                        value={h.name}
                        onChange={(e) => {
                          const next = [...customHeaders];
                          next[i] = { ...h, name: e.target.value };
                          setCustomHeaders(next);
                        }}
                        className="w-32 flex-shrink-0 rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright font-mono"
                      />
                      <input
                        type="text"
                        placeholder="Value"
                        value={h.value}
                        onChange={(e) => {
                          const next = [...customHeaders];
                          next[i] = { ...h, value: e.target.value };
                          setCustomHeaders(next);
                        }}
                        className="flex-1 rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setCustomHeaders((prev) => prev.filter((_, j) => j !== i))}
                        className="text-text-dimmed hover:text-rose-400"
                      >
                        <XMarkIcon className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setCustomHeaders((prev) => [...prev, { name: "", value: "" }])}
                  className="mt-2 text-[11px] text-text-dimmed hover:text-text-bright underline"
                >
                  + Add header
                </button>
              </div>
            </div>
          )}

          {/* ── Body tab ─────────────────────────────────────────── */}
          {tab === "body" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-dimmed">
                  {Object.keys(schemaProps).length} param{Object.keys(schemaProps).length !== 1 ? "s" : ""}
                </span>
                <label className="flex items-center gap-1.5 text-[11px] text-text-dimmed cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rawMode}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setRawBody(JSON.stringify(bodyValues, null, 2));
                      } else {
                        try { setBodyValues(JSON.parse(rawBody) as Record<string, unknown>); } catch {}
                      }
                      setRawMode(e.target.checked);
                    }}
                    className="accent-amber-500"
                  />
                  Raw JSON
                </label>
              </div>

              {rawMode ? (
                <textarea
                  value={rawBody}
                  onChange={(e) => setRawBody(e.target.value)}
                  rows={12}
                  spellCheck={false}
                  className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1.5 text-xs font-mono text-text-bright resize-y"
                />
              ) : Object.keys(schemaProps).length === 0 ? (
                <p className="text-xs text-text-dimmed italic">No parameters defined for this tool.</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(schemaProps).map(([key, def]) => {
                    const isRequired = schemaRequired.has(key);
                    const val = bodyValues[key];
                    return (
                      <div key={key}>
                        <label className="flex items-center gap-1 text-[11px] font-medium text-text-bright mb-0.5">
                          {key}
                          {isRequired && <span className="text-rose-400">*</span>}
                        </label>
                        {def.description && (
                          <p className="text-[10px] text-text-dimmed mb-1">{def.description}</p>
                        )}
                        {def.enum ? (
                          <select
                            value={String(val ?? "")}
                            onChange={(e) =>
                              setBodyValues((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                            className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                          >
                            <option value="">— select —</option>
                            {(def.enum as string[]).map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : def.type === "boolean" ? (
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={Boolean(val)}
                              onChange={(e) =>
                                setBodyValues((prev) => ({ ...prev, [key]: e.target.checked }))
                              }
                              className="accent-amber-500"
                            />
                            {val ? "true" : "false"}
                          </label>
                        ) : def.type === "number" || def.type === "integer" ? (
                          <input
                            type="number"
                            value={typeof val === "number" ? val : ""}
                            onChange={(e) =>
                              setBodyValues((prev) => ({
                                ...prev,
                                [key]: e.target.value === "" ? undefined : Number(e.target.value),
                              }))
                            }
                            className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                          />
                        ) : def.type === "object" || def.type === "array" ? (
                          <textarea
                            value={typeof val === "string" ? val : JSON.stringify(val ?? (def.type === "array" ? [] : {}), null, 2)}
                            onChange={(e) => {
                              try {
                                setBodyValues((prev) => ({ ...prev, [key]: JSON.parse(e.target.value) }));
                              } catch {
                                setBodyValues((prev) => ({ ...prev, [key]: e.target.value }));
                              }
                            }}
                            rows={4}
                            spellCheck={false}
                            className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs font-mono text-text-bright resize-y"
                          />
                        ) : (
                          <input
                            type="text"
                            value={typeof val === "string" ? val : ""}
                            onChange={(e) =>
                              setBodyValues((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                            className="w-full rounded border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Response tab ─────────────────────────────────────── */}
          {tab === "response" && (
            <div className="space-y-3">
              {isSending && (
                <p className="text-xs text-text-dimmed animate-pulse">Sending…</p>
              )}
              {!isSending && !testResult && (
                <p className="text-xs text-text-dimmed italic">Hit "Send" to see a response.</p>
              )}
              {!isSending && testResult && (
                <>
                  {testResult.ok && testResult.result ? (
                    <>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={testResult.result.status < 300 ? "success" : "error"}
                        >
                          {testResult.result.status}
                        </Badge>
                        <span className="text-xs text-text-dimmed">{testResult.result.durationMs}ms</span>
                      </div>
                      <div>
                        <p className="text-[11px] font-medium text-text-dimmed mb-1 uppercase tracking-wider">Body</p>
                        <pre className="max-h-64 overflow-auto rounded border border-charcoal-700 bg-charcoal-900 p-2 text-[11px] font-mono text-text-bright">
                          {typeof testResult.result.body === "string"
                            ? testResult.result.body
                            : JSON.stringify(testResult.result.body, null, 2)}
                        </pre>
                      </div>
                      {Object.keys(testResult.result.headers ?? {}).length > 0 && (
                        <div>
                          <p className="text-[11px] font-medium text-text-dimmed mb-1 uppercase tracking-wider">Response headers</p>
                          <div className="rounded border border-charcoal-700 divide-y divide-charcoal-700">
                            {Object.entries(testResult.result.headers).map(([k, v]) => (
                              <div key={k} className="flex gap-2 px-2 py-1 text-[11px] font-mono">
                                <span className="text-text-dimmed w-40 truncate">{k}</span>
                                <span className="text-text-bright flex-1 truncate">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
                      {testResult.error || "Unknown error"}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;

export default function AgentToolsPage() {
  const { rows, agentReachable, connectEntityPath, envSlug } = useTypedLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const navigate = useNavigate();

  const [lastUpdated, setLastUpdated] = useState<number>(() => Date.now());
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [testTool, setTestTool] = useState<MatrixRow | null>(null);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounce search → URL param.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = useCallback(
    (value: string) => {
      setQ(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (value) next.set("q", value);
            else next.delete("q");
            return next;
          },
          { replace: true },
        );
      }, 200);
    },
    [setSearchParams],
  );

  // Read filter state from URL.
  const entities = useMemo(
    () => searchParams.get("entity")?.split(",").filter(Boolean) ?? [],
    [searchParams],
  );
  const healths = useMemo(
    () => searchParams.get("health")?.split(",").filter(Boolean) ?? [],
    [searchParams],
  );
  const statusFilter = searchParams.get("status") ?? "all";
  const categories = useMemo(
    () => searchParams.get("category")?.split(",").filter(Boolean) ?? [],
    [searchParams],
  );
  const sort = searchParams.get("sort") ?? "name-asc";

  // Derived option lists.
  const allEntities = useMemo(() => [...new Set(rows.map((r) => r.entityId))].sort(), [rows]);
  const allCategories = useMemo(
    () => [...new Set(rows.map((r) => r.category ?? "uncategorized"))].sort(),
    [rows],
  );

  // Filtered + sorted rows.
  const displayRows = useMemo(
    () => applyFiltersAndSort(rows, q, entities, healths, statusFilter, categories, sort),
    [rows, q, entities, healths, statusFilter, categories, sort],
  );

  // Revalidation.
  useEffect(() => { setLastUpdated(Date.now()); }, [rows]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (revalidator.state === "loading") return;
      revalidator.revalidate();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [revalidator]);
  useEffect(() => {
    const tick = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
      if (e.key === "/" && !inInput) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        if (testTool) { setTestTool(null); return; }
        if (document.activeElement === searchRef.current) searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [testTool, navigate]);

  const updatedAgoSeconds = Math.max(0, Math.floor((nowTick - lastUpdated) / 1000));
  const isRevalidating = revalidator.state === "loading";

  function setFilter(key: string, value: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }

  function toggleMulti(key: string, current: string[], item: string) {
    const next = current.includes(item) ? current.filter((x) => x !== item) : [...current, item];
    setFilter(key, next.length > 0 ? next.join(",") : null);
  }

  const hasActiveFilters =
    entities.length > 0 || healths.length > 0 || statusFilter !== "all" || categories.length > 0 || q;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Agent Tools"
          icon={<WrenchScrewdriverIcon className="size-5 text-amber-500" />}
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-text-dimmed">
          {isRevalidating ? (
            <Badge variant="outline-rounded">Refreshing…</Badge>
          ) : (
            <span>Updated {formatUpdatedAgo(updatedAgoSeconds)}</span>
          )}
          <DocsLink slug="tools" />
        </div>
      </NavBar>

      <PageBody>
        {!agentReachable && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            Agent service is not reachable. Tool matrix will repopulate once it comes back online.
            <button type="button" onClick={() => revalidator.revalidate()} className="ml-2 underline">
              Retry
            </button>
          </div>
        )}

        {/* ── Search + filters ───────────────────────────────────── */}
        <div className="mb-4 space-y-2">
          {/* Search */}
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-text-dimmed pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={q}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search tools by name, description, or entity… (/)"
              className="w-full rounded border border-charcoal-700 bg-charcoal-900 pl-8 pr-3 py-1.5 text-sm text-text-bright placeholder:text-text-dimmed focus:outline-none focus:border-amber-500/50"
            />
            {q && (
              <button
                type="button"
                onClick={() => handleSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-dimmed hover:text-text-bright"
              >
                <XMarkIcon className="size-4" />
              </button>
            )}
          </div>

          {/* Filter row */}
          <div className="flex flex-wrap items-center gap-2">
            <FunnelIcon className="size-4 text-text-dimmed flex-shrink-0" />

            {/* Entity filter */}
            {allEntities.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {allEntities.map((eid) => (
                  <button
                    key={eid}
                    type="button"
                    onClick={() => toggleMulti("entity", entities, eid)}
                    className={`px-2 py-0.5 rounded text-[11px] border ${
                      entities.includes(eid)
                        ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                        : "border-charcoal-700 text-text-dimmed hover:text-text-bright"
                    }`}
                  >
                    {eid}
                  </button>
                ))}
              </div>
            )}

            {/* Health filter */}
            <div className="flex gap-1">
              {(["ok", "degraded", "error", "unknown"] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => toggleMulti("health", healths, h)}
                  className={`px-2 py-0.5 rounded text-[11px] border ${
                    healths.includes(h)
                      ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                      : "border-charcoal-700 text-text-dimmed hover:text-text-bright"
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>

            {/* Status toggle */}
            <div className="flex rounded border border-charcoal-700 overflow-hidden text-[11px]">
              {["all", "enabled", "disabled"].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilter("status", s === "all" ? null : s)}
                  className={`px-2 py-0.5 capitalize ${
                    statusFilter === s
                      ? "bg-charcoal-700 text-text-bright"
                      : "text-text-dimmed hover:text-text-bright"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Category filter */}
            {allCategories.length > 1 && (
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) toggleMulti("category", categories, e.target.value);
                }}
                className="rounded border border-charcoal-700 bg-charcoal-900 px-2 py-0.5 text-[11px] text-text-dimmed"
              >
                <option value="">Category…</option>
                {allCategories.map((c) => (
                  <option key={c} value={c}>
                    {c} {categories.includes(c) ? "✓" : ""}
                  </option>
                ))}
              </select>
            )}

            {/* Sort */}
            <select
              value={sort}
              onChange={(e) => setFilter("sort", e.target.value === "name-asc" ? null : e.target.value)}
              className="ml-auto rounded border border-charcoal-700 bg-charcoal-900 px-2 py-0.5 text-[11px] text-text-dimmed"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            {/* Clear all */}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  setSearchParams({}, { replace: true });
                }}
                className="text-[11px] text-rose-400 hover:text-rose-300 underline"
              >
                Clear filters
              </button>
            )}

            <span className="text-[11px] text-text-dimmed ml-1">
              {displayRows.length} of {rows.length}
            </span>
          </div>

          {/* Active category chips */}
          {categories.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleMulti("category", categories, c)}
                  className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded border border-amber-500/60 bg-amber-500/10 text-[11px] text-amber-300"
                >
                  {c} <XMarkIcon className="size-3" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ── Tool matrix ─────────────────────────────────────────── */}
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <WrenchScrewdriverIcon className="size-12 text-charcoal-500" />
            <Paragraph variant="base/bright" className="text-center max-w-md">
              No tools registered yet. Connect an entity&apos;s backend via WebSocket and it will
              push its tool catalog here automatically.
            </Paragraph>
            <Link to={connectEntityPath} className="text-sm underline text-text-bright">
              Connect an entity
            </Link>
          </div>
        ) : displayRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Paragraph variant="small" className="text-text-dimmed">
              No tools match the current filters.
            </Paragraph>
            <button
              type="button"
              onClick={() => {
                setQ("");
                setSearchParams({}, { replace: true });
              }}
              className="text-xs underline text-text-bright"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Tool</TableHeaderCell>
                  <TableHeaderCell>Entity</TableHeaderCell>
                  <TableHeaderCell>Env</TableHeaderCell>
                  <TableHeaderCell>Enabled</TableHeaderCell>
                  <TableHeaderCell>Health</TableHeaderCell>
                  <TableHeaderCell>Calls / Failures</TableHeaderCell>
                  <TableHeaderCell>Latency avg/p95</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayRows.map((row) => (
                  <ToolRowUi
                    key={`${row.toolId}:${row.entityPk}`}
                    row={row}
                    envSlug={envSlug}
                    onTest={() => setTestTool(row)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* ── Test Sheet ────────────────────────────────────────── */}
        <TestSheet tool={testTool} open={testTool !== null} onClose={() => setTestTool(null)} />
      </PageBody>
    </PageContainer>
  );
}

// ─── Tool row ─────────────────────────────────────────────────────────────────

function ToolRowUi({
  row,
  envSlug,
  onTest,
}: {
  row: MatrixRow;
  envSlug: string;
  onTest: () => void;
}) {
  const toggleFetcher = useFetcher<{ ok: boolean; enabled?: boolean; error?: string }>();

  const toggling = toggleFetcher.state !== "idle";
  const optimisticEnabled =
    toggling && toggleFetcher.formData
      ? toggleFetcher.formData.get("enabled") === "true"
      : row.enabled;

  return (
    <TableRow
      // PIFSP-4: CSS content-visibility lets the browser skip paint for off-screen rows,
      // giving smooth scroll through 400+ rows without a virtual-scroll library.
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 72px" } as React.CSSProperties}
    >
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium text-text-bright">{row.toolName}</span>
          <span className="text-text-dimmed text-xs truncate max-w-md">{row.description}</span>
          {row.category && row.category !== "uncategorized" && (
            <span className="mt-0.5">
              <Badge variant="outline-rounded">{row.category}</Badge>
            </span>
          )}
        </div>
      </TableCell>
      {/* Entity column — kept; duplicate chip under description removed (PIFSP-4 D4) */}
      <TableCell>
        <code className="text-xs font-mono text-text-bright">{row.entityId}</code>
      </TableCell>
      <TableCell>
        <Badge variant="outline-rounded">{envSlug}</Badge>
      </TableCell>
      <TableCell>
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            disabled={toggling}
            checked={optimisticEnabled}
            onChange={(e) => {
              toggleFetcher.submit(
                {
                  intent: "toggle_tool",
                  entityId: row.entityId,
                  toolName: row.toolName,
                  enabled: e.currentTarget.checked ? "true" : "false",
                },
                { method: "post" },
              );
            }}
            className="accent-emerald-500"
          />
          {optimisticEnabled ? <Badge variant="success">On</Badge> : <Badge variant="outline-rounded">Off</Badge>}
        </label>
        {toggleFetcher.data && !toggleFetcher.data.ok && (
          <p className="mt-1 text-[10px] text-rose-300">{toggleFetcher.data.error}</p>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge row={row} />
      </TableCell>
      <TableCell>
        <span className="text-xs font-mono text-text-dimmed">
          {row.health.totalCalls} / {row.health.totalFailures}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-xs font-mono text-text-bright">
          {fmtMs(row.health.avgLatencyMs)} / {fmtMs(row.health.p95LatencyMs)}
        </span>
      </TableCell>
      <TableCell>
        <button
          type="button"
          onClick={onTest}
          className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/20"
          title="Open Postman-style test sheet"
        >
          <BoltIcon className="size-3" />
          Test
        </button>
      </TableCell>
    </TableRow>
  );
}
