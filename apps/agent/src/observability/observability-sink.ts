/**
 * The one boundary observability projection writes cross.
 *
 * Everything upstream of this interface speaks Thread → Turn → Step → Tool Call.
 * Everything downstream is one analytical store's problem. Nothing else in the
 * agent may hold a ClickHouse client for observability, which is what keeps
 * "the store is down" a single fact with a single answer instead of a
 * behaviour that differs per call site.
 */

import type {
  ObservabilityRows,
  StepObserved,
  ToolCallObserved,
  TurnObserved,
  UsageObserved,
} from "./observability-event";

/**
 * What the sink is doing, in the words an operator needs.
 *
 * `disabled` and `schema_missing` are deliberately different words. The first
 * is a choice; the second is a deployment that believes it has an analytical
 * store and does not. Reporting the second as the first is how the current
 * span pipeline stayed broken without anyone being told (WIN-150).
 */
export type ObservabilitySinkStatus =
  | "disabled"
  | "misconfigured"
  | "unreachable"
  | "schema_missing"
  | "ready";

export interface ObservabilitySinkHealth {
  /** An endpoint was configured. Says nothing about whether it works. */
  configured: boolean;
  /** Configured, reachable, and carrying the expected schema. */
  available: boolean;
  status: ObservabilitySinkStatus;
  /** One line, safe to log. Never contains credentials or a statement body. */
  detail: string;
  /** Tables the probe expected and did not find. */
  missingTables?: string[];
}

export interface ObservabilitySink {
  writeTurn(event: TurnObserved): Promise<void>;
  writeStep(event: StepObserved): Promise<void>;
  writeToolCall(event: ToolCallObserved): Promise<void>;
  writeUsage(event: UsageObserved): Promise<void>;
  /**
   * The batched form the outbox drain uses. The four single-event methods above
   * are the one-row case of this, because a per-row INSERT is the access
   * pattern ClickHouse is worst at and a queue exists precisely to avoid it.
   */
  writeRows(rows: ObservabilityRows): Promise<void>;
  health(): Promise<ObservabilitySinkHealth>;
}

/**
 * The sink for a deployment that has no analytical store.
 *
 * It REFUSES writes rather than accepting them. Nothing should reach it — the
 * runtime does not enqueue when no sink is configured — so a call arriving here
 * is a wiring bug, and a silent success would hide it forever. Product
 * behaviour is unaffected either way: Postgres already holds the Turn.
 */
export class DisabledObservabilitySink implements ObservabilitySink {
  constructor(private readonly reason: string) {}

  private refuse(): never {
    throw new Error(`observability sink is not available: ${this.reason}`);
  }

  async writeTurn(): Promise<void> {
    this.refuse();
  }
  async writeStep(): Promise<void> {
    this.refuse();
  }
  async writeToolCall(): Promise<void> {
    this.refuse();
  }
  async writeUsage(): Promise<void> {
    this.refuse();
  }
  async writeRows(): Promise<void> {
    this.refuse();
  }
  async health(): Promise<ObservabilitySinkHealth> {
    return {
      configured: false,
      available: false,
      status: "disabled",
      detail: this.reason,
    };
  }
}
