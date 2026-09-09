import { createHash } from "node:crypto";

/**
 * WIN-268 (M4.2) P1 — the ONE expression of the MCP version, for every MCP
 * server this deployable serves.
 *
 * `api-surface.ts` one file over is the same idea for REST, and the two are
 * deliberately shaped alike: one file per deployable per transport, holding
 * every part of the version decision, with nothing outside it allowed to spell
 * any part again. What differs is WHERE the version rides, and that difference
 * is the whole reason this file exists rather than a second constant in the
 * REST one.
 *
 * -----------------------------------------------------------------------------
 * MCP IS NOT REST: THE VERSION IS NOT IN THE URL, AND MUST NOT BE.
 *
 * ADR M0.4 §2's MCP row (WIN-249, ACCEPTED) fixes two INDEPENDENT axes and
 * refuses to let them be conflated — decision D2, recorded in §7:
 *
 *   AXIS 1 — THE WIRE.  `protocolVersion` in the `initialize` result, and the
 *   `MCP-Protocol-Version` header. It is a DATE, it belongs to the Model Context
 *   Protocol specification, it is NEGOTIATED between client and server, and it
 *   "never carries Platos semantics". A client that pinned it would be pinning
 *   somebody else's release train.
 *
 *   AXIS 2 — THE CONTRACT. `serverInfo.version`, a Platos semver whose MAJOR is
 *   the break axis, plus `_meta["platos.dev/contract"]`. This is what a third-
 *   party agent client pins when it depends on a tool name, an input schema or
 *   a scope grant.
 *
 * Collapsing them — "just bump protocolVersion" — breaks handshake negotiation
 * with every compliant client, because the date is matched against the spec's
 * own list and an unknown one is a failed initialize. So they are two constants
 * here, and `mcpServerInfo()` is the only thing that puts them in one object.
 *
 * AND THE PATH STAYS UNVERSIONED. `api-surface.ts`'s `UNVERSIONED_ROOT_SEGMENTS`
 * already lists `mcp` for exactly this reason, citing the same ADR row: "Paths
 * stay unversioned; the major travels in `serverInfo.version`, never in the
 * URL." A `/mcp/v1/...` segment would be a THIRD axis nobody negotiated.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS REPLACED, MEASURED
 *
 * Before this file the version was seven string literals in three files, and
 * every one of them was a place two servers could privately disagree:
 *
 *   `"2025-06-18"`  mcp-router.ts:245, mcp-entity.controller.ts:907,
 *                   docs-mcp.controller.ts:262        (3 protocol literals)
 *   `"0.1.0"`       mcp-router.ts:252, mcp-entity.controller.ts:911,
 *                   docs-mcp.controller.ts:141 and :268  (4 contract literals)
 *
 * ADR M0.4 §7 D2 names the three `"0.1.0"` handshake literals as a hard
 * prerequisite — "collapse the 3x `0.1.0` into one const FIRST" — and the fourth
 * is the `GET /mcp/docs` capability probe, which advertised the same number to
 * the same clients through a different door.
 *
 * THE COUNT IS NOT LEFT AT ZERO BY CONVENTION. `scripts/arch/mcp-surface.mjs`
 * walks the production TypeScript of this repository and refuses any string
 * literal sitting in a `protocolVersion` or a `serverInfo`-shaped `version`
 * position outside this file — the same shape as the REST no-bare-prefix lint in
 * `scripts/arch/contract-map.mjs`, and for the same reason: a rule that is only
 * followed is a rule that is followed until somebody is in a hurry.
 *
 * -----------------------------------------------------------------------------
 * THE DIGESTS ARE DERIVED, AND THAT IS WHAT MAKES THEM WORTH EMITTING
 *
 * `catalogDigest` and `scopeSetDigest` are computed from the catalog and the
 * scope constants themselves. Neither is a number somebody maintains, so neither
 * can be forgotten: adding a required input to one tool moves `schemaHash` for
 * that tool, which moves `catalogDigest`, which moves the manifest, which fails
 * `generate-control-plane.mjs --check` until a human looks at it. ADR M0.4 §5
 * asks for exactly this and calls the alternative out by name — a hand-kept
 * version "bakes in the miscount".
 *
 * CANONICALISATION IS SORTED-KEY JSON. A benign reformat of an input schema must
 * not read as a breaking change, so the hash is over a key-sorted rendering
 * rather than over the source text. ADR M0.4 §5 item 5 states this requirement.
 */

