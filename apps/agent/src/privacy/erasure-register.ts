/**
 * Erased-subject register — the write barrier that keeps an erasure erased.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * The sweep deletes rows and returns. Nothing else in the runtime knows an
 * erasure happened, so the next write recreates the person:
 *
 *   - `ConversationService.resolveEndUserRow` resolves the identity tuple,
 *     finds none, and creates a fresh PlatosEndUser plus every identity it was
 *     handed. A browser tab still holding a valid session token rebuilds the
 *     subject on its next turn, under a NEW uuid the finished receipt cannot
 *     see.
 *   - `ChannelPersistenceService.resolveVerifiedIdentity` does the same for an
 *     inbound Slack/email/WhatsApp message.
 *   - Executors run sequentially, so a turn landing mid-sweep writes rows the
 *     earlier stores already scanned past.
 *
 * A receipt that says "completed" while the next request restores the subject
 * is a false legal statement. So erasure now leaves something behind: a
 * tombstone per alias, consulted before any identity may be resolved or minted.
 *
 * FOUR PROPERTIES, EACH LOAD-BEARING
 *
 * 1. EVERY ALIAS, NOT THE REQUESTED ONE. The register is keyed by
 *    (channel, subject) and sealed from every PlatosEndUserIdentity row the
 *    subject owns — including rows already `disabledAt`, which the sweep
 *    deletes too. An erasure requested under a Walle external id therefore also
 *    refuses the subject's Slack handle, their email, and their raw
 *    PlatosEndUser uuid. Blocking one id while the same person walks back in
 *    through a channel handle is not a barrier.
 *
 *    Keyed by (channel, subject) rather than the full (issuer, channel,
 *    subject) tuple ON PURPOSE: issuer strings are constructed differently per
 *    write path — `channel:slack` in the conversation path, `channel:slack:…`
 *    with a realm suffix in the channel path — so binding to the issuer would
 *    let the same handle through the other door.
 *
 * 2. CONTENT-FREE. A register of raw handles would recreate, in a new table,
 *    exactly the personal data the operation destroyed. Rows hold only the
 *    salted, organization-scoped hash — the same primitive as the receipt's
 *    subjectKeyHash, so the register is no more reversible than the receipt.
 *
 * 3. FAIL CLOSED. If the lookup cannot run — database unreachable, migration
 *    not applied — the write is REFUSED, not allowed. An erasure barrier that
 *    opens under load is not a barrier; a failed turn is recoverable, a
 *    resurrected subject is not.
 *
 * 4. BOUNDED. See RETENTION below. A permanent register would grow forever and
 *    would eventually refuse a genuinely new person who happens to reuse a
 *    handle.
 *
 * RETENTION
 *
 * A tombstone lives for `PLATOS_ERASURE_TOMBSTONE_TTL_DAYS` (default 30) from
 * the moment the subject was sealed, and expiry is applied at READ time so the
 * rule holds whether or not anything sweeps.
 *
 * 30 days is not arbitrary: the tombstone only has to outlive the longest-lived
 * reference that could still land a write for the erased subject. Those are the
 * live end-user session (bounded by session expiry), an in-flight durable
 * Trigger task (minutes), and the ClickHouse span TTL (30 days). Past that
 * window nothing anywhere still points at the subject, and a signup under the
 * same handle is a different person who must not inherit someone else's
 * erasure.
 *
 * Steady-state size is therefore (erasures in the last 30 days) × (aliases per
 * subject), which is bounded by construction rather than by hope. Sealing
 * opportunistically purges expired rows, so the table stays trimmed without
 * depending on a scheduler that does not exist yet.
 */

import { createHash } from "node:crypto";

/** Default retention window. See RETENTION above for why 30. */
export const DEFAULT_TOMBSTONE_TTL_DAYS = 30;

/** One handle the subject can be addressed by. */
export interface SubjectAlias {
  /** Identity channel: "external", "session", "slack", "email", … */
  channel: string;
  /** The handle within that channel. */
  subject: string;
}

/**
 * Synthetic channel for the canonical PlatosEndUser uuid.
 *
 * Sealed alongside the real handles so an asynchronous writer that captured an
 * `endUserId` before the sweep — a tool-call audit, a memory extraction landing
 * minutes later — can be checked against the register too.
 */
export const CANONICAL_ALIAS_CHANNEL = "platos:end-user";

