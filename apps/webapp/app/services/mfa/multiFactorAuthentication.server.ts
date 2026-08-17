import { PlatosAuthError } from "@platos/database";
import { platosAuth, requestRateLimitIdentifier } from "../platosAuth.server";
import { getOperatorSessionToken } from "../sessionStorage.server";

export class MultiFactorAuthenticationService {
  async enableTotp(userId: string) {
    return platosAuth.beginTotpEnrollment(userId);
  }

  async validateTotpSetup(userId: string, totpCode: string, request: Request) {
    try {
      const result = await platosAuth.confirmTotpEnrollment(
        userId,
        totpCode,
        requestRateLimitIdentifier(request, "mfa-enrollment")
      );
      return { success: true as const, recoveryCodes: result.recoveryCodes };
    } catch (error) {
      if (error instanceof PlatosAuthError && error.code === "invalid_mfa") {
        return {
          success: false as const,
          error: "The code was not accepted. Restart setup to generate a fresh QR code.",
        };
      }
      throw error;
    }
  }

  async disableTotp(request: Request, params: { totpCode?: string; recoveryCode?: string }) {
    const sessionToken = await getOperatorSessionToken(request);
    if (!sessionToken) return { success: false as const };
    try {
      await platosAuth.disableTotpForSession({
        sessionToken,
        rateLimitIdentifier: requestRateLimitIdentifier(request, "mfa-disable"),
        ...params,
      });
      return { success: true as const };
    } catch (error) {
      if (error instanceof PlatosAuthError && ["invalid_mfa", "rate_limited"].includes(error.code)) {
        return { success: false as const };
      }
      throw error;
    }
  }
}
