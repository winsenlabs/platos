// Create a credential and its first envelope.
//
// The whole thing is one unit of work: the credential row, revision 1 of its
// envelope, the pointer from one to the other, and the audit record. A partial
// commit here would leave a credential nobody can read from and nobody can
// rotate — the extraction source's integration suite pins the same atomicity
// ("rolls back credential create/rotation when linkage fails").

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretMutation, requireSameEnvironment } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { auditActor } from "../domain/authorization.js";
import type { CredentialKind } from "../domain/credential.js";
import { FIRST_SECRET_REVISION, asSecretsIdentifier, secretRevision } from "../domain/ids.js";
import type { CredentialId } from "../domain/ids.js";
import { toCredentialMetadata } from "../domain/metadata.js";
import type { CredentialMetadata } from "../domain/metadata.js";
import { requireWriteOnly } from "../domain/secret-material.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { sealSecret } from "./envelope-operations.js";
import { inTransaction } from "./transaction.js";

export interface CreateCredentialCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly name: string;
  readonly kind?: CredentialKind;
  readonly provider?: string | null;
  /**
   * WRITE-ONLY. Minted by `acceptPlaintext`, which the contract re-exports, so
   * the plaintext is already inside a self-redacting holder by the time a
   * command object exists to be serialised, queued or logged.
   */
  readonly plaintext: SecretMaterial;
}

export async function createCredential(
  deps: SecretsDependencies,
  command: CreateCredentialCommand,
): Promise<Result<CredentialMetadata>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);
  const material = requireWriteOnly("plaintext", command.plaintext);
  if (!material.ok) return err(material.error);
  const revision = secretRevision(FIRST_SECRET_REVISION);
  if (!revision.ok) return err(revision.error);

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const credentialId = asSecretsIdentifier<CredentialId>(deps.ids.uuid());
    const now = deps.clock.now();
    const created = await deps.repository.insertCredential(
      {
        id: credentialId,
        environmentId,
        kind: command.kind ?? "SERVICE_CREDENTIAL",
        name: command.name,
        provider: command.provider ?? null,
        createdBy: auditActor(authorization).effectiveUserId ?? auditActor(authorization).actorId,
        createdAt: now,
      },
      transaction,
    );
    if (!created.ok) return err(created.error);

    const draft = await sealSecret(deps, {
      environmentId,
      credentialId,
      secretRevision: revision.value,
      plaintext: material.value,
    });
    if (!draft.ok) return err(draft.error);

    const stored = await deps.repository.insertSecretVersion(draft.value, transaction);
    if (!stored.ok) return err(stored.error);

    const pointed = await deps.repository.setActiveSecretVersion(
      credentialId,
      stored.value.id,
      now,
      transaction,
    );
    if (!pointed.ok) return err(pointed.error);
    const scoped = requireSameEnvironment(authorization, pointed.value.environmentId);
    if (!scoped.ok) return err(scoped.error);

    const audited = await recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId,
        action: "CREATE",
        secretRevision: revision.value,
        toRootKeyVersion: stored.value.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(toCredentialMetadata(pointed.value, stored.value));
  });
}
