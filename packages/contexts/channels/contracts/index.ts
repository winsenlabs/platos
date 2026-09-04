// The published surface of the `channels` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The composition root
// wires it.
//
// WHO MAY IMPORT THIS, AND WHO MAY NOT. Nothing in the §1 DAG depends on
// `channels`, so today this surface exists for `apps/core-api` alone.
// `identity-access` is forbidden from reaching it outright by the
// identity-isolation rule (§5.1(g)), and `conversations` must not import it in
// either direction (§3) — the two contexts meet only at the kernel's
// `DurableRuntime` and `EventBus` seams.
//
// It is types only. Nothing here has a runtime representation, so importing
// this module costs a consumer no code and cannot drag an implementation across
// a context boundary. The implementation is `createChannelsContract` in
// `application/`, reached only through the composition root.
//
// The driven `ChannelAdapter` port is NOT re-exported here. It is
// adapter-facing, not context-facing, and it is published from
// `application/ports/index.js` where its adapters import it (ADR M0.3 §13).

import type { EnvironmentScope, ErasureTarget, Result } from "@platos/kernel";

import type {
  ChannelAppId,
  ChannelConnectionId,
  ChannelEventInboxId,
  ChannelInstallationId,
  ChannelRoutingRule,
  ChannelThreadKey,
  LeaseHold,
  LeaseOwner,
  ProviderEventId,
  ThreadId,
} from "../domain/index.js";

// The identifier and vocabulary a caller needs to build a command. Branded
// types, so a `threadId` cannot reach an `agentId` parameter across the boundary
// any more than it can inside it.
export type {
  AgentId,
  AppDistribution,
  AppProvider,
  ChannelAppId,
  ChannelAppThreadId,
  ChannelConnectionId,
  ChannelEventInboxId,
  ChannelEventStatus,
  ChannelInstallationId,
  ChannelRoutingMatch,
  ChannelRoutingRule,
  ChannelThreadId,
  ChannelThreadKey,
  ConnectionProvider,
  CredentialId,
  EndUserId,
  ExternalInstallationId,
  InstallationStatus,
  LeaseHold,
  LeaseOwner,
  ProviderEventId,
  RefreshClaimId,
  RefreshExpectation,
  RefreshState,
  ThreadId,
  TurnId,
} from "../domain/index.js";

// The inbound job seam. Published because the composition root registers the
// handler for this job name and must agree with this context about its payload
// (ADR M0.3 §3) — WITHOUT either side importing the other's internals.
export type { InboundMessage, InboundTurnJobPayload } from "../domain/index.js";
export { INBOUND_TURN_JOB_NAME, INBOUND_TURN_PAYLOAD_VERSION } from "../domain/index.js";

export type {
  ChannelAppView,
  ChannelConnectionView,
  ChannelEventView,
  ChannelInstallationView,
  ChannelThreadLinkView,
} from "../application/views.js";

import type {
  ChannelAppView,
  ChannelConnectionView,
  ChannelEventView,
  ChannelInstallationView,
  ChannelThreadLinkView,
} from "../application/views.js";

export interface AdmitEventRequest {
  readonly appId: ChannelAppId;
  readonly eventId: ProviderEventId;
  /** The raw provider body, already signature-verified by the transport. */
  readonly body: string;
}

export interface AdmitEventResult {
  readonly event: ChannelEventView;
  /** False when this delivery duplicated one already admitted. */
  readonly admitted: boolean;
}

export interface ClaimEventRequest {
  readonly appId: ChannelAppId;
  readonly leaseOwner: LeaseOwner;
}

export interface ClaimedEventResult {
  readonly event: ChannelEventView;
  /** Opaque proof of the lease. Every later call must present it unchanged. */
  readonly hold: LeaseHold;
}

export interface ResolveEventRequest {
  readonly inboxId: ChannelEventInboxId;
  readonly hold: LeaseHold;
  /** Recorded on the row so an operator can see why a try ended. */
  readonly errorCode?: string;
}

export interface DispatchInboundTurnRequest {
  readonly inboxId: ChannelEventInboxId;
  readonly connectionId?: ChannelConnectionId;
  readonly installationId?: ChannelInstallationId;
  readonly channelThreadKey: ChannelThreadKey;
  readonly platformChannelId: string | null;
  readonly text: string;
  readonly endUserId: string | null;
  /** Used only when this message opens the conversation. See the contract note. */
  readonly newThreadId: ThreadId;
}

export interface DispatchInboundTurnResult {
  readonly link: ChannelThreadLinkView;
  readonly jobId: string;
  readonly startedConversation: boolean;
  /** The routing decision, or null when the thread already had an agent. */
  readonly agentId: string | null;
}

export interface ConfigureRoutingRequest {
  readonly scope: EnvironmentScope;
  readonly connectionId?: ChannelConnectionId;
  readonly appId?: ChannelAppId;
  /** Raw operator input. Normalized and scope-checked before it is stored. */
  readonly agentRouting: unknown;
}

export interface DescribeConnectionRequest {
  readonly scope: EnvironmentScope;
  readonly connectionId: ChannelConnectionId;
}

export interface DescribeAppRequest {
  readonly scope: EnvironmentScope;
  readonly appId: ChannelAppId;
}

/**
 * The `channels` capability, as the composition root sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no provider SDK exception crosses this boundary.
 *
 * NOTE ON `newThreadId`. Starting a conversation needs a `Thread`, which
 * `conversations` owns and this context may neither write nor import (ADR M0.3
 * §3). So the id is an INPUT: the composition root mints the thread and hands
 * the id down. That is what keeps the forbidden edge absent rather than merely
 * unused.
 */
export interface ChannelsContract {
  readonly name: "channels";

  /** Admit one verified provider delivery. Idempotent on `[appId, eventId]`. */
  admitEvent(request: AdmitEventRequest): Promise<Result<AdmitEventResult>>;

  /** Take the lease on the next claimable event, or report that there is none. */
  claimNextEvent(request: ClaimEventRequest): Promise<Result<ClaimedEventResult | null>>;

  /** Extend a held lease while a turn is still running. */
  renewEventLease(request: ResolveEventRequest): Promise<Result<ChannelEventView>>;

  completeEvent(request: ResolveEventRequest): Promise<Result<ChannelEventView>>;

  /** Record a failed try; retried or discarded according to the retry cap. */
  failEvent(request: ResolveEventRequest): Promise<Result<ChannelEventView>>;

  /** Link the conversation and enqueue a turn job. Never calls conversations. */
  dispatchInboundTurn(request: DispatchInboundTurnRequest): Promise<Result<DispatchInboundTurnResult>>;

  /** Validate an `agentRouting` table against its scope, then store it. */
  configureRouting(request: ConfigureRoutingRequest): Promise<Result<ChannelConnectionView | ChannelAppView>>;

  describeConnection(request: DescribeConnectionRequest): Promise<Result<ChannelConnectionView>>;

  describeApp(request: DescribeAppRequest): Promise<Result<ChannelAppView>>;

  describeInstallation(installationId: ChannelInstallationId): Promise<Result<ChannelInstallationView>>;

  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one per context and injects the array into
   * `privacy` (ADR M0.3 §3).
   */
  erasureTarget(): ErasureTarget;
}
