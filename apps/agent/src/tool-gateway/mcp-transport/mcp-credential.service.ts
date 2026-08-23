import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { ScopedEnvService, type ScopeTuple } from "../../providers/scoped-env.service";

/**
 * MCP consumption (Surface 2) — credential + header resolution for a
 * registered third-party MCP server (Phase 1).
 *
 * A server row carries a `headersTemplate` ({ header → value-template } map)
 * and an optional Credential relation (safe metadata/reference, never raw
 * secret material). This service resolves the template into the concrete outbound
 * header set the transport should send, interpolating the decrypted secret
 * into any `{{secret}}` placeholder.
 *
 * Redaction contract: resolved header VALUES and the decrypted secret are
 * NEVER logged, and never echoed into a thrown error message (only the bare
 * failure reason is surfaced, which downstream stores in `discoveryError` /
 * returns as a failed dispatch).
 *
 * Template tokens:
 *   - `{{secret}}`     — the resolved same-Environment value, interpolated here.
 *   - `{{endUserId}}`  — the turn's resolved end-user identity (the customer-
 *                        meaningful opaque id that becomes Composio's
 *                        `user_id`). Interpolated here into BOTH header values
 *                        and the outbound URL (`resolveUrl`).
 *
 * HARD FAIL-CLOSED INVARIANT (per-user isolation — the crown jewel).
 * If a template references `{{endUserId}}` and NO end-user id is resolved for
 * the turn, resolution throws a structured `McpCredentialError` and dispatch
 * sends NOTHING upstream. We NEVER substitute a default, a placeholder, an org
 * id, or `scope.userId` — a missing per-user identity must fail, never silently
 * collapse two users onto one shared identity/session. This is deliberately
 * STRICTER than (and NOT a mirror of) the fail-OPEN OIDC token-forwarding path:
 * OIDC omits a header and continues because the backend authenticates its own
 * users; the template path's entire identity signal IS the substituted id, so a
 * missing id must abort. See design §3.2 / §3.4.
 */

/**
 * The subset of an EntityMcpClient row this service reads. Structural —
 * any object carrying these two fields satisfies it (the entity's 1:1 client
 * row does, unchanged).
 */
export interface CredentialServerSlice {
  /** `Json?` column — a { header: valueTemplate } map, or null. */
  headersTemplate?: unknown;
  /** Safe Credential metadata; `name` remains the bare scoped reference. */
  credential?: { name: string } | null;
  /** Compatibility projection used by registered-handler inputs; always a bare name. */
  credsSecretKey?: string | null;
}

/**
 * Structured failure for credential/template resolution. Discovery surfaces it
 * as `discoveryError`; dispatch surfaces it as a failed tool call. The message
 * intentionally carries NO header value or secret material.
 */
export class McpCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCredentialError";
  }
}

const SECRET_TOKEN = "{{secret}}";
const END_USER_TOKEN = "{{endUserId}}";

/**
 * Dispatch-boundary residual scan (design §3.2, belt-and-suspenders half).
 * Returns true when the literal `{{endUserId}}` template SURVIVED substitution
 * anywhere in the resolved URL or any resolved header value — i.e. a
 * substitution bug slipped through the resolver throw. `mcpDispatch` calls this
 * immediately before any pool/transport touch and refuses the call (structured
 * failure, ZERO bytes upstream) when it returns true. Exported as a pure
 * function so the invariant is unit-testable independent of the executor and
 * there is exactly ONE source of truth for the token literal.
 */
export function hasResidualEndUserTemplate(
  resolvedUrl: string,
  resolvedHeaders: Record<string, string>,
): boolean {
  return (
    resolvedUrl.includes(END_USER_TOKEN) ||
    Object.values(resolvedHeaders).some((v) => v.includes(END_USER_TOKEN))
  );
}

@Injectable()
export class McpCredentialService {
  // Retained for symmetry with sibling services; this class deliberately logs
  // nothing derived from header values or secrets.
  private readonly logger = new Logger(McpCredentialService.name);

  constructor(private readonly scopedEnv: ScopedEnvService) {}

