import { describe, expect, it, vi } from "vitest";
import { OFFICIAL_SKILL_SOURCES } from "./official/official-skills";
import { OfficialSkillsSeederService } from "./official-skills-seeder.service";

describe("OfficialSkillsSeederService clean-tenancy catalog seeding", () => {
  it("seeds Organization-owned skills without fabricated scope tuples", async () => {
    const prisma = {
      organization: { findMany: vi.fn().mockResolvedValue([{ id: "org_1" }]) },
    } as any;
    const registry = { registerOfficial: vi.fn().mockResolvedValue({}) } as any;
    const seeder = new OfficialSkillsSeederService(prisma, registry);

    await expect(seeder.seedAll()).resolves.toEqual({
      seededOrgs: 1,
      skillsPerOrg: OFFICIAL_SKILL_SOURCES.length,
    });
    expect(registry.registerOfficial).toHaveBeenCalledTimes(OFFICIAL_SKILL_SOURCES.length);
    for (const call of registry.registerOfficial.mock.calls) {
      expect(call[0]).toBe("org_1");
      expect(call[1].manifest.id).toMatch(/^platos\./);
    }
  });
});
