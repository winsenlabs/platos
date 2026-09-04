// What a cap is aimed at, and the one column the store packs it into.
//
// `Budget` has ONE `scope String` column and seven facts to keep in it. The
// extraction source JSON-encodes them together: which kind of subject the cap
// governs, which subject, which spend tier, which skill, two legacy alert
// recipients, and who authorised the current override. That encoding is
// transcribed here, in the domain, and NOT left to an adapter — for one reason.
//
// THE DECODE HAS A FALLBACK, AND THE FALLBACK IS A DOMAIN DECISION. A row whose
// `scope` column is not JSON is read as an environment-wide `llm` cap with no
// target. That is not error handling: it is the statement that a `Budget` row
// written by something other than this encoder — a migration, an operator's SQL,
// an older release — still governs the whole environment rather than governing
// nothing. Put in an adapter, that rule would be invisible and each adapter
// would be free to choose differently; the difference between "caps everything"
// and "caps nothing" is not a serialisation detail.
//
// The two legacy recipient fields are carried but never READ by this context.
// `AlertDelivery` rows are the canonical recipient set (that is what the durable
// delivery ledger is FOR), and the source's own note on the wire payload says as
// much. They survive here so a round-trip through this context does not silently
// erase a column an older surface still renders.

import { asCostIdentifier, type ActorId, type AgentId, type SkillSlug } from "./identifiers.js";

/** Which kind of subject a cap governs. */
export const BUDGET_SUBJECTS = ["scope", "agent", "user"] as const;

export type BudgetSubject = (typeof BUDGET_SUBJECTS)[number];

export function isBudgetSubject(value: string): value is BudgetSubject {
  return (BUDGET_SUBJECTS as readonly string[]).includes(value);
}

/**
 * Which spend bucket a cap governs.
 *
 *   `llm`   model inference. The default, and what every pre-tier row is.
 *   `skill` skill-tool dispatches, counted on their own keys.
 *
 * A caller asking about one tier is never blocked by the other's cap. That
 * separation is the whole point: a skill budget that could stop a conversation
 * would be a conversation budget wearing a different name.
 */
export const BUDGET_TIERS = ["llm", "skill"] as const;

export type BudgetTier = (typeof BUDGET_TIERS)[number];

export function isBudgetTier(value: string): value is BudgetTier {
  return (BUDGET_TIERS as readonly string[]).includes(value);
}

/**
 * The sentinel that turns a per-user cap into a DEFAULT per-user cap.
 *
 * `targetId = "*"` on a `user` cap means "this allowance applies to every end
 * user, independently". Each user's spend is read from their own bucket, so one
 * user cannot exhaust another's allowance. It is the only way an operator can
 * say "everyone gets at most $X a day" without knowing the user ids in advance,
 * and it is meaningless on any other subject — a wildcard agent cap would match
 * no agent and cap nothing at all.
 */
export const EVERY_USER = "*";

/** Everything the `scope` column carries, decoded. */
export interface BudgetTarget {
  readonly subject: BudgetSubject;
  /** Empty for an environment-wide cap; `*` for the default-per-user cap. */
  readonly targetId: string;
  readonly tier: BudgetTier;
  readonly skillSlug: SkillSlug | null;
  readonly agentId: AgentId | null;
  /** Carried for round-trip fidelity. Never read: `AlertDelivery` is canonical. */
  readonly legacyWebhookUrl: string | null;
  /** Carried for round-trip fidelity. Never read: `AlertDelivery` is canonical. */
  readonly legacyEmails: string | null;
  /** Who authorised the override currently in force, or null. */
  readonly overrideBy: ActorId | null;
}

/** What an unreadable `scope` column means: the whole environment, `llm` tier. */
export const ENVIRONMENT_WIDE: BudgetTarget = Object.freeze({
  subject: "scope",
  targetId: "",
  tier: "llm",
  skillSlug: null,
  agentId: null,
  legacyWebhookUrl: null,
  legacyEmails: null,
  overrideBy: null,
});

interface EncodedTarget {
  readonly scopeType: string;
  readonly targetId: string;
  readonly tier: string;
  readonly skillSlug: string | null;
  readonly alertWebhookUrl: string | null;
  readonly alertEmails: string | null;
  readonly overrideBy: string | null;
}

/**
 * Encode a target into the `scope` column.
 *
 * The field names are the SOURCE's, not this context's. Renaming them would
 * orphan every row already written, and the column is not versioned.
 */
export function encodeBudgetTarget(target: BudgetTarget): string {
  const encoded: EncodedTarget = {
    scopeType: target.subject,
    targetId: target.targetId,
    tier: target.tier,
    skillSlug: target.skillSlug,
    alertWebhookUrl: target.legacyWebhookUrl,
    alertEmails: target.legacyEmails,
    overrideBy: target.overrideBy,
  };
  return JSON.stringify(encoded);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Decode the `scope` column. Total: every input produces a target.
 *
 * `agentId` is NOT in the column — it is its own indexed foreign key on the row —
 * so it is a separate parameter rather than something this function could invent.
 */
export function decodeBudgetTarget(encoded: string, agentId: AgentId | null = null): BudgetTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return { ...ENVIRONMENT_WIDE, agentId };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...ENVIRONMENT_WIDE, agentId };
  const fields = parsed as Partial<EncodedTarget>;
  const subject = typeof fields.scopeType === "string" ? fields.scopeType : "";
  if (!isBudgetSubject(subject)) return { ...ENVIRONMENT_WIDE, agentId };
  const skillSlug = text(fields.skillSlug);
  const overrideBy = text(fields.overrideBy);
  return {
    subject,
    targetId: typeof fields.targetId === "string" ? fields.targetId : "",
    // Anything that is not the literal `skill` is `llm`. The source's own
    // ternary, kept: an unrecognised tier must fall to the tier every legacy row
    // already has, or a migration typo would silently stop enforcing.
    tier: fields.tier === "skill" ? "skill" : "llm",
    skillSlug: skillSlug === null ? null : asCostIdentifier<SkillSlug>(skillSlug),
    agentId,
    legacyWebhookUrl: text(fields.alertWebhookUrl),
    legacyEmails: text(fields.alertEmails),
    overrideBy: overrideBy === null ? null : asCostIdentifier<ActorId>(overrideBy),
  };
}

/**
 * The tuple two caps must NOT share.
 *
 * The store has no unique index over it — the source resolves collisions by
 * reading the environment's caps and matching in memory — so this is the only
 * definition of "the same cap". All six dimensions are in it. Leaving tier,
 * skill or agent out is the defect the source records against itself: an `llm`
 * environment-wide cap and a `skill` environment-wide cap at the same period
 * aliased onto one row, and the second write silently replaced the first.
 */
export function collisionKey(target: BudgetTarget, period: string): string {
  return [
    target.subject,
    target.targetId,
    period,
    target.tier,
    target.skillSlug ?? "",
    target.agentId ?? "",
  ].join("|");
}

/** A human label for a cap, for an operator reading why they were stopped. */
export function describeTarget(target: BudgetTarget): string {
  if (target.subject === "agent") return `Agent: ${target.targetId}`;
  if (target.subject === "user") {
    return target.targetId === EVERY_USER ? "Every user" : `User: ${target.targetId}`;
  }
  return "Scope-wide";
}
