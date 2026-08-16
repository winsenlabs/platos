import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { ChannelAppEventsController } from "./channel-app-events.controller";

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
  return new ChannelAppEventsController(persistence as any, {} as any, {} as any) as any;
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
