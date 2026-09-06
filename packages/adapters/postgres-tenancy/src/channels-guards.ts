// The write guards for `channels`' six canonical rows, and the refusal codes
// that tell them apart.
//
// WHY A GUARD AND NOT JUST THE DATABASE. Every guard below either restates a
// constraint the MIGRATIONS install — never `schema.prisma`, which carries none
// of them — or states a rule the schema cannot express at all. Restating one is
// not duplication: the database refuses with a message naming a constraint, and
// a caller that has to parse `ChannelInstallation_tokenRefreshState_check` out
// of a driver error to learn which of its fields was wrong is a caller that will
// not bother. The guard names the field before the statement is sent, and the
// constraint stays as the thing that makes the guard falsifiable.
//
// WHICH ONES HAVE A CONSTRAINT BEHIND THEM, EXACTLY. Four do:
//
//   `refresh_state_unknown`   ChannelInstallation_tokenRefreshState_check
//   `event_status_unknown`    ChannelEventInbox_status_check
//   `routing_not_array`       {ChannelConnection,ChannelApp,ChannelInstallation}
//                             _agentRouting_json_root
//   `identifier_not_uuid`     the UUID column type itself, which refuses a
//                             non-uuid with SQLSTATE 22P02
//
// The rest have NONE, and that is stated rather than implied: `provider`,
// `distribution` and `status` are plain `TEXT` columns with no CHECK, so the
// vocabulary `domain/provider.ts` and `domain/installation.ts` fix is enforced
// HERE or nowhere. A store that dropped those three guards would write
// `"Slack"` beside `"slack"` and the database would take both.
//
// EVERY REFUSAL HAS ITS OWN CODE. Two guards sharing one code cannot be told
// apart in a log, which is how two defects hid behind one code in `privacy` and
// in `identity-access`. They travel inside `repositoryUnavailable`'s
// `details.reason`, prefixed by the operation, because the port's error type is
// the context's and an adapter may not mint a new one.

import type { Result } from "@platos/context-channels/application/ports/index.js";
import {
  APP_DISTRIBUTIONS,
  APP_PROVIDERS,
  CHANNEL_EVENT_STATUSES,
  CONNECTION_PROVIDERS,
  err,
  INSTALLATION_STATUSES,
  MAX_AGENT_ROUTING_RULES,
  ok,
  REFRESH_STATES,
  repositoryUnavailable,
} from "@platos/context-channels/application/ports/index.js";

/** A value bound for a `@db.Uuid` column is not one. SQLSTATE 22P02. */
export const IDENTIFIER_NOT_UUID = "identifier_not_uuid";

/** `agentRouting` is not a JSON array. The three `_json_root` CHECKs. */
export const ROUTING_NOT_ARRAY = "routing_not_array";

/** A rule inside `agentRouting` is not the shape the resolver reads. */
export const ROUTING_RULE_MALFORMED = "routing_rule_malformed";

/** More rules than `MAX_AGENT_ROUTING_RULES`. No constraint behind it. */
export const ROUTING_TOO_MANY_RULES = "routing_too_many_rules";

/** A provider outside the list its table admits. No constraint behind it. */
export const PROVIDER_UNKNOWN = "provider_unknown";

/** `ChannelApp.distribution` outside private|public. No constraint behind it. */
export const DISTRIBUTION_UNKNOWN = "distribution_unknown";

/** `ChannelInstallation.status` outside active|revoked. No constraint. */
export const INSTALLATION_STATUS_UNKNOWN = "installation_status_unknown";

/** `tokenRefreshState` outside the three. Restates the CHECK. */
export const REFRESH_STATE_UNKNOWN = "refresh_state_unknown";

/** The fence's state and its claim columns disagree. No constraint. */
export const REFRESH_FENCE_INCOHERENT = "refresh_fence_incoherent";

/** `ChannelEventInbox.status` outside the five. Restates the CHECK. */
export const EVENT_STATUS_UNKNOWN = "event_status_unknown";

/** The lease's state and its owner/expiry columns disagree. No constraint. */
export const EVENT_LEASE_INCOHERENT = "event_lease_incoherent";

