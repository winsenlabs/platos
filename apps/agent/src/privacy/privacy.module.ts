import { Module } from "@nestjs/common";
import { DatabaseModule } from "../shared/database.provider";
import { RedisModule } from "../shared/redis.provider";
import { ErasureService } from "./erasure.service";
import { ErasureObjectStore } from "./object-store";
import { ErasureClickhouse } from "./clickhouse";
import { ErasureController } from "./erasure.controller";
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
 *
 * WIN-269 (M4.3) — it used to register `PlatosMCPTokenService` out of
 * `mcp-platform` as a local provider too, which made `privacy` import
 * `mcp-platform` while `mcp-platform` reaches `privacy` back through
 * `agent-runtime -> memory -> privacy`. `ErasureController` now injects
 * `ERASURE_ADMIN_CREDENTIALS` (`./admin-credential.port`), bound to that same
 * service by the `@Global()` `McpPortBindingsModule`, so the edge is gone and
 * the verifier is one instance rather than two.
 */
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [ErasureController],
  providers: [
    ErasureService,
    ErasureObjectStore,
    ErasureClickhouse,
    AdminAuditService,
  ],
  exports: [ErasureService],
})
export class PrivacyModule {}
