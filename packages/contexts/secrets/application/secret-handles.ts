// Issuing a SECRET REFERENCE, and exchanging one for material.
//
// domain/secret-handle.ts states what a reference IS. This file states the two
// things that can be done with one, and the rules each obeys.
//
// -----------------------------------------------------------------------------
// WHO MAY ISSUE, AND WHY IT IS THE METADATA GRANT.
//
// Issuing takes `requireMetadataAccess` — any minted environment grant — and
// that is a deliberate choice rather than the loosest one available.
//
// A reference confers NOTHING on its own. It carries no material, no key and no
// ciphertext of a secret; exchanging one still needs a RUNTIME grant for the
// SAME environment, which is precisely the grant that could already have read
// the same credential by name. So an issuer hands out no access it did not
// already have the power to describe, and issuing is exactly as sensitive as
// `describeCredential`, which the same grant already allows.
//
// What issuing DOES do is narrow: it pins one revision and one expiry onto an
// address that was previously an unbounded, guessable, environment-portable
// string. The control plane that used to write `"STRIPE_SECRET_KEY"` into a job
// payload can now write a reference, and the job payload stops being a map of
// the vault.
//
// AN ISSUE IS NOT AUDITED, AND THAT IS A MEASURED LIMIT RATHER THAN AN OVERSIGHT.
// `CredentialAudit.action` is the canonical store's vocabulary — CREATE, READ,
// ROTATE, REWRAP, REVOKE, PURGE — and this issue does not extend it. There is no
// member that truthfully describes "minted an address"; recording an issue as
// READ would put a row in the trail saying material moved when none did, which
// is worse than the gap because it makes every genuine READ row less trustworthy.
// The moment material actually moves — the EXCHANGE — is audited, in both
// directions, below.
//
// -----------------------------------------------------------------------------
// WHAT THE EXCHANGE REFUSES, AND IN WHICH ORDER.
//
//   1. NOT THE RUNTIME TIER — the same rule `readSecret` obeys. An operator may
//      mint a reference and may not spend one.
//   2. NOT THIS ENVIRONMENT — and this refusal is not a comparison. The
//      environment is in the reference's key derivation and its AAD, so a
//      reference minted in staging presented under a production grant fails to
//      DECRYPT. There is no `if` here to invert.
//   3. EXPIRED — a reference is a ticket with a life, not a key.
//   4. SUPERSEDED — the reference pins the revision that was active when it was
//      issued. A rotation past that revision closes every reference to it, which
//      is the property that makes a reference safe to persist: a leaked payload
//      stops resolving the moment the secret is rotated, without anyone having to
//      find the payload.
//
// Every one of the four answers the SAME `CREDENTIAL_UNAVAILABLE` or
// `CREDENTIAL_FORBIDDEN` on the wire. The reason lives in log-only `details`.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireMetadataAccess, requireSecretRead } from "../domain/access-rules.js";
import { isMintedAuthorization } from "../domain/authorization.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { isUsable } from "../domain/credential.js";
import type { CredentialKind } from "../domain/credential.js";
import { credentialUnavailable } from "../domain/errors.js";
import type { CredentialId } from "../domain/ids.js";
import {
  DEFAULT_SECRET_HANDLE_LIFETIME_MS,
  decodeSecretHandle,
  encodeSecretHandle,
  isHandleExpired,
  parseHandleClaims,
  requireHandleLifetime,
  serializeHandleClaims,
} from "../domain/secret-handle.js";
import type {
  SecretHandle,
  SecretHandleBinding,
  SecretHandleClaims,
} from "../domain/secret-handle.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import { recordAudit } from "./audit-log.js";
import type { SecretsDependencies } from "./dependencies.js";
import { openSecret } from "./envelope-operations.js";
import { inTransaction } from "./transaction.js";

export interface IssueSecretHandleCommand {
  readonly authorization: EnvironmentAuthorization;
  readonly credentialId?: CredentialId;
  readonly name?: string;
  readonly provider?: string;
  readonly kind?: CredentialKind;
  /** How long the reference lives. Defaulted short; ceilinged, never clamped. */
  readonly lifetimeMs?: number;
}

