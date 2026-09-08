import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SecretsModule } from "./secrets.module";
import { ProviderHealthService } from "./provider-health.service";
import { SessionTokenController } from "./session-token.controller";
import { PublicGuestTokenController } from "./public-guest-token.controller";
import { ProvidersModule } from "../providers/providers.module";
import { ToolGatewayModule } from "../tool-gateway/tool-gateway.module";
import { AgentBindingDirectory } from "../agent-runtime/agent-binding.directory";

@Module({
  imports: [SecretsModule, ProvidersModule, ToolGatewayModule],
  controllers: [
    // EOBD.95 — entity-authed mint endpoint.
    SessionTokenController,
    // EOBD.89 — unauthenticated guest-token mint (rate-limited per IP
    // + per agent). Only mints for agents with visibility="public-guest".
    PublicGuestTokenController,
  ],
  providers: [
    AuthService,
    ProviderHealthService,
    // WIN-258 T6 — the one owner of `agentBinding` reads, so
    // PublicGuestTokenController never holds the ORM client. Registered here
    // rather than imported from a ChannelsModule because it depends on nothing
    // but the @Global PRISMA_TOKEN and is stateless.
    AgentBindingDirectory,
  ],
  exports: [AuthService, SecretsModule, ProviderHealthService],
})
export class AuthModule {}
