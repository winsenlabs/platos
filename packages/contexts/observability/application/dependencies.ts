// What every use case in this context is constructed with.
//
// One frozen bundle rather than seven constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing
// below reaches for the wall clock or a random generator. That is what makes a
// drain's back-off schedule, a retention cut-off and a minted audit id
// reproducible at any instant — and a back-off schedule that cannot be tested at
// an instant is a back-off schedule nobody has tested.
//
// ON `tenancy`. ADR M0.3 §1 permits this context exactly two dependencies:
// `tenancy` and the kernel. The handle is held here as the OPAQUE contract type
// its owner publishes. `observability` never re-derives a tenant scope: the
// scope arrives on the envelope, stamped by the outbox adapter inside the
// producer's own transaction, and this handle is the declared edge along which a
// future re-validation would travel. It is deliberately not called from any rule
// in this package — a rule that depended on another context's runtime behaviour
// would not be exercisable in memory.

import type { Clock, IdGenerator, Logger, UnitOfWork } from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import type { DrainBudget } from "../domain/index.js";
import type {
  ErasedSubjectRegister,
  ObservabilityRepository,
  ObservabilitySink,
  ProjectionOutbox,
  SubjectLocatorSource,
} from "./ports/index.js";

export interface ObservabilityDependencies {
  readonly sink: ObservabilitySink;
  readonly outbox: ProjectionOutbox;
  readonly repository: ObservabilityRepository;
  readonly erasedSubjects: ErasedSubjectRegister;
  readonly subjectLocators: SubjectLocatorSource;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  /**
   * The drain's ceilings, as a value.
   *
   * Not read from the environment inside a use case: a limit resolved from
   * `process.env` in the middle of a loop is untestable, and it is exactly the
   * coupling ADR M0.3 §2 bans.
   */
  readonly budget: DrainBudget;
  /**
   * Where an operator is told something.
   *
   * A port, because a drain's most important output is often a sentence — "the
   * store is missing its schema", "eleven envelopes are parked" — and a context
   * that cannot say those things without a framework would not say them.
   */
  readonly logger: Logger;
  /** Opaque by design: see the note above. */
  readonly tenancy: TenancyContract;
}

export function observabilityDependencies(
  dependencies: ObservabilityDependencies,
): ObservabilityDependencies {
  return Object.freeze({ ...dependencies });
}
