// `EntityMcpClient` — Platos as a CLIENT of an entity's own MCP server.
//
// The opposite direction to `EntityMcpConfig`. One row per entity: a transport,
// a URL, an optional credential in `secrets`, and a header template. Discovery
// opens a session against it and turns `tools/list` into `Tool` +
// `EnvironmentEntityTool` rows; dispatch opens one and makes the call.
//
// ── THE CROWN JEWEL: PER-USER ISOLATION, FAIL-CLOSED ──────────────────────
//
// A header value or a URL may name `{{endUserId}}`. When it does and no end
// user is resolved for the turn, resolution FAILS and nothing is sent upstream.
// There is no default, no placeholder, no fallback to an organization id and no
// fallback to the operator's own user id. Two users must never collapse onto
// one identity at a third-party server, and a substitution that "mostly works"
// is a cross-customer data leak that looks like a working integration.
//
// THIS IS DELIBERATELY STRICTER THAN THE OIDC FORWARDING PATH AND IT IS NOT AN
// INCONSISTENCY. OIDC omits a header and continues, because the backend
// authenticates its own users and a missing token yields its own 401. Here the
// substituted id IS the entire identity signal, so a missing one must abort.
//
// THE RESIDUAL SCAN IS THE SECOND HALF OF THE SAME INVARIANT. `resolveHeaders`
// throwing is the first line; `residualToken` run at the dispatch boundary is
// the second, and it catches a substitution DEFECT rather than a missing input.
// Two independent checks for one property, because the property is the one this
// context cannot get wrong.
//
// ── WHAT NEVER APPEARS IN THIS FILE ──────────────────────────────────────
//
// Secret material is interpolated and never inspected, never compared, never
// logged and never put in an error. `credentialFingerprint` hashes a canonical
// form of the RESOLVED headers, so a pooled session is never shared across two
// credentials — and the digest itself is a port's job, because taking one is a
// primitive this layer may not import.

import { err, ok, type Result } from "@platos/kernel";
import type { EntityId } from "@platos/kernel";

import { credentialUnavailable, endUserRequired, mcpTransportInvalid, residualTemplate } from "./errors.js";
import type { CredentialId, CredentialName, ToolName } from "./identifiers.js";

/** `EntityMcpClient.transport`. */
export const MCP_TRANSPORTS = ["http", "sse", "stdio"] as const;

export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** The two tokens a template may carry. There is no third. */
export const SECRET_TOKEN = "{{secret}}";
export const END_USER_TOKEN = "{{endUserId}}";

export interface EntityMcpClient {
  readonly entityId: EntityId;
  readonly transport: McpTransport;
  /** Null only for `stdio`, which has no endpoint to name. */
  readonly url: string | null;
  readonly credentialId: CredentialId | null;
  readonly credentialName: CredentialName | null;
  /** `{ header: valueTemplate }`. Never resolved values, never material. */
  readonly headersTemplate: Readonly<Record<string, string>>;
  readonly lastDiscoveryAt: Date | null;
  readonly discoveryError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Coerce the `Json?` column into a `{ header: template }` map.
 *
 * Four shapes reach this column in practice and each is handled without
 * coercing anything into a header it was not:
 *
 *   a JSON string  — a serialiser wrote the object as a scalar. Parsed once,
 *                    and a parse failure becomes "no template" rather than an
 *                    exception on a read path.
 *   an array       — `typeof [] === "object"`, so an array reaches here. It has
 *                    no header names and yields nothing.
 *   a non-string value against a header name — SKIPPED, not stringified. A
 *                    number coerced to a header value is a silently wrong
 *                    request; an absent header is a visible 401.
 *   nothing usable, but a credential IS set — defaults to
 *                    `Authorization: Bearer {{secret}}`, transcribed, because
 *                    that is the overwhelmingly common case and demanding the
 *                    operator also author a template for it is friction with no
 *                    safety return.
 */
export function normalizeHeaderTemplate(
  raw: unknown,
  hasCredential: boolean,
): Readonly<Record<string, string>> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = null;
    }
  }

  const template: Record<string, string> = {};
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [header, item] of Object.entries(value as Record<string, unknown>)) {
      if (header !== "" && typeof item === "string") template[header] = item;
    }
  }
  if (Object.keys(template).length === 0 && hasCredential) {
    template["Authorization"] = `Bearer ${SECRET_TOKEN}`;
  }
  return template;
}

/** What the resolver needs before it can produce headers. */
export interface TemplateRequirements {
  readonly needsSecret: boolean;
  readonly needsEndUser: boolean;
}

/**
 * Read the template's demands WITHOUT fetching anything.
 *
 * The secret demand is read from the HEADERS ALONE, and the end-user demand
 * from the headers and the URL. That asymmetry mirrors the substitution rule
 * below: a URL is never given a secret, so a `{{secret}}` written into one is
 * not a demand for material — it is a mistake, and counting it would make this
 * context read a credential out of the vault for a call the residual scan is
 * about to refuse anyway.
 */
export function templateRequirements(
  template: Readonly<Record<string, string>>,
  urlTemplate: string | null,
): TemplateRequirements {
  const headers = Object.values(template);
  const all = [...headers, ...(urlTemplate === null ? [] : [urlTemplate])];
  return {
    needsSecret: headers.some((value) => value.includes(SECRET_TOKEN)),
    needsEndUser: all.some((value) => value.includes(END_USER_TOKEN)),
  };
}