/** A sealed payload is missing a version or carries an unusable one. */
export const SEALED_PAYLOAD_INVALID = "sealed_payload_invalid";

/** A `TEXT[]` column was handed something that is not a list of strings. */
export const TEXT_LIST_INVALID = "text_list_invalid";

/** A monotonic counter went backwards past zero. No constraint. */
export const GENERATION_NEGATIVE = "generation_negative";

/** A channel-thread key is empty or longer than the domain admits. */
export const THREAD_KEY_INVALID = "thread_key_invalid";

/**
 * The canonical UUID shape, and it is deliberately NOT `/^[0-9a-f-]+$/`.
 *
 * PostgreSQL accepts several spellings of a uuid literal and normalises them, so
 * a store that admitted a braced or unhyphenated form would write a row whose id
 * does not equal the string it was handed — and the next read, keyed on the
 * caller's spelling, would find nothing. Eight-four-four-four-twelve lowercase
 * hexadecimal is the one spelling that round-trips.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The longest channel-thread key `domain/thread-link.ts` admits. */
const MAX_THREAD_KEY_LENGTH = 512;

function refuse<Value>(operation: string, code: string, detail: string): Result<Value> {
  return err(repositoryUnavailable(`${operation}:${code}:${detail}`));
}

/** Every id bound for a UUID column passes through here. */
export function requireUuid<Value>(
  operation: string,
  field: string,
  value: string,
): Result<Value> | null {
  return UUID.test(value) ? null : refuse(operation, IDENTIFIER_NOT_UUID, field);
}

