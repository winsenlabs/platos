// Authenticate a scoped bearer credential.
//
// One entry point for McpToken, McpBearerToken, PersonalAccessToken and
// EndUserSession. The presented string's PREFIX selects the store; everything
// after that is the same code, so the four cannot drift apart on the expiry
// rule, the scope check or the permission check.
//
// THE PREFIX IS A ROUTING HINT AND NOTHING ELSE. It is public, attacker-chosen
// and unauthenticated. It picks which table to ask; it never contributes to the
// answer. A token whose prefix says `plt_mcp_` and whose hash is not in McpToken
// is simply unauthenticated, exactly as an unprefixed one would be.
//
// CROSS-SCOPE DENIAL IS THE NEGATIVE CONTROL THAT MATTERS. A credential bound to
// one environment is refused its sibling environment, its parent project and
// every other organization, because `assertAuthorizes` reduces to the kernel's
// `contains()` over the canonical scope path. The suite proves the sibling case
// specifically: it is the one an id-comparison bug passes and a path-containment
// check does not.

import {
  authenticateBearerCredential,
  classifyToken,
  touchedCredential,
  unauthenticated,
  type BearerAuthorization,
  type BearerCredentialKind,
  type TokenKind,
} from "../domain/index.js";
import type { PortsOf } from "./dependencies.js";
import { err, ok, type Result, type TenantScope } from "@platos/kernel";

export type AuthenticateBearerTokenPorts = PortsOf<"repository" | "hasher" | "clock">;

export interface AuthenticateBearerTokenInput {
  readonly presentedToken: string | null | undefined;
  /** Where the request is addressed. Null skips the scope check. */
  readonly requestedScope: TenantScope | null;
  /** The permission the operation needs, when it names one. */
  readonly requiredPermission?: string;
  /**
   * Restrict which kinds are acceptable at this entry point. An MCP endpoint
   * that accepted a personal access token would widen its own audience silently.
   */
  readonly acceptedKinds?: readonly BearerCredentialKind[];
}

/**
 * Which credential table a registered prefix belongs to.
 *
 * The four token kinds that name a bearer credential are mapped; every other
 * registered prefix (a magic link, an authorization code, a client identifier)
 * is deliberately absent, so presenting one here routes nowhere.
 */
const STORE_BY_PREFIX: Partial<Record<TokenKind, BearerCredentialKind>> = {
  mcpToken: "mcp-token",
  entityBearerToken: "entity-bearer-token",
};

export async function authenticateBearerToken(
  ports: AuthenticateBearerTokenPorts,
  input: AuthenticateBearerTokenInput,
): Promise<Result<BearerAuthorization>> {
  if (!input.presentedToken) return err(unauthenticated({ reason: "no-token" }));

  const prefix = classifyToken(input.presentedToken);
  const kind = prefix === null ? undefined : STORE_BY_PREFIX[prefix];
  if (kind === undefined) return err(unauthenticated({ reason: "unroutable-prefix" }));
  if (input.acceptedKinds !== undefined && !input.acceptedKinds.includes(kind)) {
    return err(unauthenticated({ reason: "kind-not-accepted" }));
  }

  const now = ports.clock.now();
  const credential = await ports.repository.bearerCredentials.findByTokenHash(
    kind,
    ports.hasher.hash(input.presentedToken),
  );
  if (credential === null) return err(unauthenticated({ reason: "no-credential" }));

  const authorization = authenticateBearerCredential({
    credential,
    requestedScope: input.requestedScope,
    requiredPermission: input.requiredPermission ?? null,
    now,
  });
  if (!authorization.ok) return authorization;

  // Liveness is stamped only after the decision, so a refused request leaves no
  // timestamp an attacker could watch to confirm a credential exists.
  await ports.repository.bearerCredentials.save(touchedCredential(credential, now));
  return ok(authorization.value);
}
