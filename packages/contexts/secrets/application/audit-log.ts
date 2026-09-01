// Appending evidence.
//
// The extraction source's integration suite pins that the vault "keeps audit rows
// immutable and FAILS CLOSED when audit insertion fails". That is why this helper
// returns a `Result` and every caller propagates it inside the same transaction:
// if the evidence cannot be written, the state change it describes is rolled back.
// A vault whose audit trail is best-effort has no audit trail.
//
// Everything recorded is metadata. Revisions and root key versions, never material.

import { err, ok } from "@platos/kernel";
import type { EnvironmentId, Result, TransactionScope } from "@platos/kernel";

import { auditActor } from "../domain/authorization.js";
import type {
  EnvironmentAuthorization,
  RootKeyOperationsAuthorization,
} from "../domain/authorization.js";
import type { CredentialAuditAction, CredentialAuditOutcome } from "../domain/audit.js";
import { asSecretsIdentifier } from "../domain/ids.js";
import type {
  ActorId,
  CredentialAuditId,
  CredentialId,
  RootKeyVersion,
  SecretRevision,
} from "../domain/ids.js";
import type { SecretsDependencies } from "./dependencies.js";

type AnyAuthorization = EnvironmentAuthorization | RootKeyOperationsAuthorization;

export interface AuditInput {
  readonly authorization: AnyAuthorization;
  readonly environmentId: EnvironmentId;
  readonly credentialId: CredentialId;
  readonly action: CredentialAuditAction;
  readonly outcome?: CredentialAuditOutcome;
  readonly secretRevision?: SecretRevision;
  readonly fromRootKeyVersion?: RootKeyVersion;
  readonly toRootKeyVersion?: RootKeyVersion;
}

function actorOf(authorization: AnyAuthorization): {
  actorId: ActorId;
  effectiveUserId: ActorId | null;
} {
  if (authorization.principalType === "operations") {
    return { actorId: authorization.actorId, effectiveUserId: null };
  }
  return auditActor(authorization);
}

export async function recordAudit(
  deps: SecretsDependencies,
  input: AuditInput,
  transaction: TransactionScope,
): Promise<Result<void>> {
  const actor = actorOf(input.authorization);
  const appended = await deps.repository.appendAudit(
    {
      id: asSecretsIdentifier<CredentialAuditId>(deps.ids.uuid()),
      environmentId: input.environmentId,
      credentialId: input.credentialId,
      action: input.action,
      outcome: input.outcome ?? "SUCCESS",
      actorType: input.authorization.principalType,
      actorId: actor.actorId,
      effectiveUserId: actor.effectiveUserId,
      secretRevision: input.secretRevision ?? null,
      fromRootKeyVersion: input.fromRootKeyVersion ?? null,
      toRootKeyVersion: input.toRootKeyVersion ?? null,
      createdAt: deps.clock.now(),
    },
    transaction,
  );
  return appended.ok ? ok(undefined) : err(appended.error);
}