/**
 * AXIS 1 — the Model Context Protocol revision this deployable speaks.
 *
 * A DATE FROM SOMEBODY ELSE'S SPECIFICATION. It moves when this repository
 * adopts a new MCP revision and never because a Platos contract changed. It is
 * the value all three servers report in `initialize`, and the value a client's
 * `MCP-Protocol-Version` header is matched against.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * AXIS 2 — the Platos MCP contract MAJOR. The break axis.
 *
 * ADR M0.4 §2: a break is "a new major mounted alongside the old one". Within
 * this major every change is additive and every reader is required to ignore
 * unknown fields, unknown `_meta` keys and unknown enum members.
 */
export const PLATOS_MCP_CONTRACT_MAJOR = 1;

/** The minor. Moves on any additive change; carries no compatibility meaning. */
export const PLATOS_MCP_CONTRACT_MINOR = 0;

/** The patch. Same. */
export const PLATOS_MCP_CONTRACT_PATCH = 0;

/**
 * `serverInfo.version` — assembled, never written out.
 *
 * A hand-written `"1.0.0"` would be a fourth spelling of a decision that already
 * has three parts, which is the thing this file exists to prevent.
 */
export const PLATOS_MCP_CONTRACT_VERSION = `${String(PLATOS_MCP_CONTRACT_MAJOR)}.${String(
  PLATOS_MCP_CONTRACT_MINOR,
)}.${String(PLATOS_MCP_CONTRACT_PATCH)}`;

/**
 * The `_meta` key the contract block rides under.
 *
 * `_meta` AND NOT A TOP-LEVEL FIELD. The MCP schema fixes the shape of
 * `InitializeResult` and of `serverInfo`; `_meta` is the specification's own
 * sanctioned extension channel, so a strict client that rejects unknown
 * top-level keys still completes the handshake. ADR M0.4 §7 D2 gives this as
 * the reason the Platos version rides here rather than beside `name`.
 *
 * The key is a reverse-DNS name under a domain this project owns, which is what
 * the MCP specification asks of an extension so two vendors' `_meta` cannot
 * collide.
 */
export const PLATOS_MCP_CONTRACT_META_KEY = "platos.dev/contract";

/** The per-tool `_meta` key. ADR M0.4 §2 MCP row: `{v, schemaHash, admin}`. */
export const PLATOS_MCP_TOOL_META_KEY = "platos.dev/tool";

/**
 * The three MCP servers this deployable serves, named once.
 *
 * `serverInfo.name` is how a client tells them apart in a log and in a
 * connection list, and each of the three used to spell its own. They are here so
 * the surface census has ONE list to enumerate rather than three files to grep,
 * and so `mcpServerInfo` can refuse a name that is not one of them.
 */
export const PLATFORM_MCP_SERVER_NAME = "platos-platform-mcp";
export const DOCS_MCP_SERVER_NAME = "platos-docs-mcp";
/**
 * The entity server's name is per-entity — `platos-entity-mcp:<externalId>` —
 * because one deployable serves many entity servers and a client connected to
 * two of them must be able to tell which is which. The PREFIX is the part that
 * is a surface decision, so the prefix is what lives here.
 */
export const ENTITY_MCP_SERVER_NAME_PREFIX = "platos-entity-mcp";

/** The entity server's `serverInfo.name` for one entity. */
export function entityMcpServerName(entityId: string): string {
  return `${ENTITY_MCP_SERVER_NAME_PREFIX}:${entityId}`;
}

