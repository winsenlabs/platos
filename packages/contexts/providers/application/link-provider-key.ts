// Use case: link a provider to a credential that already exists.
//
// The operator has already put material in the vault — through the environment
// variable surface, a migration, or an earlier registration — and is now saying
// "that one is this provider's key". Nothing here touches material: the whole
// operation is one metadata row.
//
// ORDER MATTERS AND IS DELIBERATE. The label collision is checked BEFORE the
// credential is resolved, and both before anything is written, so the ordinary
// mistake — reusing a label — is refused without a write and without a lookup
// that reveals which credentials exist.

import { asIdentifier, err, ok, type Result } from "@platos/kernel";

import {
  admitProviderKey,
  asProvidersIdentifier,
  type ActorId,
  type CredentialId,
  type CredentialName,
  type ProviderKey,
  type ProviderKeyId,
  type ProviderKeyIntake,
} from "../domain/index.js";
import { requireAccess, vaultGrantFor, verifyOperator } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import { assertLabelIsFree, insertProviderKey } from "./provider-key-store.js";
import { requireProviderCredential } from "./vault.js";

export interface LinkProviderKeyCommand {
  /** A grant minted by `tenancy`. Its scope is the only environment it reaches. */
  readonly authorization: unknown;
  readonly intake: ProviderKeyIntake;
}

export async function linkProviderKey(
  dependencies: ProvidersDependencies,
  command: LinkProviderKeyCommand,
): Promise<Result<ProviderKey>> {
  const verified = verifyOperator(dependencies, command.authorization);
  if (!verified.ok) return err(verified.error);
  const granted = requireAccess(verified.value, "secret:mutate");
  if (!granted.ok) return err(granted.error);

  const admitted = admitProviderKey(command.intake);
  if (!admitted.ok) return err(admitted.error);

  const scope = granted.value.scope;
  const free = await assertLabelIsFree(dependencies, scope, admitted.value.provider, admitted.value.label);
  if (!free.ok) return err(free.error);

  const vault = vaultGrantFor(granted.value);
  const credential = await requireProviderCredential(
    dependencies,
    vault,
    admitted.value.credentialName,
    admitted.value.provider,
  );
  if (!credential.ok) return err(credential.error);

  const now = dependencies.clock.now();
  const draft: ProviderKey = {
    providerKeyId: asProvidersIdentifier<ProviderKeyId>(dependencies.ids.uuid()),
    environmentId: scope.environmentId,
    credentialId: asIdentifier<CredentialId>(credential.value.id),
    provider: admitted.value.provider,
    label: admitted.value.label,
    // Taken from the CREDENTIAL, not from the intake. The two agree here, and
    // taking it from the resolved row is what keeps them agreeing when a future
    // lookup becomes case-insensitive or trims differently.
    credentialName: asProvidersIdentifier<CredentialName>(credential.value.name),
    isDefault: admitted.value.isDefault,
    createdBy: asIdentifier<ActorId>(granted.value.effectiveUserId),
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const inserted = await insertProviderKey(dependencies, scope, draft);
  if (!inserted.ok) return err(inserted.error);

  // The picker's cached answer for this provider was computed without this key.
  // A failure to forget it is not a failure of the link: the entry expires on
  // its own, and reporting an error here would tell an operator their key was
  // not created when it was.
  // WIN-259 M2.4 LEAVES THIS ONE DISCARDING, AND SAYS SO EXPLICITLY. Four of the
  // six eviction sites now refuse when the cache cannot be told, because the
  // material behind an ADDRESSABLE entry changed or went away. This is not one of
  // them, and the paragraph above already had the argument: nothing stale is
  // reachable here.
  //
  // A key is being ADDED where there was none, so there is no entry keyed by it —
  // `credentialFingerprint` includes the row identifier, and this row is new. The
  // only entry that could exist is the `not_configured` answer from before, and
  // `check-provider-health.ts` never serves that from cache at all: "THE CACHE IS
  // CONSULTED ONLY AFTER READINESS IS ESTABLISHED ... so adding a key produces a
  // fresh answer immediately rather than one served from a window opened before
  // the key existed."
  //
  // The `void` is deliberate. It is the difference between a discard someone
  // decided and a discard nobody noticed, which is what the other four were.
  void (await dependencies.probeCache.forgetProvider(draft.provider));
  return ok(inserted.value);
}
