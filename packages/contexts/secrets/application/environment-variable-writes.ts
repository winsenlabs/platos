// Writing environment variables — the seam where configuration meets the vault.
//
// A PLAIN variable stores its value in its own row. A SECRET variable stores NO
// value at all: it points at a Credential of kind SECRET_REFERENCE, and the
// sealed material lives in that credential's envelope. That indirection is the
// whole reason EnvironmentVariable belongs to `secrets` and not to `tenancy`.
//
// TRANSACTION COMPOSITION. The credential half is done by calling this context's
// own `createCredential` / `rotateCredential`, not by re-implementing them. The
// kernel `UnitOfWork` documents that "nesting joins the outer transaction rather
// than opening a second one", so the variable row, the credential, its envelope
// and both audit records commit or roll back together. Re-implementing the seal
// here would have been a second, divergent copy of the encryption boundary.
//
// FLIPPING SECRET TO PLAIN REVOKES. When a variable stops being a secret, the
// credential behind it is revoked if nothing else references it. Without that,
// the vault silently accumulates live, unreferenced, readable material.

import { err, ok } from "@platos/kernel";
import type { Result, TransactionScope } from "@platos/kernel";

import { requireSecretMutation } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { auditActor } from "../domain/authorization.js";
import {
  environmentVariableKey,
  environmentVariableValue,
  toEnvironmentVariableMetadata,
} from "../domain/environment-variable.js";
import type { EnvironmentVariableMetadata } from "../domain/environment-variable.js";
import { asSecretsIdentifier } from "../domain/ids.js";
import type { CredentialId, EnvironmentVariableId } from "../domain/ids.js";
import { createCredential } from "./create-credential.js";
import type { SecretsDependencies } from "./dependencies.js";
import { revokeCredential } from "./revoke-credential.js";
import { rotateCredential } from "./rotate-credential.js";
import { inTransaction } from "./transaction.js";

export interface SetEnvironmentVariableCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
}

async function upsertBackingCredential(
  deps: SecretsDependencies,
  command: SetEnvironmentVariableCommand,
  key: string,
  existingCredentialId: CredentialId | null,
): Promise<Result<CredentialId>> {
  if (existingCredentialId !== null) {
    const rotated = await rotateCredential(deps, {
      authorization: command.authorization,
      credentialId: existingCredentialId,
      plaintext: command.value,
    });
    return rotated.ok ? ok(rotated.value.id) : err(rotated.error);
  }
  const created = await createCredential(deps, {
    authorization: command.authorization,
    name: key,
    kind: "SECRET_REFERENCE",
    plaintext: command.value,
  });
  return created.ok ? ok(created.value.id) : err(created.error);
}

async function revokeIfUnreferenced(
  deps: SecretsDependencies,
  authorization: EnvironmentAuthorization,
  credentialId: CredentialId,
): Promise<Result<void>> {
  const references = await deps.variables.countReferences(credentialId);
  if (!references.ok) return err(references.error);
  if (references.value > 0) return ok(undefined);
  const revoked = await revokeCredential(deps, { authorization, credentialId });
  return revoked.ok ? ok(undefined) : err(revoked.error);
}

export async function setEnvironmentVariable(
  deps: SecretsDependencies,
  command: SetEnvironmentVariableCommand,
): Promise<Result<EnvironmentVariableMetadata>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);
  const key = environmentVariableKey(command.key);
  if (!key.ok) return err(key.error);
  const value = environmentVariableValue(command.value);
  if (!value.ok) return err(value.error);

  const environmentId = granted.value.environmentId;
  const actor = auditActor(granted.value);

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const existing = await deps.variables.findByKey(environmentId, key.value);
    if (!existing.ok) return err(existing.error);
    const previousCredentialId = existing.value?.credentialId ?? null;

    let credentialId: CredentialId | null = null;
    if (command.secret) {
      const backing = await upsertBackingCredential(deps, command, key.value, previousCredentialId);
      if (!backing.ok) return err(backing.error);
      credentialId = backing.value;
    }

    const stored = await deps.variables.upsert(
      {
        id: existing.value?.id ?? asSecretsIdentifier<EnvironmentVariableId>(deps.ids.uuid()),
        environmentId,
        key: key.value,
        kind: command.secret ? "SECRET" : "PLAIN",
        value: command.secret ? null : value.value,
        credentialId,
        lastUpdatedBy: actor.effectiveUserId ?? actor.actorId,
        at: deps.clock.now(),
        // THE FENCE, carried from the read this whole block was decided from.
        //
        // WIN-258 T7. Everything above — which id to reuse, which credential to
        // rotate rather than create — was chosen from `existing`, and between
        // that read and this write another caller may have set the same key.
        // Without the version the store cannot tell the two apart and applies
        // both, and the loser is told it won. With it the loser is refused, and
        // because the refusal travels back through `inTransaction` the ROTATION
        // above rolls back too — which is the part that matters, since a
        // committed rotation for a variable that was never written leaves a
        // credential whose envelope no reader can account for.
        expectedVersion: existing.value?.version ?? null,
      },
      transaction,
    );
    if (!stored.ok) return err(stored.error);

    if (!command.secret && previousCredentialId !== null) {
      const swept = await revokeIfUnreferenced(deps, granted.value, previousCredentialId);
      if (!swept.ok) return err(swept.error);
    }
    return ok(toEnvironmentVariableMetadata(stored.value));
  });
}

export interface DeleteEnvironmentVariableCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly key: string;
}

export interface DeleteEnvironmentVariableResult {
  readonly deleted: boolean;
  readonly key: string;
}

export async function deleteEnvironmentVariable(
  deps: SecretsDependencies,
  command: DeleteEnvironmentVariableCommand,
): Promise<Result<DeleteEnvironmentVariableResult>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);
  const key = environmentVariableKey(command.key);
  if (!key.ok) return err(key.error);

  const environmentId = granted.value.environmentId;

  return inTransaction(deps.unitOfWork, async (transaction: TransactionScope) => {
    const existing = await deps.variables.findByKey(environmentId, key.value);
    if (!existing.ok) return err(existing.error);
    if (existing.value === null) return ok({ deleted: false, key: key.value });

    const removed = await deps.variables.remove(existing.value.id, transaction);
    if (!removed.ok) return err(removed.error);
    if (existing.value.credentialId !== null) {
      const swept = await revokeIfUnreferenced(deps, granted.value, existing.value.credentialId);
      if (!swept.ok) return err(swept.error);
    }
    return ok({ deleted: true, key: key.value });
  });
}