/**
 * The OAuth scope sets the two authenticated MCP surfaces advertise.
 *
 * THEY LIVE HERE BECAUSE NARROWING ONE IS A MAJOR-VERSION EVENT. ADR M0.4 §2's
 * MCP row lists "remove/narrow a scope grant" among the BREAKING changes and §4
 * adds the reason it is the nastiest one on the list: the change is invisible to
 * a client whose token still validates, so nothing on the wire tells it that a
 * grant it had not yet exercised is gone. A decision with that property belongs
 * beside the major it must bump, not in a service file next to the code that
 * happens to advertise it.
 *
 * `oauth.service.ts` RE-EXPORTS these under the same names, so every existing
 * call site — including the two `scopes_supported` fields in the RFC 8414
 * metadata documents — reads the same array object. That is one VALUE with two
 * names, which is a re-export; it is not a second spelling of the decision,
 * which is what this file exists to prevent.
 *
 * They are also the reason this module imports nothing but `node:crypto`: the
 * lint, the manifest generator and the runtime catalog helper all read it with
 * no Nest container, no database client and no environment behind them.
 */
export const PLATFORM_MCP_SCOPES = ["mcp:read", "mcp:write"] as const;
export const ENTITY_MCP_SCOPES = ["mcp:tools"] as const;

/**
 * A JSON value rendered with object keys in sorted order.
 *
 * WHY NOT `JSON.stringify`. Key order in a JavaScript object is insertion order,
 * so re-ordering two properties in a tool's `inputSchema` — a change no client
 * can observe — would change the digest and report a breaking change that did
 * not happen. ADR M0.4 §5 item 5: "Canonicalize (sorted keys) so a benign
 * reformat is not false drift."
 *
 * Arrays keep their order, because array order in JSON Schema IS semantic
 * (`required`, `enum`, `oneOf`).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * One tool's schema hash. ADR M0.4 §5: `sha256(canonical(inputSchema))`.
 *
 * IT COVERS THE INPUT SCHEMA AND NOTHING ELSE, deliberately. A description is
 * prose for a model and changes constantly; a client that broke when a
 * description was improved would make every copy-edit a release event. What a
 * client is compiled against is the shape of the arguments, which is exactly
 * what an added required property or a narrowed enum changes.
 */
export function toolSchemaHash(inputSchema: unknown): string {
  return sha256Hex(canonicalJson(inputSchema));
}

/** The minimum a tool must expose for its `_meta` block to be derivable. */
export interface DigestibleTool {
  readonly name: string;
  readonly inputSchema: unknown;
  readonly requiresAdminTier?: boolean;
}

/**
 * The catalog digest — one value over a whole server's tool inventory.
 *
 * SORTED BY NAME, so two processes that registered the same tools in a different
 * order agree. Each row carries the name, the schema hash and the admin flag,
 * because ADR M0.4 §2 lists "flip scope->admin" among the BREAKING changes: a
 * tool that quietly became admin-only has vanished from every scope-tier
 * client's `tools/list`, and a digest that ignored the flag would not notice.
 */