/**
 * What an issue returns.
 *
 * `expiresAt` is published because a holder has to be able to decide whether to
 * ask for a fresh reference before spending a stale one, and a holder cannot
 * read it out of the reference itself — the whole point is that the reference is
 * opaque. Nothing else about the credential comes back: not its name, not its
 * provider, not its revision.
 */
export interface IssuedSecretHandle {
  readonly handle: SecretHandle;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface ExchangeSecretHandleQuery {
  readonly authorization: EnvironmentAuthorization;
  readonly handle: unknown;
}

function selector(command: IssueSecretHandleCommand): {
  readonly credentialId?: CredentialId;
  readonly name?: string;
  readonly provider?: string;
  readonly kind?: CredentialKind;
} {
  return {
    ...(command.credentialId === undefined ? {} : { credentialId: command.credentialId }),
    ...(command.name === undefined ? {} : { name: command.name }),
    ...(command.provider === undefined ? {} : { provider: command.provider }),
    ...(command.kind === undefined ? {} : { kind: command.kind }),
  };
}

/**
 * Mint a reference to the credential's CURRENT revision.
 *
 * No transaction: this reads one row and writes none. Wrapping a pure read in a
 * unit of work would have said a state change happened here, and the one place
 * this context is strict about is what its transactions mean.
 */
export async function issueSecretHandle(
  deps: SecretsDependencies,
  command: IssueSecretHandleCommand,
): Promise<Result<IssuedSecretHandle>> {
  const granted = requireMetadataAccess(command.authorization);
  if (!granted.ok) return err(granted.error);
  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  const lifetime = requireHandleLifetime(command.lifetimeMs ?? DEFAULT_SECRET_HANDLE_LIFETIME_MS);
  if (!lifetime.ok) return err(lifetime.error);

  const found = await deps.repository.findCredential({ environmentId, ...selector(command) });
  if (!found.ok) return err(found.error);
  const current = found.value;
  if (current === null) return err(credentialUnavailable("credential_not_found"));

  const now = deps.clock.now();
  if (!isUsable(current.credential, now)) {
    return err(
      credentialUnavailable(
        current.credential.revokedAt === null ? "no_active_secret_version" : "credential_revoked",
      ),
    );
  }
  const active = current.activeSecretVersion;
  if (active === null) return err(credentialUnavailable("no_active_secret_version"));

  // The reference is sealed under the ring's ACTIVE key, not under the key that
  // sealed the credential's envelope. They are independent lifetimes: a root key
  // rotation retires outstanding references (their key leaves the ring) without
  // touching the stored envelopes, which is the conservative direction — a
  // reference stops working and a secret stays readable, never the reverse.
  const ring = await deps.keyRing.state();
  if (!ring.ok) return err(ring.error);
  const key = await deps.keyRing.handle(ring.value.activeVersion);
  if (!key.ok) return err(key.error);

  const binding: SecretHandleBinding = {
    environmentId,
    rootKeyVersion: ring.value.activeVersion,
  };
  const claims: SecretHandleClaims = {
    handleId: deps.ids.uuid(),
    credentialId: current.credential.id,
    secretRevision: active.secretRevision,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + lifetime.value),
  };
  const sealed = await deps.cipher.sealHandle({
    key: key.value,
    binding,
    body: serializeHandleClaims(claims),
  });
  if (!sealed.ok) return err(sealed.error);

