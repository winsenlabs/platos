// Driven ports this context needs, and the adapter-facing port it OWNS.
//
// `ChannelAdapter` is published from here rather than from the kernel: ADR M0.3
// §13 assigns it to `channels`, and `packages/adapters/channel-slack` has
// exactly one import edge, to this entrypoint. `ChannelsRepository` is the
// canonical-store port behind which this context's sole-writer ownership of
// `ChannelConnection`, `ChannelThread`, `ChannelApp`, `ChannelInstallation`,
// `ChannelAppThread` and `ChannelEventInbox` is realised.
//
// The three reader ports beside them — `ChannelCredentialReader`,
// `AgentDirectory` and `ChannelEventCipher` — exist because the §1 DAG grants
// `channels` only `tenancy`, `identity-access` and the kernel. Each is the
// narrow question this context needs answered by a context it may not import
// (reader-port inversion, ADR M0.3 §2), wired at the composition root.
//
// Implemented under `packages/adapters/*`, wired in `apps/core-api`, never
// imported by `domain/` (ADR M0.3 §2).
export * from "./channel-adapter.js";
export * from "./channels-repository.js";

// WIN-258 T5 — the domain values `ChannelsRepository`'s SIGNATURES already name.
//
// WITHOUT THIS BLOCK THE CANONICAL-STORE PORT IS UNIMPLEMENTABLE OUTSIDE THIS
// PACKAGE. `channels-repository.ts` above imports `ChannelConnection`,
// `ChannelInstallation`, `ChannelEvent`, `ChannelThreadLink` and ten more from
// `../../domain/index.js` as TYPES and re-exports none of them, and
// `contracts/index.ts` publishes the read VIEWS rather than the aggregates. So
// every method of the port was declared in terms of names an adapter package —
// the only kind of package ADR M0.3 §2 permits to implement a driven port — had
// no way to spell. The same omission was found three times already on this
// issue, on `EndUserStore`, on `SessionRevocationOrder` and on
// `BudgetRepository`; this is the fourth, and it is repaired the same way: the
// port entry point publishes exactly what the port's own signatures use, plus
// the values an implementation must not re-derive, and nothing more.
//
// THE FUNCTIONS ARE HERE FOR A STRONGER REASON THAN THE TYPES. `linkIdentity`
// and `ownerKey` are the STORED spelling of a thread link's unique, and
// `isClaimable` and `byClaimOrder` are the inbox's claim predicate and its total
// order. A store that wrote its own copy of any of them would be a second
// definition of a rule the domain already owns, and the two would drift silently
// — the exact failure `domain/routing.ts` describes when it settles case
// sensitivity once, at write time. `eventDuplicate` and `threadLinkConflict` are
// published because a store must report a lost race with the SAME error the
// in-memory double reports, or the shared conformance transcript compares two
// different vocabularies and calls the difference a divergence.
//
// The kernel values these signatures name are republished for the same reason
// `identity-access`'s and `cost-monitoring`'s port entry points republish their
// own: `EnvironmentScope`, `TransactionScope` and `Result` are in EVERY method,
// and an adapter that reached for `@platos/kernel` directly would be a second
// import edge into the kernel from a package whose only declared dependency is
// the context whose port it satisfies.
export type { EnvironmentScope, Result, TransactionScope } from "@platos/kernel";
export { asIdentifier, environmentScope, err, ok } from "@platos/kernel";

export type {
  AgentId,
  AppDistribution,
  AppProvider,
  ChannelApp,
  ChannelAppId,
  ChannelAppThreadId,
  ChannelConnection,
  ChannelConnectionId,
  ChannelEvent,
  ChannelEventInboxId,
  ChannelEventStatus,
  ChannelInstallation,
  ChannelInstallationId,
  ChannelRoutingRule,
  ChannelThreadId,
  ChannelThreadKey,
  ChannelThreadLink,
  ConnectionProvider,
  CredentialId,
  ExternalInstallationId,
  InstallationStatus,
  LeaseOwner,
  ProviderEventId,
  RefreshClaimId,
  RefreshState,
  SealedEventPayload,
  ThreadId,
  ThreadLinkOwner,
  TurnId,
} from "../../domain/index.js";
export {
  APP_DISTRIBUTIONS,
  APP_PROVIDERS,
  byClaimOrder,
  CHANNEL_EVENT_STATUSES,
  CONNECTION_PROVIDERS,
  connectionOwner,
  eventDuplicate,
  INSTALLATION_STATUSES,
  installationOwner,
  isClaimable,
  linkIdentity,
  MAX_AGENT_ROUTING_RULES,
  ownerKey,
  REFRESH_STATES,
  repositoryUnavailable,
  threadLinkConflict,
} from "../../domain/index.js";
