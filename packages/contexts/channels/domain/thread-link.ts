// `ChannelThread` and `ChannelAppThread` — the link between one provider-side
// conversation and one Platos thread.
//
// Two tables, one rule. A direct connection links through `ChannelThread`
// (unique on `[connectionId, channelThreadKey]`); a hosted installation links
// through `ChannelAppThread` (unique on `[installationId, channelThreadKey]`).
// The OWNER differs, the semantics do not, so the owner is modelled as a
// discriminated union rather than duplicated into two near-identical modules —
// and as a union rather than two nullable columns, so "which kind of link is
// this?" is a compile-time question.
//
// WHY THE LINK IS PERMANENT. The key is the provider's address for a
// conversation. Re-pointing an existing key at a different thread would split
// one human conversation across two transcripts, and the agent would lose every
// turn before the split. Re-linking to the SAME thread is idempotent — inbound
// delivery is at-least-once, so an idempotent repeat must not fail — and
// re-linking to a DIFFERENT thread is a conflict.
//
// WHERE THE AGENT IS PINNED — AND WHY IT IS NOT HERE. Routing is resolved on
// FIRST contact only, and the answer is pinned on the Platos `Thread` row, which
// `conversations` owns and this context may neither import nor write. So the
// link deliberately carries NO agent column: the existence of the link IS the
// signal that routing has already been decided. When a link is found, this
// context does not re-resolve at all and the turn runs on the thread's own
// agent. That is what stops an operator editing a rule from handing the second
// half of a live conversation to a different agent, with no shared context,
// mid-sentence — and it is preserved here WITHOUT inventing a column the
// baseline schema does not have.

import { err, ok, type Result } from "@platos/kernel";

import { threadKeyInvalid, threadLinkConflict } from "./errors.js";
import type {
  ChannelAppThreadId,
  ChannelConnectionId,
  ChannelInstallationId,
  ChannelThreadId,
  ChannelThreadKey,
  ThreadId,
} from "./identifiers.js";

/** Which table owns a link, and the row it hangs from. */
export type ThreadLinkOwner =
  | { readonly kind: "connection"; readonly connectionId: ChannelConnectionId }
  | { readonly kind: "installation"; readonly installationId: ChannelInstallationId };

export function connectionOwner(connectionId: ChannelConnectionId): ThreadLinkOwner {
  return { kind: "connection", connectionId };
}

export function installationOwner(installationId: ChannelInstallationId): ThreadLinkOwner {
  return { kind: "installation", installationId };
}

/** The stable string form of an owner — the first half of the unique. */
export function ownerKey(owner: ThreadLinkOwner): string {
  return owner.kind === "connection" ? `connection/${owner.connectionId}` : `installation/${owner.installationId}`;
}

export interface ChannelThreadLink {
  readonly linkId: ChannelThreadId | ChannelAppThreadId;
  readonly owner: ThreadLinkOwner;
  readonly channelThreadKey: ChannelThreadKey;
  readonly threadId: ThreadId;
  readonly createdAt: Date;
}

const MAX_THREAD_KEY_LENGTH = 512;

/**
 * Admit a provider-supplied conversation address as a thread key.
 *
 * Trimmed and length-bounded, and NOT lower-cased: provider ids are
 * case-sensitive (a Slack channel id is mixed-case), so folding case would
 * collide two distinct conversations onto one thread.
 */
export function admitChannelThreadKey(value: unknown): Result<ChannelThreadKey> {
  if (typeof value !== "string") return err(threadKeyInvalid("channelThreadKey must be a string"));
  const trimmed = value.trim();
  if (trimmed === "") return err(threadKeyInvalid("channelThreadKey must not be empty"));
  if (trimmed.length > MAX_THREAD_KEY_LENGTH) {
    return err(threadKeyInvalid(`channelThreadKey must be at most ${MAX_THREAD_KEY_LENGTH} characters`));
  }
  return ok(trimmed as ChannelThreadKey);
}

/** The full unique, as one comparable string. */
export function linkIdentity(owner: ThreadLinkOwner, channelThreadKey: ChannelThreadKey): string {
  return `${ownerKey(owner)}/${channelThreadKey}`;
}

export interface CreateThreadLinkInput {
  readonly linkId: ChannelThreadId | ChannelAppThreadId;
  readonly owner: ThreadLinkOwner;
  readonly channelThreadKey: ChannelThreadKey;
  readonly threadId: ThreadId;
  readonly now: Date;
}

export function createThreadLink(input: CreateThreadLinkInput): ChannelThreadLink {
  return Object.freeze({
    linkId: input.linkId,
    owner: input.owner,
    channelThreadKey: input.channelThreadKey,
    threadId: input.threadId,
    createdAt: input.now,
  });
}

/**
 * Reconcile an existing link with a requested one.
 *
 * Idempotent for the same thread, a conflict for a different one. The EXISTING
 * link is returned on the idempotent path, so a redelivery cannot quietly
 * re-point the conversation at whatever thread the caller named this time round.
 */
export function reconcileThreadLink(existing: ChannelThreadLink, requestedThreadId: ThreadId): Result<ChannelThreadLink> {
  if (existing.threadId !== requestedThreadId) {
    return err(threadLinkConflict(existing.channelThreadKey, existing.threadId, requestedThreadId));
  }
  return ok(existing);
}
