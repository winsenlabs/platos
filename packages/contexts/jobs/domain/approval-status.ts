// The approval status vocabulary, and the one pair that does not match by name.
//
// The persisted `ApprovalStatus` enum and the status a caller sees are different
// vocabularies, and three of the four pairs are the same word in a different
// case. The fourth is not:
//
//     pending    <-> PENDING
//     approved   <-> APPROVED
//     rejected   <-> REJECTED
//     timed_out  <-> EXPIRED        <- the one that does not match by name
//
// An extraction that mapped by upper-casing would be right three times out of
// four and would silently turn every timed-out approval into an unknown status.
// The mapping is therefore a total, explicit table in one direction and its
// inverse in the other, and a test asserts they compose to the identity.
//
// THE LIVE `publicStatus` HAS A LOSSY DEFAULT: its `switch` returns `"pending"`
// for anything that is not one of the three named values. That is safe for the
// four-member enum it reads, but it means an unrecognised value would be reported
// as pending — a decision waiting on a human that no human will ever see. Here
// the parse is total and returns `null` for an unknown value, so an adapter must
// decide what to do rather than inherit a default that hides the row.

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "timed_out"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A decision a human can record. `pending` is the absence of one. */
export type ApprovalDecision = Exclude<ApprovalStatus, "pending">;

export const STORED_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;

export type StoredApprovalStatus = (typeof STORED_APPROVAL_STATUSES)[number];

const TO_STORED: Readonly<Record<ApprovalStatus, StoredApprovalStatus>> = Object.freeze({
  pending: "PENDING",
  approved: "APPROVED",
  rejected: "REJECTED",
  timed_out: "EXPIRED",
});

const FROM_STORED: Readonly<Record<StoredApprovalStatus, ApprovalStatus>> = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "timed_out",
});

export function toStoredStatus(status: ApprovalStatus): StoredApprovalStatus {
  return TO_STORED[status];
}

/** Total: an unrecognised value yields `null` rather than a default. */
export function fromStoredStatus(value: string): ApprovalStatus | null {
  return Object.prototype.hasOwnProperty.call(FROM_STORED, value)
    ? FROM_STORED[value as StoredApprovalStatus]
    : null;
}

export function isDecision(status: ApprovalStatus): status is ApprovalDecision {
  return status !== "pending";
}

/**
 * What asked for the approval. Free-form on the wire (the live column stores it
 * inside JSON and the read path types it `ApprovalSource | string`), so this list
 * is the KNOWN set rather than a closed one, and an unknown source is carried
 * through rather than refused.
 */
export const APPROVAL_SOURCES = ["request_approval", "cancel_run", "mcp_tool_call"] as const;

export type KnownApprovalSource = (typeof APPROVAL_SOURCES)[number];

export type ApprovalSource = KnownApprovalSource | (string & {});

export function isKnownSource(value: string): value is KnownApprovalSource {
  return (APPROVAL_SOURCES as readonly string[]).includes(value);
}
