/**
 * W.3 — Batch run viewer.
 *
 * Renders a per-item progress grid + summary card for runs whose trigger.dev
 * `taskIdentifier === "platos-agent-batch"`. The agent-batch task streams
 * progress events by writing to `metadata.progress` on every per-item state
 * change — we read the run's `metadata` column (JSON string) and pull out the
 * batch header (`batchRunId`, `total`, `label`) + the last `progress` frame.
 *
 * The agent-batch task emits two frame shapes on `metadata.progress`:
 *
 *   { type: "batch_progress", batchRunId, index, total,
 *     status: "running" | "success" | "failed", output?, error? }
 *
 *   { type: "batch_complete", batchRunId, successCount, failureCount,
 *     totalCost }
 *
 * Only the latest frame is retained on the run's metadata (each
 * `metadata.set("progress", ...)` overwrites the previous one). For the v1
 * viewer we therefore reconstruct a best-effort per-item state map by
 * folding in whatever frame is currently on the run: the item referenced by
 * the frame takes the frame's status/output/error, earlier indexes are
 * assumed-success (the task runs sequentially — see
 * `agent-batch.task.ts` concurrency=1) and later indexes are pending.
 *
 * Live updates: the parent route already wires a SSE revalidator
 * (`useEventSource(v3RunStreamingPath ...) → revalidator.revalidate()`) so
 * each new metadata mutation re-runs the loader and we re-render with the
 * latest frame. That mirrors the `run_update` pattern the chat UI uses.
 *
 * TODO(W.3.2): switch to a proper per-item history once
 * `agent-batch.task.ts` is upgraded to emit `metadata.append("items", ...)`
 * instead of overwriting `metadata.progress`. Current single-frame model is
 * correct-only-for-sequential batches.
 */
import { StopCircleIcon } from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { PageBody } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { CancelRunDialog } from "~/components/runs/v3/CancelRunDialog";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { v3RunPath, v3RunStreamingPath } from "~/utils/pathBuilder";

type RunForBatchView = {
  friendlyId: string;
  status: string;
  isFinished: boolean;
  startedAt: string | null;
  completedAt: string | null;
  taskIdentifier: string;
  createdAt: string;
  metadata: string | null;
  metadataType: string;
  costInCents: number;
  baseCostInCents: number;
};

type ItemStatus = "success" | "failed" | "running" | "pending";

type ItemRow = {
  index: number;
  status: ItemStatus;
  output?: string;
  error?: string;
};

type BatchProgressFrame = {
  type: "batch_progress";
  batchRunId?: string;
  index: number;
  total: number;
  status: "running" | "success" | "failed";
  output?: string;
  error?: string;
};

type BatchCompleteFrame = {
  type: "batch_complete";
  batchRunId?: string;
  successCount: number;
  failureCount: number;
  totalCost?: number;
};

type ParsedMetadata = {
  total?: number;
  label?: string | null;
  batchRunId?: string;
  progress?: BatchProgressFrame | BatchCompleteFrame | null;
  /**
   * If a future task version ever writes per-item rows, we pick them up
   * here. Today it's always undefined — see TODO(W.3.2).
   */
  items?: unknown;
};

export const BATCH_TASK_IDENTIFIER = "platos-agent-batch";

function parseMetadata(raw: string | null): ParsedMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as ParsedMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

function fmtCost(cents: number | undefined): string {
  if (cents === undefined || cents === null || Number.isNaN(cents)) return "—";
  return `$${(cents / 100).toFixed(4)}`;
}

function fmtElapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "—";
  const startMs = new Date(startedAt).getTime();
  const endMs = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diff = Math.max(0, endMs - startMs);
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Fold the single retained `progress` frame into an array of ItemRow.
 *
 * Sequential-execution assumption: items before the frame's `index` are
 * treated as `success` (they completed earlier, their frames were
 * overwritten), the frame's own index takes its explicit status, and
 * everything after is `pending`.
 *
 * If the frame is `batch_complete`, we don't know per-item outcomes — we
 * return an empty array and let the caller render the summary-only view.
 */
function buildItemRows(meta: ParsedMetadata): ItemRow[] {
  const total = typeof meta.total === "number" ? meta.total : 0;
  if (total <= 0) return [];

  const frame = meta.progress;
  if (!frame) {
    // No progress frame yet — everything is pending.
    return Array.from({ length: total }, (_, i) => ({ index: i, status: "pending" as const }));
  }

  if (frame.type === "batch_complete") {
    // Terminal; we lost per-item detail — caller falls back to summary-only.
    return [];
  }

  const rows: ItemRow[] = [];
  for (let i = 0; i < total; i++) {
    if (i < frame.index) {
      // Earlier items in a sequential run completed successfully (failures
      // would surface in the final summary; per-item failures before the
      // current index are not recoverable from a single frame).
      rows.push({ index: i, status: "success" });
    } else if (i === frame.index) {
      rows.push({
        index: i,
        status: frame.status,
        output: frame.output,
        error: frame.error,
      });
    } else {
      rows.push({ index: i, status: "pending" });
    }
  }
  return rows;
}

function StatusBadge({ status }: { status: ItemStatus }) {
  const variants: Record<
    ItemStatus,
    {
      label: string;
      className: string;
    }
  > = {
    success: {
      label: "Success",
      className: "bg-emerald-950 text-emerald-300 border-emerald-800",
    },
    failed: {
      label: "Failed",
      className: "bg-rose-950 text-rose-300 border-rose-800",
    },
    running: {
      label: "Running",
      className: "bg-amber-950 text-amber-300 border-amber-800",
    },
    pending: {
      label: "Pending",
      className: "bg-charcoal-800 text-charcoal-300 border-charcoal-700",
    },
  };
  const v = variants[status];
  return (
    <span
      className={cn(
        "grid place-items-center rounded-full px-2 h-5 tracking-wider text-xxs uppercase whitespace-nowrap border",
        v.className
      )}
    >
      {v.label}
    </span>
  );
}

