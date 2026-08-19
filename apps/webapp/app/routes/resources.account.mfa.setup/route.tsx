import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { redirectWithSuccessMessage, redirectWithErrorMessage, typedJsonWithSuccessMessage } from "~/models/message.server";
import { useMfaSetup } from "./useMfaSetup";
import { MfaToggle } from "./MfaToggle";
import { MfaSetupDialog } from "./MfaSetupDialog";
import { MfaDisableDialog } from "./MfaDisableDialog";
import {
  authSessionRateLimitIdentifier,
  commitOperatorSession,
  requireCanonicalAuthorization,
  platosDashboardAuth,
} from "~/services/platosDashboardAuth.server";
import { PlatosAuthError } from "@platos/tenancy-database";

const formSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enable-mfa"),
  }),
  z.object({
    action: z.literal("disable-mfa"),
    totpCode: z.string().optional(),
    recoveryCode: z.string().optional(),
  }),
  z.object({
    action: z.literal("saved-recovery-codes"),
  }),
  z.object({
    action: z.literal("cancel-totp"),
  }),
  z.object({
    action: z.literal("validate-totp"),
    totpCode: z.string().length(6, "TOTP code must be 6 digits"),
  }),
]);

function validateForm(formData: FormData) {
  const formEntries = Object.fromEntries(formData.entries());

  const result = formSchema.safeParse(formEntries);

  if (!result.success) {
    return {
      valid: false as const,
      errors: result.error.flatten().fieldErrors,
    };
  }

  return {
    valid: true as const,
    data: result.data,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const operator = await requireCanonicalAuthorization(request);

    const formData = await request.formData();

    const submission = validateForm(formData);

    if (!submission.valid) {
      return typedjson({
        action: "invalid-form" as const,
        errors: submission.errors,
      });
    }

    switch (submission.data.action) {
      case "enable-mfa": {
        const result = await platosDashboardAuth.beginTotpEnrollment(operator.canonicalUserId);

        return typedjson({
          action: "enable-mfa" as const,
          secret: result.secret,
          otpAuthUrl: result.otpAuthUrl,
        });
      }
      case "disable-mfa": {
        try {
          await platosDashboardAuth.disableTotpForSession({
            sessionToken: operator.token,
            rateLimitIdentifier: authSessionRateLimitIdentifier(operator.token),
            totpCode: submission.data.totpCode,
            recoveryCode: submission.data.recoveryCode,
          });
        } catch (error) {
          if (error instanceof PlatosAuthError && error.code === "invalid_mfa") {
            return typedjson({
              action: "disable-mfa" as const,
              success: false as const,
              error: "Invalid code provided. Please try again.",
            });
          }
          throw error;
        }
        return typedJsonWithSuccessMessage(
          {
            action: "disable-mfa" as const,
            success: true as const,
          },
          request,
          "Successfully disabled MFA"
        );
      }
      case "validate-totp": {
        const result = await platosDashboardAuth.confirmTotpEnrollment(
          operator.canonicalUserId,
          submission.data.totpCode,
          authSessionRateLimitIdentifier(operator.token)
        );
        const replacement = await platosDashboardAuth.issueOperatorSession({
          userId: operator.canonicalUserId,
          mfaVerifiedAt: new Date(),
        });
        return typedjson(
          {
            action: "validate-totp" as const,
            success: true as const,
            recoveryCodes: result.recoveryCodes,
          },
          {
            headers: {
              "Set-Cookie": await commitOperatorSession(replacement.token, replacement.expiresAt),
            },
          }
        );
      }
      case "cancel-totp": {
        return typedjson({
          action: "cancel-totp" as const,
          success: true as const,
        });
      }
      case "saved-recovery-codes": {
        return redirectWithSuccessMessage("/account/security", request, "Successfully enabled MFA");
      }
    }
  } catch (error) {
    if (error instanceof PlatosAuthError) {
      if (error.code === "invalid_mfa") {
        return typedjson({
          action: "validate-totp" as const,
          success: false as const,
          error: "Invalid code provided. Please try again.",
          secret: undefined,
          otpAuthUrl: undefined,
        });
      }
      return redirectWithErrorMessage("/account/security", request, error.message);
    }
    
    // Re-throw unexpected errors
    throw error;
  }
}

export function MfaSetup({ isEnabled }: { isEnabled: boolean }) {
  const { state, actions, isQrDialogOpen, isRecoveryDialogOpen, isDisableDialogOpen } = useMfaSetup(isEnabled);

  const handleToggle = (enabled: boolean) => {
    if (enabled && !state.isEnabled) {
      actions.enableMfa();
    } else if (!enabled && state.isEnabled) {
      actions.openDisableDialog();
    }
  };

  return (
    <>
      <MfaToggle
        isEnabled={state.isEnabled}
        onToggle={handleToggle}
      />

      <MfaSetupDialog
        isOpen={isQrDialogOpen}
        setupData={state.setupData}
        recoveryCodes={state.recoveryCodes}
        error={state.error}
        isSubmitting={state.isSubmitting}
        onValidate={actions.validateTotp}
        onCancel={actions.cancelSetup}
        onSaveRecoveryCodes={actions.saveRecoveryCodes}
      />

      <MfaDisableDialog
        isOpen={isDisableDialogOpen}
        isSubmitting={state.isSubmitting}
        error={state.error}
        onDisable={actions.disableMfa}
        onCancel={actions.cancelDisable}
      />
    </>
  );
}
