/**
 * WIN-269 (M4.3) — THE ERASURE ADMIN-CREDENTIAL PORT.
 *
 * THE CYCLE THIS EXISTS TO REMOVE. `erasure.controller.ts` and
 * `privacy.module.ts` imported `PlatosMCPTokenService` out of
 * `apps/agent/src/mcp-platform`. That made `privacy` depend on `mcp-platform`,
 * and `mcp-platform` reaches `privacy` back through
 * `agent-runtime -> memory -> privacy`, so the erasure API was the last leg of
 * a runtime↔MCP import cycle — the one WIN-269's clause is about, arriving by a
 * route nobody would look for in a controller about deleting people's data.
 *
 * WHY THIS DIRECTION AND NOT THE OTHER. `privacy` is deliberately the narrowest
 * module in the tree ("it shares no state with the agent runtime"). Making
 * `mcp-platform` import the erasure controller to hand it a credential would
 * widen exactly the module that was built not to widen. So `privacy` publishes
 * what it needs — "verify a bearer and tell me whether it is admin-tier, who
 * minted it and what scope it is bound to" — and `mcp-platform` provides it
 * (`mcp-platform/mcp-port-bindings.module.ts`).
 *
 * THE SHAPE IS NARROWER THAN `VerifiedToken` ON PURPOSE. `permissions`,
 * `expiresAt` and the opaque `credential` reference are not read here, and an
 * erasure route must not start branching on an MCP token's permission list: the
 * only authorization this API accepts is admin tier plus an organization match.
 */

/** The DI token. A string, because binding to the class is the import removed. */
export const ERASURE_ADMIN_CREDENTIALS = "ERASURE_ADMIN_CREDENTIALS";

/** The credential, reduced to what erasure authorization and its audit read. */
export interface AdminCredential {
  id: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  /** The named operator who minted the bearer — the human answerable. */
  mintedByUserId: string;
  tier: "scope" | "admin";
}

/** The port. `PlatosMCPTokenService implements` it, so the match is checked. */
export interface AdminCredentialVerifier {
  verify(raw: string | undefined | null): Promise<AdminCredential | null>;
}
