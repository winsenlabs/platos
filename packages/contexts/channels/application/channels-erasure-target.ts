// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is SOLE WRITER of, and the composition
// root injects the array.
//
// THIS TARGET REPORTS A ZERO-ROW PLAN, AND THAT IS THE HONEST ANSWER — not a
// stub, and not an oversight. It was established against the baseline schema,
// column by column, and it is the finding this file exists to record.
//
// NONE of the six tables `channels` is sole writer of carries a subject column:
//
//   ChannelConnection   environmentId, entityId, provider, credentialId …
//   ChannelApp          environmentId, provider, clientId, scopes …
//   ChannelInstallation appId, externalInstallationId, status, credentialId …
//   ChannelThread       connectionId, threadId, channelThreadKey
//   ChannelAppThread    installationId, threadId, channelThreadKey
//   ChannelEventInbox   appId, eventId, encryptedPayload, status …
//
// The first three are ORGANIZATION CONFIGURATION. Erasing an end user must not
// delete their employer's Slack app; a target that "helpfully" did so would take
// down every other user of that workspace.
//
// The two link tables are keyed by `threadId`, and `Thread` — which does carry
// `endUserId` — belongs to `conversations`. Both links declare
// `onDelete: Cascade` on that relation, so when `conversations` erases the
// subject's threads these rows go with them, atomically, in the same
// transaction. Duplicating that here would mean this context reaching for a
// subject it cannot see, through a join it has no DAG edge to make.
//
// `ChannelEventInbox` holds an ENCRYPTED provider payload that may mention the
// subject. It is keyed by app and provider event id with no subject column, so
// it cannot be selected by subject at all. It is reported as `crypto-shred`
// with a zero count and `blockedBy` naming the reason, so the gap is VISIBLE in
// every plan an operator inspects rather than silently absent — reporting a
// zero-row plan is more honest than omitting the target from the operation, and
// naming an unreachable row is more honest than reporting nothing at all.

import type {
  DomainError,
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { erasurePlanForeign } from "../domain/index.js";
import type { ChannelsDependencies } from "./dependencies.js";

export const CHANNELS_ERASURE_TARGET_NAME = "channels";

export const CHANNEL_THREAD_MODEL = "ChannelThread";
export const CHANNEL_APP_THREAD_MODEL = "ChannelAppThread";
export const CHANNEL_EVENT_INBOX_MODEL = "ChannelEventInbox";

/**
 * Why the link tables need nothing done to them here. Recorded on the plan so
 * an auditor reading a receipt sees the mechanism, not an unexplained zero.
 */
export const CASCADE_NOTE = "cascades from conversations.Thread (onDelete: Cascade)";

/**
 * Why the inbox cannot be selected by subject. Recorded as `blockedBy` so the
 * residual is visible in every plan rather than discovered during an audit.
 */
export const INBOX_NOTE = "no subject column; keyed by [appId, eventId]";

/**
 * The refusal, carried out of a port that is not `Result`-shaped.
 *
 * `ErasureTarget.erase` returns a bare `ErasureReceipt`, so a refusal cannot be
 * a value here the way it is everywhere else in this context. It is a THROW
 * carrying the domain error, which is the shape `files` already gives the same
 * problem on the same port — and it is the right failure mode besides: `erase`
 * runs inside the caller's transaction, so throwing aborts a multi-context
 * erasure rather than half-completing one.
 */
export class ChannelsErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "ChannelsErasureRejected";
    this.domainError = error;
  }
}

function refuse(error: DomainError): never {
  throw new ChannelsErasureRejected(error);
}

function item(model: string, method: ErasurePlanItem["method"], blockedBy: string): ErasurePlanItem {
  return { model, method, rowCount: 0, blockedBy };
}

/**
 * The same three items for every subject kind.
 *
 * Deliberately not branched on `subjectKind`: the answer does not depend on it,
 * and a branch would imply this context holds something for one kind and not
 * another, which would be false.
 */
function planFor(): readonly ErasurePlanItem[] {
  return [
    item(CHANNEL_THREAD_MODEL, "delete", CASCADE_NOTE),
    item(CHANNEL_APP_THREAD_MODEL, "delete", CASCADE_NOTE),
    item(CHANNEL_EVENT_INBOX_MODEL, "crypto-shred", INBOX_NOTE),
  ];
}

type Dependencies = Pick<ChannelsDependencies, "clock">;

export function createChannelsErasureTarget(dependencies: Dependencies): ErasureTarget {
  return {
    targetName: CHANNELS_ERASURE_TARGET_NAME,

    plan: async (_subject: ErasureSubject): Promise<ErasurePlan> => ({
      targetName: CHANNELS_ERASURE_TARGET_NAME,
      items: planFor(),
    }),

    /**
     * A FOREIGN PLAN IS REFUSED, NOT QUIETLY REPLACED.
     *
     * The kernel's `ErasurePlan` carries a target name and items and NOTHING
     * about whose data it describes, so a target handed a plan it did not mint
     * cannot know what it is being asked to destroy. `erasurePlanForeign`'s own
     * note says refusing is the only safe answer, and until WIN-256 it had ZERO
     * producers: this method substituted `planFor()` for the foreign items and
     * returned a receipt as if the plan had been carried out. That receipt is
     * the artefact an auditor reads. It said "channels erased these three
     * models" under a plan nobody reviewed, and it made a caller bug — handing
     * target A the plan of target B — invisible at exactly the moment it
     * matters. `CHANNELS_ERROR_CODES` published the code for a refusal this
     * context could not emit.
     *
     * DESTROYING NOTHING IS NOT A REASON TO ACCEPT ANYTHING. This target owns no
     * subject-selectable row, so the substitution was harmless to DATA; it was
     * never harmless to the record.
     */
    erase: async (plan: ErasurePlan, _transaction: TransactionScope): Promise<ErasureReceipt> => {
      if (plan.targetName !== CHANNELS_ERASURE_TARGET_NAME) refuse(erasurePlanForeign(plan.targetName));
      return {
        targetName: CHANNELS_ERASURE_TARGET_NAME,
        erasedAt: dependencies.clock.now(),
        items: plan.items,
      };
    },
  };
}
