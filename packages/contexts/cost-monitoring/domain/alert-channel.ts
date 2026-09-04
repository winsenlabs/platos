// `AlertChannel` and `AlertChannelConfiguration` — where an alert goes.
//
// Two rows, one aggregate. The store splits them because the configuration is
// per-kind and sparse — an email channel has an address and eleven nulls — and
// because the configuration is the row that holds the credential reference. They
// are one thing here: a channel with no configuration cannot deliver anything,
// and every path in the source that finds one refuses on the spot.
//
// THIS CONTEXT NEVER HOLDS A SECRET AND NEVER READS ONE.
//
// A webhook's signing secret and a chat platform's bearer token live in the
// `secrets` vault, which is NOT on this context's ADR §1 row 13 allow-list. A
// configuration therefore carries a `CredentialRef` — a name for material this
// context cannot open — and the `Notifier` adapter resolves it at dispatch. The
// separation is not ceremony: it is why an alert-channel listing can be rendered
// by a surface that has no vault grant at all, which is the source's own
// behaviour and the reason `publicChannel` there redacts by construction rather
// than by remembering to.
//
// THE DEDUPLICATION KEY IS UNIQUE PER ENVIRONMENT, AND DELETION RELEASES IT.
// The source nulls the key when it tombstones a channel, and that is load-bearing
// rather than tidy: `@@unique([environmentId, deduplicationKey])` counts deleted
// rows, so a retired channel would otherwise hold its operator-chosen key
// hostage forever and a rebuild under the same name would be refused.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { admitTopics, wantsBudgetAlerts } from "./alert-topic.js";
import { alertChannelInvalid } from "./errors.js";
import {
  asCostIdentifier,
  type AlertChannelId,
  type CredentialRef,
  type DeduplicationKey,
} from "./identifiers.js";

/** The three transports a channel can be. `AlertChannelType` in the store. */
export const CHANNEL_KINDS = ["EMAIL", "SLACK", "WEBHOOK"] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as readonly string[]).includes(value);
}

export const MAX_CHANNEL_NAME_LENGTH = 200;
export const MAX_DEDUPLICATION_KEY_LENGTH = 200;

/** An address, per kind. Never material — only a reference to some. */
export type ChannelConfiguration =
  | {
      readonly kind: "EMAIL";
      readonly email: string;
    }
  | {
      readonly kind: "SLACK";
      readonly channelId: string;
      readonly channelName: string;
      /** The workspace link, when one was made. Metadata, never a token. */
      readonly integrationId: string | null;
      readonly credential: CredentialRef | null;
    }
  | {
      readonly kind: "WEBHOOK";
      readonly url: string;
      /** The signing secret's handle. Required: an unsigned webhook is forgeable. */
      readonly credential: CredentialRef;
    };

export interface AlertChannel {
  readonly channelId: AlertChannelId;
  readonly environmentId: EnvironmentId;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly topics: readonly string[];
  readonly deduplicationKey: DeduplicationKey | null;
  readonly operatorSuppliedKey: boolean;
  readonly configuration: ChannelConfiguration;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an operator supplies to create a channel. */
export interface AlertChannelIntake {
  readonly kind: string;
  readonly name: string;
  readonly topics: readonly string[];
  readonly deduplicationKey?: string | null;
  readonly configuration: ChannelConfigurationIntake;
}

export interface ChannelConfigurationIntake {
  readonly email?: string;
  readonly url?: string;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly integrationId?: string | null;
  /** The reference minted by the vault after the secret was stored. */
  readonly credential?: string | null;
}

export interface AdmittedAlertChannel {
  readonly kind: ChannelKind;
  readonly name: string;
  readonly topics: readonly string[];
  readonly deduplicationKey: DeduplicationKey | null;
  readonly operatorSuppliedKey: boolean;
  readonly configuration: ChannelConfiguration;
}

function bounded(value: string, field: string, maximum: number): Result<string> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return err(
      alertChannelInvalid(`${field} is required`, [
        { field, code: "required", message: `${field} is required` },
      ]),
    );
  }
  if (trimmed.length > maximum) {
    return err(
      alertChannelInvalid(`${field} must be at most ${maximum} characters`, [
        { field, code: "too_long", message: `${field} must be at most ${maximum} characters` },
      ]),
    );
  }
  return ok(trimmed);
}

/**
 * Admit a configuration for a kind.
 *
 * The email check is the source's: an address must contain `@` and nothing more
 * is asserted. That is deliberate rather than lazy — a stricter grammar rejects
 * addresses that are legal and deliverable, and the authority on whether an
 * address works is the delivery result the ledger already records.
 *
 * The URL is NOT reachability-checked here. Whether a host resolves to a private
 * or loopback address is a property of the network at the instant of the call,
 * not of the string, and a domain function that answered it would be doing I/O.
 * The `Notifier` adapter re-checks at dispatch, which is also the only check
 * that can defend against a name that resolves differently the second time.
 */
