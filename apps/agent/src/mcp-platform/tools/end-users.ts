/**
 * Theme EUI — end-user identity management platform MCP tools.
 *
 * The runtime resolves an end-user to a canonical `PlatosEndUser` row and
 * attaches channel-native identities (email addr, E.164 phone, Slack user
 * id, …) as `PlatosEndUserIdentity` rows using a link-not-merge model:
 * a verified identity anchors the person, every claimed identity is linked
 * to that person, and a handle already pointing at a DIFFERENT person is
 * never re-pointed. These tools give MCP clients the read + manual-edit
 * surface over that graph.
 *
 *   - end_users.get              → fetch a PlatosEndUser + its identities[]
 *   - end_users.link_identity    → manually attach a (channel, handle) identity
 *   - end_users.bind_external_id → adopt an EXTERNAL id (Composio user_id) onto
 *                                  the person behind a verified (channel, handle)
 *                                  claim; sets linkedExternalId (idempotent
 *                                  overwrite). See IDENTITY-CORE §A.3.
 *   - end_users.unlink_identity  → detach a (channel, handle) identity
 *
 * Scope is ALWAYS taken from the verified MCP token, never from the
 * LLM-supplied args — every query is filtered by the token's
 * (organizationId, projectId, environmentId) tuple. Manual links carry no
 * trust anchor (`sourceEntityId = null`); only the runtime resolver stamps
 * a sourceEntityId from the connected entity that asserted the identity.
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";

// ── Identity sanitization — mirrors the mint-time rules in the shared
//    contract (auth.service SessionPayload.userIdentities). Keep in sync:
//    channel lowercased/trimmed matching /^[a-z0-9_-]{1,32}$/; handle
//    trimmed, length 1..256, no control chars. ────────────────────────
const CHANNEL_RE = /^[a-z0-9_-]{1,32}$/;
// C0 control chars + DEL — a handle carrying these could split a header /
// log line or smuggle a NUL into a DB text column.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

function sanitizeChannel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const channel = raw.trim().toLowerCase();
  return CHANNEL_RE.test(channel) ? channel : null;
}

function sanitizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const handle = raw.trim();
  if (handle.length < 1 || handle.length > 256) return null;
  if (CONTROL_CHAR_RE.test(handle)) return null;
  return handle;
}

// The adopted EXTERNAL id (Walle user id = Composio `user_id`). Same bounds as
// `externalUserId`: trimmed, 1..256, no control chars (a control char here
// could split the outbound URL / header it is later substituted into).
function sanitizeExternalId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const externalId = raw.trim();
  if (externalId.length < 1 || externalId.length > 256) return null;
  if (CONTROL_CHAR_RE.test(externalId)) return null;
  return externalId;
}

function scopeTuple(scope: RequestScope) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

/** Shape the identity row returns for read + write responses. */
function projectIdentity(row: {
  channel: string;
  handle: string;
  verified: boolean;
  sourceEntityId: string | null;
  createdAt: Date | string;
}) {
  return {
    channel: row.channel,
    handle: row.handle,
    verified: row.verified,
    sourceEntityId: row.sourceEntityId ?? null,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export function buildEndUserToolHandlers(deps: {
  prisma: any;
  toolAudit: ToolAuditService;
}): McpToolHandler[] {
  const { prisma, toolAudit } = deps;

  /**
   * Fire-and-forget audit trail for mutating end-user tools. Mirrors the
   * shape used by `entities.ts` / `index.ts` so MCP-driven identity edits
   * surface in the same dashboard rows.
   */
  function auditMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit
      .record({
        scope: scopeTuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(error !== undefined ? { error } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => undefined);
  }

  return [
    {
      name: "end_users.get",
      description:
        "Fetch a single PlatosEndUser in the token's scope by EXACTLY ONE " +
        "of `externalUserId` (the opaque id forwarded by the entity backend) " +
        "or `platosEndUserId` (the canonical cuid). Returns the person's " +
        "profile (id, externalUserId, displayName, email, threadCount, " +
        "lastActiveAt, metadata) plus every linked identity (channel, " +
        "handle, verified, sourceEntityId, createdAt). Scope-pinned — " +
        "cross-scope ids return `{ error: 'not_found' }`.",
      inputSchema: {
        type: "object",
        properties: {
          externalUserId: { type: "string" },
          platosEndUserId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const externalUserId =
          typeof params["externalUserId"] === "string"
            ? (params["externalUserId"] as string).trim()
            : "";
        const platosEndUserId =
          typeof params["platosEndUserId"] === "string"
            ? (params["platosEndUserId"] as string).trim()
            : "";
        const hasExternal = externalUserId.length > 0;
        const hasPk = platosEndUserId.length > 0;
        // Exactly one selector — an ambiguous or empty call is a caller
        // error, not a 404.
        if (hasExternal === hasPk) {
          return {
            error: "invalid_params",
            message:
              "supply exactly one of `externalUserId` or `platosEndUserId`",
          };
        }

        const tuple = scopeTuple(scope);
        // findFirst (never findUnique) so the scope tuple is always part of
        // the WHERE — a forged cuid from another scope can't be read.
        const user = await prisma.platosEndUser.findFirst({
          where: hasPk
            ? { id: platosEndUserId, ...tuple }
            : { externalUserId, ...tuple },
        });
        if (!user) {
          return {
            error: "not_found",
            ...(hasPk ? { platosEndUserId } : { externalUserId }),
          };
        }

        const identities = await prisma.platosEndUserIdentity.findMany({
          where: { platosEndUserId: user.id, ...tuple },
          orderBy: { createdAt: "asc" },
        });

        return {
          id: user.id,
          externalUserId: user.externalUserId,
          displayName: user.displayName ?? null,
          email: user.email ?? null,
          threadCount: user.threadCount ?? 0,
          lastActiveAt:
            user.lastActiveAt instanceof Date
              ? user.lastActiveAt.toISOString()
              : (user.lastActiveAt ?? null),
          metadata: user.metadata ?? null,
          identities: (identities as any[]).map(projectIdentity),
        };
      },
    },

    {
      name: "end_users.link_identity",
      description:
        "Manually attach a channel-native identity to a PlatosEndUser. " +
        "The person must already exist in the token's scope. `channel` is " +
        "lowercased + must match /^[a-z0-9_-]{1,32}$/ (e.g. email, phone, " +
        "slack, teams, whatsapp); `handle` is the channel-native id " +
        "(email addr, E.164 phone, Slack user id) — trimmed, 1..256 chars, " +
        "no control chars. Manual links carry NO trust anchor " +
        "(sourceEntityId = null). If the (channel, handle) already points " +
        "at a DIFFERENT person the call returns `{ error: " +
        "'identity_conflict' }` naming the existing linkage and does NOT " +
        "re-point (link-not-merge). Re-linking the SAME person updates the " +
        "verified flag + metadata.",
      inputSchema: {
        type: "object",
        required: ["platosEndUserId", "channel", "handle"],
        properties: {
          platosEndUserId: { type: "string" },
          channel: { type: "string" },
          handle: { type: "string" },
          verified: { type: "boolean" },
          metadata: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const platosEndUserId = String(params["platosEndUserId"] ?? "").trim();
        const channel = sanitizeChannel(params["channel"]);
        const handle = sanitizeHandle(params["handle"]);
        const verified = params["verified"] === true;
        const metadata =
          params["metadata"] &&
          typeof params["metadata"] === "object" &&
          !Array.isArray(params["metadata"])
            ? (params["metadata"] as Record<string, unknown>)
            : undefined;

        if (!platosEndUserId) {
          const err = "platosEndUserId required";
          auditMutation(scope, "end_users.link_identity", params, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!channel) {
          const err = "channel must match /^[a-z0-9_-]{1,32}$/ (after lowercasing)";
          auditMutation(scope, "end_users.link_identity", params, null, "failed", startedAt, err);
          return { error: "invalid_channel", message: err };
        }
        if (!handle) {
          const err = "handle must be trimmed, 1..256 chars, no control chars";
          auditMutation(scope, "end_users.link_identity", params, null, "failed", startedAt, err);
          return { error: "invalid_handle", message: err };
        }

        const tuple = scopeTuple(scope);
        try {
          // 1. The person must exist IN SCOPE — no cross-scope linking.
          const user = await prisma.platosEndUser.findFirst({
            where: { id: platosEndUserId, ...tuple },
            select: { id: true },
          });
          if (!user) {
            auditMutation(
              scope,
              "end_users.link_identity",
              params,
              null,
              "failed",
              startedAt,
              "not_found",
            );
            return { error: "not_found", platosEndUserId };
          }

          // 2. Detect an existing linkage for this (channel, handle) in
          //    scope. link-not-merge: a handle already owned by another
          //    person is NEVER re-pointed.
          const existing = await prisma.platosEndUserIdentity.findFirst({
            where: { ...tuple, channel, handle },
          });
          if (existing && existing.platosEndUserId !== platosEndUserId) {
            const conflict = {
              error: "identity_conflict",
              channel,
              handle,
              existingPlatosEndUserId: existing.platosEndUserId,
              message:
                `(${channel}, ${handle}) is already linked to ` +
                `${existing.platosEndUserId}; unlink it first to re-point.`,
            };
            auditMutation(
              scope,
              "end_users.link_identity",
              params,
              conflict,
              "failed",
              startedAt,
              "identity_conflict",
            );
            return conflict;
          }

          // 3. Upsert onto the resolved person. Manual link ⇒ no trust
          //    anchor. Re-link of the same person updates verified/metadata.
          const row = existing
            ? await prisma.platosEndUserIdentity.update({
                where: { id: existing.id },
                data: {
                  verified,
                  sourceEntityId: null,
                  ...(metadata !== undefined ? { metadata } : {}),
                },
              })
            : await prisma.platosEndUserIdentity.create({
                data: {
                  ...tuple,
                  platosEndUserId,
                  channel,
                  handle,
                  verified,
                  sourceEntityId: null,
                  ...(metadata !== undefined ? { metadata } : {}),
                },
              });

          const result = {
            ok: true,
            platosEndUserId,
            created: !existing,
            identity: projectIdentity(row as any),
          };
          auditMutation(scope, "end_users.link_identity", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "end_users.link_identity",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "link_failed", message };
        }
      },
    },

    {
      name: "end_users.bind_external_id",
      description:
        "Adopt an EXTERNAL id (e.g. the Walle DB user id = Composio " +
        "`user_id`) onto the PlatosEndUser behind a VERIFIED (channel, handle) " +
        "claim, so per-user Composio tools resolve `{{endUserId}}` to that " +
        "external id. Keyed by the claim, NOT the cuid — callers (e.g. Walle " +
        "finish-setup) supply only `(channel, handle, externalId)`.\n\n" +
        "For Slack, `handle` is `<team>:<slackUserId>` where `<team> = " +
        "teamId ?? enterpriseId` (an org/Grid install has teamId null ⇒ keyed " +
        "by enterpriseId) — the SAME team-qualified handle the channel runtime " +
        "mints. `channel` is lowercased + must match /^[a-z0-9_-]{1,32}$/; " +
        "`externalId` is trimmed, 1..256 chars, no control chars.\n\n" +
        "Behaviour: if a (channel, handle) identity exists, adopt its owner; " +
        "else find-or-create a person by externalUserId=`<channel>:<handle>` " +
        "and create the identity row with verified:true FORCED (so a later " +
        "inbound message anchors on it) — regardless of the `verified` input " +
        "flag. Then set linkedExternalId with idempotent OVERWRITE: an " +
        "identical re-call is a no-op (created:false); a re-bind of the same " +
        "claim to a NEW externalId re-links (moves the Composio identity). If " +
        "a DIFFERENT person in scope already holds that externalId the call is " +
        "refused with `{ error: 'external_id_conflict', existingPlatosEndUserId }`. " +
        "Scope-pinned; audited (records old→new on a re-link).",
      inputSchema: {
        type: "object",
        required: ["channel", "handle", "externalId"],
        properties: {
          channel: { type: "string" },
          handle: { type: "string" },
          externalId: { type: "string" },
          // Retained for wire-compat / future use. Does NOT gate the anchor:
          // the web-first CREATE path always forces verified:true (§A.3 G5).
          verified: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const channel = sanitizeChannel(params["channel"]);
        const handle = sanitizeHandle(params["handle"]);
        const externalId = sanitizeExternalId(params["externalId"]);

        if (!channel) {
          const err = "channel must match /^[a-z0-9_-]{1,32}$/ (after lowercasing)";
          auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, err);
          return { error: "invalid_channel", message: err };
        }
        if (!handle) {
          const err = "handle must be trimmed, 1..256 chars, no control chars";
          auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, err);
          return { error: "invalid_handle", message: err };
        }
        if (!externalId) {
          const err = "externalId must be trimmed, 1..256 chars, no control chars";
          auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, err);
          return { error: "invalid_external_id", message: err };
        }

        const tuple = scopeTuple(scope);
        try {
          // ── Step 1/2: adopt by the VERIFIED (channel, handle) claim. If the
          //    identity row exists we adopt WHOEVER owns it — never re-point
          //    the claim (link-not-merge). ──────────────────────────────────
          let personId: string;
          // `created` = we minted the web-first identity ANCHOR in step 3.
          // Row-exists adoption, race-lost adoption, and a pure re-bind all
          // return created:false.
          let created = false;

          const existingIdentity = await prisma.platosEndUserIdentity.findFirst({
            where: { ...tuple, channel, handle },
            select: { platosEndUserId: true },
          });

          if (existingIdentity) {
            personId = existingIdentity.platosEndUserId as string;
          } else {
            // ── Step 3: web/finish-setup happened first — no identity row.
            //    Find-or-create the person by externalUserId=`<channel>:<handle>`
            //    (mirrors the authorScope.userId convention so a LATER inbound's
            //    resolveEndUser step-(b) collapses onto the SAME person), then
            //    lay down the (channel, handle) identity with verified:true
            //    FORCED (§A.3 G5 — an unverified anchor would be ignored by
            //    resolveEndUser step-(a), minting a SECOND person for the human).
            const syntheticExternalUserId = `${channel}:${handle}`;
            const existingPerson = await prisma.platosEndUser.findFirst({
              where: { ...tuple, externalUserId: syntheticExternalUserId },
              select: { id: true },
            });
            if (existingPerson) {
              personId = existingPerson.id as string;
            } else {
              try {
                const mintedPerson = await prisma.platosEndUser.create({
                  data: {
                    ...tuple,
                    externalUserId: syntheticExternalUserId,
                    lastActiveAt: new Date(),
                  },
                  select: { id: true },
                });
                personId = mintedPerson.id as string;
              } catch {
                // Race: a concurrent insert won the externalUserId unique.
                // Re-read + adopt the winner (link-not-merge).
                const winner = await prisma.platosEndUser.findFirst({
                  where: { ...tuple, externalUserId: syntheticExternalUserId },
                  select: { id: true },
                });
                if (!winner) throw new Error("person find-or-create race unresolved");
                personId = winner.id as string;
              }
            }

            // Create the forced-verified anchor. sourceEntityId carries the
            // asserting entity as the trust anchor (same trust level the
            // channel runtime asserts verified slack claims under).
            try {
              await prisma.platosEndUserIdentity.create({
                data: {
                  ...tuple,
                  platosEndUserId: personId,
                  channel,
                  handle,
                  verified: true, // FORCED (§A.3 G5) — ignores the input flag.
                  sourceEntityId: scope.entityId ?? null,
                },
              });
              created = true;
            } catch {
              // Race: the (channel, handle) row was created between our step-1
              // read and here. Re-read + adopt its owner (link-not-merge — the
              // claim is authoritative, never re-pointed).
              const raced = await prisma.platosEndUserIdentity.findFirst({
                where: { ...tuple, channel, handle },
                select: { platosEndUserId: true },
              });
              if (raced) personId = raced.platosEndUserId as string;
            }
          }

          // ── Step 4: set linkedExternalId with idempotent OVERWRITE (§A.3 G4).
          const person = await prisma.platosEndUser.findFirst({
            where: { id: personId, ...tuple },
            select: { id: true, linkedExternalId: true },
          });
          if (!person) {
            // The person we just resolved vanished (cross-scope / delete race).
            auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, "not_found");
            return { error: "not_found", channel, handle };
          }
          const oldLinked = (person.linkedExternalId as string | null) ?? null;

          if (oldLinked === externalId) {
            // Identical re-call → no-op.
            const result = { ok: true, platosEndUserId: personId, externalId, created: false };
            auditMutation(scope, "end_users.bind_external_id", params, result, "success", startedAt);
            return result;
          }

          // Cross-person collision pre-check: the scoped @@unique (NULL-distinct)
          // guards CROSS-PERSON reuse of one Composio user_id. Re-binding the
          // SAME person's own claim never trips this (it targets the same row).
          const clash = await prisma.platosEndUser.findFirst({
            where: { ...tuple, linkedExternalId: externalId },
            select: { id: true },
          });
          if (clash && (clash.id as string) !== personId) {
            const conflict = {
              error: "external_id_conflict",
              existingPlatosEndUserId: clash.id as string,
            };
            auditMutation(scope, "end_users.bind_external_id", params, conflict, "failed", startedAt, "external_id_conflict");
            return conflict;
          }

          // Overwrite (first set OR deliberate re-link). The @@unique is the
          // race backstop: a concurrent cross-person claim throws here.
          try {
            await prisma.platosEndUser.update({
              where: { id: personId },
              data: { linkedExternalId: externalId },
            });
          } catch {
            // Unique-violation race — a different person grabbed externalId
            // between the pre-check and the write. Re-read the owner.
            const raceClash = await prisma.platosEndUser.findFirst({
              where: { ...tuple, linkedExternalId: externalId },
              select: { id: true },
            });
            const conflict = {
              error: "external_id_conflict",
              existingPlatosEndUserId: (raceClash?.id as string) ?? null,
            };
            auditMutation(scope, "end_users.bind_external_id", params, conflict, "failed", startedAt, "external_id_conflict");
            return conflict;
          }

          const result = { ok: true, platosEndUserId: personId, externalId, created };
          // Record old→new on a re-link so the move (Composio identity change)
          // is traceable in the audit trail; wire output stays the clean shape.
          auditMutation(
            scope,
            "end_users.bind_external_id",
            params,
            oldLinked !== null ? { ...result, relinkedFrom: oldLinked } : result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, message);
          return { error: "bind_failed", message };
        }
      },
    },

    {
      name: "end_users.unlink_identity",
      description:
        "Detach a channel-native identity by its (channel, handle) within " +
        "the token's scope. `channel` is lowercased before lookup; `handle` " +
        "is trimmed. Scope-pinned — an identity in another scope is invisible " +
        "and returns `{ ok: false, error: 'not_found' }`. Returns the row " +
        "that was unlinked (channel, handle, verified, sourceEntityId, " +
        "platosEndUserId) so the caller can re-link if needed. Never merges " +
        "or re-points other rows.",
      inputSchema: {
        type: "object",
        required: ["channel", "handle"],
        properties: {
          channel: { type: "string" },
          handle: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const channel = sanitizeChannel(params["channel"]);
        const handle = sanitizeHandle(params["handle"]);

        if (!channel) {
          const err = "channel must match /^[a-z0-9_-]{1,32}$/ (after lowercasing)";
          auditMutation(scope, "end_users.unlink_identity", params, null, "failed", startedAt, err);
          return { error: "invalid_channel", message: err };
        }
        if (!handle) {
          const err = "handle must be trimmed, 1..256 chars, no control chars";
          auditMutation(scope, "end_users.unlink_identity", params, null, "failed", startedAt, err);
          return { error: "invalid_handle", message: err };
        }

        const tuple = scopeTuple(scope);
        try {
          // find-then-delete so we can (a) scope-filter the delete and
          // (b) return exactly what was removed.
          const existing = await prisma.platosEndUserIdentity.findFirst({
            where: { ...tuple, channel, handle },
          });
          if (!existing) {
            const result = { ok: false, error: "not_found", channel, handle };
            auditMutation(
              scope,
              "end_users.unlink_identity",
              params,
              result,
              "failed",
              startedAt,
              "not_found",
            );
            return result;
          }
          await prisma.platosEndUserIdentity.delete({ where: { id: existing.id } });
          const result = {
            ok: true,
            unlinked: {
              ...projectIdentity(existing as any),
              platosEndUserId: existing.platosEndUserId,
            },
          };
          auditMutation(scope, "end_users.unlink_identity", params, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "end_users.unlink_identity",
            params,
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "unlink_failed", message };
        }
      },
    },
  ];
}
