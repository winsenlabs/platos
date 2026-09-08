// WIN-267 T4 — WHAT A ONE-TIME-SECRET MINT DOES, WITH NO FRAMEWORK IN SCOPE.
//
// `idempotency-policy.ts` classes eight operations `required`, and says why in
// one sentence: "EVERY REQUIRED ROW HANDS THE CALLER A SECRET IT CAN NEVER SEE
// AGAIN." Until this file there was no handler behind any of them in
// `apps/core-api`, which is the process where the `Idempotency-Key` gate
// actually runs — so the winner of an idempotency race reached the framework's
// own 404, and `settlementFor` then RECORDED that 404 for twenty-four hours,
// answering every honest retry of that key with it.
//
// THE RULE IS HERE AND THE ROUTE IS NEXT DOOR, for the reason
// `idempotency.ts`/`idempotency-middleware.ts` are split: ADR M0.3 §6 budgets a
// transport for wiring, not for decisions, and every branch below is reachable
// in a unit test with no socket, no container and no framework.
//
// FOUR STEPS, AND NOT ONE OF THEM REACHES PAST A PUBLISHED CONTRACT.
//
//   1. WHO IS CALLING — `identity-access.authenticateBearer`. The context that
//      owns "who is this caller" answers it. This transport does not parse a
//      token, does not know what a session looks like, and cannot be made to
//      trust a user id a caller supplied, because it never reads one.
//   2. MAY THEY — `tenancy.authorizeEnvironmentOperator`. The four-gate RBAC
//      decision, re-derived from the environment id alone. The grant it returns
//      is branded and frozen; nothing here can construct one.
//   3. THE VAULT GRANT — derived from (2) by `secrets`' own published mint,
//      exactly as `providers/application/authorization.ts` derives it, and from
//      the tenancy grant's RE-DERIVED scope rather than from anything a caller
//      sent.
//   4. THE ROTATION — `secrets.rotateCredential`, inside that context's own
//      transaction, which advances the secret revision by ONE and retires the
//      version it replaces.
//
// WHY THE MATERIAL IS MINTED HERE AND NOT BY THE VAULT. `rotateCredential` takes
// the new plaintext as an input: the vault seals what it is given and has no
// opinion about where a secret comes from, which is what lets the SAME operation
// serve a BYOK write and a mint. So the mint — 32 bytes of CSPRNG, hex — belongs
// to the operation that is a mint, and this is that operation. `node:crypto` is
// the process edge's own, the same import `http/token.ts` and `http/idempotency.ts`
// already make; a context could not make it, and does not.
//
// AND WHY 32 BYTES. It is the width the frozen surface mints today
// (`apps/agent/src/agent-runtime/channels.controller.ts`:
// `crypto.randomBytes(32).toString("hex")`), so a secret rotated through this
// handler is indistinguishable from one rotated through the oracle. A V1 handler
// that quietly narrowed a webhook secret would be a security regression nobody
// would see in a diff.

import { randomBytes } from "node:crypto";

import {
  err,
  ok,
  type DomainError,
  type EnvironmentId,
  type Result,
  type TenantScope,
} from "@platos/kernel";
import type { IdentityAccessContract } from "@platos/context-identity-access";
import {
  acceptPlaintext,
  authorizeEnvironmentOperator as mintVaultGrant,
  type ActorId,
  type CredentialId,
  type CredentialMetadata,
  type EnvironmentOperatorAuthorization as VaultGrant,
  type SecretsContract,
} from "@platos/context-secrets";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  mintContextUncomposed,
  mintCredentialUnknown,
  mintPrincipalNotOperator,
  mintScopeNotEnvironment,
} from "./mint-errors.js";

/**
 * How wide a minted webhook secret is, in BYTES before hex.
 *
 * Read by `secret-mint.test.ts` to check the LENGTH of what came out rather than
 * to compute it — the test asserts `2 * MINTED_SECRET_BYTES` hex characters
 * against the value this module actually returned, so shrinking this constant
 * fails the case instead of moving both sides of it.
 */
export const MINTED_SECRET_BYTES = 32;

/**
 * The credential a channel connection's webhook secret lives in.
 *
 * ONE FUNCTION, so the name a mint rotates and the name anything else resolves
 * can never drift. It is a NAME and not an id because a transport must not hold
 * a handle into another context's store — `providers`' published surface refuses
 * to hand out a credential id for exactly this reason — and because the vault's
 * names are already unique within an environment, which is the scope this
 * operation is addressed at.
 *
 * The connection id is interpolated verbatim and is NOT escaped, and that is
 * safe here for a reason worth stating rather than assuming: the value is
 * compared with `===` against names the vault returns, never parsed, never used
 * to build a query, and never rendered into a page. `channelConnectionId` is
 * validated by the caller before it reaches this function.
 */
export function channelWebhookCredentialName(channelConnectionId: string): string {
  return `channel:${channelConnectionId}:webhook`;
}

/** Everything a mint needs from the composed application. Ports, never adapters. */
export interface MintDependencies {
  readonly identityAccess: IdentityAccessContract | undefined;
  readonly tenancy: TenancyContract | undefined;
  readonly secrets: SecretsContract | undefined;
  /**
   * Overridable ONLY so a suite can pin what came out of the generator.
   *
   * Defaulted to `randomBytes`, so production never depends on a caller
   * remembering to pass one, and a test that forgets gets real randomness rather
   * than a predictable secret.
   */
  readonly mintSecret?: () => string;
}

