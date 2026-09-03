// Re-encryption — moving an envelope onto the ACTIVE root key without changing
// the secret.
//
// This is the operation a key rotation is made of. Until every envelope sealed
// under a prior root key has been re-encrypted, that key must stay in the ring,
// which means it cannot be destroyed and the blast radius of its compromise stays
// open. `domain/key-ring.ts` states the same rule from the other side:
// `canRemoveRootKey` is false while anything unpurged still references the version.
//
// The revision does NOT advance. The material is unchanged, and the store's
// `[credentialId, secretRevision, rootKeyVersion]` unique key is what makes the
// same revision under a new root key a legal, distinct row.
//
// Already on the active key is a SUCCESS, not an error. An operator sweeping a
// whole environment must be able to run this over every credential and have it
// converge, and a partial sweep must be safe to repeat.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretMutation } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { credentialUnavailable } from "../domain/errors.js";
import type { CredentialId } from "../domain/ids.js";
import { toCredentialMetadata } from "../domain/metadata.js";
import type { CredentialMetadata } from "../domain/metadata.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { openSecret, sealSecret } from "./envelope-operations.js";
import { inTransaction } from "./transaction.js";

export interface ReEncryptCredentialCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId: CredentialId;
}

export async function reEncryptCredential(
  deps: SecretsDependencies,
  command: ReEncryptCredentialCommand,
): Promise<Result<CredentialMetadata>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const loaded = await deps.repository.loadForUpdate(environmentId, command.credentialId, transaction);
    if (!loaded.ok) return err(loaded.error);
    const current = loaded.value;
    if (current === null) return err(credentialUnavailable("credential_not_found"));
    const previous = current.activeSecretVersion;
    if (previous === null) return err(credentialUnavailable("no_active_secret_version"));

    const ring = await deps.keyRing.state();
    if (!ring.ok) return err(ring.error);
    if (previous.rootKeyVersion === ring.value.activeVersion) {
      return ok(toCredentialMetadata(current.credential, previous));
    }

    const material = await openSecret(deps, {
      environmentId,
      version: previous,
      activeSecretVersionId: current.credential.activeSecretVersionId,
    });
    if (!material.ok) return err(material.error);

    const draft = await sealSecret(deps, {
      environmentId,
      credentialId: current.credential.id,
      secretRevision: previous.secretRevision,
      plaintext: material.value,
    });
    if (!draft.ok) return err(draft.error);

    const stored = await deps.repository.insertSecretVersion(draft.value, transaction);
    if (!stored.ok) return err(stored.error);

    const now = deps.clock.now();
    const retired = await deps.repository.retireSecretVersion(previous.id, now, null, transaction);
    if (!retired.ok) return err(retired.error);

    const pointed = await deps.repository.setActiveSecretVersion(
      current.credential.id,
      stored.value.id,
      now,
      transaction,
    );
    if (!pointed.ok) return err(pointed.error);

    const audited = await recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: current.credential.id,
        action: "REWRAP",
        secretRevision: previous.secretRevision,
        fromRootKeyVersion: previous.rootKeyVersion,
        toRootKeyVersion: stored.value.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(toCredentialMetadata(pointed.value, stored.value));
  });
}
