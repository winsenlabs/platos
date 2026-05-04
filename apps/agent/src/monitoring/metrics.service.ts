import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import * as prom from "prom-client";

/**
 * EOBD.41 — Prometheus metrics for the agent process.
 *
 * Exposed at `/metrics` by the MetricsController. All counters /
 * histograms / gauges live on the default registry so the default
 * Node.js process metrics (event loop lag, memory, GC) are bundled
 * for free.
 *
 * Hot paths:
 *   - AgentTaskService.executeStreamingTurn → incTurn + observeDuration
 *   - AgentTaskService cost path → incTokens
 *   - ConnectionsGateway → wsConnectionsGauge
 *   - AssignmentService (approvals) → approvalsPendingGauge
 *   - MemoryExtractionService → incExtractionRun
 *   - EvalService → scoreHistogram
 *
 * Cardinality control: labels are kept small (status, model). Scope
 * labels (org/project/env) are intentionally omitted — per-scope
 * aggregation lives in the cost_records table, not in Prometheus.
 */
@Injectable()
export class MetricsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MetricsService.name);

  // Counters
  readonly turnsTotal = new prom.Counter({
    name: "platos_turns_total",
    help: "Total agent turns started.",
    labelNames: ["status"],
  });

  // PRELAUNCH-A1-12 — `kind` label so SREs can graph cache hit rate +
  // reasoning spend without joining Postgres. Cardinality stays bounded
  // by `direction` × `model` × 4 kinds. Caller emits one increment per
  // (direction, kind) pair to keep the label dimensions orthogonal.
  readonly tokensTotal = new prom.Counter({
    name: "platos_tokens_total",
    help: "Total tokens consumed by LLM calls.",
    labelNames: ["direction", "model", "kind", "provider"],
  });

  readonly extractionRunsTotal = new prom.Counter({
    name: "platos_memory_extraction_runs_total",
    help: "Total memory extraction runs.",
    labelNames: ["status"],
  });

  readonly toolCallsTotal = new prom.Counter({
    name: "platos_tool_calls_total",
    help: "Total tool calls dispatched.",
    labelNames: ["status"],
  });

  // Histograms
  readonly turnDurationSeconds = new prom.Histogram({
    name: "platos_turn_duration_seconds",
    help: "Turn execution wall time.",
    labelNames: ["status"],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  });

  readonly evalScoreHistogram = new prom.Histogram({
    name: "platos_eval_score",
    help: "Judge-model eval scores.",
    labelNames: ["suite"],
    buckets: [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1],
  });

  // Gauges
  readonly wsConnectionsGauge = new prom.Gauge({
    name: "platos_ws_connections_active",
    help: "Active tool-sync WebSocket connections.",
  });

  readonly approvalsPendingGauge = new prom.Gauge({
    name: "platos_approvals_pending",
    help: "Currently pending human-in-the-loop approvals.",
  });

  // PRELAUNCH-A3-5 — extended gauge labels so SREs can graph utilization
  // per-cap. Cardinality is bounded by the number of caps configured per
  // org, which is small (single-digit per scope in practice).
  readonly budgetUtilizationGauge = new prom.Gauge({
    name: "platos_budget_utilization_ratio",
    help: "Latest observed budget utilization ratio (0-1+) by cap.",
    labelNames: ["cap_id", "scope_type", "period"],
  });

  onApplicationBootstrap(): void {
    prom.collectDefaultMetrics({
      prefix: "platos_process_",
    });
    this.logger.log("Metrics registered");
  }

  /** Called by MetricsController to serialize the registry. */
  async snapshot(): Promise<string> {
    return prom.register.metrics();
  }
}
