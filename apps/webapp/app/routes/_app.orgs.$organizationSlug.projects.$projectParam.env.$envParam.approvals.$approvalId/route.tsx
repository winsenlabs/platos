/**
 * MCP approval-UI — per-approval detail page.
 *
 * The Platform MCP router's pending-approval JSON-RPC error embeds a
 * link to this page. An operator lands here, reads the redacted args
 * + tool description, and approves or rejects. Approving stamps the
 * row → the next MCP `tools/call` retrying with `X-Platos-Approval-Id`
 * actually executes; rejecting closes the call permanently.
 */

import {
  ArrowLeftIcon,
  PencilSquareIcon,
  ShieldCheckIcon,
} from "@heroicons/react/20/solid";
import {
  Form,
  Link,
  useNavigation,
  type MetaFunction,
} from "@remix-run/react";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { DocsLink } from "~/components/primitives/DocsLink";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import {
  approvalsPath,
  EnvironmentParamSchema,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => [{ title: "Approval | Platos" }];

const ParamsSchema = EnvironmentParamSchema.extend({
  approvalId: z.string().min(1),
});

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
  updatedAt: string;
  resolvedAt: string | null;
  respondedBy: string | null;
  comment: string | null;
  deadlineAt: string | null;
  secondsRemaining: number | null;
  expired: boolean;
  args: unknown;
  resolution: unknown;
  consumedAt: string | null;
  timeoutSeconds: number;
  /** Wave 2 — operator-edited args, populated when decision was approved_with_edits. */
  editedArgs: unknown;
  editedByUserId: string | null;
};

type LoaderData = {
  agentReachable: boolean;
  row: ApprovalRow | null;
};

async function agentRequest<T>(
  method: "GET" | "POST",
  path: string,
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
  },
  body?: unknown,
): Promise<{ ok: boolean; data: T | null; status: number }> {
  const AGENT_API_URL = process.env.PLATOS_AGENT_API_URL || "http://localhost:3100";
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Organization-Id": scope.organizationId,
        "X-Platos-Project-Id": scope.projectId,
        "X-Platos-Environment-Id": scope.environmentId,
        "X-Platos-User-Id": scope.userId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: T | null = null;
    if (res.ok) {
      try {
        data = (await res.json()) as T;
      } catch {
        data = null;
      }
    }
    return { ok: res.ok, data, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, approvalId } =
    ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

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
    return typedjson<LoaderData>({ agentReachable: false, row: null });
  }

  const result = await agentRequest<ApprovalRow>(
    "GET",
    `/api/v1/agent/monitoring/approvals/${encodeURIComponent(approvalId)}`,
    scope,
  );

  return typedjson<LoaderData>({
    agentReachable: true,
    row: result.data,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, approvalId } =
    ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });
  const environment = await findEnvironmentById(envParam, userId, project.id);
  if (!environment) throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const form = await request.formData();
  const decision = String(form.get("decision") || "");
  const comment = (form.get("comment") as string | null) || undefined;
  const editedArgsRaw = (form.get("editedArgs") as string | null) || "";
  if (
    decision !== "approve" &&
    decision !== "reject" &&
    decision !== "approve_with_edits"
  ) {
    return typedjson(
      { ok: false, error: "decision must be approve | reject | approve_with_edits" },
      { status: 400 },
    );
  }

  let editedArgs: Record<string, unknown> | undefined;
  if (decision === "approve_with_edits") {
    if (!editedArgsRaw.trim()) {
      return typedjson(
        { ok: false, error: "editedArgs required for approve_with_edits decision" },
        { status: 400 },
      );
    }
    try {
      const parsed = JSON.parse(editedArgsRaw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return typedjson(
          { ok: false, error: "editedArgs must be a JSON object" },
          { status: 400 },
        );
      }
      editedArgs = parsed as Record<string, unknown>;
    } catch (err) {
      return typedjson(
        {
          ok: false,
          error: `editedArgs is not valid JSON: ${
            err instanceof Error ? err.message : "parse error"
          }`,
        },
        { status: 400 },
      );
    }
  }

  const approved = decision === "approve" || decision === "approve_with_edits";

  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    userId,
  };

  const result = await agentRequest<{ resolved: boolean }>(
    "POST",
    `/api/v1/agent/approvals/${encodeURIComponent(approvalId)}/resolve`,
    scope,
    {
      approved,
      comment,
      ...(editedArgs ? { editedArgs } : {}),
    },
  );

  if (!result.ok) {
    return typedjson(
      { ok: false, error: `agent returned ${result.status}` },
      { status: 502 },
    );
  }

  return redirect(
    `${approvalsPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { id: envParam },
    )}?status=pending`,
  );
}

