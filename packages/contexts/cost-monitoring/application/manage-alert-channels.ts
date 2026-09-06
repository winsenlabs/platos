// Use cases: the alert-channel lifecycle.
//
// EVERY MUTATION HERE DEMANDS `secret:mutate`, AND A READ DEMANDS ONLY
// `metadata`. That asymmetry is the source's and it is right: creating or
// updating a channel causes a credential to be minted or rotated in the vault,
// even though this context never touches the material. A cap, by contrast, holds
// no material at all — `configure-budget.ts` authorises at the lower level for
// exactly that reason.
//
// THE CREDENTIAL IS PUT IN THE VAULT BY THE CALLER, NOT HERE. `secrets` is not on
// this context's ADR §1 row 13 allow-list, so a command arrives carrying a
// `CredentialRef` — the handle the vault already minted — and this context stores
// the reference. The composition root does the two-step: vault write, then this
// call, in one transaction. Modelling it the other way round would need a
// `secrets` edge that the DAG does not have and that nothing else here wants.
//
// DELETION ASKS BEFORE IT TELLS. `releasableCredential` answers whether the
// vault entry may now be revoked, and it answers no when another live channel
// still points at it. Two channels can share one signing secret, and revoking on
// the first delete silently breaks the second.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitAlertChannel,
  admitAlertChannelPatch,
  alertChannelExists,
  alertChannelNotFound,
  alertChannelUnchanged,
  applyChannelPatch,
  asCostIdentifier,
  isEmptyPatch,
  retireChannel,
  type AlertChannel,
  type AlertChannelId,
  type AlertChannelIntake,
  type AlertChannelPatch,
  type ChannelKind,
} from "../domain/index.js";
import { authorize, verifyOperator } from "./authorization.js";
import type { CostMonitoringDependencies } from "./dependencies.js";

export interface ReadAlertChannelsQuery {
  readonly authorization: unknown;
  readonly kind?: ChannelKind | null;
  readonly enabled?: boolean | null;
  readonly limit?: number;
}

export interface DescribeAlertChannelQuery {
  readonly authorization: unknown;
  readonly channelId: AlertChannelId;
}

export interface CreateAlertChannelCommand {
  readonly authorization: unknown;
  readonly intake: AlertChannelIntake;
}

export interface UpdateAlertChannelCommand {
  readonly authorization: unknown;
  readonly channelId: AlertChannelId;
  readonly patch: AlertChannelPatch;
}

export interface RemoveAlertChannelCommand {
  readonly authorization: unknown;
  readonly channelId: AlertChannelId;
}

/** A retired channel, and whether its credential may now be revoked. */
export interface RetiredAlertChannel {
  readonly channel: AlertChannel;
  /**
   * The vault entry the caller may now revoke, or `null`.
   *
   * Null covers both "this channel had none" and "another live channel still
   * uses it". The caller does not need to tell them apart — in both cases it
   * revokes nothing — and collapsing them means there is no code path that
   * revokes a shared secret.
   */
  readonly releasableCredential: string | null;
}

export async function listAlertChannels(
  dependencies: CostMonitoringDependencies,
  query: ReadAlertChannelsQuery,
): Promise<Result<readonly AlertChannel[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return dependencies.repository.listAlertChannels(granted.value.scope, {
    kind: query.kind ?? null,
    enabled: query.enabled ?? null,
    limit: Math.min(
      Math.max(Math.trunc(query.limit ?? dependencies.policy.maxPageSize), 1),
      dependencies.policy.maxPageSize,
    ),
  });
}

export async function describeAlertChannel(
  dependencies: CostMonitoringDependencies,
  query: DescribeAlertChannelQuery,
): Promise<Result<AlertChannel>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const found = await dependencies.repository.findAlertChannel(granted.value.scope, query.channelId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(alertChannelNotFound(query.channelId));
  return ok(found.value);
}