  /**
   * Resolve the outbound header set for a server.
   *
   * The secret is fetched LAZILY — only when some header value references
   * `{{secret}}`. If a `{{secret}}` reference exists but no Credential is
   * unset or unresolvable, a structured `McpCredentialError` is thrown.
   *
   * Per-user (`{{endUserId}}`) FAIL-CLOSED: if any header value references
   * `{{endUserId}}` and `endUserId` is null/empty, a structured
   * `McpCredentialError("tool requires a linked end user")` is thrown BEFORE any
   * secret is fetched or any header emitted — the caller dispatches nothing. We
   * never fall back to a default/org/`scope.userId`. When resolved, every
   * `{{endUserId}}` occurrence is interpolated with the same split/join the
   * secret path uses.
   */
  async resolveHeaders(
    server: CredentialServerSlice,
    scope: ScopeTuple,
    endUserId?: string | null,
  ): Promise<Record<string, string>> {
    const template = this.normalizeTemplate(server);

    // FAIL-CLOSED per-user guard — evaluated first, before any secret fetch, so
    // a templated-but-unlinked call touches neither the secret store nor the
    // wire. `!endUserId` catches both null/undefined and the empty string.
    const needsEndUser = Object.values(template).some((v) =>
      v.includes(END_USER_TOKEN),
    );
    if (needsEndUser && !endUserId) {
      throw new McpCredentialError("tool requires a linked end user");
    }

    const needsSecret = Object.values(template).some((v) =>
      v.includes(SECRET_TOKEN),
    );

    let secret: string | undefined;
    if (needsSecret) {
      const credentialName = server.credential?.name ?? server.credsSecretKey;
      if (!credentialName) {
        throw new McpCredentialError(
          "MCP header template references {{secret}} but the server has no credential configured",
        );
      }
      secret = await this.resolveCredentialReference(scope, credentialName);
      if (secret === undefined) {
        throw new McpCredentialError(
          "MCP credential reference could not be resolved (missing or unreadable)",
        );
      }
    }

    const resolved: Record<string, string> = {};
    for (const [header, tpl] of Object.entries(template)) {
      let value = tpl;
      if (secret !== undefined && value.includes(SECRET_TOKEN)) {
        // Interpolate every occurrence (avoids String.replaceAll for older
        // lib targets; `split/join` is a safe replaceAll).
        value = value.split(SECRET_TOKEN).join(secret);
      }
      if (endUserId && value.includes(END_USER_TOKEN)) {
        value = value.split(END_USER_TOKEN).join(endUserId);
      }
      resolved[header] = value;
    }
    return resolved;
  }

  /**
   * Resolve the outbound URL for a server, interpolating `{{endUserId}}` (the
   * only token a URL may carry — secrets belong in headers, never the URL).
   *
   * FAIL-CLOSED: if the URL template references `{{endUserId}}` and `endUserId`
   * is null/empty, throws `McpCredentialError("tool requires a linked end
   * user")` — the caller dispatches nothing and the connection pool is never
   * keyed on a partially-substituted URL. A URL with no `{{endUserId}}` passes
   * through unchanged regardless of whether an end user is present.
   */
  resolveUrl(urlTemplate: string, endUserId?: string | null): string {
    if (!urlTemplate.includes(END_USER_TOKEN)) return urlTemplate;
    if (!endUserId) {
      throw new McpCredentialError("tool requires a linked end user");
    }
    return urlTemplate.split(END_USER_TOKEN).join(endUserId);
  }

  /**
   * Stable, NON-REVERSIBLE fingerprint of a resolved header set, used only as
   * part of the connection-pool key so a session is never shared across
   * different credentials. sha256 over the sorted (name,value) entries — the
   * digest cannot be reversed to the secret, and the canonical source (which
   * DOES contain the secret) is never logged.
   */
  credentialHash(resolvedHeaders: Record<string, string>): string {
    const entries = Object.entries(resolvedHeaders).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const canonical = JSON.stringify(entries);
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** Resolve a safe same-Environment credential name at the transport edge. */
  async resolveCredentialReference(
    scope: ScopeTuple,
    credentialName: string,
  ): Promise<string | undefined> {
    return this.scopedEnv.get(scope, credentialName);
  }

  /** Resolve only an entity signing credential, never a same-named variable. */
  async resolveEntitySigningCredential(
    scope: ScopeTuple,
    entityExternalId: string,
  ): Promise<string | undefined> {
    return this.scopedEnv.getEntitySecret(scope, entityExternalId);
  }

  /**
   * Coerce `server.headersTemplate` (a `Json?` column) into a
   * { header: valueTemplate } string map.
   *
   * Robust against the JSON-column-shape footgun (a string scalar can land in
   * a `Json?` column) and against non-object / array shapes. When NO template
   * is configured but a Credential IS set, defaults to a single
   * `Authorization: Bearer {{secret}}` header so the overwhelmingly-common
   * bearer-token case works without the operator also authoring a template.
   * Returns `{}` when neither a usable template nor a Credential exists.
   */
  private normalizeTemplate(
    server: CredentialServerSlice,
  ): Record<string, string> {
    let raw: unknown = server.headersTemplate;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = null;
      }
    }

    const out: Record<string, string> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        // Only string→string entries are meaningful header templates; skip
        // anything else defensively rather than coercing.
        if (k && typeof v === "string") out[k] = v;
      }
    }

    if (Object.keys(out).length === 0 && (server.credential?.name || server.credsSecretKey)) {
      out["Authorization"] = `Bearer ${SECRET_TOKEN}`;
    }
    return out;
  }
}