/** The write was for a subject this organization has erased. */
export class SubjectErasedError extends Error {
  constructor(readonly organizationId: string) {
    super("Subject has been erased; write refused");
    this.name = "SubjectErasedError";
  }
}

/**
 * The register could not be consulted.
 *
 * Distinct from SubjectErasedError because they mean opposite things about the
 * subject — but identical in effect, because both refuse the write. Reported
 * separately so an operator can tell "we blocked a resurrection" from "we lost
 * the ability to tell", which is an incident.
 */
export class ErasureRegisterUnavailableError extends Error {
  constructor(cause: unknown) {
    // Error CLASS only. Messages routinely embed the identifiers being erased.
    super(`Erasure register unavailable (${cause instanceof Error ? cause.name : "Error"})`);
    this.name = "ErasureRegisterUnavailableError";
  }
}

/** Minimal shape of the tombstone table, so callers can pass any Prisma client. */
export interface TombstoneStore {
  erasureTombstone: {
    findFirst(args: unknown): Promise<{ aliasHash: string } | null>;
    createMany(args: unknown): Promise<{ count: number }>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

/** Minimal shape of the identity table, for enumerating a subject's aliases. */
export interface IdentityReader {
  endUserIdentity: {
    findMany(args: unknown): Promise<Array<{ channel: string; subject: string }>>;
  };
}

/**
 * The per-deployment erasure salt, shared with the receipt's subjectKeyHash.
 *
 * Mandatory in production for the same reason there: an unsalted hash of an
 * email is reversible with a wordlist, which would make the register a
 * directory of erased people rather than a barrier protecting them.
 */
export function erasureHashSalt(): string {
  const configured = process.env.PLATOS_ERASURE_HASH_SALT;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("PLATOS_ERASURE_HASH_SALT is required in production");
  }
  return configured || "platos-erasure-development-only";
}

/** Retention window in days, clamped to at least one day. */
export function tombstoneTtlDays(): number {
  const raw = Number(process.env.PLATOS_ERASURE_TOMBSTONE_TTL_DAYS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_TOMBSTONE_TTL_DAYS;
  return Math.floor(raw);
}

/**
 * Normalize an alias to the one form both sides of the barrier agree on.
 *
 * Case-folded deliberately. The write paths do not agree on casing — the
 * conversation path stores a channel handle verbatim, the channel path
 * lowercases emails — so comparing raw would let "Alice@Example.com" back in
 * after "alice@example.com" was erased. Folding can in principle block a
 * genuinely different handle that differs only by case; that is the safe
 * direction, and it is the direction this whole module leans.
 */
export function normalizeAlias(alias: SubjectAlias): SubjectAlias | null {
  const channel = alias.channel?.trim().toLowerCase() ?? "";
  const subject = alias.subject?.trim().toLowerCase() ?? "";
  if (!channel || !subject) return null;
  return { channel, subject };
}

/**
 * Salted, organization-scoped, non-reversible handle for one alias.
 *
 * Scoped by organization so the same person erased in two tenants does not
 * produce a correlatable value, and namespaced by channel so an erased email
 * address does not also refuse an unrelated external id that happens to be the
 * same string.
 */
export function aliasKeyHash(
  alias: SubjectAlias,
  organizationId: string,
  salt: string,
  hasher: (input: string) => string = (s) => createHash("sha256").update(s).digest("hex"),
): string {
  const separator = "\x00";
  return hasher([salt, organizationId, "alias", alias.channel, alias.subject].join(separator));
}

/** Hash a batch of aliases, dropping empties and de-duplicating. */
export function aliasHashes(
  aliases: SubjectAlias[],
  organizationId: string,
  salt: string,
): string[] {
  const out = new Set<string>();
  for (const raw of aliases) {
    const alias = normalizeAlias(raw);
    if (!alias) continue;
    out.add(aliasKeyHash(alias, organizationId, salt));
  }
  return [...out].sort();
}

/**
 * Refuse the write if any presented alias belongs to an erased subject.
 *
 * Called at the identity chokepoints rather than at every table: every
 * subject-keyed row hangs off an `endUserId` that one of those chokepoints
 * produced, so refusing there refuses the rows downstream of it too.
 *
 * Throws on ANY failure, including a failure to ask. See property 3.
 */
export async function assertSubjectNotErased(
  store: TombstoneStore,
  args: {
    organizationId: string;
    aliases: SubjectAlias[];
    salt?: string;
    now?: () => Date;
  },
): Promise<void> {
  const hashes = aliasHashes(args.aliases, args.organizationId, args.salt ?? erasureHashSalt());
  if (hashes.length === 0) return;

  let hit: { aliasHash: string } | null;
  try {
    hit = await store.erasureTombstone.findFirst({
      where: {
        organizationId: args.organizationId,
        aliasHash: { in: hashes },
        // Read-time expiry: the retention rule holds even if nothing sweeps.
        expiresAt: { gt: (args.now ?? (() => new Date()))() },
      },
      select: { aliasHash: true },
    });
  } catch (err) {
    throw new ErasureRegisterUnavailableError(err);
  }

  if (hit) throw new SubjectErasedError(args.organizationId);
}

/**
 * Seal a subject: record a tombstone for every alias it can be reached by.
 *
 * Runs BEFORE the store executors, not after. Sealing first closes the
 * mid-sweep window — a turn landing while MinIO or Redis is still working is
 * refused rather than writing rows the later stores will never look for — and
 * it is the only point at which the identity rows enumerating the aliases still
 * exist, since Postgres is about to delete them.
 *
 * The consequence is deliberate: if the sweep then fails, the subject stays
 * sealed while the operation sits at partial_failure awaiting retry. Refusing
 * writes for someone whose erasure is half-finished is the direction that
 * cannot produce an unrecoverable outcome.
 */
export async function sealErasedSubject(
  store: TombstoneStore & IdentityReader,
  args: {
    organizationId: string;
    operationId: string;
    policyVersion: string;
    /** Canonical PlatosEndUser ids; their identity rows supply the handles. */
    platosEndUserIds: string[];
    /** Handles known without a database read — the requested external id. */
    extraAliases?: SubjectAlias[];
    salt?: string;
    ttlDays?: number;
    now?: () => Date;
  },
): Promise<{ aliases: number; sealed: number; purged: number }> {
  const salt = args.salt ?? erasureHashSalt();
  const now = (args.now ?? (() => new Date()))();
  const ttlDays = args.ttlDays ?? tombstoneTtlDays();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  // Deliberately unfiltered by disabledAt: the sweep deletes every identity row
  // the subject owns, so the barrier has to cover every one of them too.
  const identities = args.platosEndUserIds.length
    ? await store.endUserIdentity.findMany({
        where: { organizationId: args.organizationId, endUserId: { in: args.platosEndUserIds } },
        select: { channel: true, subject: true },
      })
    : [];

  const aliases: SubjectAlias[] = [
    ...identities,
    ...(args.extraAliases ?? []),
    // The raw uuid, for asynchronous writers that captured it before the sweep.
    ...args.platosEndUserIds.map((id) => ({ channel: CANONICAL_ALIAS_CHANNEL, subject: id })),
  ];
  const hashes = aliasHashes(aliases, args.organizationId, salt);
  if (hashes.length === 0) return { aliases: 0, sealed: 0, purged: 0 };

  // Insert-then-extend rather than delete-then-insert: a re-seal on retry must
  // never leave the barrier momentarily open.
  const created = await store.erasureTombstone.createMany({
    data: hashes.map((aliasHash) => ({
      organizationId: args.organizationId,
      aliasHash,
      operationId: args.operationId,
      policyVersion: args.policyVersion,
      sealedAt: now,
      expiresAt,
    })),
    skipDuplicates: true,
  });
  await store.erasureTombstone.updateMany({
    where: { organizationId: args.organizationId, aliasHash: { in: hashes } },
    data: { expiresAt, operationId: args.operationId, policyVersion: args.policyVersion },
  });

  const purged = await purgeExpiredTombstones(store, { now: () => now });
  return { aliases: hashes.length, sealed: created.count, purged: purged.purged };
}

/**
 * Drop tombstones past their retention window.
 *
 * Correctness does not depend on this running — `assertSubjectNotErased`
 * already ignores expired rows — so it is safe to call opportunistically, and
 * safe never to call at all beyond the table growing.
 */
export async function purgeExpiredTombstones(
  store: TombstoneStore,
  args: { now?: () => Date } = {},
): Promise<{ purged: number }> {
  const result = await store.erasureTombstone.deleteMany({
    where: { expiresAt: { lte: (args.now ?? (() => new Date()))() } },
  });
  return { purged: result.count };
}