function statusVariant(status: string): "success" | "error" | "outline-rounded" {
  if (status === "approved") return "success";
  if (status === "rejected" || status === "timed_out") return "error";
  return "outline-rounded";
}

/**
 * Stable JSON stringification for comparing the editor textarea against
 * the original args. Two values are equal iff they parse to deep-equal
 * JSON. Falls back to `JSON.stringify` ordering when the keys match
 * insertion order; for our use case (operator pasted JSON they just
 * read) this is sufficient — round-tripping through parse + stringify
 * normalizes whitespace + trailing commas the operator may have typed.
 */
function normalizeJsonText(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

export default function ApprovalDetailPage() {
  const data = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [comment, setComment] = useState("");
  const [confirming, setConfirming] = useState<
    "approve" | "approve_with_edits" | "reject" | null
  >(null);

  const submitting = navigation.state === "submitting";
  const queueHref = approvalsPath(organization, project, environment);

  if (!data.agentReachable) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Approval" />
        </NavBar>
        <PageBody>
          <Paragraph className="text-amber-300">
            Agent service is not reachable. Approval detail cannot be loaded.
          </Paragraph>
        </PageBody>
      </PageContainer>
    );
  }

  const row = data.row;
  if (!row) {
    return (
      <PageContainer>
        <NavBar>
          <PageTitle title="Approval not found" />
        </NavBar>
        <PageBody>
          <Paragraph className="text-text-dimmed">
            This approval id is not visible in the current scope. It may
            have been resolved, expired beyond the retention window, or
            opened in a different environment.
          </Paragraph>
          <Link to={queueHref} className="mt-4 inline-flex items-center gap-1 text-sm text-blue-400 hover:underline">
            <ArrowLeftIcon className="size-3" />
            Back to approvals queue
          </Link>
        </PageBody>
      </PageContainer>
    );
  }

  const isPending = row.status === "pending" && !row.expired;

  // Wave 2 — editor state for edit-first decisions.
  const originalArgsText = useMemo(
    () => JSON.stringify(row.args ?? {}, null, 2),
    [row.args],
  );
  const originalArgsNormalized = useMemo(
    () => normalizeJsonText(originalArgsText),
    [originalArgsText],
  );
  const [editorText, setEditorText] = useState<string>(originalArgsText);

  // Did the operator change the JSON? Compare normalized forms so
  // whitespace/key-order tweaks alone don't trigger the "Approve with
  // my edits" path.
  const editorNormalized = useMemo(
    () => normalizeJsonText(editorText),
    [editorText],
  );
  const isEdited =
    editorNormalized !== null &&
    originalArgsNormalized !== null &&
    editorNormalized !== originalArgsNormalized;
  const isEmptyEditor = editorText.trim().length === 0;
  const isInvalidJson = !isEmptyEditor && editorNormalized === null;
  const editorParseError = useMemo(() => {
    if (!isInvalidJson || isEmptyEditor) return null;
    try {
      JSON.parse(editorText);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "parse error";
    }
  }, [isInvalidJson, isEmptyEditor, editorText]);

  // Buttons enabled state.
  const canApproveAsIs = !submitting && !isEdited && !isInvalidJson && !isEmptyEditor;
  const canApproveWithEdits =
    !submitting && isEdited && !isInvalidJson && !isEmptyEditor;
  // Reject is always available while pending — the operator may not
  // have touched the editor at all.
  const canReject = !submitting;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={row.toolName ?? row.action}
          icon={<ShieldCheckIcon className="size-5 text-amber-400" />}
        />
        <PageAccessories>
          <DocsLink slug="approvals-and-hitl" />
        </PageAccessories>
      </NavBar>
      <PageBody>
        <Link
          to={queueHref}
          className="mb-4 inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
        >
          <ArrowLeftIcon className="size-3" />
          Back to approvals queue
        </Link>

        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <h3 className="mb-3 text-sm font-semibold text-text-bright">
              What this will do
            </h3>
            <Paragraph variant="small" className="text-text-dimmed">
              {row.toolName
                ? `Approving will execute the MCP tool ${row.toolName} with the arguments below. Rejecting closes the original call permanently — the operator who triggered it must mint a fresh request.`
                : row.action}
            </Paragraph>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-dimmed">
              <span className="font-medium text-text-bright">Source</span>
              <Badge variant="outline-rounded">{row.source}</Badge>
              <span className="font-medium text-text-bright">Status</span>
              <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
              <span className="font-medium text-text-bright">Approval id</span>
              <span className="font-mono">{row.approvalId}</span>
              <span className="font-medium text-text-bright">Opened</span>
              <span>{new Date(row.createdAt).toLocaleString()}</span>
              {row.deadlineAt && (
                <>
                  <span className="font-medium text-text-bright">Expires</span>
                  <span>{new Date(row.deadlineAt).toLocaleString()}</span>
                </>
              )}
              {row.requestedBy && (
                <>
                  <span className="font-medium text-text-bright">Requested by</span>
                  <span className="font-mono">{row.requestedBy}</span>
                </>
              )}
              {row.requestedByMcpTokenId && (
                <>
                  <span className="font-medium text-text-bright">MCP token</span>
                  <span className="font-mono">{row.requestedByMcpTokenId}</span>
                </>
              )}
              {row.respondedBy && (
                <>
                  <span className="font-medium text-text-bright">Resolved by</span>
                  <span className="font-mono">{row.respondedBy}</span>
                </>
              )}
              {row.resolvedAt && (
                <>
                  <span className="font-medium text-text-bright">Resolved at</span>
                  <span>{new Date(row.resolvedAt).toLocaleString()}</span>
                </>
              )}
              {row.consumedAt && (
                <>
                  <span className="font-medium text-text-bright">Executed at</span>
                  <span>{new Date(row.consumedAt).toLocaleString()}</span>
                </>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-bright">
                {isPending ? "Arguments (editable)" : "Arguments (redacted)"}
              </h3>
              {isPending && isEdited && !isInvalidJson && (
                <span className="inline-flex items-center gap-1 rounded-sm bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                  <PencilSquareIcon className="size-3" />
                  modified
                </span>
              )}
            </div>
            {isPending ? (
              <>
                <textarea
                  name="editorPreview"
                  value={editorText}
                  onChange={(e) => {
                    setEditorText(e.currentTarget.value);
                    setConfirming(null);
                  }}
                  spellCheck={false}
                  rows={14}
                  className={`max-h-[400px] w-full overflow-auto rounded-sm border bg-charcoal-900 p-3 font-mono text-[11px] text-text-bright ${
                    isInvalidJson
                      ? "border-rose-500/60"
                      : isEdited
                      ? "border-amber-400/60"
                      : "border-charcoal-700"
                  }`}
                />
                {isInvalidJson && (
                  <Paragraph
                    variant="extra-small"
                    className="mt-2 font-mono text-rose-300"
                  >
                    Invalid JSON: {editorParseError ?? "parse error"}
                  </Paragraph>
                )}
                {isEdited && !isInvalidJson && (
                  <Paragraph
                    variant="extra-small"
                    className="mt-2 text-amber-300"
                  >
                    You've made changes — &laquo;Approve with my edits&raquo;
                    will execute YOUR version, not the original. Both copies
                    are kept in the audit trail.
                  </Paragraph>
                )}
                {!isEdited && !isInvalidJson && (
                  <Paragraph variant="extra-small" className="mt-2 text-text-dimmed">
                    Edit the JSON above to change what runs (e.g.
                    <code> count: 100 → count: 10</code>). Secret-shaped
                    fields shown as <code>&lt;redacted&gt;</code> were
                    masked at create-time — leave them alone unless you
                    want to overwrite the masked value.
                  </Paragraph>
                )}
              </>
            ) : (
              <>
                <pre className="max-h-[400px] overflow-auto rounded-sm bg-charcoal-900 p-3 text-[11px] text-text-bright">
                  {JSON.stringify(row.args ?? {}, null, 2)}
                </pre>
                <Paragraph variant="extra-small" className="mt-2 text-text-dimmed">
                  Secret-shaped fields (api keys, tokens, passwords) are
                  redacted before persisting; the actual call uses the
                  original values from the requesting MCP token.
                </Paragraph>
              </>
            )}
          </div>
        </div>

        {/* Wave 2 — when an approval was resolved with edits, show both
            the original args and the operator-edited version side by
            side as the audit trail. */}
        {!isPending &&
          row.editedArgs !== null &&
          row.editedArgs !== undefined && (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-300">
                <PencilSquareIcon className="size-4" />
                Operator-edited arguments
              </h3>
              <pre className="max-h-[300px] overflow-auto rounded-sm bg-charcoal-900 p-3 text-[11px] text-text-bright">
                {JSON.stringify(row.editedArgs ?? {}, null, 2)}
              </pre>
              <Paragraph variant="extra-small" className="mt-2 text-text-dimmed">
                The MCP tool executed with these edited arguments instead
                of the LLM-proposed version above.
                {row.editedByUserId && (
                  <>
                    {" "}Edited by{" "}
                    <span className="font-mono">{row.editedByUserId}</span>.
                  </>
                )}
              </Paragraph>
            </div>
          )}

        {row.consumedAt && row.resolution !== null && row.resolution !== undefined && (
          <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <h3 className="mb-2 text-sm font-semibold text-emerald-300">
              Cached execution result
            </h3>
            <pre className="max-h-[300px] overflow-auto rounded-sm bg-charcoal-900 p-3 text-[11px] text-text-bright">
              {typeof row.resolution === "string"
                ? row.resolution
                : JSON.stringify(row.resolution, null, 2)}
            </pre>
            <Paragraph variant="extra-small" className="mt-2 text-text-dimmed">
              The MCP client received this payload when it retried the
              call with <code>X-Platos-Approval-Id: {row.approvalId}</code>.
            </Paragraph>
          </div>
        )}

        {row.comment && (
          <div className="mb-4 rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <h3 className="mb-2 text-sm font-semibold text-text-bright">Comment</h3>
            <Paragraph variant="small" className="text-text-dimmed whitespace-pre-wrap">
              {row.comment}
            </Paragraph>
          </div>
        )}

        {isPending ? (
          <Form method="post" className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <h3 className="mb-3 text-sm font-semibold text-text-bright">Decision</h3>
            {/* Wave 2 — `editedArgs` rides along on every submit; the
                action ignores it on the no-edit decisions, so we always
                ship the textarea content. The action validates JSON on
                the server too. */}
            <input type="hidden" name="editedArgs" value={editorText} />
            <label className="mb-2 block text-[11px] text-text-dimmed">
              Optional comment (shown in the audit trail and returned
              to the rejecting client):
            </label>
            <textarea
              name="comment"
              value={comment}
              onChange={(e) => setComment(e.currentTarget.value)}
              rows={3}
              maxLength={1000}
              className="mb-3 w-full rounded-sm border border-charcoal-700 bg-charcoal-900 px-2 py-1 text-xs text-text-bright"
              placeholder="e.g. approved after Slack confirmation"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                name="decision"
                value="approve"
                disabled={!canApproveAsIs}
                title={
                  canApproveAsIs
                    ? "Run the tool with the original LLM-proposed arguments."
                    : isEdited
                    ? "Arguments changed — use 'Approve with my edits' instead."
                    : isInvalidJson
                    ? "Fix the JSON in the editor first."
                    : "Cannot approve right now."
                }
                onClick={(e) => {
                  if (confirming !== "approve") {
                    e.preventDefault();
                    setConfirming("approve");
                  }
                }}
                className={`rounded-sm border px-3 py-1 text-xs transition disabled:opacity-40 ${
                  confirming === "approve"
                    ? "border-emerald-400 bg-emerald-500 text-charcoal-900 hover:bg-emerald-400"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                }`}
              >
                {confirming === "approve" ? "Confirm approve as-is" : "Approve as-is"}
              </button>
              <button
                type="submit"
                name="decision"
                value="approve_with_edits"
                disabled={!canApproveWithEdits}
                title={
                  canApproveWithEdits
                    ? "Run the tool with YOUR edited arguments. Both versions are preserved in the audit trail."
                    : isInvalidJson
                    ? "Fix the JSON in the editor first."
                    : !isEdited
                    ? "Edit the arguments in the box above first."
                    : "Cannot approve with edits right now."
                }
                onClick={(e) => {
                  if (confirming !== "approve_with_edits") {
                    e.preventDefault();
                    setConfirming("approve_with_edits");
                  }
                }}
                className={`inline-flex items-center gap-1 rounded-sm border px-3 py-1 text-xs transition disabled:opacity-40 ${
                  confirming === "approve_with_edits"
                    ? "border-amber-400 bg-amber-500 text-charcoal-900 hover:bg-amber-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                }`}
              >
                <PencilSquareIcon className="size-3" />
                {confirming === "approve_with_edits"
                  ? "Confirm approve with my edits"
                  : "Approve with my edits"}
              </button>
              <button
                type="submit"
                name="decision"
                value="reject"
                disabled={!canReject}
                onClick={(e) => {
                  if (confirming !== "reject") {
                    e.preventDefault();
                    setConfirming("reject");
                  }
                }}
                className={`rounded-sm border px-3 py-1 text-xs transition disabled:opacity-40 ${
                  confirming === "reject"
                    ? "border-rose-400 bg-rose-500 text-charcoal-900 hover:bg-rose-400"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
                }`}
              >
                {confirming === "reject" ? "Confirm reject" : "Reject"}
              </button>
              {confirming && (
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="text-xs text-text-dimmed hover:text-text-bright"
                >
                  Cancel
                </button>
              )}
            </div>
          </Form>
        ) : (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-850 p-4">
            <Paragraph variant="small" className="text-text-dimmed">
              This approval is no longer pending — its status is{" "}
              <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
              . Resolved approvals stay visible for 90 days for audit
              purposes; resolution + execution result are cached above.
            </Paragraph>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}
