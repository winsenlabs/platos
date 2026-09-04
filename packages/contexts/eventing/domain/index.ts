// The `eventing` domain (ADR M0.3 §1, context 17).
//
// One aggregate and one flow.
//
//   NotificationRule       the only canonical row this context writes: an
//                          environment-scoped standing order that says which
//                          events go where.
//   ObservedEvent          one drained outbox envelope, narrowed to the
//                          environment scope a rule can actually match.
//   NotificationRequested  what a match produces. This context's OUTPUT: it
//                          emits the request and does not perform the delivery.
//
// The matcher (`event-pattern.ts`, `rule-filter.ts`), the destination union
// (`destination.ts`) and the retry schedule (`retry-schedule.ts`) are lifted
// unchanged in behaviour from `apps/agent/src/mcp-platform/events.service.ts`,
// where they were private functions inside a Nest service. Each module names the
// legacy function it preserves and pins the surprising parts of it.
//
// This layer imports `@platos/kernel` and its own siblings, and nothing else —
// no framework, no client, no peer context (ADR M0.3 §2).
export * from "./identifiers.js";
export * from "./coercions.js";
export * from "./errors.js";
export * from "./legacy-rows.js";
export * from "./rule-name.js";
export * from "./event-pattern.js";
export * from "./rule-filter.js";
export * from "./destination.js";
export * from "./notification-rule.js";
export * from "./observed-event.js";
export * from "./notification-request.js";
export * from "./retry-schedule.js";