/** What one mint hands back. The material is in it exactly once. */
export interface MintedChannelSecret {
  readonly channelConnectionId: string;
  /**
   * THE MATERIAL. Named `webhookSecret` deliberately: it is one of
   * `secret-response-census.mjs`'s `MATERIAL_RESPONSE_KEYS`, so this response
   * path is COUNTED by that gate and carries a disposition in its manifest. A
   * property named `secret` would have been invisible to the census, which is
   * the one thing a raw-secret response path must never be.
   */
  readonly webhookSecret: string;
  /** What the vault recorded. Carries no material — see `CredentialMetadata`. */
  readonly credential: CredentialMetadata;
}

/** The environment scope an operator's bearer credential is addressed at. */
function environmentOf(scope: TenantScope | null): EnvironmentId | null {
  if (scope === null) return null;
  return scope.level === "environment" ? scope.environmentId : null;
}

/**
 * Rotate a channel connection's webhook secret and hand the new one back once.
 *
 * EVERY REFUSAL IS A `DomainError` VALUE. Nothing here throws: the route next
 * door is the only place a value becomes an exception, which is what
 * `transports/rest/fault.ts` exists to be the single site of.
 */
export async function rotateChannelWebhookSecret(
  dependencies: MintDependencies,
  request: { readonly channelConnectionId: string; readonly presentedToken: string | null },
): Promise<Result<MintedChannelSecret>> {
  // THE THREE CONTEXTS ARE CHECKED SEPARATELY AND EACH IS NAMED. An install can
  // have the vault and not the authenticator — that is EXACTLY the state of this
  // build, where `secrets` composes from two constructed adapters and
  // `identity-access` cannot because four of its eight ports have no
  // implementation — and an operator reading "this mint is unavailable" must be
  // able to tell which of the three is missing without reading source.
  const identityAccess = dependencies.identityAccess;
  if (identityAccess === undefined) return err(mintContextUncomposed("identity-access"));
  const tenancy = dependencies.tenancy;
  if (tenancy === undefined) return err(mintContextUncomposed("tenancy"));
  const secrets = dependencies.secrets;
  if (secrets === undefined) return err(mintContextUncomposed("secrets"));

  // 1. WHO. `requestedScope: null` because the scope is not known until this
  //    answer arrives — the caller does not name an environment on this route,
  //    the credential does. Asking with a scope the transport had guessed would
  //    be asking the wrong question.
  const principal = await identityAccess.authenticateBearer({
    presentedToken: request.presentedToken,
    requestedScope: null,
  });
  if (!principal.ok) return err(principal.error);
  if (principal.value.tier !== "OPERATOR") return err(mintPrincipalNotOperator(principal.value.tier));
  const environmentId = environmentOf(principal.value.scope.tenant);
  if (environmentId === null) return err(mintScopeNotEnvironment(principal.value.scope.kind));

  // 2. MAY THEY. `secret:mutate` and not `metadata`: this operation replaces
  //    material, and asking for the weaker level would let a read-only operator
  //    rotate a live webhook secret.
  const grant = await tenancy.authorizeEnvironmentOperator({
    environmentId,
    operator: {
      // THE PRINCIPAL ID FOR BOTH, and that is the honest reading of what
      // `authenticateBearer` returns: a bearer credential names ONE principal
      // and carries no impersonation, so the actor and the effective identity
      // are the same party. `authenticateOperator` is the method that can tell
      // them apart, and it authenticates a DASHBOARD SESSION rather than the
      // bearer this route is reached with.
      actorUserId: principal.value.principalId as unknown as never,
      effectiveUserId: principal.value.principalId as unknown as never,
    },
    access: "secret:mutate",
  });
  if (!grant.ok) return err(grant.error);

  // 3. THE VAULT GRANT, from the tenancy grant's own re-derived scope.
  const vault: VaultGrant = mintVaultGrant({
    ancestry: {
      organizationId: grant.value.scope.organizationId as unknown as never,
      projectId: grant.value.scope.projectId as unknown as never,
      environmentId: grant.value.scope.environmentId as unknown as never,
    },
    access: "secret:mutate",
    actorUserId: grant.value.actorUserId as unknown as ActorId,
    effectiveUserId: grant.value.effectiveUserId as unknown as ActorId,
  });

  // 4a. WHICH CREDENTIAL. By NAME, through the vault's own listing, so this
  //     transport never holds a credential id it did not read back from the
  //     context that owns them.
  const name = channelWebhookCredentialName(request.channelConnectionId);
  const listed = await secrets.listCredentials(vault);
  if (!listed.ok) return err(listed.error);
  const credential = listed.value.find((row) => row.name === name);
  if (credential === undefined) return err(mintCredentialUnknown(request.channelConnectionId));

  // 4b. THE ROTATION. `acceptPlaintext` first, so the bare string is inside a
  //     self-redacting holder before any object exists that a logger, a retry
  //     buffer or an error report could serialise — WIN-259's rule, and the
  //     reason `RotateCredentialCommand.plaintext` is not a `string`.
  const material = (dependencies.mintSecret ?? defaultMintSecret)();
  const held = acceptPlaintext(material);
  if (!held.ok) return err(held.error);
  const rotated = await secrets.rotateCredential({
    authorization: vault,
    credentialId: credential.id as unknown as CredentialId,
    plaintext: held.value,
  });
  if (!rotated.ok) return err(rotated.error);

  return ok({
    channelConnectionId: request.channelConnectionId,
    webhookSecret: material,
    credential: rotated.value,
  });
}

function defaultMintSecret(): string {
  return randomBytes(MINTED_SECRET_BYTES).toString("hex");
}

/** Re-exported so the route can name the type it answers with. */
export type MintFailure = DomainError;
