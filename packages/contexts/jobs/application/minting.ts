// Turning a kernel-minted identifier into one of this context's branded ids.
//
// `IdGenerator` returns a `Uuid`; a `Job` needs a `JobId`. Both are branded
// strings, so the conversion is a re-brand and `asIdentifier` is the kernel's
// sanctioned way to perform one. Collecting the three conversions here keeps
// `asIdentifier` out of the use cases, where a reader would have to check each
// occurrence to see whether it was re-branding a freshly minted id (fine) or
// laundering an untrusted string (not fine).

import { asIdentifier, type Ulid, type Uuid } from "@platos/kernel";

import type { ApprovalId, ApprovalRowId, JobId } from "../domain/index.js";

export function asJobId(value: Uuid): JobId {
  return asIdentifier<JobId>(value);
}

export function asApprovalRowId(value: Uuid): ApprovalRowId {
  return asIdentifier<ApprovalRowId>(value);
}

/**
 * The business id a waiting caller keys its resume channel by.
 *
 * ULID rather than UUID: it is what the caller sees, it sorts by mint time, and
 * the live MCP path already mints a sortable-by-construction value
 * (`appr_mcp_<random>`) for the same role.
 */
export function asApprovalId(value: Ulid): ApprovalId {
  return asIdentifier<ApprovalId>(value);
}
