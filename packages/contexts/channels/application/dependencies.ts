// What every use case in this context is constructed with.
//
// One frozen bundle rather than a dozen constructor parameters, so adding a
// collaborator does not ripple through every call site and so a test can build
// the whole context from in-memory doubles in one expression.
//
// TIME AND IDENTITY ARE INPUTS. `clock` and `ids` are kernel ports; nothing
// below reaches for the wall clock or a random generator. That is what makes a
// use case that expires a lease, backs off a retry or mints a link row
// reproducible at any instant — and it is what lets the lease-expiry and
// refresh-fence negative controls be deterministic rather than flaky.
//
// ON `durableRuntime` AND `eventBus`. These two ARE the reverse-edge inversions
// of ADR M0.3 §3, not conveniences. Inbound enqueues a turn job through
// `DurableRuntime`; outbound subscribes through `EventBus`. They are the reason
// this package can drive a turn engine without importing `conversations`, and
// the arch gate proves the import is absent.
//
// ON `tenancy` AND `identity`. ADR M0.3 §1 permits this context exactly three
// dependencies: `tenancy`, `identity-access` and the kernel. Both handles are
// held here as the OPAQUE contract types their owners publish. `channels` never
// re-derives a tenant scope and never writes an identity row: the resolved
// `EnvironmentScope` arrives on the command, having been established by the
// context that owns the tree, and an end-user link is established by the context
// that owns `EndUser`. They are deliberately not called from any rule in this
// package — a rule that depended on another context's runtime behaviour would
// not be exercisable in memory — and they are declared so the permitted edge is
// visible at the seam where a future re-validation would travel.

import type { Clock, DurableRuntime, EventBus, IdGenerator, Logger, UnitOfWork } from "@platos/kernel";
import type { IdentityAccessContract } from "@platos/context-identity-access";
import type { TenancyContract } from "@platos/context-tenancy";

import type { ChannelsPolicy } from "../domain/index.js";
import type {
  AgentDirectory,
  ChannelAdapterRegistry,
  ChannelCredentialReader,
  ChannelEventCipher,
  ChannelsRepository,
} from "./ports/index.js";

export interface ChannelsDependencies {
  readonly repository: ChannelsRepository;
  readonly adapters: ChannelAdapterRegistry;
  readonly credentials: ChannelCredentialReader;
  readonly agents: AgentDirectory;
  readonly cipher: ChannelEventCipher;
  readonly durableRuntime: DurableRuntime;
  readonly eventBus: EventBus;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly unitOfWork: UnitOfWork;
  readonly logger: Logger;
  readonly policy: ChannelsPolicy;
  /** Opaque by design: see the note above. */
  readonly tenancy: TenancyContract;
  /** Opaque by design: see the note above. */
  readonly identity: IdentityAccessContract;
}

export function channelsDependencies(dependencies: ChannelsDependencies): ChannelsDependencies {
  return Object.freeze({ ...dependencies });
}