export async function createAlertChannel(
  dependencies: CostMonitoringDependencies,
  command: CreateAlertChannelCommand,
): Promise<Result<AlertChannel>> {
  const granted = authorize(dependencies, command.authorization, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const admitted = admitAlertChannel(command.intake);
  if (!admitted.ok) return err(admitted.error);

  const scope = granted.value.scope;
  // The deduplication-key collision is checked BEFORE anything is written, so
  // the ordinary mistake — reusing a key — is refused without a write.
  if (admitted.value.deduplicationKey !== null) {
    const existing = await dependencies.repository.listAlertChannels(scope, {
      kind: null,
      enabled: null,
      limit: dependencies.policy.maxPageSize,
    });
    if (!existing.ok) return err(existing.error);
    const taken = existing.value.some(
      (channel) => channel.deduplicationKey === admitted.value.deduplicationKey,
    );
    if (taken) return err(alertChannelExists(admitted.value.deduplicationKey));
  }

  const now = dependencies.clock.now();
  const draft: AlertChannel = {
    channelId: asCostIdentifier<AlertChannelId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    kind: admitted.value.kind,
    name: admitted.value.name,
    enabled: true,
    topics: admitted.value.topics,
    deduplicationKey: admitted.value.deduplicationKey,
    operatorSuppliedKey: admitted.value.operatorSuppliedKey,
    configuration: admitted.value.configuration,
    createdAt: now,
    updatedAt: now,
  };
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.insertAlertChannel(draft, transaction),
  );
}

export async function updateAlertChannel(
  dependencies: CostMonitoringDependencies,
  command: UpdateAlertChannelCommand,
): Promise<Result<AlertChannel>> {
  const granted = authorize(dependencies, command.authorization, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findAlertChannel(scope, command.channelId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(alertChannelNotFound(command.channelId));

  // The kind comes from the STORED row, never from the patch. The store keys the
  // configuration on `[channelId, environmentId, type]`, so a kind change would
  // orphan the configuration row rather than convert it.
  const admitted = admitAlertChannelPatch(found.value.kind, command.patch);
  if (!admitted.ok) return err(admitted.error);
  if (isEmptyPatch(admitted.value)) return err(alertChannelUnchanged(command.channelId));

  const patched = applyChannelPatch(found.value, admitted.value, dependencies.clock.now());
  return runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.updateAlertChannel(patched, transaction),
  );
}

export async function removeAlertChannel(
  dependencies: CostMonitoringDependencies,
  command: RemoveAlertChannelCommand,
): Promise<Result<RetiredAlertChannel>> {
  const granted = authorize(dependencies, command.authorization, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const scope = granted.value.scope;
  const found = await dependencies.repository.findAlertChannel(scope, command.channelId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(alertChannelNotFound(command.channelId));

  const retired = retireChannel(found.value, dependencies.clock.now());
  const written = await runResult(dependencies.unitOfWork, (transaction) =>
    dependencies.repository.updateAlertChannel(retired, transaction),
  );
  if (!written.ok) return err(written.error);

  const credential = credentialOf(found.value);
  if (credential === null) return ok({ channel: written.value, releasableCredential: null });

  const shared = await dependencies.repository.countChannelsUsingCredential(scope, credential);
  // A count that could not be read is treated as "still shared". Failing to
  // revoke leaves an unused secret in the vault, which is untidy; revoking one
  // another live channel is signing with breaks that channel silently.
  if (!shared.ok || shared.value > 0) {
    return ok({ channel: written.value, releasableCredential: null });
  }
  return ok({ channel: written.value, releasableCredential: credential });
}

/** The vault handle a channel's configuration names, if it names one. */
export function credentialOf(channel: AlertChannel): string | null {
  const configuration = channel.configuration;
  if (configuration.kind === "EMAIL") return null;
  if (configuration.kind === "SLACK") return configuration.credential;
  return configuration.credential;
}
