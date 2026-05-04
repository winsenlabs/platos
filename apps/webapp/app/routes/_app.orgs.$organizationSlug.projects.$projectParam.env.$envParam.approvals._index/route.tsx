/**
 * MCP approval-UI — dedicated approvals queue page.
 *
 * The Platform MCP router's pending-approval JSON-RPC response embeds a
 * link to this route's per-approval detail page. This index also acts
 * as a generic queue for the existing waitpoint approvals (request_approval
 * / cancel_run sources) so an operator can triage everything in one
 * place. Mirrors the data shape the agent-monitoring overview uses but
 * with a richer table (status filter, args summary, decision form).
 */

import { ClockIcon, ShieldCheckIcon } from "@heroicons/react/20/solid";
import {
  Link,
  useFetcher,
  useNavigate,
  useRevalidator,
  type MetaFunction,
} from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useEffect, useMemo } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  approvalDetailPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Approvals | Platos" }];

const POLL_INTERVAL_MS = 15_000;

type StatusFilter = "all" | "pending" | "approved" | "rejected" | "timed_out";

type ApprovalRow = {
  id: string;
  approvalId: string;
  source: string;
  status: string;
  action: string;
  toolName: string | null;
  agentId: string | null;
  threadId: string | null;
  requestedBy: string | null;
  requestedByMcpTokenId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  respondedBy: string | null;
  comment: string | null;
  deadlineAt: string | null;
  secondsRemaining: number | null;
  expired: boolean;
  args: unknown;
  consumedAt: string | null;
};

type ApprovalsPayload = {
  rows: ApprovalRow[];
  total: number;
  pendingCount: number;
};

type LoaderData = {
  agentReachable: boolean;
  status: StatusFilter;
  payload: ApprovalsPayload | null;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
};

function parseStatus(raw: string | null | undefined): StatusFilter {
  if (raw === "approved" || raw === "rejected" || raw === "timed_out" || raw === "all") return raw;
  return "pending";
}

