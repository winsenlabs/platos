import { Module } from "@nestjs/common";
import { OAuthService } from "./oauth.service";
import { OAuthController } from "./oauth.controller";

/**
 * Theme K.10 — OAuth 2.1 authorization server.
 *
 * Public (no ScopeGuard) — scope-guard bypass lives in `auth/scope.guard.ts`
 * for `/oauth/*` and `/.well-known/*`. Each endpoint does its own auth via
 * the OAuth protocol (client credentials, PKCE, bearer tokens).
 */
@Module({
  providers: [OAuthService],
  controllers: [OAuthController],
  exports: [OAuthService],
})
export class OAuthModule {}