  return ok({
    handle: encodeSecretHandle(binding, sealed.value),
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

/**
 * Open a reference under the presented grant's environment.
 *
 * Split out because BOTH the granted path and the denied path need it, and they
 * need it to behave identically: a denial must not learn more about a reference
 * than a success does, or the denial becomes the oracle.
 */
async function openHandleClaims(
  deps: SecretsDependencies,
  authorization: EnvironmentAuthorization,
  handle: unknown,
): Promise<Result<SecretHandleClaims>> {
  const parsed = decodeSecretHandle(handle);
  if (!parsed.ok) return err(parsed.error);

  const key = await deps.keyRing.handle(parsed.value.rootKeyVersion);
  if (!key.ok) return err(key.error);

  const opened = await deps.cipher.openHandle({
    key: key.value,
    binding: {
      environmentId: authorization.environmentId,
      rootKeyVersion: parsed.value.rootKeyVersion,
    },
    envelope: parsed.value.envelope,
  });
  if (!opened.ok) return err(opened.error);

  return parseHandleClaims(opened.value);
}

/**
 * Write the evidence that somebody spent a reference they may not spend.
 *
 * The same three limits `recordDeniedRead` states, for the same three reasons:
 * its own unit of work, an unminted authorization is not recorded, and a
 * credential that does not resolve is not recorded because
 * `CredentialAudit.credentialId` is a required column with a foreign key.
 *
 * A FOURTH LIMIT IS SPECIFIC TO REFERENCES AND IS THE STRONGEST OF THE FOUR. A
 * reference that does not OPEN under the presented grant's environment leaves no
 * trace, because there is nothing to leave a trace about: the reference names no
 * credential in this environment, and the trail may only name credentials that
 * exist here. That is the correct answer rather than a shortfall — an attacker
 * replaying another tenant's references into this one would otherwise be able to
 * write rows into this tenant's audit trail.
 */
async function recordDeniedExchange(
  deps: SecretsDependencies,
  query: ExchangeSecretHandleQuery,
): Promise<void> {
  const authorization = query.authorization;
  if (!isMintedAuthorization(authorization)) return;
  const environmentId = authorization.environmentId;

  const claims = await openHandleClaims(deps, authorization, query.handle);
  if (!claims.ok) return;

  const found = await deps.repository.findCredential({
    environmentId,
    credentialId: claims.value.credentialId,
  });
  if (!found.ok || found.value === null) return;
  const probed = found.value;
  const version = probed.activeSecretVersion;

  await inTransaction(deps.unitOfWork, (transaction) =>
    recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: probed.credential.id,
        action: "READ",
        outcome: "DENIED",
        secretRevision: claims.value.secretRevision,
        ...(version === null
          ? {}
          : {
              fromRootKeyVersion: version.rootKeyVersion,
              toRootKeyVersion: version.rootKeyVersion,
            }),
      },
      transaction,
    ),
  );
}

export async function exchangeSecretHandle(
  deps: SecretsDependencies,
  query: ExchangeSecretHandleQuery,
): Promise<Result<SecretMaterial>> {
  const granted = requireSecretRead(query.authorization);
  if (!granted.ok) {
    await recordDeniedExchange(deps, query);
    return err(granted.error);
  }

  const authorization = granted.value;
  const environmentId = authorization.environmentId;

  const claims = await openHandleClaims(deps, authorization, query.handle);
  if (!claims.ok) return err(claims.error);
  const reference = claims.value;

  if (isHandleExpired(reference, deps.clock.now())) {
    return err(credentialUnavailable("handle_expired"));
  }

  return inTransaction(deps.unitOfWork, async (transaction) => {
    const found = await deps.repository.findCredential({
      environmentId,
      credentialId: reference.credentialId,
    });
    if (!found.ok) return err(found.error);
    const current = found.value;
    if (current === null) return err(credentialUnavailable("credential_not_found"));

    const now = deps.clock.now();
    if (!isUsable(current.credential, now)) {
      return err(
        credentialUnavailable(
          current.credential.revokedAt === null ? "no_active_secret_version" : "credential_revoked",
        ),
      );
    }
    const version = current.activeSecretVersion;
    if (version === null) return err(credentialUnavailable("no_active_secret_version"));
    if (version.secretRevision !== reference.secretRevision) {
      return err(credentialUnavailable("handle_revision_superseded"));
    }

    const material = await openSecret(deps, {
      environmentId,
      version,
      activeSecretVersionId: current.credential.activeSecretVersionId,
    });
    if (!material.ok) return err(material.error);

    const audited = await recordAudit(
      deps,
      {
        authorization,
        environmentId,
        credentialId: current.credential.id,
        action: "READ",
        secretRevision: version.secretRevision,
        fromRootKeyVersion: version.rootKeyVersion,
        toRootKeyVersion: version.rootKeyVersion,
      },
      transaction,
    );
    if (!audited.ok) return err(audited.error);

    return ok(material.value);
  });
}
