// Rotate: seal NEW material at revision + 1 and retire what it replaces.
//
// Rotation and re-encryption are deliberately different use cases even though
// both mint an envelope. Rotation changes the SECRET, so the revision advances.
// Re-encryption changes the KEY, so the revision does not. Collapsing them would
// make the store's `[credentialId, secretRevision, rootKeyVersion]` unique key
// unexplainable, and would let a key rotation silently look like a secret change
// in the audit trail.
//
// `readableUntil` on the retired version is a purge-deferral window, not a
// second read path: the retired envelope is closed to reads the instant it is
// retired. Material a caller already holds stays valid — the extraction source's
// integration suite pins that ("rotates without invalidating acquired material") —
// because that material is a value in the caller's hand, not a re-openable row.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretMutation } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { credentialUnavailable } from "../domain/errors.js";
import { nextSecretRevision } from "../domain/ids.js";
import type { CredentialId } from "../domain/ids.js";
import { toCredentialMetadata } from "../domain/metadata.js";
import type { CredentialMetadata } from "../domain/metadata.js";
import { requireWriteOnly } from "../domain/secret-material.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { sealSecret } from "./envelope-operations.js";
import { inTransaction } from "./transaction.js";

export interface RotateCredentialCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId: CredentialId;
  /** WRITE-ONLY, for the reason `CreateCredentialCommand.plaintext` gives. */
  readonly plaintext: SecretMaterial;
  /** Defers purging of the envelope being retired. It does NOT keep it readable. */
  readonly readableUntil?: Date;
}

export async function rotateCredential(
  deps: SecretsDependencies,
  command: RotateCredentialCommand,
): Promise<Result<CredentialMetadata>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);
  const material = requireWriteOnly("plaintext", command.plaintext);
  if (!material.ok) return err(material.error);

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const loaded = await deps.repository.loadForUpdate(environmentId, command.credentialId, transaction);
    if (!loaded.ok) return err(loaded.error);
    const current = loaded.value;
    if (current === null) return err(credentialUnavailable("credential_not_found"));
    if (current.credential.revokedAt !== null) return err(credentialUnavailable("credential_revoked"));
    const previous = current.activeSecretVersion;
    if (previous === null) return err(credentialUnavailable("no_active_secret_version"));

    const revision = nextSecretRevision(previous.secretRevision);
    if (!revision.ok) return err(revision.error);

    const draft = await sealSecret(deps, {
      environmentId,
      credentialId: current.credential.id,
      secretRevision: revision.value,
      plaintext: material.value,
    });
    if (!draft.ok) return err(draft.error);

    const stored = await deps.repository.insertSecretVersion(draft.value, transaction);
    if (!stored.ok) return err(stored.error);

    const now = deps.clock.now();
    const retired = await deps.repository.retireSecretVersion(
      previous.id,
      now,
      command.readableUntil ?? null,
      transaction,
    );
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
        action: "ROTATE",
        secretRevision: revision.value,
        fromRootKeyVersion: previous.rootKeyVersion,
        toRootKeyVersion: stored.value.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(toCredentialMetadata(pointed.value, stored.value));
  });
}
