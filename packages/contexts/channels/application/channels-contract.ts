// The composition of this context's use cases into its published contract.
//
// Thin on purpose. Every rule lives in `domain/`, every orchestration in a named
// use-case module, and this file is the adapter between the command shapes the
// contract publishes and the ones the use cases take. It holds no rule of its
// own, which is what keeps it from becoming the god-service ADR M0.3 §6 exists
// to prevent.

import { err, ok, type ErasureTarget, type Result } from "@platos/kernel";

import type {
  AdmitEventRequest,
  AdmitEventResult,
  ChannelAppView,
  ChannelConnectionView,
  ChannelEventView,
  ChannelInstallationView,
  ChannelsContract,
  ClaimEventRequest,
  ClaimedEventResult,
  ConfigureRoutingRequest,
  DescribeAppRequest,
  DescribeConnectionRequest,
  DispatchInboundTurnRequest,
  DispatchInboundTurnResult,
  ResolveEventRequest,
} from "../contracts/index.js";
import {
  appNotFound,
  assertActive,
  assertEnabled,
  connectionNotFound,
  connectionOwner,
  inheritRouting,
  installationNotFound,
  installationOwner,
  routingInvalid,
  type ChannelInstallationId,
  type ThreadLinkOwner,
} from "../domain/index.js";
import { admitChannelEvent } from "./admit-channel-event.js";
import { createChannelsErasureTarget } from "./channels-erasure-target.js";
import { configureAppRouting, configureConnectionRouting } from "./configure-agent-routing.js";
import type { ChannelsDependencies } from "./dependencies.js";
import { dispatchInboundTurn } from "./dispatch-inbound-turn.js";
import {
  claimNextChannelEvent,
  completeChannelEvent,
  failChannelEvent,
  renewChannelEventLease,
} from "./process-channel-event.js";
import { toAppView, toConnectionView, toEventView, toInstallationView, toThreadLinkView } from "./views.js";

/** The default an event resolution records when the caller names none. */
const UNSPECIFIED_ERROR_CODE = "CHANNELS_UNSPECIFIED";

/**
 * Exactly one of `connectionId` / `installationId` must be present.
 *
 * Checked rather than assumed: the two are different tables with different
 * uniques, and a request naming both is ambiguous about which link table it
 * means. Silently preferring one would put the link in a table the caller did
 * not intend and make the conversation unreachable from the other path.
 */
function ownerOf(request: {
  readonly connectionId?: unknown;
  readonly installationId?: unknown;
}): Result<ThreadLinkOwner> {
  const hasConnection = request.connectionId !== undefined && request.connectionId !== null;
  const hasInstallation = request.installationId !== undefined && request.installationId !== null;
  if (hasConnection === hasInstallation) {
    return err(routingInvalid("exactly one of connectionId or installationId is required"));
  }
  return hasConnection
    ? ok(connectionOwner(request.connectionId as never))
    : ok(installationOwner(request.installationId as never));
}

async function admitEvent(
  dependencies: ChannelsDependencies,
  request: AdmitEventRequest,
): Promise<Result<AdmitEventResult>> {
  const admitted = await admitChannelEvent(dependencies, request);
  if (!admitted.ok) return err(admitted.error);
  return ok({ event: toEventView(admitted.value.event), admitted: admitted.value.admitted });
}

async function claimNextEvent(
  dependencies: ChannelsDependencies,
  request: ClaimEventRequest,
): Promise<Result<ClaimedEventResult | null>> {
  const claimed = await claimNextChannelEvent(dependencies, request.appId, request.leaseOwner);
  if (!claimed.ok) return err(claimed.error);
  if (claimed.value === null) return ok(null);
  return ok({ event: toEventView(claimed.value.event), hold: claimed.value.hold });
}

