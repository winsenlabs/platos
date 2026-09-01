// Revoke — close a credential and start the retention clock on its last envelope.
//
// Revocation does not destroy the envelope. It retires it, sets a bounded
// `readableUntil`, and drops the credential's pointer, so the secret becomes
// unreadable IMMEDIATELY while the row survives long enough for an operator to
// see that it existed. Destruction is a separate, installation-scoped purge.
//
// The retention window is bounded on both ends on purpose: zero would destroy the
// evidence with the secret, and unbounded would keep sealed material alive for
// ever. The extraction source's bounds are carried over unchanged — 24 hours by
// default, 30 days at most.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretMutation } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { credentialUnavailable, invalidRetentionRequest } from "../domain/errors.js";
import type { CredentialId } from "../domain/ids.js";
import { toCredentialMetadata } from "../domain/metadata.js";
import type { CredentialMetadata } from "../domain/metadata.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { inTransaction } from "./transaction.js";

export const DEFAULT_REVOKED_SECRET_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_REVOKED_SECRET_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface RevokeCredentialCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId: CredentialId;
  readonly retentionMs?: number;
}

function retentionOf(command: RevokeCredentialCommand): Result<number> {
  const retentionMs = command.retentionMs ?? DEFAULT_REVOKED_SECRET_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    return err(invalidRetentionRequest("retention_not_a_positive_integer"));
  }
  if (retentionMs > MAX_REVOKED_SECRET_RETENTION_MS) {
    return err(invalidRetentionRequest("retention_above_maximum"));
  }
  return ok(retentionMs);
}

export async function revokeCredential(
  deps: SecretsDependencies,
  command: RevokeCredentialCommand,
): Promise<Result<CredentialMetadata>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);
  const retention = retentionOf(command);
  if (!retention.ok) return err(retention.error);

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const loaded = await deps.repository.loadForUpdate(environmentId, command.credentialId, transaction);
    if (!loaded.ok) return err(loaded.error);
    const current = loaded.value;
    if (current === null) return err(credentialUnavailable("credential_not_found"));
    const previous = current.activeSecretVersion;
    if (previous === null) return err(credentialUnavailable("no_active_secret_version"));

    const revokedAt = deps.clock.now();
    const readableUntil = new Date(revokedAt.getTime() + retention.value);
    const retired = await deps.repository.retireSecretVersion(
      previous.id,
      revokedAt,
      readableUntil,
      transaction,
    );
    if (!retired.ok) return err(retired.error);

    const cleared = await deps.repository.setActiveSecretVersion(
      current.credential.id,
      null,
      revokedAt,
      transaction,
    );
    if (!cleared.ok) return err(cleared.error);

    const revoked = await deps.repository.revokeCredential(
      current.credential.id,
      revokedAt,
      transaction,
    );
    if (!revoked.ok) return err(revoked.error);

    const audited = await recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: current.credential.id,
        action: "REVOKE",
        secretRevision: previous.secretRevision,
        fromRootKeyVersion: previous.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(toCredentialMetadata(revoked.value, null));
  });
}
