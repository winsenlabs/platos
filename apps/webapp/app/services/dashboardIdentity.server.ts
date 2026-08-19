import type { OperatorAuthorization } from "@platos/tenancy-database";

declare const canonicalUserIdBrand: unique symbol;
declare const legacyUserIdBrand: unique symbol;

export type CanonicalUserId = string & { readonly [canonicalUserIdBrand]: "CanonicalUserId" };
export type LegacyUserId = string & { readonly [legacyUserIdBrand]: "LegacyUserId" };

export interface DashboardIdentity {
  authorization: OperatorAuthorization;
  canonicalActorUserId: CanonicalUserId;
  canonicalEffectiveUserId: CanonicalUserId;
  /** Compatibility alias for the canonical effective user. */
  canonicalUserId: CanonicalUserId;
  legacyActorUserId: LegacyUserId;
  legacyEffectiveUserId: LegacyUserId;
  /** Compatibility alias for the legacy effective dashboard user. */
  legacyUserId: LegacyUserId;
  email: string;
  mfaEnabledAt: Date | null;
  isImpersonating: boolean;
}

export interface OperatorSessionAuthorizer {
  authorizeOperatorSession(token: string): Promise<OperatorAuthorization>;
}

export interface LegacyIdentityBridgeReader {
  findByNormalizedEmail(normalizedEmail: string): Promise<Array<{ id: string; email: string }>>;
}

export interface CanonicalMfaReader {
  findEnabledAt(userId: CanonicalUserId): Promise<Date | null>;
}

export interface CanonicalIdentityReader {
  findEmail(userId: CanonicalUserId): Promise<string | null>;
}

export function normalizeBridgeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function canonicalUserId(value: string): CanonicalUserId {
  return value as CanonicalUserId;
}

export function legacyUserId(value: string): LegacyUserId {
  return value as LegacyUserId;
}

export async function resolveDashboardIdentity(params: {
  token: string | null | undefined;
  authorizer: OperatorSessionAuthorizer;
  legacyIdentityReader: LegacyIdentityBridgeReader;
  canonicalMfaReader: CanonicalMfaReader;
  canonicalIdentityReader: CanonicalIdentityReader;
}): Promise<DashboardIdentity | null> {
  if (!params.token) return null;

  let authorization: OperatorAuthorization;
  try {
    authorization = await params.authorizer.authorizeOperatorSession(params.token);
  } catch {
    return null;
  }

  async function bridgeEmail(email: string): Promise<LegacyUserId | null> {
    const normalizedEmail = normalizeBridgeEmail(email);
    const matches = await params.legacyIdentityReader.findByNormalizedEmail(normalizedEmail);
    if (
      matches.length !== 1 ||
      normalizeBridgeEmail(matches[0].email) !== normalizedEmail
    ) {
      return null;
    }
    return legacyUserId(matches[0].id);
  }

  const canonicalActorUserId = canonicalUserId(authorization.actorUserId);
  const canonicalEffectiveUserId = canonicalUserId(authorization.effectiveUserId);
  const legacyEffectiveUserId = await bridgeEmail(authorization.email);
  if (!legacyEffectiveUserId) return null;

  let legacyActorUserId = legacyEffectiveUserId;
  if (canonicalActorUserId !== canonicalEffectiveUserId) {
    const actorEmail = await params.canonicalIdentityReader.findEmail(canonicalActorUserId);
    if (!actorEmail) return null;
    const bridgedActor = await bridgeEmail(actorEmail);
    if (!bridgedActor) return null;
    legacyActorUserId = bridgedActor;
  }

  return {
    authorization,
    canonicalActorUserId,
    canonicalEffectiveUserId,
    canonicalUserId: canonicalEffectiveUserId,
    legacyActorUserId,
    legacyEffectiveUserId,
    legacyUserId: legacyEffectiveUserId,
    email: authorization.email,
    mfaEnabledAt: await params.canonicalMfaReader.findEnabledAt(canonicalActorUserId),
    isImpersonating: authorization.impersonation?.active === true,
  };
}

export function applyLegacyImpersonation(params: {
  identity: DashboardIdentity;
  legacyTargetUserId: string | null | undefined;
  legacyActorIsAdmin: boolean;
  legacyTargetExists: boolean;
}): DashboardIdentity {
  if (
    !params.legacyTargetUserId ||
    !params.legacyActorIsAdmin ||
    !params.legacyTargetExists ||
    params.identity.authorization.impersonation
  ) {
    return params.identity;
  }

  const legacyEffectiveUserId = legacyUserId(params.legacyTargetUserId);
  return {
    ...params.identity,
    legacyEffectiveUserId,
    legacyUserId: legacyEffectiveUserId,
    isImpersonating: true,
  };
}
