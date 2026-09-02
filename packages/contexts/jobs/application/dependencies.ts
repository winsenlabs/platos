// What every use case in this context is constructed with.
//
// One frozen bundle rather than eight constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing below
// reaches for the wall clock or a random generator. That is what makes a use case
// that expires an approval, clamps a timeout or mints a row reproducible at any
// instant — "the deadline has passed" is `clock.advanceSeconds(...)`, not a
// sleep.
//
// HASHING IS AN INPUT TOO. `digest` is a plain function rather than a port
// because it has no state and no I/O, but it is still a choice this layer must
// not make: the live algorithm is SHA-256 and the adapter supplies it. A domain
// that imported `node:crypto` would be naming a runtime.
//
// ON `durableRuntime`. This is the kernel port ADR M0.3 §1 names for this context:
// "a turn needing approval creates `AgentApproval` and parks on a
// `DurableRuntime` suspension". Unlike `files`' opaque tenancy handle, this one is
// CALLED — `request-approval.ts` suspends on it and `resolve-approval.ts` resumes
// it — so its in-memory double is a real implementation, not an uninhabited stub.
//
// ON `tenancy`. ADR M0.3 §1 permits this context exactly two dependencies:
// `tenancy` and the kernel. The handle is held here as the OPAQUE contract type
// its owner publishes. `jobs` never re-derives a tenant scope: the resolved
// `EnvironmentScope` arrives on the command, having been established by the
// context that owns the tree, and this handle is the declared edge along which a
// future re-validation would travel. It is deliberately not called from any rule
// in this package — a rule that depended on another context's runtime behaviour
// would not be exercisable in memory.

import type { Clock, DurableRuntime, IdGenerator, UnitOfWork } from "@platos/kernel";
import type { TenancyContract } from "@platos/context-tenancy";

import type { DigestFunction } from "../domain/index.js";
import type {
  ApprovalsRepository,
  IdempotencyStore,
  JobHandlerRuntime,
  JobsRepository,
} from "./ports/index.js";

/**
 * Values the composition root already knows are secret. A job payload or result
 * quoting one is refused (`domain/payload.ts`). The live caller supplies the
 * internal auth token and the database URL.
 */
export type KnownSecrets = readonly string[];

export interface JobsDependencies {
  readonly jobs: JobsRepository;
  readonly approvals: ApprovalsRepository;
  readonly idempotency: IdempotencyStore;
  readonly handlers: JobHandlerRuntime;
  readonly durableRuntime: DurableRuntime;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly digest: DigestFunction;
  readonly knownSecrets: KnownSecrets;
  /** Opaque by design: see the note above. */
  readonly tenancy: TenancyContract;
}

export function jobsDependencies(dependencies: JobsDependencies): JobsDependencies {
  return Object.freeze({ ...dependencies });
}