export function mcpCatalogDigest(tools: readonly DigestibleTool[]): string {
  const rows = tools
    .map((tool) => ({
      name: tool.name,
      schemaHash: toolSchemaHash(tool.inputSchema),
      admin: tool.requiresAdminTier === true,
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return sha256Hex(canonicalJson(rows));
}

/**
 * The OAuth scope-set digest.
 *
 * DERIVED FROM THE SCOPE CONSTANTS THEMSELVES rather than being a counter
 * somebody increments. ADR M0.4 §2 makes scope NARROWING a v2 event and §5 asks
 * for "scope drift vs consts" to be asserted; the failure mode it is guarding is
 * invisible by construction — a client whose token still validates cannot tell
 * that a grant it never exercised was removed — so the only place the change is
 * observable is a value computed from the set.
 *
 * The caller passes the sets so this file does not import the OAuth module: the
 * surface constant must stay reachable from a lint and from a script with no
 * Nest container behind it.
 */
export function mcpScopeSetDigest(scopeSets: readonly (readonly string[])[]): string {
  const flattened = [...new Set(scopeSets.flat())].sort();
  return sha256Hex(canonicalJson(flattened));
}

/** The contract block that rides in `serverInfo._meta`. */
export interface McpContractMeta {
  readonly major: number;
  readonly catalogDigest: string | null;
  readonly scopeSetDigest: string | null;
  /**
   * ADR M0.4 §2 names a `rateTableVersion` alongside the other three.
   *
   * IT IS EMITTED AS `null`, AND THAT IS A FINDING RATHER THAN AN OMISSION.
   * There is no MCP rate table in this tree to derive a version from: the docs
   * server holds one hard-coded per-IP limit inside its own controller, the
   * platform and entity servers hold none, and `identity-access`'s
   * `consumeRateLimit` covers three PRE-AUTHENTICATION credential actions
   * (`LOGIN`, `INVITE_ACCEPT`, `MFA_VERIFY`) that no MCP path reaches. A
   * constant here would be a version of nothing — the exact defect ADR M0.4 §5
   * calls out when it insists the version be "generated, never hand-written".
   * The field is present and explicitly unset so a client can see that it is
   * unset, rather than absent so a client cannot tell this server from one that
   * simply forgot.
   */
  readonly rateTableVersion: null;
}

/** `initialize.result.serverInfo`, with the contract block attached. */
export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
  readonly _meta: Readonly<Record<string, McpContractMeta>>;
}

/**
 * The ONE function that builds a `serverInfo`.
 *
 * Every server calls it and none of them assembles the object itself, so the
 * contract block cannot be present on two servers and missing on the third —
 * which is the state the three hand-written literals were one edit away from.
 *
 * `catalogDigest` is nullable BY DESIGN and not by laziness. The platform
 * server's catalog is declared in the generated manifest and can be digested;
 * an ENTITY server's tools are discovered downstream from the entity's own MCP
 * endpoint, and ADR M0.4 §5 excludes them from the digest for that reason. A
 * digest over a catalog this process does not own would change when somebody
 * else's server changed, and a client would read that as a Platos contract
 * change.
 */
export function mcpServerInfo(
  name: string,
  options: {
    readonly catalogDigest?: string | null;
    readonly scopeSetDigest?: string | null;
  } = {},
): McpServerInfo {
  return {
    name,
    version: PLATOS_MCP_CONTRACT_VERSION,
    _meta: {
      [PLATOS_MCP_CONTRACT_META_KEY]: {
        major: PLATOS_MCP_CONTRACT_MAJOR,
        catalogDigest: options.catalogDigest ?? null,
        scopeSetDigest: options.scopeSetDigest ?? null,
        rateTableVersion: null,
      },
    },
  };
}

/** One tool's `_meta` block. ADR M0.4 §2 MCP row. */
export interface McpToolMeta {
  readonly v: number;
  readonly schemaHash: string;
  readonly admin: boolean;
}

/**
 * The `_meta` a `tools/list` entry carries.
 *
 * `v` IS THE CONTRACT MAJOR AND NOT A PER-TOOL COUNTER. ADR M0.4 §2 lists the
 * per-tool key as `{v, schemaHash, admin, deprecated?}`, and a per-tool version
 * would be a fourth axis a client would have to track for each of 202 tools. The
 * major says which contract the tool belongs to; the schema hash says whether
 * its shape moved. `deprecated` is absent here because no tool in this tree
 * carries a sunset yet, and ADR M0.4 §4 requires a sunset instant and a
 * replacement name before one may be flagged — an empty flag would tell a client
 * a tool is going away with nothing it can do about it.
 */
export function mcpToolMeta(tool: DigestibleTool): McpToolMeta {
  return {
    v: PLATOS_MCP_CONTRACT_MAJOR,
    schemaHash: toolSchemaHash(tool.inputSchema),
    admin: tool.requiresAdminTier === true,
  };
}
