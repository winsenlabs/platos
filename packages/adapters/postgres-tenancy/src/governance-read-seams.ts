// `governance`'s THREE inverted read seams, assembled — the counterpart of
// `governance-repository.ts` for the ports this context does NOT own the rows of.
//
// WHY IT IS A SECOND OBJECT AND NOT THREE MORE KEYS ON `GovernanceStores`.
// That object's header states what it is: "the five canonical stores", the ports
// `governance` is SOLE WRITER of, sharing one transaction so an erasure that
// touches two of them cannot half-apply. These three write nothing at all. They
// read `Thread`, `Turn`, `ToolCallAudit` and `AgentApproval`, which
// `scripts/arch/table-ownership.mjs` gives to `conversations`, `tools` and
// `jobs` — and `sole-writer.mjs` would refuse a write to any of them from this
// directory under the `governance` tag, correctly. Keeping them apart is what
// makes that distinction legible instead of only enforced: one object is the
// rows this context owns, the other is the questions it asks about rows it does
// not.
//
// THEY SHARE THE SAME `TenancyTransactions`, for the same reason the five do. A
// rating is written in the unit of work that read its turn back
// (`rate-turn.ts`), so the read must resolve through the caller's ambient frame
// rather than through a second pool — otherwise the read would not see the
// caller's own uncommitted writes and, worse, would hold a second connection
// open inside somebody else's transaction.
//
// THE SLOT NAMES ARE `GovernanceDependencies`' OWN — `ratingTargets`,
// `transcripts`, `activity`. Same rule as the five stores and tenancy's five:
// a composition root hands each port over under its own name, so a bundle
// assembled from this object's keys cannot put one port in another's slot.
// Here it matters more than usual, because `RatingTargetReader.find` and
// `TranscriptReader.read` have different names but the same SHAPE of first
// argument, and two readers over the same two tables transposed would answer
// plausible-looking values for ever.

import type {
  ActivityReader,
  RatingTargetReader,
  TranscriptReader,
} from "@platos/context-governance/application/ports/index.js";

import { createActivityReader } from "./governance-seam-activity.js";
import {
  createRatingTargetReader,
  createTranscriptReader,
} from "./governance-seam-conversations.js";
import type { TenancyTransactions } from "./transaction.js";

/** The three read seams, under the names the context's bundle uses. */
export interface GovernanceReadSeams {
  readonly ratingTargets: RatingTargetReader;
  readonly transcripts: TranscriptReader;
  readonly activity: ActivityReader;
}

export function createGovernanceReadSeams(transactions: TenancyTransactions): GovernanceReadSeams {
  return {
    ratingTargets: createRatingTargetReader(transactions),
    transcripts: createTranscriptReader(transactions),
    activity: createActivityReader(transactions),
  };
}
