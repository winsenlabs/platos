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
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

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

    // No rows to destroy and nothing to refuse: this target owns no
    // subject-selectable row, so it cannot be handed a foreign plan it would
    // act on incorrectly. It reports what it holds and destroys nothing.
    erase: async (plan: ErasurePlan, _transaction: TransactionScope): Promise<ErasureReceipt> => ({
      targetName: CHANNELS_ERASURE_TARGET_NAME,
      erasedAt: dependencies.clock.now(),
      items: plan.targetName === CHANNELS_ERASURE_TARGET_NAME ? plan.items : planFor(),
    }),
  };
}
