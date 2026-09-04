// Identifiers owned by the `channels` context (ADR M0.3 §1, context 9).
//
// The kernel brands the tenancy tree; these brand the six rows this context is
// sole writer of, plus the opaque strings that are NOT primary keys and are the
// easiest to mix up: a provider-side installation id, a provider-side event id,
// and the channel-thread key. All three are plain `String` columns in the
// baseline schema, all three arrive from outside, and every one of them is the
// kind of value that silently substitutes for a row id when it is typed as
// `string`.

import type { Branded } from "@platos/kernel";

/** `ChannelConnection.id` — uuid. */
export type ChannelConnectionId = Branded<string, "ChannelConnectionId">;

/** `ChannelThread.id` — uuid. */
export type ChannelThreadId = Branded<string, "ChannelThreadId">;

/** `ChannelApp.id` — uuid. */
export type ChannelAppId = Branded<string, "ChannelAppId">;

/** `ChannelInstallation.id` — uuid. */
export type ChannelInstallationId = Branded<string, "ChannelInstallationId">;

/** `ChannelAppThread.id` — uuid. */
export type ChannelAppThreadId = Branded<string, "ChannelAppThreadId">;

/** `ChannelEventInbox.id` — uuid. */
export type ChannelEventInboxId = Branded<string, "ChannelEventInboxId">;

// Rows this context references but never writes. They are branded here because
// `channels` must not import another context's domain to name them (ADR M0.3
// §2), and because the DAG forbids the edge outright for `agents` and
// `conversations`: a `threadId` reaching an `agentId` parameter is exactly the
// defect the kernel's branding note describes.
export type ThreadId = Branded<string, "ThreadId">;
export type TurnId = Branded<string, "TurnId">;
export type AgentId = Branded<string, "AgentId">;
export type EndUserId = Branded<string, "EndUserId">;
export type CredentialId = Branded<string, "CredentialId">;

/**
 * `ChannelInstallation.externalInstallationId` — the PROVIDER's id for the
 * workspace an app is installed into (a Slack team id, and its equivalents).
 * It is unique only within one app, which is why `[appId, externalInstallationId]`
 * is the unique and this alone is never a lookup key.
 */
export type ExternalInstallationId = Branded<string, "ExternalInstallationId">;

/**
 * `ChannelEventInbox.eventId` — the PROVIDER's id for one delivery. It is the
 * idempotency key of the inbox and is likewise scoped to one app, so the unique
 * is `[appId, eventId]`. It is not a `ChannelEventInboxId` and must never be
 * used as one.
 */
export type ProviderEventId = Branded<string, "ProviderEventId">;

/**
 * The provider-side address of one conversation — a channel/thread pair,
 * rendered by the adapter. It groups every inbound message that belongs to the
 * same conversation, and is unique per connection or per installation, never
 * globally.
 */
export type ChannelThreadKey = Branded<string, "ChannelThreadKey">;

/**
 * A lease holder's identity — one process/worker claiming inbox rows. Opaque,
 * and deliberately not a `PrincipalId`: a lease owner is a machine, not an
 * acting principal, and the two must not be interchangeable.
 */
export type LeaseOwner = Branded<string, "LeaseOwner">;

/**
 * One retry at consuming a rotating grant. Minted per retry, written into
 * `tokenRefreshClaimId`, and compared on commit: it is the fence that makes a
 * concurrent refresh detectable rather than silently last-write-wins.
 */
export type RefreshClaimId = Branded<string, "RefreshClaimId">;