/**
 * Shared tail for every event resolution: run it, then map the row to a view.
 *
 * Takes an already-bound thunk rather than a function plus arguments, because
 * `renew`/`complete` and `fail` have genuinely different signatures — only the
 * latter records an error code — and a shared wrapper that papered over that
 * would need a cast, which is exactly where a wrong argument would hide.
 */
async function toEventResult(
  run: () => Promise<Result<Parameters<typeof toEventView>[0]>>,
): Promise<Result<ChannelEventView>> {
  const resolved = await run();
  if (!resolved.ok) return err(resolved.error);
  return ok(toEventView(resolved.value));
}

/**
 * Assemble the routing table in force for this message, then dispatch.
 *
 * The inheritance step belongs here rather than in the use case: which table
 * wins is a property of WHICH SURFACE the message arrived on, and the use case
 * takes an already-resolved list so it stays identical for both paths.
 */
async function dispatch(
  dependencies: ChannelsDependencies,
  request: DispatchInboundTurnRequest,
): Promise<Result<DispatchInboundTurnResult>> {
  const owner = ownerOf(request);
  if (!owner.ok) return err(owner.error);

  const routing = await routingFor(dependencies, owner.value);
  if (!routing.ok) return err(routing.error);

  const dispatched = await dispatchInboundTurn(dependencies, {
    inboxId: request.inboxId,
    owner: owner.value,
    agentRouting: routing.value.rules,
    defaultAgentId: routing.value.defaultAgentId,
    message: {
      channelThreadKey: request.channelThreadKey,
      platformChannelId: request.platformChannelId,
      text: request.text,
      endUserId: request.endUserId as never,
      receivedAt: dependencies.clock.now(),
    },
    newThreadId: request.newThreadId,
    requestScope: {
      requestId: dependencies.ids.uuid() as never,
      tenant: routing.value.scope,
      principalId: dependencies.ids.uuid() as never,
      onBehalfOf: null,
      receivedAt: dependencies.clock.now(),
    },
  });
  if (!dispatched.ok) return err(dispatched.error);

  return ok({
    link: toThreadLinkView(dispatched.value.link),
    jobId: dispatched.value.jobId,
    startedConversation: dispatched.value.startedConversation,
    agentId: dispatched.value.agentId,
  });
}

interface RoutingInForce {
  readonly rules: ReturnType<typeof inheritRouting>;
  readonly defaultAgentId: Parameters<typeof dispatchInboundTurn>[1]["defaultAgentId"];
  readonly scope: Parameters<typeof dispatchInboundTurn>[1]["requestScope"]["tenant"];
}

/**
 * Resolve the routing table in force, AND run the inbound admission gates.
 *
 * THE GATES LIVE HERE BECAUSE THIS IS THE ONLY PLACE THE INBOUND PATH LOADS THE
 * OWNER ROW. `dispatch` is its sole caller, so a connection an operator has
 * switched off — and an installation the workspace has revoked — is refused
 * BEFORE `dispatchInboundTurn` can create a thread link or enqueue a turn job.
 * Refusing later, at send time, would still have spent the turn: the point of
 * the kill switch is that a disabled surface stops COSTING money, not merely
 * that it stops replying.
 *
 * Both gates fail closed with the domain's own codes
 * (`CHANNELS_CONNECTION_DISABLED`, `CHANNELS_INSTALLATION_REVOKED`) rather than
 * a generic routing error, so an operator reading the refusal can tell "I
 * turned this off" apart from "this is misconfigured".
 */