export function admitConfiguration(
  kind: ChannelKind,
  intake: ChannelConfigurationIntake,
): Result<ChannelConfiguration> {
  if (kind === "EMAIL") {
    const email = bounded(intake.email ?? "", "email", MAX_CHANNEL_NAME_LENGTH);
    if (!email.ok) return err(email.error);
    if (!email.value.includes("@")) {
      return err(
        alertChannelInvalid("invalid email", [
          { field: "email", code: "invalid", message: "email must contain @" },
        ]),
      );
    }
    return ok({ kind: "EMAIL", email: email.value });
  }
  if (kind === "SLACK") {
    const channelId = bounded(intake.channelId ?? "", "channelId", MAX_CHANNEL_NAME_LENGTH);
    if (!channelId.ok) return err(channelId.error);
    const channelName = bounded(intake.channelName ?? "", "channelName", MAX_CHANNEL_NAME_LENGTH);
    if (!channelName.ok) return err(channelName.error);
    const integrationId = (intake.integrationId ?? "").trim();
    const credential = (intake.credential ?? "").trim();
    return ok({
      kind: "SLACK",
      channelId: channelId.value,
      channelName: channelName.value,
      integrationId: integrationId === "" ? null : integrationId,
      credential: credential === "" ? null : asCostIdentifier<CredentialRef>(credential),
    });
  }
  const url = bounded(intake.url ?? "", "url", 2048);
  if (!url.ok) return err(url.error);
  const credential = (intake.credential ?? "").trim();
  if (credential === "") {
    return err(
      alertChannelInvalid("invalid webhook secret", [
        { field: "credential", code: "required", message: "a webhook must be signed" },
      ]),
    );
  }
  return ok({ kind: "WEBHOOK", url: url.value, credential: asCostIdentifier<CredentialRef>(credential) });
}

export function admitAlertChannel(intake: AlertChannelIntake): Result<AdmittedAlertChannel> {
  if (!isChannelKind(intake.kind)) {
    return err(
      alertChannelInvalid(`invalid type: ${intake.kind}`, [
        { field: "kind", code: "invalid", message: "kind must be EMAIL, SLACK or WEBHOOK" },
      ]),
    );
  }
  const name = bounded(intake.name, "name", MAX_CHANNEL_NAME_LENGTH);
  if (!name.ok) return err(name.error);
  const topics = admitTopics(intake.topics);
  if (!topics.ok) return err(topics.error);
  const configuration = admitConfiguration(intake.kind, intake.configuration);
  if (!configuration.ok) return err(configuration.error);

  const supplied = typeof intake.deduplicationKey === "string";
  if (!supplied) {
    return ok({
      kind: intake.kind,
      name: name.value,
      topics: topics.value,
      deduplicationKey: null,
      operatorSuppliedKey: false,
      configuration: configuration.value,
    });
  }
  const key = bounded(intake.deduplicationKey ?? "", "deduplicationKey", MAX_DEDUPLICATION_KEY_LENGTH);
  if (!key.ok) return err(key.error);
  return ok({
    kind: intake.kind,
    name: name.value,
    topics: topics.value,
    deduplicationKey: asCostIdentifier<DeduplicationKey>(key.value),
    operatorSuppliedKey: true,
    configuration: configuration.value,
  });
}

/** What an operator may change on a live channel. */
export interface AlertChannelPatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly topics?: readonly string[];
  readonly configuration?: ChannelConfigurationIntake;
}

export interface AdmittedAlertChannelPatch {
  readonly name: string | null;
  readonly enabled: boolean | null;
  readonly topics: readonly string[] | null;
  readonly configuration: ChannelConfiguration | null;
}

/**
 * Admit a patch. KIND IS ABSENT AND CANNOT BE PATCHED.
 *
 * The store keys the configuration on `[channelId, environmentId, type]`, so a
 * kind change would orphan the configuration row rather than convert it. The
 * source spells this in prose on the surface ("Type and ownership are
 * immutable"); here it is spelled in the type, where it cannot be forgotten.
 */
export function admitAlertChannelPatch(
  kind: ChannelKind,
  patch: AlertChannelPatch,
): Result<AdmittedAlertChannelPatch> {
  let name: string | null = null;
  if (patch.name !== undefined) {
    const admitted = bounded(patch.name, "name", MAX_CHANNEL_NAME_LENGTH);
    if (!admitted.ok) return err(admitted.error);
    name = admitted.value;
  }
  let topics: readonly string[] | null = null;
  if (patch.topics !== undefined) {
    const admitted = admitTopics(patch.topics);
    if (!admitted.ok) return err(admitted.error);
    topics = admitted.value;
  }
  let configuration: ChannelConfiguration | null = null;
  if (patch.configuration !== undefined) {
    const admitted = admitConfiguration(kind, patch.configuration);
    if (!admitted.ok) return err(admitted.error);
    configuration = admitted.value;
  }
  return ok({ name, enabled: patch.enabled ?? null, topics, configuration });
}

/** True when a patch would change nothing at all. */
export function isEmptyPatch(patch: AdmittedAlertChannelPatch): boolean {
  return (
    patch.name === null &&
    patch.enabled === null &&
    patch.topics === null &&
    patch.configuration === null
  );
}

export function applyChannelPatch(
  channel: AlertChannel,
  patch: AdmittedAlertChannelPatch,
  now: Date,
): AlertChannel {
  return {
    ...channel,
    name: patch.name ?? channel.name,
    enabled: patch.enabled ?? channel.enabled,
    topics: patch.topics ?? channel.topics,
    configuration: patch.configuration ?? channel.configuration,
    updatedAt: now,
  };
}

/**
 * Retire a channel: disabled, and its deduplication key released.
 *
 * The row itself survives so the delivery ledger that points at it stays
 * readable — an operator investigating a missed alert needs the channel's name,
 * and a foreign key that dangles is not an investigation aid.
 */
export function retireChannel(channel: AlertChannel, now: Date): AlertChannel {
  return {
    ...channel,
    enabled: false,
    deduplicationKey: null,
    operatorSuppliedKey: false,
    updatedAt: now,
  };
}

/** The channels a budget alert fans out to: live, switched on, subscribed. */
export function budgetRecipients(channels: readonly AlertChannel[]): readonly AlertChannel[] {
  return channels.filter((channel) => channel.enabled && wantsBudgetAlerts(channel.topics));
}
