import type { ErasureSubject } from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  CASCADE_NOTE,
  ChannelsErasureRejected,
  CHANNEL_APP_THREAD_MODEL,
  CHANNEL_EVENT_INBOX_MODEL,
  CHANNEL_THREAD_MODEL,
  createChannelsErasureTarget,
  INBOX_NOTE,
} from "./channels-erasure-target.js";
import { buildChannelsTestContext, testEnvironmentScope } from "./testing/index.js";

function subject(subjectKind: ErasureSubject["subjectKind"]): ErasureSubject {
  return { subjectKind, subjectId: asIdentifier("subject-1"), scope: testEnvironmentScope() };
}

describe("the channels erasure target", () => {
  it("names this context, so a plan says who is destroying what", async () => {
    const context = buildChannelsTestContext();
    expect(createChannelsErasureTarget(context.dependencies).targetName).toBe("channels");
  });

  it("reports the three subject-reachable models and no others", async () => {
    // The other three tables are ORGANIZATION configuration. Erasing an end
    // user must not delete their employer's Slack app.
    const context = buildChannelsTestContext();
    const plan = await createChannelsErasureTarget(context.dependencies).plan(subject("end-user"));

    expect(plan.items.map((item) => item.model)).toEqual([
      CHANNEL_THREAD_MODEL,
      CHANNEL_APP_THREAD_MODEL,
      CHANNEL_EVENT_INBOX_MODEL,
    ]);
  });

  it("reports zero rows, because no table this context owns is subject-keyed", async () => {
    const context = buildChannelsTestContext();
    const plan = await createChannelsErasureTarget(context.dependencies).plan(subject("end-user"));
    expect(plan.items.every((item) => item.rowCount === 0)).toBe(true);
  });

  it("explains the link tables as a cascade rather than an unexplained zero", async () => {
    const context = buildChannelsTestContext();
    const plan = await createChannelsErasureTarget(context.dependencies).plan(subject("end-user"));

    const links = plan.items.filter((item) => item.model !== CHANNEL_EVENT_INBOX_MODEL);
    expect(links.every((item) => item.blockedBy === CASCADE_NOTE)).toBe(true);
    expect(links.every((item) => item.method === "delete")).toBe(true);
  });

  it("names the inbox residual VISIBLY instead of omitting it", async () => {
    // The inbox holds an encrypted body that may mention the subject and has
    // no subject column at all. Reporting it as crypto-shred with a reason is
    // more honest than reporting nothing.
    const context = buildChannelsTestContext();
    const plan = await createChannelsErasureTarget(context.dependencies).plan(subject("end-user"));

    const inbox = plan.items.find((item) => item.model === CHANNEL_EVENT_INBOX_MODEL);
    expect(inbox?.method).toBe("crypto-shred");
    expect(inbox?.blockedBy).toBe(INBOX_NOTE);
  });

  it.each([["user"], ["end-user"], ["entity"]] as const)(
    "reports the same plan for a %s subject",
    async (subjectKind) => {
      const context = buildChannelsTestContext();
      const plan = await createChannelsErasureTarget(context.dependencies).plan(subject(subjectKind));
      expect(plan.items).toHaveLength(3);
      expect(plan.items.every((item) => item.rowCount === 0)).toBe(true);
    },
  );

  it("does not mutate when planning", async () => {
    const context = buildChannelsTestContext();
    await createChannelsErasureTarget(context.dependencies).plan(subject("end-user"));
    expect(context.repository.writes).toHaveLength(0);
    expect(context.unitOfWork.transactions).toHaveLength(0);
  });

  it("produces a receipt stamped from the injected clock", async () => {
    const context = buildChannelsTestContext();
    const target = createChannelsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("end-user"));

    context.clock.advanceSeconds(60);
    const receipt = await target.erase(plan, { transactionId: asIdentifier("txn-1") });

    expect(receipt.targetName).toBe("channels");
    expect(receipt.erasedAt).toEqual(new Date("2026-01-01T00:01:00.000Z"));
    expect(receipt.items).toEqual(plan.items);
  });

  it("destroys nothing, because it owns no subject-selectable row", async () => {
    const context = buildChannelsTestContext();
    const target = createChannelsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("end-user"));

    await target.erase(plan, { transactionId: asIdentifier("txn-1") });
    expect(context.repository.writes).toHaveLength(0);
  });

  it("REFUSES a plan minted by another target, rather than substituting its own", async () => {
    // The earlier behaviour returned a receipt naming this target and its own
    // three models. It destroyed nothing — so the DATA was safe — but the
    // receipt is the artefact an auditor reads, and it recorded work under a
    // plan nobody reviewed while hiding the caller bug that produced it.
    const context = buildChannelsTestContext();
    const target = createChannelsErasureTarget(context.dependencies);

    const rejected = await target
      .erase(
        { targetName: "files", items: [{ model: "Artifact", method: "delete", rowCount: 9, blockedBy: null }] },
        { transactionId: asIdentifier("txn-1") },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejected).toBeInstanceOf(ChannelsErasureRejected);
    expect((rejected as ChannelsErasureRejected).domainError.code).toBe("CHANNELS_ERASURE_PLAN_FOREIGN");
    // Named, so the refusal says WHOSE plan arrived rather than only that one did.
    expect((rejected as ChannelsErasureRejected).domainError.details.targetName).toBe("files");
    expect(context.repository.writes).toHaveLength(0);
  });

  it("carries out a plan it minted itself — the control for the refusal above", async () => {
    // Without this, a target that threw at every plan would satisfy the case
    // above for the wrong reason.
    const context = buildChannelsTestContext();
    const target = createChannelsErasureTarget(context.dependencies);
    const plan = await target.plan(subject("end-user"));

    const receipt = await target.erase(plan, { transactionId: asIdentifier("txn-1") });
    expect(receipt.targetName).toBe("channels");
    expect(receipt.items).toEqual(plan.items);
  });
});
