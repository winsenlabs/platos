/**
 * Connect v3 — Enterprise Grid envelope routing for channel-app events.
 *
 * An org-install grant (oauth.v2.access → team:null, is_enterprise_install
 * true) is stored with teamId=NULL, but Slack event envelopes always carry
 * the ORIGINATING workspace's team_id. These tests pin the fallback: when
 * the exact (appId, teamId, enterpriseId) tuple misses inside a Grid, both
 * installation lookup and lifecycle revocation must fall back to the
 * (appId, teamId IS NULL, enterpriseId) org-install row.
 *
 * CLAUDE.md §9.11: Vitest, no mocking framework — an in-memory Prisma shim
 * implements only platosChannelInstallation.findFirst/updateMany with
 * Prisma's null-compiles-to-IS-NULL matching semantics.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ChannelAppEventsController } from "./channel-app-events.controller";

type Row = {
  id: string;
  appId: string;
  teamId: string | null;
  enterpriseId: string | null;
  isEnterpriseInstall: boolean;
  status: string;
  revokedAt: Date | null;
};

function makePrismaShim(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(
      ([k, v]) => (row as Record<string, unknown>)[k] === v,
    );
  return {
    rows,
    platosChannelInstallation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Row>;
      }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
  };
}

function makeController(prisma: ReturnType<typeof makePrismaShim>) {
  // redis / messageCrypto / runtime are not touched by the lookup/revoke
  // paths under test.
  return new ChannelAppEventsController(
    prisma,
    {} as any,
    {} as any,
    {} as any,
  ) as any;
}

const APP = "app_1";

const orgInstallRow = (): Row => ({
  id: "inst_org",
  appId: APP,
  teamId: null,
  enterpriseId: "E1",
  isEnterpriseInstall: true,
  status: "active",
  revokedAt: null,
});

const workspaceRow = (): Row => ({
  id: "inst_ws",
  appId: APP,
  teamId: "T123",
  enterpriseId: "E1",
  isEnterpriseInstall: false,
  status: "active",
  revokedAt: null,
});

describe("ChannelAppEventsController — Grid org-install routing", () => {
  let rows: Row[];

  describe("findActiveInstallation", () => {
    it("falls back to the teamId-NULL org-install row for a Grid envelope", async () => {
      rows = [orgInstallRow()];
      const ctrl = makeController(makePrismaShim(rows));
      // Envelope from workspace T123 of grid E1 — exact tuple can never match.
      const found = await ctrl.findActiveInstallation(APP, "T123", "E1");
      expect(found?.id).toBe("inst_org");
    });

    it("prefers an exact workspace row over the org-install fallback", async () => {
      rows = [orgInstallRow(), workspaceRow()];
      const ctrl = makeController(makePrismaShim(rows));
      const found = await ctrl.findActiveInstallation(APP, "T123", "E1");
      expect(found?.id).toBe("inst_ws");
    });

    it("does not fall back outside a Grid (enterpriseId null)", async () => {
      rows = [orgInstallRow()];
      const ctrl = makeController(makePrismaShim(rows));
      const found = await ctrl.findActiveInstallation(APP, "T999", null);
      expect(found).toBeNull();
    });

    it("never resurrects a revoked org install", async () => {
      const revoked = orgInstallRow();
      revoked.status = "revoked";
      rows = [revoked];
      const ctrl = makeController(makePrismaShim(rows));
      const found = await ctrl.findActiveInstallation(APP, "T123", "E1");
      expect(found).toBeNull();
    });
  });

  describe("revokeInstallations", () => {
    it("revokes the org-install row when the Grid lifecycle envelope carries a workspace team_id", async () => {
      rows = [orgInstallRow()];
      const ctrl = makeController(makePrismaShim(rows));
      await ctrl.revokeInstallations(APP, "T123", "E1");
      expect(rows[0].status).toBe("revoked");
      expect(rows[0].revokedAt).toBeInstanceOf(Date);
    });

    it("only touches the exact row when a workspace row matches", async () => {
      rows = [orgInstallRow(), workspaceRow()];
      const ctrl = makeController(makePrismaShim(rows));
      await ctrl.revokeInstallations(APP, "T123", "E1");
      const org = rows.find((r) => r.id === "inst_org");
      const ws = rows.find((r) => r.id === "inst_ws");
      expect(ws?.status).toBe("revoked");
      expect(org?.status).toBe("active");
    });

    it("is idempotent — the second (unordered) lifecycle event updates nothing", async () => {
      rows = [orgInstallRow()];
      const ctrl = makeController(makePrismaShim(rows));
      await ctrl.revokeInstallations(APP, "T123", "E1");
      const firstRevokedAt = rows[0].revokedAt;
      await ctrl.revokeInstallations(APP, "T123", "E1");
      expect(rows[0].revokedAt).toBe(firstRevokedAt);
    });
  });
});
