import { describe, expect, test, vi } from "vitest";
import { OrganizationRole } from "../generated/control";
import {
  decryptSecret,
  encryptSecret,
  generateTotp,
  hashSecret,
  operatorSessionCookie,
  PlatosAuthService,
} from "./auth";

describe("Platos auth primitives", () => {
  test("hashes secrets deterministically without retaining plaintext", () => {
    expect(hashSecret("raw-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret("raw-token")).toBe(hashSecret("raw-token"));
    expect(hashSecret("raw-token")).not.toContain("raw-token");
  });

  test("encrypts recoverable TOTP secrets with authenticated encryption", () => {
    const key = "0123456789abcdef0123456789abcdef";
    const encrypted = encryptSecret("JBSWY3DPEHPK3PXP", key);

    expect(encrypted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(encrypted, key)).toBe("JBSWY3DPEHPK3PXP");
    const [iv, encodedTag, ciphertext] = encrypted.split(".");
    const tag = Buffer.from(encodedTag, "base64url");
    tag[0] ^= 1;
    expect(() =>
      decryptSecret(`${iv}.${tag.toString("base64url")}.${ciphertext}`, key)
    ).toThrow();
  });

  test("implements the RFC 6238 SHA-1 six-digit TOTP semantics", () => {
    // RFC 6238 secret "12345678901234567890" in base32. The RFC's eight-digit
    // result at 59 seconds is 94287082, whose six-digit truncation is 287082.
    expect(generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", new Date(59_000))).toBe("287082");
  });

  test("stores only the raw opaque token in the operator cookie", () => {
    const cookie = operatorSessionCookie("plt_os_raw-token");
    expect(cookie).toContain("__Host-platos_operator_session=plt_os_raw-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toMatch(/user(Id)?=/i);
    expect(cookie).not.toMatch(/organization(Id)?=/i);
  });
});

describe("PlatosAuthService membership role changes", () => {
  function harness(target: { organizationId: string; role: OrganizationRole } | null) {
    const findFirst = vi.fn()
      .mockResolvedValueOnce({ role: OrganizationRole.OWNER })
      .mockResolvedValueOnce(target && {
        id: "membership-target",
        userId: "user-target",
        role: target.role,
      });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "organization-a" }]),
      organizationMembership: {
        findFirst,
        count: vi.fn().mockResolvedValue(2),
        update: vi.fn().mockResolvedValue({ id: "membership-target" }),
      },
      operatorSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
    };
    const database = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    return {
      tx,
      service: new PlatosAuthService(database as any, {
        encryptionKey: "0123456789abcdef0123456789abcdef",
        now: () => new Date("2026-08-20T12:00:00.000Z"),
      }),
    };
  }

  test("rejects a membership id outside the URL organization without mutating either tenant", async () => {
    const { service, tx } = harness(null);

    await expect(service.changeMembershipRole({
      organizationId: "organization-a",
      membershipId: "membership-from-organization-b",
      actorUserId: "owner-a",
      role: OrganizationRole.ADMIN,
    })).rejects.toMatchObject({ code: "forbidden", status: 403 });

    expect(tx.organizationMembership.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: "membership-from-organization-b",
        organizationId: "organization-a",
        deactivatedAt: null,
      },
      select: { id: true, userId: true, role: true },
    });
    expect(tx.organizationMembership.update).not.toHaveBeenCalled();
    expect(tx.operatorSession.updateMany).not.toHaveBeenCalled();
  });

  test("updates the scoped role and revokes every direct or impersonated session in one transaction", async () => {
    const { service, tx } = harness({
      organizationId: "organization-a",
      role: OrganizationRole.MEMBER,
    });

    await service.changeMembershipRole({
      organizationId: "organization-a",
      membershipId: "membership-target",
      actorUserId: "owner-a",
      role: OrganizationRole.ADMIN,
    });

    expect(tx.organizationMembership.update).toHaveBeenCalledWith({
      where: {
        id_organizationId: {
          id: "membership-target",
          organizationId: "organization-a",
        },
      },
      data: { role: OrganizationRole.ADMIN },
    });
    expect(tx.operatorSession.updateMany).toHaveBeenCalledWith({
      where: {
        revokedAt: null,
        OR: [{ userId: "user-target" }, { impersonatedUserId: "user-target" }],
      },
      data: { revokedAt: new Date("2026-08-20T12:00:00.000Z") },
    });
    expect((tx.organizationMembership.update as any).mock.invocationCallOrder[0]).toBeLessThan(
      (tx.operatorSession.updateMany as any).mock.invocationCallOrder[0],
    );
  });

  test("protects the last active owner under the organization lock", async () => {
    const { service, tx } = harness({
      organizationId: "organization-a",
      role: OrganizationRole.OWNER,
    });
    tx.organizationMembership.count.mockResolvedValue(1);

    await expect(service.changeMembershipRole({
      organizationId: "organization-a",
      membershipId: "membership-target",
      actorUserId: "owner-a",
      role: OrganizationRole.ADMIN,
    })).rejects.toMatchObject({ code: "owner_invariant", status: 409 });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.organizationMembership.update).not.toHaveBeenCalled();
    expect(tx.operatorSession.updateMany).not.toHaveBeenCalled();
  });
});
