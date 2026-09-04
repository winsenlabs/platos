import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentId } from "@platos/kernel";

import {
  admitAlertChannel,
  admitAlertChannelPatch,
  admitConfiguration,
  applyChannelPatch,
  budgetRecipients,
  isChannelKind,
  isEmptyPatch,
  retireChannel,
  type AlertChannel,
  type AlertChannelIntake,
} from "./alert-channel.js";
import { BUDGET_TOPIC, MAX_TOPICS, admitTopics, wantsBudgetAlerts } from "./alert-topic.js";
import { asCostIdentifier, type AlertChannelId, type DeduplicationKey } from "./identifiers.js";

const AT = new Date("2026-01-15T12:00:00.000Z");

function channel(overrides: Partial<AlertChannel> = {}): AlertChannel {
  return {
    channelId: asCostIdentifier<AlertChannelId>("channel-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    kind: "EMAIL",
    name: "ops mailbox",
    enabled: true,
    topics: [BUDGET_TOPIC],
    deduplicationKey: null,
    operatorSuppliedKey: false,
    configuration: { kind: "EMAIL", email: "ops@example.test" },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function intake(overrides: Partial<AlertChannelIntake> = {}): AlertChannelIntake {
  return {
    kind: "EMAIL",
    name: "ops mailbox",
    topics: [BUDGET_TOPIC],
    configuration: { email: "ops@example.test" },
    ...overrides,
  };
}

describe("topics", () => {
  it("recognises the ONE topic this context interprets", () => {
    expect(wantsBudgetAlerts([BUDGET_TOPIC])).toBe(true);
    expect(wantsBudgetAlerts(["SOMETHING_ELSE"])).toBe(false);
  });

  it("carries another boundary's topics through untouched", () => {
    // Copying the runtime's vocabulary here would make this context the place a
    // new runtime event has to be registered — a coupling with no benefit on a
    // context whose allow-list is tenancy, providers and the kernel.
    const admitted = admitTopics(["SOMETHING_ELSE", BUDGET_TOPIC]);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual(["BUDGET", "SOMETHING_ELSE"]);
  });

  it("deduplicates and sorts, so two orderings are one subscription", () => {
    const admitted = admitTopics([BUDGET_TOPIC, BUDGET_TOPIC]);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toEqual([BUDGET_TOPIC]);
  });

  it("refuses an empty subscription, which would never fire", () => {
    expect(admitTopics([]).ok).toBe(false);
  });

  it("refuses a malformed token, so a typo cannot subscribe to nothing", () => {
    for (const topic of ["budget", "BUDGET-ALERT", " ", "1BUDGET", "BUDGET__X"]) {
      expect(admitTopics([topic]).ok).toBe(false);
    }
  });

  it("refuses an unbounded list", () => {
    const many = Array.from({ length: MAX_TOPICS + 1 }, (_, index) => `TOPIC_${index}`);
    expect(admitTopics(many).ok).toBe(false);
  });
});

describe("admitting a configuration", () => {
  it("accepts an address containing an at-sign and nothing stricter", () => {
    // A stricter grammar rejects addresses that are legal and deliverable; the
    // authority on whether one works is the delivery result the ledger records.
    expect(admitConfiguration("EMAIL", { email: "a+b@sub.example.test" }).ok).toBe(true);
    expect(admitConfiguration("EMAIL", { email: "not-an-address" }).ok).toBe(false);
    expect(admitConfiguration("EMAIL", { email: "  " }).ok).toBe(false);
  });

  it("requires both a chat channel id and its display name", () => {
    expect(admitConfiguration("SLACK", { channelId: "C1", channelName: "#ops" }).ok).toBe(true);
    expect(admitConfiguration("SLACK", { channelId: "C1" }).ok).toBe(false);
  });

  it("REQUIRES a signing secret on a webhook — an unsigned one is forgeable", () => {
    expect(admitConfiguration("WEBHOOK", { url: "https://x.example.test" }).ok).toBe(false);
    const signed = admitConfiguration("WEBHOOK", {
      url: "https://x.example.test",
      credential: "cred-1",
    });
    expect(signed.ok).toBe(true);
  });

  it("does NOT resolve the destination, which is a network fact and not a string one", () => {
    // A name that resolves publicly at configuration time and privately at send
    // time is the attack the adapter's re-check exists for. The domain judges
    // the string; only the adapter can judge the resolution, at the moment it
    // dials.
    expect(
      admitConfiguration("WEBHOOK", { url: "http://169.254.169.254/latest", credential: "c" }).ok,
    ).toBe(true);
  });

  it("treats a blank chat token and integration id as absent", () => {
    const admitted = admitConfiguration("SLACK", {
      channelId: "C1",
      channelName: "#ops",
      credential: "  ",
      integrationId: "",
    });
    if (!admitted.ok || admitted.value.kind !== "SLACK") throw new Error("unreachable");
    expect(admitted.value.credential).toBeNull();
    expect(admitted.value.integrationId).toBeNull();
  });
});

describe("admitting a channel", () => {
  it("admits an ordinary email channel", () => {
    const admitted = admitAlertChannel(intake());
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.name).toBe("ops mailbox");
    expect(admitted.value.deduplicationKey).toBeNull();
    expect(admitted.value.operatorSuppliedKey).toBe(false);
  });

  it("marks an operator-supplied deduplication key as such", () => {
    const admitted = admitAlertChannel(intake({ deduplicationKey: "nightly-ops" }));
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.deduplicationKey).toBe("nightly-ops");
    expect(admitted.value.operatorSuppliedKey).toBe(true);
  });

  it("refuses a blank supplied key rather than storing it as absent", () => {
    expect(admitAlertChannel(intake({ deduplicationKey: "   " })).ok).toBe(false);
  });

  it("refuses an unknown kind, a blank name and an empty subscription", () => {
    expect(admitAlertChannel(intake({ kind: "PIGEON" })).ok).toBe(false);
    expect(admitAlertChannel(intake({ name: "  " })).ok).toBe(false);
    expect(admitAlertChannel(intake({ topics: [] })).ok).toBe(false);
  });

  it("recognises exactly the three kinds the store holds", () => {
    expect(["EMAIL", "SLACK", "WEBHOOK"].every(isChannelKind)).toBe(true);
    expect(isChannelKind("PIGEON")).toBe(false);
  });
});

describe("patching a channel", () => {
  it("has NO kind field at all", () => {
    // The store keys the configuration on [channelId, environmentId, type], so a
    // kind change orphans the configuration row rather than converting it. The
    // source says so in prose on the surface; here it is in the type.
    const admitted = admitAlertChannelPatch("EMAIL", { name: "renamed" });
    if (!admitted.ok) throw new Error("unreachable");
    expect(Object.keys(admitted.value).sort()).toEqual([
      "configuration",
      "enabled",
      "name",
      "topics",
    ]);
  });

  it("validates the configuration against the STORED kind", () => {
    expect(admitAlertChannelPatch("WEBHOOK", { configuration: { email: "a@b.test" } }).ok).toBe(false);
    expect(
      admitAlertChannelPatch("WEBHOOK", {
        configuration: { url: "https://x.example.test", credential: "c" },
      }).ok,
    ).toBe(true);
  });

  it("recognises a patch that changes nothing", () => {
    const admitted = admitAlertChannelPatch("EMAIL", {});
    if (!admitted.ok) throw new Error("unreachable");
    expect(isEmptyPatch(admitted.value)).toBe(true);
  });

  it("applies only the fields that were supplied", () => {
    const admitted = admitAlertChannelPatch("EMAIL", { enabled: false });
    if (!admitted.ok) throw new Error("unreachable");
    const patched = applyChannelPatch(channel(), admitted.value, AT);
    expect(patched.enabled).toBe(false);
    expect(patched.name).toBe("ops mailbox");
    expect(patched.topics).toEqual([BUDGET_TOPIC]);
  });
});

describe("retiring a channel", () => {
  it("RELEASES the deduplication key", () => {
    // The unique index counts deleted rows, so a retired channel would hold its
    // operator-chosen key hostage forever and a rebuild under the same name
    // would be refused.
    const live = channel({
      deduplicationKey: asCostIdentifier<DeduplicationKey>("nightly-ops"),
      operatorSuppliedKey: true,
    });
    const retired = retireChannel(live, AT);
    expect(retired.deduplicationKey).toBeNull();
    expect(retired.operatorSuppliedKey).toBe(false);
    expect(retired.enabled).toBe(false);
  });

  it("keeps the row, so the delivery ledger pointing at it stays readable", () => {
    expect(retireChannel(channel(), AT).channelId).toBe("channel-1");
    expect(retireChannel(channel(), AT).name).toBe("ops mailbox");
  });
});

describe("choosing budget recipients", () => {
  it("keeps only channels that are switched on AND subscribed", () => {
    const pool = [
      channel({ channelId: asCostIdentifier<AlertChannelId>("wanted") }),
      channel({ channelId: asCostIdentifier<AlertChannelId>("off"), enabled: false }),
      channel({ channelId: asCostIdentifier<AlertChannelId>("other"), topics: ["OTHER_TOPIC"] }),
    ];
    expect(budgetRecipients(pool).map((row) => row.channelId)).toEqual(["wanted"]);
  });
});