async function routingFor(
  dependencies: ChannelsDependencies,
  owner: ThreadLinkOwner,
): Promise<Result<RoutingInForce>> {
  if (owner.kind === "connection") {
    const found = await dependencies.repository.findConnectionById(owner.connectionId);
    if (!found.ok) return err(found.error);
    if (found.value === null) return err(connectionNotFound(owner.connectionId));

    const enabled = assertEnabled(found.value);
    if (!enabled.ok) return err(enabled.error);

    return ok({
      rules: enabled.value.agentRouting,
      defaultAgentId: enabled.value.defaultAgentId,
      scope: enabled.value.scope,
    });
  }

  const installation = await dependencies.repository.findInstallation(owner.installationId);
  if (!installation.ok) return err(installation.error);
  if (installation.value === null) return err(installationNotFound(owner.installationId));

  const active = assertActive(installation.value);
  if (!active.ok) return err(active.error);

  const app = await dependencies.repository.findAppById(installation.value.appId);
  if (!app.ok) return err(app.error);
  if (app.value === null) return err(appNotFound(installation.value.appId));

  // An installation's own table overrides its app's; an EMPTY table is not an
  // override. See `domain/routing.ts`.
  return ok({
    rules: inheritRouting(installation.value.agentRouting, app.value.agentRouting),
    defaultAgentId: installation.value.defaultAgentId ?? app.value.defaultAgentId,
    scope: app.value.scope,
  });
}

async function configureRouting(
  dependencies: ChannelsDependencies,
  request: ConfigureRoutingRequest,
): Promise<Result<ChannelConnectionView | ChannelAppView>> {
  const owner = ownerOf({ connectionId: request.connectionId, installationId: request.appId });
  if (!owner.ok) return err(owner.error);

  if (request.connectionId !== undefined) {
    const saved = await configureConnectionRouting(dependencies, {
      scope: request.scope,
      connectionId: request.connectionId,
      agentRouting: request.agentRouting,
    });
    if (!saved.ok) return err(saved.error);
    return ok(toConnectionView(saved.value));
  }

  const saved = await configureAppRouting(dependencies, {
    scope: request.scope,
    appId: request.appId as never,
    agentRouting: request.agentRouting,
  });
  if (!saved.ok) return err(saved.error);
  return ok(toAppView(saved.value));
}

async function describeConnection(
  dependencies: ChannelsDependencies,
  request: DescribeConnectionRequest,
): Promise<Result<ChannelConnectionView>> {
  const found = await dependencies.repository.findConnection(request.scope, request.connectionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(connectionNotFound(request.connectionId));
  return ok(toConnectionView(found.value));
}

async function describeApp(
  dependencies: ChannelsDependencies,
  request: DescribeAppRequest,
): Promise<Result<ChannelAppView>> {
  const found = await dependencies.repository.findApp(request.scope, request.appId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(appNotFound(request.appId));
  return ok(toAppView(found.value));
}

async function describeInstallation(
  dependencies: ChannelsDependencies,
  installationId: ChannelInstallationId,
): Promise<Result<ChannelInstallationView>> {
  const found = await dependencies.repository.findInstallation(installationId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(installationNotFound(installationId));
  return ok(toInstallationView(found.value));
}

export function createChannelsContract(dependencies: ChannelsDependencies): ChannelsContract {
  return {
    name: "channels",
    admitEvent: (request) => admitEvent(dependencies, request),
    claimNextEvent: (request) => claimNextEvent(dependencies, request),
    renewEventLease: (request) =>
      toEventResult(() => renewChannelEventLease(dependencies, request.inboxId, request.hold)),
    completeEvent: (request) =>
      toEventResult(() => completeChannelEvent(dependencies, request.inboxId, request.hold)),
    failEvent: (request) =>
      toEventResult(() =>
        failChannelEvent(dependencies, request.inboxId, request.hold, request.errorCode ?? UNSPECIFIED_ERROR_CODE),
      ),
    dispatchInboundTurn: (request) => dispatch(dependencies, request),
    configureRouting: (request) => configureRouting(dependencies, request),
    describeConnection: (request) => describeConnection(dependencies, request),
    describeApp: (request) => describeApp(dependencies, request),
    describeInstallation: (installationId) => describeInstallation(dependencies, installationId),
    erasureTarget: (): ErasureTarget => createChannelsErasureTarget(dependencies),
  };
}
