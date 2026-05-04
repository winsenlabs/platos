import { Module } from "@nestjs/common";
import { ConnectionsGateway } from "./connections.gateway";
import { AgentRuntimeModule } from "../agent-runtime/agent-runtime.module";
import { AuthModule } from "../auth/auth.module";
import { MonitoringModule } from "../monitoring/monitoring.module";

@Module({
  imports: [AgentRuntimeModule, AuthModule, MonitoringModule],
  providers: [ConnectionsGateway],
  exports: [ConnectionsGateway],
})
export class ConnectionsModule {}
