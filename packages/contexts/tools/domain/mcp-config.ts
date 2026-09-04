// `EntityMcpConfig` — the INBOUND MCP surface an entity hosts.
//
// One row per entity, keyed by `entityId` itself. Its existence does not make
// the surface reachable; `enabled` does, and it defaults to false. That default
// is the whole security posture of the feature: an entity acquires a public
// endpoint only when an operator says so, and the tier-1 baseline gates the
// tool that says it (`entities.set_mcp_enabled`).
//
// DO NOT CONFUSE THIS WITH `EntityMcpClient`. This row is Platos HOSTING a
// server for a third party; that row is Platos being a CLIENT of the entity's
// server. They share a table prefix and nothing else — opposite directions,
// opposite trust, opposite failure modes.
//
// `toolAllowlist` IS A CACHE AND MUST NEVER BE READ AS THE DECISION.
// `EntityToolPolicy` rows are the authority on what is exposed; this column is
// recomputed from them after every mutation so a hot path can answer without a
// join. `domain/entity-policy.ts` owns the recomputation. A reader that
// consulted this column INSTEAD of the policy rows would expose whatever the
// last successful sync left behind, including after a failed one.
//
// `injectMcpContext` IS BREAKING BY DESIGN AND THAT IS WHY IT IS A FLAG.
// Turning it on merges a `_context` envelope into the arguments of every
// MCP-origin call, so a backend that does not pop the extra key crashes. It is
// off by default and its setter is tier-1 gated.

import type { EntityId } from "@platos/kernel";

import { err, ok, type Result } from "@platos/kernel";

import type { IdentityMode } from "./entity-policy.js";
import { mcpTransportInvalid } from "./errors.js";
import type { ToolName } from "./identifiers.js";

/** One way a third party may prove who it is to a hosted surface. */
export interface McpIdentityProvider {
  readonly kind: "bearer" | "oidc";
  readonly issuer: string | null;
  readonly audience: string | null;
}

export interface EntityMcpConfig {
  readonly entityId: EntityId;
  /** False by default. Nothing is reachable until an operator flips it. */
  readonly enabled: boolean;
  readonly identityMode: IdentityMode;
  readonly identityProviders: readonly McpIdentityProvider[];
  readonly branding: Readonly<Record<string, string>>;
  /** DERIVED from EntityToolPolicy. Never the authority. See the header note. */
  readonly toolAllowlist: readonly ToolName[];
  readonly redirectUriAllowlist: readonly string[];
  readonly rateLimitPerMinute: number;
  readonly injectMcpContext: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The column default, transcribed. Sixty calls a minute per hosted surface. */
export const DEFAULT_MCP_RATE_LIMIT_PER_MINUTE = 60;

/** A ceiling on the operator-supplied limit. A limit that cannot bind is not one. */
export const MAX_MCP_RATE_LIMIT_PER_MINUTE = 60_000;

export function admitRateLimit(value: number): Result<number> {
  const limit = Math.trunc(value);
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_MCP_RATE_LIMIT_PER_MINUTE) {
    return err(
      mcpTransportInvalid(
        `an MCP rate limit must be between 1 and ${MAX_MCP_RATE_LIMIT_PER_MINUTE} calls per minute`,
        String(value),
      ),
    );
  }
  return ok(limit);
}

/**
 * Is a redirect target permitted?
 *
 * EXACT MATCH, and no prefix rule. A redirect allowlist matched by prefix is
 * the classic open-redirect: `https://tenant.example.com` would admit
 * `https://tenant.example.com.attacker.test`, and the OAuth code in the
 * fragment goes with it. The source stores the column as a `String[]` of whole
 * URIs and it is compared as one.
 */
export function permitsRedirect(config: EntityMcpConfig, redirectUri: string): boolean {
  return config.redirectUriAllowlist.includes(redirectUri);
}

/**
 * Is this hosted surface reachable at all?
 *
 * Enabled AND holding at least one exposed tool. An enabled surface with an
 * empty allowlist answers `tools/list` with nothing, which reads to a client as
 * a broken server rather than an unconfigured one — so it is reported as not
 * ready, and `entity-policy.ts` is where an operator makes it so.
 */
export function isHostReady(config: EntityMcpConfig): boolean {
  return config.enabled && config.toolAllowlist.length > 0;
}

/**
 * The identity mode a hosted surface will accept at minimum.
 *
 * The config's own mode floors every tool's: a tool asking for `bearer` on a
 * surface configured for `oidc` still gets `oidc` callers only. Taking the
 * weaker of the two would let a per-tool setting downgrade the surface, which
 * is the loosening the four-tier lattice exists to make impossible.
 */
export function effectiveIdentityMode(
  config: EntityMcpConfig,
  toolMinimum: IdentityMode,
): IdentityMode {
  const order: readonly IdentityMode[] = ["anonymous", "bearer", "oidc"];
  return order.indexOf(config.identityMode) >= order.indexOf(toolMinimum)
    ? config.identityMode
    : toolMinimum;
}

/**
 * The context envelope merged into an MCP-origin call's arguments.
 *
 * A RESERVED KEY, and a collision with a caller's own `_context` is resolved in
 * the platform's favour rather than the caller's — an entity backend reading
 * `_context.endUserId` must be able to trust it, and a caller that can overwrite
 * it can impersonate any end user of the surface.
 */
export const MCP_CONTEXT_KEY = "_context";

export function injectContext(
  callArguments: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return { ...callArguments, [MCP_CONTEXT_KEY]: context };
}
