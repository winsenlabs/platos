export interface AlertEmailDeliveryResult {
  ok: boolean;
  statusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Canonical Resend transport used by alert test sends and budget deliveries.
 * Credentials are resolved at dispatch and never included in results/errors.
 */
export async function sendAlertEmail(input: {
  resolveVariable(name: string): Promise<string | undefined>;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}): Promise<AlertEmailDeliveryResult> {
  const apiKey = await input.resolveVariable("RESEND_API_KEY");
  if (!apiKey) return failed("email_credential_unavailable", "RESEND_API_KEY is unavailable");
  const from =
    (await input.resolveVariable("RESEND_FROM_EMAIL")) ??
    (await input.resolveVariable("FROM_EMAIL"));
  if (!from) return failed("email_sender_unavailable", "Email sender is unavailable");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      return { ok: true, statusCode: response.status, errorCode: null, errorMessage: null };
    }
    return failed("email_api_error", `Email provider returned status ${response.status}`, response.status);
  } catch {
    return failed("email_fetch_failed", "Email provider request failed");
  }
}

function failed(
  errorCode: string,
  errorMessage: string,
  statusCode: number | null = null,
): AlertEmailDeliveryResult {
  return { ok: false, statusCode, errorCode, errorMessage };
}
