// Driven ports of the `eventing` context.
//
// Implemented by `packages/adapters/*` and wired in `apps/core-api`. Never
// imported by `domain/` — the arrows point inward, and a port is an
// application-layer concept because it is a use case that decides it needs one.
//
// This is the second of this package's two published entry points
// (`@platos/context-eventing/application/ports/index.js`), and it is the one an
// adapter imports. ADR M0.3 §13: an adapter-facing port belongs to the context
// whose capability it serves, and does not move into the kernel merely because
// its implementation lives under `packages/adapters/`.
//
// NOTE ON `Notifier`. ADR M0.3 §13 assigns the `Notifier` port to
// `cost-monitoring`, and `notifier-email` / `notifier-webhook` are that
// context's adapters (`scripts/arch/v1-project-graph.mjs`). Nothing here
// duplicates it. `NotificationQueue` is a different seam: it hands off a
// REQUEST for delivery, and what eventually performs the send is downstream of
// this context entirely.

export type { NotificationRuleRepository, EventingErasureSelector } from "./notification-rule-repository.js";
export type { DestinationScreen, ScreenedDestination } from "./destination-screen.js";
export type { NotificationQueue, EnqueuedNotification } from "./notification-queue.js";
