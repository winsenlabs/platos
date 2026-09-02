// The published surface of the `eventing` bounded context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. By the §1 DAG no
// other context depends on `eventing` at all: it is a pure SINK of the outbox,
// and its consumers are the composition root (which wires the drain) and the
// transports that expose rule CRUD. That is not a reason to publish less
// carefully; it is the reason the surface can stay this small.
//
// It is types only. Nothing here has a runtime representation, so importing this
// module costs a consumer no code and cannot drag an implementation across a
// context boundary. The implementation is `createEventingContract` in
// `application/`, reached only through the composition root.
//
// The driven ports (`NotificationRuleRepository`, `DestinationScreen`,
// `NotificationQueue`) are NOT re-exported here. They are adapter-facing, not
// context-facing, and are published from `application/ports/index.js` where
// their adapters import them (ADR M0.3 §13).

import type {
  DomainEvent,
  EnvironmentScope,
  ErasureTarget,
  EventId,
  JsonValue,
  PrincipalId,
  Result,
} from "@platos/kernel";

import type {
  DestinationInput,
  NotificationRuleId,
  NotificationSeverity,
  RuleFilterInput,
} from "../domain/index.js";

// The identifier vocabulary a caller needs to build a command. Branded, so a
// `ruleId` cannot reach a `subjectId` parameter across the boundary any more
// than it can inside it.
export type { EventName, NotificationRuleId, RuleName, SubjectId } from "../domain/index.js";

// The column shapes, which are what a transport serialises. These are the `Json`
// columns' contents, NOT this context's parsed value objects — the translation
// happens in `application/views.ts`.
export type { DestinationInput, DestinationKind, RuleFilterInput } from "../domain/index.js";
export type { NotificationSeverity, RetryDecision } from "../domain/index.js";

// --- read models -------------------------------------------------------------

/** One `NotificationRule` row, as seen from outside. */
export interface NotificationRuleView {
  readonly ruleId: NotificationRuleId;
  readonly scope: EnvironmentScope;
  readonly name: string;
  readonly filters: RuleFilterInput;
  readonly delivery: DestinationInput;
  readonly enabled: boolean;
  readonly createdBy: PrincipalId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Retained under its generated name so no sibling placeholder breaks. The
 * "aggregate" eventing hands out is the rule row: it is the only thing this
 * context owns that another reader can hold.
 */
export type EventingAggregate = NotificationRuleView;

/**
 * `NotificationRequested` — what this context EMITS (ADR M0.3 §1 row 17).
 *
 * Self-contained by design: it carries the destination by value rather than a
 * rule id to resolve, so a delivery that runs after a retry does not change
 * behaviour because the rule was edited in between.
 */
export interface NotificationRequestView {
  readonly ruleId: NotificationRuleId;
  readonly ruleName: string;
  readonly scope: EnvironmentScope;
  readonly eventId: EventId;
  readonly eventName: string;
  readonly subjectId: string | null;
  readonly payload: JsonValue;
  readonly delivery: DestinationInput;
  readonly severity: NotificationSeverity;
  /** 0 on the first request; incremented by the retry schedule. */
  readonly attempt: number;
  readonly requestedAt: Date;
  /** `[platos] <eventName>[ subject=<id>] (rule: <name>)`. */
  readonly summary: string;
}

export interface EventRoutingView {
  /** Null when the event was not environment-scoped and no rule could match. */
  readonly eventId: EventId | null;
  readonly considered: number;
  readonly requested: readonly NotificationRequestView[];
  readonly skippedCount: number;
  /** Non-empty means the pass was partial: some matches were not enqueued. */
  readonly failedRuleIds: readonly NotificationRuleId[];
}

export interface DeliveryFailureView {
  readonly retrying: boolean;
  /** The attempt number just scheduled, or the total made before giving up. */
  readonly attempt: number;
  readonly delayMs: number | null;
  readonly rescheduled: NotificationRequestView | null;
}

// --- commands ----------------------------------------------------------------

export interface RegisterNotificationRule {
  readonly scope: EnvironmentScope;
  readonly name: string;
  readonly filters: RuleFilterInput;
  readonly delivery: DestinationInput;
  readonly createdBy: PrincipalId;
}

export interface UpdateNotificationRule {
  readonly scope: EnvironmentScope;
  readonly ruleId: NotificationRuleId;
  /** Omitted means "leave alone"; it is NOT the same as any value. */
  readonly name?: string;
  readonly filters?: RuleFilterInput;
  readonly delivery?: DestinationInput;
  readonly enabled?: boolean;
}

export interface AddressRule {
  readonly scope: EnvironmentScope;
  readonly ruleId: NotificationRuleId;
}

/**
 * One drained outbox event, exactly as the kernel envelope defines it.
 *
 * The drain hands over the `DomainEvent` itself and this context narrows it (see
 * `domain/observed-event.ts`). An event that is not environment-scoped can match
 * no rule and comes back as `considered: 0` rather than as a refusal.
 */
export interface RouteEventRequest {
  readonly event: DomainEvent;
}

// --- the contract ------------------------------------------------------------

/**
 * What `eventing` offers the rest of the system.
 *
 * Every method returns the kernel `Result<T>` rather than throwing: a failure a
 * caller must handle is visible in the type, and an exception crossing this
 * boundary means a defect.
 */
export interface EventingContract {
  readonly name: "eventing";

  /**
   * THE DRAIN. Evaluate one outbox event against the environment's rules and
   * emit a `NotificationRequested` per match.
   *
   * Fails when the rules could not be READ — the caller is a retrying drain and
   * must not mark the event done. A match that could not be enqueued is reported
   * in `failedRuleIds` and does not fail the pass. See
   * `application/route-observed-event.ts` for why those two are distinguished.
   */
  routeEvent(request: RouteEventRequest): Promise<Result<EventRoutingView>>;

  registerRule(request: RegisterNotificationRule): Promise<Result<NotificationRuleView>>;

  updateRule(request: UpdateNotificationRule): Promise<Result<NotificationRuleView>>;

  /** Newest first. */
  listRules(scope: EnvironmentScope): Promise<Result<readonly NotificationRuleView[]>>;

  describeRule(request: AddressRule): Promise<Result<NotificationRuleView>>;

  /** Idempotent: an absent rule is `ok(false)`, not an error. */
  deleteRule(request: AddressRule): Promise<Result<boolean>>;

  /**
   * Fire a synthetic `notifications.test_fired` at one rule. Deliberately
   * BYPASSES the rule's filter — it verifies the delivery path, not the matcher.
   */
  testRule(request: AddressRule): Promise<Result<NotificationRequestView>>;

  /**
   * Report a failed delivery attempt and get the retry decision. Giving up after
   * the third attempt is a SUCCESS carrying `retrying: false`, not an error.
   */
  recordDeliveryFailure(request: NotificationRequestView): Promise<Result<DeliveryFailureView>>;

  /**
   * This context's `ErasureTarget` for the one canonical row it is sole writer
   * of. The composition root collects one per context and injects the array into
   * `privacy` (ADR M0.3 §3).
   */
  erasureTarget(): ErasureTarget;
}
