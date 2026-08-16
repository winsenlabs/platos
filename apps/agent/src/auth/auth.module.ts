import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SecretsModule } from "./secrets.module";
import { ProviderHealthService } from "./provider-health.service";
import { SessionTokenController } from "./session-token.controller";
import { PublicGuestTokenController } from "./public-guest-token.controller";
import { ProvidersModule } from "../providers/providers.module";
import { ToolGatewayModule } from "../tool-gateway/tool-gateway.module";

@Module({
  imports: [SecretsModule, ProvidersModule, ToolGatewayModule],
  controllers: [
    // EOBD.95 — entity-authed mint endpoint.
    SessionTokenController,
    // EOBD.89 — unauthenticated guest-token mint (rate-limited per IP
    // + per agent). Only mints for agents with visibility="public-guest".
    PublicGuestTokenController,
  ],
  providers: [AuthService, ProviderHealthService],
  exports: [AuthService, SecretsModule, ProviderHealthService],
})
export class AuthModule {}