function SummaryCard({
  run,
  meta,
  rows,
}: {
  run: RunForBatchView;
  meta: ParsedMetadata;
  rows: ItemRow[];
}) {
  const complete =
    meta.progress && meta.progress.type === "batch_complete"
      ? (meta.progress as BatchCompleteFrame)
      : null;

  const total = typeof meta.total === "number" ? meta.total : rows.length;
  const succeeded = complete ? complete.successCount : rows.filter((r) => r.status === "success").length;
  const failed = complete ? complete.failureCount : rows.filter((r) => r.status === "failed").length;
  const running = rows.filter((r) => r.status === "running").length;
  const pending = rows.filter((r) => r.status === "pending").length;

  const done = succeeded + failed;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  const totalCostCents = complete?.totalCost ?? run.costInCents;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-charcoal-700 bg-background-bright p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Header2>{meta.label ?? "Agent batch"}</Header2>
          {meta.batchRunId ? (
            <CopyableText
              value={meta.batchRunId}
              variant="text-below"
              className="h-5 px-1.5 font-mono text-xxs"
            />
          ) : null}
        </div>
        <Badge variant={complete ? "success" : "small"}>
          {complete ? "Complete" : running > 0 ? "Running" : "Queued"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total" value={String(total)} />
        <Stat label="Succeeded" value={String(succeeded)} accent="text-emerald-400" />
        <Stat label="Failed" value={String(failed)} accent={failed > 0 ? "text-rose-400" : undefined} />
        <Stat label="In-flight" value={String(running + pending)} />
        <Stat label="Total cost" value={fmtCost(totalCostCents)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-xs text-text-dimmed">
          <span>
            {done}/{total} complete
          </span>
          <span>Elapsed {fmtElapsed(run.startedAt, run.completedAt)}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-800">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              failed > 0 ? "bg-gradient-to-r from-emerald-600 to-rose-600" : "bg-emerald-600"
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xxs uppercase tracking-wider text-text-dimmed">{label}</span>
      <span className={cn("text-lg font-semibold text-text-bright", accent)}>{value}</span>
    </div>
  );
}

function preview(output: string | undefined): string {
  if (!output) return "";
  const s = String(output).replace(/\s+/g, " ").trim();
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

export function BatchRunView({ run }: { run: RunForBatchView }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Live updates: share the existing SSE stream the trace view uses. Every
  // event on the run's trace fires revalidator.revalidate(), which re-runs
  // the parent loader and re-renders this component with fresh metadata.
  const revalidator = useRevalidator();
  const streamedEvents = useEventSource(
    v3RunStreamingPath(organization, project, environment, run),
    {
      event: "message",
      disabled: run.isFinished,
    }
  );
  useEffect(() => {
    if (streamedEvents !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamedEvents]);

  const meta = parseMetadata(run.metadata) ?? {};
  const rows = buildItemRows(meta);
  const complete =
    meta.progress && meta.progress.type === "batch_complete"
      ? (meta.progress as BatchCompleteFrame)
      : null;

  const emptyState = rows.length === 0 && !complete && !meta.total;

  return (
    <PageBody>
      <div className="flex h-full flex-col gap-4 overflow-auto p-4">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Header3>Batch run</Header3>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Task <code className="font-mono text-xxs">{run.taskIdentifier}</code>
            </Paragraph>
          </div>
          {run.isFinished ? null : (
            <Dialog key={`batch-cancel-${run.friendlyId}`}>
              <DialogTrigger asChild>
                <SimpleTooltip
                  button={
                    <span>
                      <Button variant="danger/small" LeadingIcon={StopCircleIcon}>
                        Cancel batch
                      </Button>
                    </span>
                  }
                  content="Cancels the trigger.dev run. TODO(W.3.1): verify mid-flight cancel safety — in-flight per-item HTTP turns will still complete on the agent side."
                />
              </DialogTrigger>
              <CancelRunDialog
                runFriendlyId={run.friendlyId}
                redirectPath={v3RunPath(organization, project, environment, run)}
              />
            </Dialog>
          )}
        </div>

        {emptyState ? (
          <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-charcoal-700 bg-background-bright">
            <Paragraph variant="small" className="text-text-dimmed">
              No progress frames received yet — the batch may not have started.
            </Paragraph>
          </div>
        ) : (
          <>
            <SummaryCard run={run} meta={meta} rows={rows} />

            {rows.length > 0 ? (
              <div className="rounded-md border border-charcoal-700">
                <Table variant="bright">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>#</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Output preview</TableHeaderCell>
                      <TableHeaderCell>Error</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.index}>
                        <TableCell className="font-mono text-xs text-text-dimmed">
                          {row.index + 1}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={row.status} />
                        </TableCell>
                        <TableCell className="text-xs text-text-dimmed">
                          {row.output ? preview(row.output) : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-rose-400">
                          {row.error ? preview(row.error) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="rounded-md border border-charcoal-700 bg-background-bright p-4">
                <Paragraph variant="small" className="text-text-dimmed">
                  Batch complete — {complete?.successCount ?? 0} succeeded,{" "}
                  {complete?.failureCount ?? 0} failed. Per-item detail isn't
                  available from the final summary frame.{" "}
                  <span className="italic">TODO(W.3.2): persist per-item history.</span>
                </Paragraph>
              </div>
            )}
          </>
        )}
      </div>
    </PageBody>
  );
}