export interface ResolvedTransport {
  readonly url: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Resolve a template into the concrete outbound URL and headers.
 *
 * ORDER MATTERS AND IT IS NOT COSMETIC. The end-user guard is evaluated FIRST,
 * before any secret is supplied, so a templated-but-unlinked call touches
 * neither the vault nor the wire. Fetching the secret first would leave a
 * credential read in the audit trail for a call that was never made.
 *
 * The secret is supplied by the caller, already resolved, because reading the
 * vault is `secrets`' and a domain rule may not do it. What this function owns
 * is the substitution and the two refusals around it.
 *
 * `{{secret}}` in a URL is not substituted. Secrets belong in headers: a URL is
 * logged by every proxy between here and the backend, and the source
 * deliberately interpolates only `{{endUserId}}` there.
 */
export function resolveTransport(input: {
  readonly template: Readonly<Record<string, string>>;
  readonly urlTemplate: string | null;
  readonly secret: string | null;
  readonly endUserId: string | null;
  readonly toolName: ToolName;
}): Result<ResolvedTransport> {
  const required = templateRequirements(input.template, input.urlTemplate);

  if (required.needsEndUser && (input.endUserId === null || input.endUserId === "")) {
    return err(endUserRequired(input.toolName));
  }
  if (required.needsSecret && (input.secret === null || input.secret === "")) {
    return err(credentialUnavailable("the header template names a secret and none resolved"));
  }

  const headers: Record<string, string> = {};
  for (const [header, template] of Object.entries(input.template)) {
    headers[header] = substitute(template, input.secret, input.endUserId);
  }
  const url =
    input.urlTemplate === null ? null : substitute(input.urlTemplate, null, input.endUserId);

  return ok({ url, headers });
}

/**
 * Replace EVERY occurrence, via split/join.
 *
 * Not `String.replace`, which substitutes only the first, and not
 * `replaceAll`, which the source avoids for its lib target. A template naming
 * the token twice and substituting it once is the exact shape the residual scan
 * exists to catch, and it is better not to produce it.
 */
function substitute(template: string, secret: string | null, endUserId: string | null): string {
  let value = template;
  if (secret !== null && value.includes(SECRET_TOKEN)) value = value.split(SECRET_TOKEN).join(secret);
  if (endUserId !== null && value.includes(END_USER_TOKEN)) {
    value = value.split(END_USER_TOKEN).join(endUserId);
  }
  return value;
}

/**
 * The dispatch-boundary residual scan.
 *
 * Returns the surviving token, or null. Reaching a non-null answer means a
 * substitution defect slipped past `resolveTransport`, so the caller refuses
 * the call with ZERO bytes upstream. Checking BOTH tokens rather than only the
 * end-user one is deliberate: a surviving `{{secret}}` would send the literal
 * string to the backend, which is a failed call, while a surviving
 * `{{endUserId}}` is a cross-user leak — different severities, one check, and
 * neither is allowed onto the wire.
 */
export function residualToken(resolved: ResolvedTransport): string | null {
  const values = [...Object.values(resolved.headers), ...(resolved.url === null ? [] : [resolved.url])];
  for (const token of [END_USER_TOKEN, SECRET_TOKEN]) {
    if (values.some((value) => value.includes(token))) return token;
  }
  return null;
}

/** Refuse a resolution that still carries a template. */
export function assertNoResidual(resolved: ResolvedTransport): Result<ResolvedTransport> {
  const token = residualToken(resolved);
  return token === null ? ok(resolved) : err(residualTemplate(token));
}

/**
 * The canonical string a pooled session's credential fingerprint is taken over.
 *
 * Sorted `(name, value)` pairs, JSON-encoded. Sorted so two resolutions
 * differing only in header order share a session; over the RESOLVED values so
 * two end users of one templated server never do. The digest of this string is
 * taken by a port — this layer produces the string and never the hash.
 *
 * The canonical form CONTAINS the secret, which is why it is never logged and
 * why the fingerprint that leaves this context is the digest and not this.
 */
export function credentialFingerprintSource(headers: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(headers).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/**
 * The pool key a resolved transport belongs to.
 *
 * URL and credential fingerprint. Two environments sharing one credential share
 * a session; a rotation changes the fingerprint and therefore the key, so the
 * old session is abandoned by construction rather than by remembering to.
 */
export function sessionPoolKey(url: string | null, credentialFingerprint: string): string {
  return `mcp-session/${url ?? "stdio"}/${credentialFingerprint}`;
}

/** A transport is usable when its shape and its endpoint agree. */
export function admitTransport(transport: string, url: string | null): Result<McpTransport> {
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) {
    return err(mcpTransportInvalid("unsupported MCP transport", transport));
  }
  const admitted = transport as McpTransport;
  if (admitted !== "stdio" && (url === null || url.trim() === "")) {
    return err(mcpTransportInvalid("this transport needs a URL", transport));
  }
  return ok(admitted);
}

/** What a discovery pass recorded on the row. */
export function withDiscoveryOutcome(
  client: EntityMcpClient,
  outcome: { readonly error: string | null },
  at: Date,
): EntityMcpClient {
  return { ...client, lastDiscoveryAt: at, discoveryError: outcome.error, updatedAt: at };
}
