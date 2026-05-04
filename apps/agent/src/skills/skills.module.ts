import { Module, OnApplicationBootstrap, Logger } from "@nestjs/common";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillRuntimeService } from "./skill-runtime.service";
import { SkillImporterService } from "./skill-importer.service";
import { OfficialSkillsSeederService } from "./official-skills-seeder.service";
import { OfficialSkillHandlers } from "./official/skill-handlers";
import { SkillsController } from "./skills.controller";
import { ProvidersModule } from "../providers/providers.module";
import { MonitoringModule } from "../monitoring/monitoring.module";
import { MemoryModule } from "../memory/memory.module";

@Module({
  // SM.1 — MonitoringModule exports CostService so SkillRuntimeService can
  // emit SkillUsageEvents. MonitoringModule has no inbound edge on Skills,
  // so this doesn't introduce a DI cycle.
  // RG.1 — MemoryModule exports MemoryService so OfficialSkillHandlers can
  // implement the `platos.platos_rag` ingest/retrieve tools. MemoryModule
  // doesn't import SkillsModule, so no cycle.
  imports: [ProvidersModule, MonitoringModule, MemoryModule],
  controllers: [SkillsController],
  providers: [
    SkillRegistryService,
    SkillRuntimeService,
    SkillImporterService,
    OfficialSkillsSeederService,
    OfficialSkillHandlers,
  ],
  exports: [
    SkillRegistryService,
    SkillRuntimeService,
    SkillImporterService,
    OfficialSkillHandlers,
  ],
})
export class SkillsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(SkillsModule.name);

  constructor(private readonly seeder: OfficialSkillsSeederService) {}

  async onApplicationBootstrap() {
    // Theme S — seed the 4 official skills on first boot per organization.
    // The seeder is idempotent (upsert by (orgId, skillId) with projectId + envId
    // NULL for official rows) so boot never double-registers.
    try {
      await this.seeder.seedAll();
    } catch (err: any) {
      this.logger.warn(`Official skill seeding failed: ${err?.message ?? err}`);
    }
  }
}
