import { Module } from "@nestjs/common";
import { DatabaseModule } from "../shared/database.provider";
import { RedisModule } from "../shared/redis.provider";
import { ErasureService } from "./erasure.service";
import { ErasureObjectStore } from "./object-store";
import { ErasureController } from "./erasure.controller";
import { PlatosMCPTokenService } from "../mcp-platform/token.service";

/**
 * Privacy module — hard erasure only.
 *
 * Deliberately narrow. It shares no state with the agent runtime and changes no
 * agent behaviour; the only thing it can do is destroy data on an explicit,
 * admin-authenticated request.
 */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [ErasureController],
  providers: [ErasureService, ErasureObjectStore, PlatosMCPTokenService],
  exports: [ErasureService],
})
export class PrivacyModule {}
