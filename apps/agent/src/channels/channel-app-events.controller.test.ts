import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { ChannelAppEventsController } from "./channel-app-events.controller";
import { ChannelDeliveryError } from "./channel-runtime.service";

type Row = {
  id: string;
  appId: string;
  externalInstallationId: string;
  status: string;
  revokedAt: Date | null;
};

function makePersistenceShim(rows: Row[]) {
  const externalId = (
    teamId: string | null,
    enterpriseId: string | null,
    enterpriseInstall = false
  ) =>
    enterpriseInstall || (!teamId && enterpriseId)
      ? enterpriseId
        ? `slack:enterprise:${enterpriseId}`
        : null
      : teamId
      ? `slack:team:${teamId}`
      : null;
  return {
    findActiveInstallation: async (
      appId: string,
      teamId: string | null,
      enterpriseId: string | null
    ) => {
      const exact = externalId(teamId, enterpriseId);
      const hit = rows.find(
        (row) =>
          row.appId === appId && row.externalInstallationId === exact && row.status === "active"
      );
      if (hit) return hit;
      if (teamId && enterpriseId) {
        return (
          rows.find(
            (row) =>
              row.appId === appId &&
              row.externalInstallationId === externalId(null, enterpriseId, true) &&
              row.status === "active"
          ) ?? null
        );
      }
      return null;
    },
    revokeInstallations: async (
      appId: string,
      teamId: string | null,
      enterpriseId: string | null
    ) => {
      const revoke = (key: string | null) => {
        let count = 0;
        for (const row of rows) {
          if (
            row.appId === appId &&
            row.externalInstallationId === key &&
            row.status === "active"
          ) {
            row.status = "revoked";
            row.revokedAt = new Date();
            count++;
          }
        }
        return count;
      };
      let count = revoke(externalId(teamId, enterpriseId));
      if (count === 0 && teamId && enterpriseId) {
        count = revoke(externalId(null, enterpriseId, true));
      }
      return count;
    },
  };
}

function makeController(persistence: ReturnType<typeof makePersistenceShim>) {
  return new ChannelAppEventsController(persistence as any, {} as any) as any;
}

const APP = "00000000-0000-0000-0000-000000000001";

const orgInstallRow = (): Row => ({
  id: "00000000-0000-0000-0000-000000000002",
  appId: APP,
  externalInstallationId: "slack:enterprise:E1",
  status: "active",
  revokedAt: null,
});

const workspaceRow = (): Row => ({
  id: "00000000-0000-0000-0000-000000000003",
  appId: APP,
  externalInstallationId: "slack:team:T123",
  status: "active",
  revokedAt: null,
});

describe("ChannelAppEventsController — Grid org-install routing", () => {
  let rows: Row[];

  describe("findActiveInstallation", () => {
    it("falls back to the enterprise installation for a Grid envelope", async () => {
      rows = [orgInstallRow()];
      const found = await makeController(makePersistenceShim(rows)).findActiveInstallation(
        APP,
        "T123",
        "E1"
      );
      expect(found?.id).toBe("00000000-0000-0000-0000-000000000002");
    });

    it("prefers an exact workspace installation", async () => {
      rows = [orgInstallRow(), workspaceRow()];
      const found = await makeController(makePersistenceShim(rows)).findActiveInstallation(
        APP,
        "T123",
        "E1"
      );
      expect(found?.id).toBe("00000000-0000-0000-0000-000000000003");
    });

    it("does not fall back outside a Grid", async () => {
      rows = [orgInstallRow()];
      const found = await makeController(makePersistenceShim(rows)).findActiveInstallation(
        APP,
        "T999",
        null
      );
      expect(found).toBeNull();
    });

    it("never resurrects a revoked enterprise installation", async () => {
      const revoked = orgInstallRow();
      revoked.status = "revoked";
      rows = [revoked];
      const found = await makeController(makePersistenceShim(rows)).findActiveInstallation(
        APP,
        "T123",
        "E1"
      );
      expect(found).toBeNull();
    });
  });

  describe("revokeInstallations", () => {
    it("revokes the enterprise installation when the envelope carries a workspace team", async () => {
      rows = [orgInstallRow()];
      await makeController(makePersistenceShim(rows)).revokeInstallations(APP, "T123", "E1");
      expect(rows[0].status).toBe("revoked");
      expect(rows[0].revokedAt).toBeInstanceOf(Date);
    });

    it("only touches the exact workspace installation when it matches", async () => {
      rows = [orgInstallRow(), workspaceRow()];
      await makeController(makePersistenceShim(rows)).revokeInstallations(APP, "T123", "E1");
      expect(rows[1].status).toBe("revoked");
      expect(rows[0].status).toBe("active");
    });

    it("is idempotent", async () => {
      rows = [orgInstallRow()];
      const controller = makeController(makePersistenceShim(rows));
      await controller.revokeInstallations(APP, "T123", "E1");
      const firstRevokedAt = rows[0].revokedAt;
      await controller.revokeInstallations(APP, "T123", "E1");
      expect(rows[0].revokedAt).toBe(firstRevokedAt);
    });
  });

  describe("Slack request verification", () => {
    it("verifies the exact raw body and rejects a modified body", () => {
      const controller = makeController(makePersistenceShim([]));
      const timestamp = String(Math.floor(Date.now() / 1000));
      const rawBody = Buffer.from('{"type":"event_callback","event_id":"E1"}');
      const secret = "signing-secret";
      const signature = `v0=${crypto
        .createHmac("sha256", secret)
        .update(`v0:${timestamp}:`)
        .update(rawBody)
        .digest("hex")}`;

      expect(controller.verifySlackSignature(secret, rawBody, timestamp, signature)).toBe(true);
      expect(
        controller.verifySlackSignature(
          secret,
          Buffer.from(`${rawBody.toString("utf8")} `),
          timestamp,
          signature
        )
      ).toBe(false);
    });

    it("rejects signatures outside Slack's five-minute replay window", () => {
      const controller = makeController(makePersistenceShim([]));
      const timestamp = String(Math.floor(Date.now() / 1000) - 301);
      const rawBody = Buffer.from("{}");
      const secret = "signing-secret";
      const signature = `v0=${crypto
        .createHmac("sha256", secret)
        .update(`v0:${timestamp}:`)
        .update(rawBody)
        .digest("hex")}`;

      expect(controller.verifySlackSignature(secret, rawBody, timestamp, signature)).toBe(false);
    });
  });
});

