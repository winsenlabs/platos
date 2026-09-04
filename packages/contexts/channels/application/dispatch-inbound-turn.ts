// Use case: turn one inbound channel message into a running turn.
//
// THIS FILE IS THE ADR M0.3 §3 INVERSION MADE EXECUTABLE. The row reads:
// "channels writes `ChannelEventInbox`, ENQUEUES A TURN JOB via `DurableRuntime`
// ... No direct edge either way." So this use case does exactly three things and
// none of them is a call into `conversations`:
//
//   1. resolve or create the thread link for this conversation,
//   2. resolve the agent — ONLY when the link is new,
//   3. `dispatch()` a versioned job payload through the kernel port.
//
// Grep this package for `conversations` and there is nothing to find. That is
// not an accident of style; it is the property the arch gate proves.
//
// ROUTING IS RESOLVED ONCE. On first contact the routing table decides the
// agent and it is carried in the job payload. On every later message the link
// already exists, `agentId` is null, and the turn runs on the agent the thread
// is already pinned to. An operator editing a rule therefore changes where NEW
// conversations go and never re-points a live one — see `domain/thread-link.ts`.
//
// DISPATCH IS IDEMPOTENT ON THE INBOX ROW. The job's idempotency key is derived
// from the inbox id alone, so a redelivery that reaches this far produces the
// same job rather than a second turn for one human message.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitChannelThreadKey,
  buildInboundTurnPayload,
  connectionOwner,
  createThreadLink,
  extractPlatformChannelId,
  inboundTurnIdempotencyKey,
  installationOwner,
  resolveAgent,
  routingUnresolved,
  INBOUND_TURN_JOB_NAME,
  INBOUND_TURN_PAYLOAD_VERSION,
  type AgentId,
  type ChannelEventInboxId,
  type ChannelRoutingRule,
  type ChannelThreadId,
  type ChannelThreadLink,
  type InboundMessage,
  type ThreadId,
  type ThreadLinkOwner,
} from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

export interface DispatchInboundTurnCommand {
  readonly inboxId: ChannelEventInboxId;
  /** Which connection or installation this message arrived on. */
  readonly owner: ThreadLinkOwner;
  /** The routing table in force, already inherited where that applies. */
  readonly agentRouting: readonly ChannelRoutingRule[];
  readonly defaultAgentId: AgentId | null;
  readonly message: InboundMessage;
  /**
   * The thread to use when the conversation is NEW.
   *
   * Supplied by the caller rather than created here: `Thread` belongs to
   * `conversations` and this context may not write it. The composition root
   * mints it and hands the id down, which is what keeps the DAG edge absent.
   */
  readonly newThreadId: ThreadId;
  readonly requestScope: Parameters<ChannelsDependencies["durableRuntime"]["dispatch"]>[0]["scope"];
}

export interface DispatchedInboundTurn {
  readonly link: ChannelThreadLink;
  readonly jobId: string;
  /** True when this message opened the conversation. */
  readonly startedConversation: boolean;
  /** The routing decision, or null when the thread already had an agent. */
  readonly agentId: AgentId | null;
}

type Dependencies = Pick<
  ChannelsDependencies,
  "repository" | "durableRuntime" | "clock" | "ids" | "unitOfWork"
>;

interface ResolvedLink {
  readonly link: ChannelThreadLink;
  readonly agentId: AgentId | null;
  readonly startedConversation: boolean;
}

/**
 * Find the existing link, or create one and resolve routing for it.
 *
 * The insert races: two messages arriving together on a brand-new conversation
 * both find nothing. `insertThreadLink` fails on the unique for the loser, and
 * the loser re-reads rather than retrying the insert — the winner's link is the
 * truth, including which agent it opened on.
 */
async function resolveLink(
  dependencies: Dependencies,
  command: DispatchInboundTurnCommand,
): Promise<Result<ResolvedLink>> {
  const key = admitChannelThreadKey(command.message.channelThreadKey);
  if (!key.ok) return err(key.error);

  const existing = await dependencies.repository.findThreadLink(command.owner, key.value);
  if (!existing.ok) return err(existing.error);
  if (existing.value !== null) {
    return ok({ link: existing.value, agentId: null, startedConversation: false });
  }

  const agentId = resolveAgent(command.agentRouting, command.defaultAgentId, {
    platformChannelId: command.message.platformChannelId ?? extractPlatformChannelId(key.value),
    text: command.message.text,
  });
  if (agentId === null) return err(routingUnresolved());

  const link = createThreadLink({
    linkId: dependencies.ids.uuid() as unknown as ChannelThreadId,
    owner: command.owner,
    channelThreadKey: key.value,
    threadId: command.newThreadId,
    now: dependencies.clock.now(),
  });

  const inserted = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.insertThreadLink(link, transaction),
  );
  if (inserted.ok) return ok({ link: inserted.value, agentId, startedConversation: true });

  const raced = await dependencies.repository.findThreadLink(command.owner, key.value);
  if (!raced.ok) return err(raced.error);
  if (raced.value === null) return err(inserted.error);
  return ok({ link: raced.value, agentId: null, startedConversation: false });
}

export async function dispatchInboundTurn(
  dependencies: Dependencies,
  command: DispatchInboundTurnCommand,
): Promise<Result<DispatchedInboundTurn>> {
  const resolved = await resolveLink(dependencies, command);
  if (!resolved.ok) return err(resolved.error);

  const payload = buildInboundTurnPayload({
    inboxId: command.inboxId,
    threadId: resolved.value.link.threadId,
    agentId: resolved.value.agentId,
    message: command.message,
  });

  const handle = await dependencies.durableRuntime.dispatch({
    jobName: INBOUND_TURN_JOB_NAME,
    payloadVersion: INBOUND_TURN_PAYLOAD_VERSION,
    payload,
    scope: command.requestScope,
    idempotencyKey: inboundTurnIdempotencyKey(command.inboxId),
    startAfter: null,
  });

  return ok({
    link: resolved.value.link,
    jobId: handle.jobId,
    startedConversation: resolved.value.startedConversation,
    agentId: resolved.value.agentId,
  });
}

/** Re-exported so a transport can name the owner without reaching into domain. */
export { connectionOwner, installationOwner };
