// What every use case in this context is constructed with.
//
// One frozen bundle rather than six constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing
// below reaches for the wall clock or a random generator. That is what makes a
// use case that stamps `createdAt`, schedules a retry, or mints a rule id
// reproducible at any instant — and it is what lets the retry schedule be tested
// without waiting two seconds.
//
// ON `tenancy`. ADR M0.3 §1 permits this context exactly two dependencies:
// `tenancy` and the kernel. The handle is held here as the OPAQUE contract type
// its owner publishes. `eventing` never re-derives a tenant scope: the resolved
// `EnvironmentScope` arrives on the command, having been established by the
// context that owns the tree, and this handle is the declared edge along which a
// future re-validation would travel. It is deliberately not called from any rule
// in this package — a rule that depended on another context's runtime behaviour
// would not be exercisable in memory.

import type { Clock, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import type { DestinationScreen, NotificationQueue, NotificationRuleRepository } from "./ports/index.js";

export interface EventingDependencies {
  readonly repository: NotificationRuleRepository;
  readonly screen: DestinationScreen;
  readonly queue: NotificationQueue;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  /** Opaque by design: see the note above. */
  readonly tenancy: TenancyContract;
}

export function eventingDependencies(dependencies: EventingDependencies): EventingDependencies {
  return Object.freeze({ ...dependencies });
}
