import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { SkillRegistryService } from "./skill-registry.service";
import { OFFICIAL_SKILL_SOURCES } from "./official/official-skills";
import { parseSkill } from "./skill-manifest.parser";

/**
 * Theme S.7–S.10 — Official skill seeder.
 *
 * Registers the 4 bundled Platos skills (`platos.web_search`,
 * `platos.code_execution`, `platos.file_operations`, `platos.image_generation`)
 * at the ORGANIZATION level (projectId + environmentId NULL) so every
 * project/env within the org can enable them without duplicating the row.
 *
 * Idempotent — re-running upserts by (orgId, skillId) and overwrites the
 * source/manifest/promptBlock. Runs once at module bootstrap.
 */
@Injectable()
export class OfficialSkillsSeederService {
  private readonly logger = new Logger(OfficialSkillsSeederService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly registry: SkillRegistryService,
  ) {}

  /** Seed for every organization that currently exists. */
  async seedAll(): Promise<{ seededOrgs: number; skillsPerOrg: number }> {
    const orgs: Array<{ id: string }> = await this.prisma.organization.findMany({
      select: { id: true },
    });
    let count = 0;
    for (const org of orgs) {
      await this.seedForOrg(org.id);
      count++;
    }
    return { seededOrgs: count, skillsPerOrg: OFFICIAL_SKILL_SOURCES.length };
  }

  /** Seed the 4 official skills for a single organization. */
  async seedForOrg(organizationId: string): Promise<void> {
    for (const { id, source } of OFFICIAL_SKILL_SOURCES) {
      try {
        const parsed = parseSkill(source);
        // Sanity — parsed id must match our registry id.
        if (parsed.manifest.id !== id) {
          this.logger.warn(
            `Official skill ${id} source declares mismatched id "${parsed.manifest.id}" — using the one from source.`,
          );
        }
        // isOfficial:true forces projectId + environmentId NULL in the row
        // — the scope passed here is only used for hydrating env-var status
        // in the return value, which the seeder throws away.
        await this.registry.register(
          { organizationId, projectId: "__official__", environmentId: "__official__" },
          parsed,
          { isOfficial: true, origin: "official" },
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to seed official skill ${id} for org ${organizationId}: ${err?.message ?? err}`,
        );
      }
    }
  }
}
