import { Module } from "@nestjs/common";
import { DatabaseModule } from "../shared/database.provider";
import { RedisModule } from "../shared/redis.provider";
import { ErasureService } from "./erasure.service";
import { ErasureObjectStore } from "./object-store";
import { ErasureClickhouse } from "./clickhouse";
import { ErasureController } from "./erasure.controller";
import { PlatosMCPTokenService } from "../mcp-platform/token.service";
import { AdminAuditService } from "../monitoring/admin-audit.service";

/**
 * Privacy module — hard erasure only.
 *
 * Deliberately narrow. It shares no state with the agent runtime and changes no
 * agent behaviour; the only thing it can do is destroy data on an explicit,
 * admin-authenticated request.
 *
 * AdminAuditService is the one collaborator it takes from outside: an
 * irreversible deletion has to land in the same append-only admin log every
 * other destructive admin action does, or "who deleted this person" is
 * answerable for agents and entities but not for people.
 */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [ErasureController],
  providers: [
    ErasureService,
    ErasureObjectStore,
    ErasureClickhouse,
    PlatosMCPTokenService,
    AdminAuditService,
  ],
  exports: [ErasureService],
})
export class PrivacyModule {}