/** The nullable form. A null is a null, not a malformed id. */
export function requireOptionalUuid<Value>(
  operation: string,
  field: string,
  value: string | null,
): Result<Value> | null {
  return value === null ? null : requireUuid(operation, field, value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The stored `agentRouting` table, checked as strictly as it is written.
 *
 * STRICT HERE BECAUSE `domain/routing.ts` IS LENIENT THERE. Its header settles
 * the asymmetry: `normalizeAgentRouting` is strict at write time so that
 * `resolveAgent` can be total at read time, and "the strict half is what makes
 * the lenient half safe". This store is the last write-time gate before the
 * column, and the CHECK behind it only asks for an ARRAY — a table of
 * `[1, 2, 3]` satisfies the constraint and makes every rule in it invisible.
 */
export function requireRoutingTable<Value>(
  operation: string,
  value: readonly unknown[],
): Result<Value> | null {
  if (!Array.isArray(value)) return refuse(operation, ROUTING_NOT_ARRAY, "agentRouting");
  if (value.length > MAX_AGENT_ROUTING_RULES) {
    return refuse(operation, ROUTING_TOO_MANY_RULES, String(value.length));
  }
  for (const [index, rule] of value.entries()) {
    if (!isPlainObject(rule)) return refuse(operation, ROUTING_RULE_MALFORMED, `rule[${index}]`);
    const agentId = rule["agentId"];
    if (typeof agentId !== "string" || agentId.trim() === "") {
      return refuse(operation, ROUTING_RULE_MALFORMED, `rule[${index}].agentId`);
    }
    const match = rule["match"];
    if (!isPlainObject(match)) return refuse(operation, ROUTING_RULE_MALFORMED, `rule[${index}].match`);
    const kind = match["type"];
    if (kind === "channel") {
      const id = match["id"];
      if (typeof id !== "string" || id.trim() === "") {
        return refuse(operation, ROUTING_RULE_MALFORMED, `rule[${index}].match.id`);
      }
    } else if (kind === "prefix") {
      const prefix = match["value"];
      if (typeof prefix !== "string" || prefix.trim() === "") {
        return refuse(operation, ROUTING_RULE_MALFORMED, `rule[${index}].match.value`);
      }
    } else {
      return refuse(operation, ROUTING_RULE_MALFORMED, `rule[${index}].match.type`);
    }
  }
  return null;
}

/** One of a fixed vocabulary, compared exactly rather than case-folded. */
function requireMember<Value>(
  operation: string,
  code: string,
  field: string,
  allowed: readonly string[],
  value: string,
): Result<Value> | null {
  return allowed.includes(value) ? null : refuse(operation, code, `${field}=${value}`);
}

export function requireConnectionProvider<Value>(
  operation: string,
  value: string,
): Result<Value> | null {
  return requireMember(operation, PROVIDER_UNKNOWN, "provider", CONNECTION_PROVIDERS, value);
}

/**
 * Deliberately narrower than the connection form, and the narrowness is the
 * rule: `domain/provider.ts` admits four providers as a direct connection and
 * exactly one as a hosted app, because the other three have no installation
 * model at all. One shared list would let an operator mint a `ChannelApp` whose
 * OAuth callback can never arrive.
 */
export function requireAppProvider<Value>(operation: string, value: string): Result<Value> | null {
  return requireMember(operation, PROVIDER_UNKNOWN, "provider", APP_PROVIDERS, value);
}

export function requireDistribution<Value>(operation: string, value: string): Result<Value> | null {
  return requireMember(operation, DISTRIBUTION_UNKNOWN, "distribution", APP_DISTRIBUTIONS, value);
}

export function requireInstallationStatus<Value>(
  operation: string,
  value: string,
): Result<Value> | null {
  return requireMember(operation, INSTALLATION_STATUS_UNKNOWN, "status", INSTALLATION_STATUSES, value);
}

export function requireRefreshState<Value>(operation: string, value: string): Result<Value> | null {
  return requireMember(operation, REFRESH_STATE_UNKNOWN, "tokenRefreshState", REFRESH_STATES, value);
}

export function requireEventStatus<Value>(operation: string, value: string): Result<Value> | null {
  return requireMember(operation, EVENT_STATUS_UNKNOWN, "status", CHANNEL_EVENT_STATUSES, value);
}

/**
 * The refresh fence's three states, each with the columns it requires.
 *
 * NO CONSTRAINT STANDS BEHIND THIS and the schema could not express it: the
 * claim id, the start instant and the repair code are three nullable columns
 * whose meaning depends on a fourth. `REFRESHING` without a claim id is a fence
 * nobody holds and nobody can release, and it is reachable from a store that
 * wrote the state column and forgot the rest.
 */
export function requireRefreshCoherence<Value>(
  operation: string,
  state: string,
  claimId: string | null,
  startedAt: Date | null,
  repairCode: string | null,
): Result<Value> | null {
  if (state === "REFRESHING") {
    if (claimId === null || startedAt === null) {
      return refuse(operation, REFRESH_FENCE_INCOHERENT, "REFRESHING without a claim");
    }
    return requireUuid(operation, "tokenRefreshClaimId", claimId);
  }
  if (claimId !== null || startedAt !== null) {
    return refuse(operation, REFRESH_FENCE_INCOHERENT, `${state} holding a claim`);
  }
  if (state === "REPAIR_REQUIRED" && repairCode === null) {
    return refuse(operation, REFRESH_FENCE_INCOHERENT, "REPAIR_REQUIRED without a repair code");
  }
  return null;
}

/**
 * The inbox lease's states, each with the columns it requires.
 *
 * `PROCESSING` needs an owner AND an expiry, because `isClaimable` reads the
 * expiry to decide whether a dead holder's row may be taken and a null one is
 * never past. A terminal row needs its owner and expiry NULLED, because a
 * completed row that kept an expired lease would look claimable to the same
 * predicate — which is the difference between admitting an event once and
 * running its turn twice.
 */
export function requireLeaseCoherence<Value>(
  operation: string,
  status: string,
  leaseOwner: string | null,
  leaseExpiresAt: Date | null,
): Result<Value> | null {
  if (status === "PROCESSING") {
    return leaseOwner !== null && leaseExpiresAt !== null
      ? null
      : refuse(operation, EVENT_LEASE_INCOHERENT, "PROCESSING without a held lease");
  }
  return leaseOwner === null && leaseExpiresAt === null
    ? null
    : refuse(operation, EVENT_LEASE_INCOHERENT, `${status} holding a lease`);
}

/**
 * The sealed payload's three parts.
 *
 * BOTH VERSIONS TRAVEL, and the domain says why: a row admitted today has to
 * stay decodable after the key rotates AND after the envelope format changes, so
 * a key id alone cannot tell a reader how to parse what it decrypts. They are
 * `INTEGER NOT NULL` columns, so a fractional or negative version is a value the
 * column would silently truncate or accept.
 */
export function requireSealedPayload<Value>(
  operation: string,
  formatVersion: number,
  keyVersion: number,
  ciphertext: string,
): Result<Value> | null {
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    return refuse(operation, SEALED_PAYLOAD_INVALID, "payloadFormatVersion");
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    return refuse(operation, SEALED_PAYLOAD_INVALID, "payloadKeyVersion");
  }
  if (ciphertext === "") return refuse(operation, SEALED_PAYLOAD_INVALID, "encryptedPayload");
  return null;
}

/** A `TEXT[]` column takes strings and nothing else. */
export function requireTextList<Value>(
  operation: string,
  field: string,
  values: readonly string[],
): Result<Value> | null {
  if (!Array.isArray(values)) return refuse(operation, TEXT_LIST_INVALID, field);
  for (const value of values) {
    if (typeof value !== "string" || value === "") {
      return refuse(operation, TEXT_LIST_INVALID, field);
    }
  }
  return null;
}

/** A monotonic counter, which may sit at zero and may never go below it. */
export function requireGeneration<Value>(
  operation: string,
  field: string,
  value: number,
): Result<Value> | null {
  return Number.isInteger(value) && value >= 0
    ? null
    : refuse(operation, GENERATION_NEGATIVE, `${field}=${String(value)}`);
}

/**
 * The channel-thread key, bounded here as `domain/thread-link.ts` bounds it.
 *
 * The column is unbounded `TEXT`, and the unique index over it is a btree: a key
 * longer than a third of a page is refused by the INDEX with an error naming
 * neither the column nor the value. The domain's own bound is stricter and
 * arrives with the field's name attached.
 */
export function requireThreadKey<Value>(operation: string, value: string): Result<Value> | null {
  if (value.trim() === "") return refuse(operation, THREAD_KEY_INVALID, "empty");
  if (value.length > MAX_THREAD_KEY_LENGTH) {
    return refuse(operation, THREAD_KEY_INVALID, `${String(value.length)} characters`);
  }
  return null;
}

/**
 * Run `work`, and turn a driver failure into a refusal.
 *
 * EVERY METHOD OF THIS PORT RETURNS `Result`, and the in-memory double's own
 * `failNext` seam exists because "a repository that cannot fail cannot prove
 * that a use case propagates a failure instead of swallowing it". This is the
 * one place that promise is kept against a real database, so no store method
 * has to remember to keep it.
 *
 * A `TransactionScopeError` is deliberately NOT caught. It means a write was
 * issued outside the unit of work, or inside the wrong one — a defect in the
 * composition, not an outcome a use case can handle — and swallowing it into a
 * `Result` would let a write that never ran look like a store that was busy.
 */
export async function guarded<Value>(
  operation: string,
  work: () => Promise<Result<Value>>,
): Promise<Result<Value>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionScopeError") throw error;
    return err(repositoryUnavailable(`${operation}:${driverCode(error)}`));
  }
}

/**
 * The driver's own code, so a refusal names the failure it came from.
 *
 * A CLIENT-SIDE VALIDATION ERROR CARRIES NO CODE, and falling back to the
 * literal `unknown` makes two very different failures — a constraint the
 * database refused and a value the client would not send — read identically.
 * The class NAME is the fallback instead, because it is the only thing that
 * separates them.
 */
function driverCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === "string") return code;
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "unknown";
}

/** The first refusal in `checks`, or `ok(value)` when every one of them passed. */
export function firstRefusal<Value>(
  value: Value,
  checks: readonly (Result<Value> | null)[],
): Result<Value> {
  for (const check of checks) {
    if (check !== null) return check;
  }
  return ok(value);
}