async function agentGet<T>(
  path: string,
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
  },
): Promise<T | null> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const url = new URL(request.url);
  const status = parseStatus(url.searchParams.get("status"));

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const { isAgentServiceAvailable } = await import("~/services/platosAgent.server");
  let agentReachable = false;
  try {
    agentReachable = await isAgentServiceAvailable();
  } catch {
    agentReachable = false;
  }

  if (!agentReachable) {
    const empty: LoaderData = {
      agentReachable: false,
      status,
      payload: null,
      scope,
    };
    return typedjson(empty);
  }

  const statusQuery = status === "all" ? "" : `&status=${status}`;
  // 90-day window so resolved rows stay visible long enough for audit
  // trails. Pending rows are never older than `MCP_APPROVAL_TTL_SECONDS`.
  const payload = await agentGet<ApprovalsPayload>(
    `/api/v1/agent/monitoring/approvals?sinceDays=90&limit=200${statusQuery}`,
    scope,
  );

  const out: LoaderData = {
    agentReachable: true,
    status,
    payload,
    scope: {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    },
  };
  return typedjson(out);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } =
    EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  if (intent !== "resolve_approval") {
    return typedjson({ ok: false, error: "unknown intent" }, { status: 400 });
  }
  const approvalId = String(form.get("approvalId") || "");
  const decision = String(form.get("decision") || "");
  if (!approvalId) return typedjson({ ok: false, error: "approvalId missing" }, { status: 400 });
  if (decision !== "approve" && decision !== "reject") {
    return typedjson({ ok: false, error: "decision must be approve | reject" }, { status: 400 });
  }
  const approved = decision === "approve";
  const comment = (form.get("comment") as string | null) || undefined;

  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(
      `${AGENT_API_URL}/api/v1/agent/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Organization-Id": project.organizationId,
          "X-Platos-Project-Id": project.id,
          "X-Platos-Environment-Id": environment.id,
          "X-Platos-User-Id": userId,
        },
        body: JSON.stringify({ approved, comment }),
      },
    );
    if (!res.ok) {
      return typedjson(
        { ok: false, error: `agent returned ${res.status}` },
        { status: 502 },
      );
    }
    return typedjson({ ok: true, approvalId, approved });
  } catch (err) {
    return typedjson(
      { ok: false, error: err instanceof Error ? err.message : "fetch failed" },
      { status: 502 },
    );
  }
}

function fmtSla(row: ApprovalRow): string {
  if (row.status !== "pending") return row.status;
  if (row.expired) return "expired";
  if (row.secondsRemaining === null) return "—";
  const s = row.secondsRemaining;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function statusVariant(row: ApprovalRow): "success" | "error" | "outline-rounded" {
  if (row.status === "approved") return "success";
  if (row.status === "rejected" || row.status === "timed_out" || row.expired) return "error";
  return "outline-rounded";
}

function fmtArgsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "—";
  const keys = Object.keys(args as Record<string, unknown>);
  if (keys.length === 0) return "{}";
  return keys
    .slice(0, 4)
    .map((k) => `${k}`)
    .join(", ") + (keys.length > 4 ? `, +${keys.length - 4}` : "");
}

export default function ApprovalsPage() {
  const data = useTypedLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const resolveFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const setStatus = (s: StatusFilter) => {
    const qs = new URLSearchParams();
    qs.set("status", s);
    navigate(`?${qs.toString()}`, { replace: true });
  };

  // Auto-refresh so a freshly-approved approval drops out of the
  // pending tab without requiring a manual reload.
  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (revalidator.state === "loading") return;
      revalidator.revalidate();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [revalidator]);

  // After resolve fetch lands, refresh.
  useEffect(() => {
    if (resolveFetcher.state === "idle" && resolveFetcher.data?.ok) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveFetcher.state, resolveFetcher.data?.ok]);

  const rows = data.payload?.rows ?? [];
  const pending = useMemo(
    () => rows.filter((r) => r.status === "pending" && !r.expired),
    [rows],
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title="Approvals"
          icon={<ShieldCheckIcon className="size-5 text-amber-400" />}
        />
        <PageAccessories>
          <Badge variant="outline-rounded">{pending.length} pending</Badge>
          <DocsLink slug="approvals-and-hitl" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Paragraph variant="extra-small" className="mb-3 text-text-dimmed">
          Approvals queue for HITL waitpoints (in-conversation
          <code className="mx-1">request_approval</code> /
          <code className="mx-1">cancel_run</code>) and Platform-MCP
          gated tool calls (<code className="mx-1">mcp_tool_call</code>,
          when <code>MCP_INTERACTIVE_APPROVALS=true</code>). Approve to
          let the call run; reject to block it.
        </Paragraph>

        {!data.agentReachable && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            Agent service is not reachable. The approval queue cannot
            be loaded.
          </div>
        )}

        <div className="mb-4 inline-flex overflow-hidden rounded-md border border-charcoal-700">
          {([
            { id: "pending" as StatusFilter, label: "Pending" },
            { id: "approved" as StatusFilter, label: "Approved" },
            { id: "rejected" as StatusFilter, label: "Rejected" },
            { id: "timed_out" as StatusFilter, label: "Expired" },
            { id: "all" as StatusFilter, label: "All" },
          ]).map((opt) => {
            const active = data.status === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setStatus(opt.id)}
                className={`px-3 py-1 text-xs ${
                  active
                    ? "bg-charcoal-750 text-text-bright"
                    : "bg-charcoal-900 text-text-dimmed hover:bg-charcoal-800"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {rows.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-6 text-center">
            <Paragraph variant="extra-small" className="text-text-dimmed">
              No approvals match this filter.
            </Paragraph>
          </div>
        ) : (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Action</TableHeaderCell>
                  <TableHeaderCell>Source</TableHeaderCell>
                  <TableHeaderCell>Args</TableHeaderCell>
                  <TableHeaderCell>Requested by</TableHeaderCell>
                  <TableHeaderCell>SLA</TableHeaderCell>
                  <TableHeaderCell>Opened</TableHeaderCell>
                  <TableHeaderCell>Decision</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const isPending = row.status === "pending" && !row.expired;
                  const detailHref = approvalDetailPath(
                    organization,
                    project,
                    environment,
                    row.approvalId,
                  );
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link
                          to={detailHref}
                          className="flex flex-col hover:underline"
                        >
                          <span
                            className="max-w-[20rem] truncate font-mono text-xs text-text-bright"
                            title={row.toolName ?? row.action}
                          >
                            {row.toolName ?? row.action}
                          </span>
                          <span className="text-[10px] text-text-dimmed">
                            {row.approvalId}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline-rounded">{row.source}</Badge>
                      </TableCell>
                      <TableCell>
                        <span
                          className="font-mono text-[11px] text-text-dimmed"
                          title={JSON.stringify(row.args ?? {}, null, 2)}
                        >
                          {fmtArgsSummary(row.args)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-[11px] text-text-dimmed">
                          {row.requestedBy?.slice(0, 8) ??
                            row.requestedByMcpTokenId?.slice(0, 8) ??
                            "—"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(row)}>
                          <ClockIcon className="mr-1 size-3" />
                          {fmtSla(row)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-text-dimmed">
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        {isPending ? (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={resolveFetcher.state !== "idle"}
                              onClick={() =>
                                resolveFetcher.submit(
                                  {
                                    intent: "resolve_approval",
                                    approvalId: row.approvalId,
                                    decision: "approve",
                                  },
                                  { method: "post" },
                                )
                              }
                              className="rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={resolveFetcher.state !== "idle"}
                              onClick={() =>
                                resolveFetcher.submit(
                                  {
                                    intent: "resolve_approval",
                                    approvalId: row.approvalId,
                                    decision: "reject",
                                  },
                                  { method: "post" },
                                )
                              }
                              className="rounded-sm border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="text-[11px] text-text-dimmed">
                            {row.respondedBy ? `by ${row.respondedBy.slice(0, 8)}` : "—"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {resolveFetcher.data && !resolveFetcher.data.ok && (
              <Paragraph variant="extra-small" className="mt-2 text-rose-400">
                Resolve failed: {resolveFetcher.data.error}
              </Paragraph>
            )}
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}