describe("ChannelAppEventsController — durable inbox", () => {
  function signedRequest(envelope: unknown, retry = false) {
    const rawBody = Buffer.from(JSON.stringify(envelope));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${crypto
      .createHmac("sha256", "signing-secret")
      .update(`v0:${timestamp}:`)
      .update(rawBody)
      .digest("hex")}`;
    return {
      rawBody,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
        ...(retry ? { "x-slack-retry-num": "1" } : {}),
      },
    } as any;
  }

  function responseShim() {
    const response: any = {
      statusCode: 0,
      body: null,
      headers: {},
      status: vi.fn((code: number) => {
        response.statusCode = code;
        return response;
      }),
      json: vi.fn((body: unknown) => {
        response.body = body;
        return response;
      }),
      setHeader: vi.fn((name: string, value: string) => {
        response.headers[name] = value;
      }),
    };
    return response;
  }

  const envelope = {
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T1",
    event: { type: "app_mention", user: "U1", text: "sensitive text" },
  };

  it("does not ACK until the verified envelope is durably inserted", async () => {
    let resolveInsert!: (row: any) => void;
    const enqueue = vi.fn(
      () => new Promise((resolve) => (resolveInsert = resolve)),
    );
    const persistence = {
      loadApp: vi.fn().mockResolvedValue({ id: APP, signingSecret: "signing-secret" }),
      enqueueChannelEvent: enqueue,
    };
    const controller = new ChannelAppEventsController(persistence as any, {} as any);
    const response = responseShim();
    const pending = controller.events(signedRequest(envelope), response, APP);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());

    expect(response.json).not.toHaveBeenCalled();
    resolveInsert({ id: "inbox-1", status: "COMPLETED" });
    await pending;

    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(APP, "Ev1", envelope);
    expect(JSON.stringify(enqueue.mock.calls[0])).not.toContain("x-slack-signature");
  });

  it("returns retryable 503 instead of ACK when durable admission fails", async () => {
    const runtime = { handleAppEvent: vi.fn() };
    const persistence = {
      loadApp: vi.fn().mockResolvedValue({ id: APP, signingSecret: "signing-secret" }),
      enqueueChannelEvent: vi.fn().mockRejectedValue(new Error("postgres unavailable")),
    };
    const controller = new ChannelAppEventsController(persistence as any, runtime as any);
    const response = responseShim();

    await controller.events(signedRequest(envelope), response, APP);

    expect(response.statusCode).toBe(503);
    expect(runtime.handleAppEvent).not.toHaveBeenCalled();
  });

  it("ACKs completed duplicates and tells Slack to stop retrying", async () => {
    const persistence = {
      loadApp: vi.fn().mockResolvedValue({ id: APP, signingSecret: "signing-secret" }),
      enqueueChannelEvent: vi.fn().mockResolvedValue({ id: "inbox-1", status: "COMPLETED" }),
    };
    const controller = new ChannelAppEventsController(persistence as any, {} as any);
    const response = responseShim();

    await controller.events(signedRequest(envelope, true), response, APP);

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-slack-no-retry"]).toBe("1");
  });

  it("marks a retryable processing failure and reprocesses it on recovery", async () => {
    const complete = vi.fn().mockResolvedValue(true);
    const fail = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      claimChannelEvent: vi.fn().mockResolvedValue({
        id: "inbox-1",
        appId: APP,
        attempts: 1,
        eventId: "Ev1",
        leaseGeneration: 1,
        envelope,
      }),
      renewChannelEventLease: vi.fn().mockResolvedValue(true),
      loadApp: vi.fn().mockResolvedValue({ id: APP }),
      findActiveInstallation: vi.fn().mockResolvedValue({ id: "installation-1" }),
      recordChannelEventTurn: vi.fn().mockResolvedValue(true),
      recordChannelEventDelivery: vi.fn().mockResolvedValue(true),
      completeChannelEvent: complete,
      failChannelEvent: fail,
    };
    const runtime = {
      handleAppEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("retry me"))
        .mockResolvedValueOnce(undefined),
    };
    const controller = new ChannelAppEventsController(
      persistence as any,
      runtime as any,
    ) as any;

    await controller.processInbox("inbox-1");
    await controller.processInbox("inbox-1");

    expect(fail).toHaveBeenCalledWith(
      "inbox-1",
      expect.any(String),
      1,
      5_000,
      "PROCESSING_FAILED",
    );
    expect(runtime.handleAppEvent).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not claim new inbox work after module shutdown", async () => {
    const claim = vi.fn();
    const controller = new ChannelAppEventsController(
      { claimChannelEvent: claim } as any,
      {} as any,
    ) as any;

    controller.onModuleDestroy();
    await controller.processInbox("inbox-1");

    expect(claim).not.toHaveBeenCalled();
  });

  it("aborts processing and never completes after losing its lease heartbeat", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const fail = vi.fn().mockResolvedValue(false);
    const persistence = {
      claimChannelEvent: vi.fn().mockResolvedValue({
        id: "inbox-1",
        appId: APP,
        eventId: "Ev1",
        leaseGeneration: 7,
        envelope,
      }),
      renewChannelEventLease: vi.fn().mockResolvedValue(false),
      loadApp: vi.fn().mockResolvedValue({ id: APP }),
      findActiveInstallation: vi.fn().mockResolvedValue({ id: "installation-1" }),
      completeChannelEvent: complete,
      failChannelEvent: fail,
      recordChannelEventDelivery: vi.fn(),
      recordChannelEventTurn: vi.fn(),
    };
    const runtime = {
      handleAppEvent: vi.fn((_app, _installation, _envelope, context) =>
        new Promise<void>((resolve) => context.abortSignal.addEventListener("abort", () => resolve())),
      ),
    };
    const controller = new ChannelAppEventsController(persistence as any, runtime as any) as any;
    const processing = controller.processInbox("inbox-1");
    await vi.advanceTimersByTimeAsync(20_000);
    await processing;

    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      "inbox-1",
      expect.any(String),
      7,
      5_000,
      "PROCESSING_FAILED",
    );
    vi.useRealTimers();
  });

  it("discards explicit nonretryable Slack delivery failures", async () => {
    const discard = vi.fn().mockResolvedValue(true);
    const fail = vi.fn();
    const persistence = {
      claimChannelEvent: vi.fn().mockResolvedValue({
        id: "inbox-1",
        appId: APP,
        eventId: "Ev1",
        leaseGeneration: 2,
        envelope,
      }),
      renewChannelEventLease: vi.fn().mockResolvedValue(true),
      loadApp: vi.fn().mockResolvedValue({ id: APP }),
      findActiveInstallation: vi.fn().mockResolvedValue({ id: "installation-1" }),
      discardChannelEvent: discard,
      failChannelEvent: fail,
    };
    const runtime = {
      handleAppEvent: vi.fn().mockRejectedValue(
        new ChannelDeliveryError("SLACK_DELIVERY_REJECTED", false),
      ),
    };
    const controller = new ChannelAppEventsController(persistence as any, runtime as any) as any;

    await controller.processInbox("inbox-1");

    expect(discard).toHaveBeenCalledWith(
      "inbox-1",
      expect.any(String),
      2,
      "SLACK_DELIVERY_REJECTED",
    );
    expect(fail).not.toHaveBeenCalled();
  });
});
