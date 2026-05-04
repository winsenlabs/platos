import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SecretsService } from "./secrets.service";
import { ProviderHealthService } from "./provider-health.service";
import { SessionTokenController } from "./session-token.controller";
import { PublicGuestTokenController } from "./public-guest-token.controller";
import { ProvidersModule } from "../providers/providers.module";

@Module({
  imports: [ProvidersModule],
  controllers: [
    // EOBD.95 — entity-authed mint endpoint.
    SessionTokenController,
    // EOBD.89 — unauthenticated guest-token mint (rate-limited per IP
    // + per agent). Only mints for agents with visibility="public-guest".
    PublicGuestTokenController,
  ],
  providers: [AuthService, SecretsService, ProviderHealthService],
  exports: [AuthService, SecretsService, ProviderHealthService],
})
export class AuthModule {}
