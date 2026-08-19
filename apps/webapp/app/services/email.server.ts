import type { DeliverEmail, SendPlainTextOptions } from "emails";
import { EmailClient, MailTransportOptions } from "emails";
import type { SendEmailOptions } from "remix-auth-email-link";
import { redirect } from "remix-typedjson";
import { env } from "~/env.server";
import { commonWorker } from "~/v3/commonWorker.server";
import { logger } from "./logger.server";
import { singleton } from "~/utils/singleton";
import { assertEmailAllowed } from "~/utils/email";

// Theme BR — default from/reply-to addresses point at trigger.dev's
// legacy mail domain so existing self-hosters don't see their outbound
// mail break on upgrade. Platos self-hosters SHOULD set FROM_EMAIL /
// REPLY_TO_EMAIL (and the alert equivalents) to their own domain. We
// emit a one-shot warning on boot when a default is used.
const DEFAULT_FROM_EMAIL = "team@email.trigger.dev";
const DEFAULT_REPLY_TO_EMAIL = "help@email.trigger.dev";
const DEFAULT_ALERT_FROM_EMAIL = "noreply@alerts.trigger.dev";

if (!env.FROM_EMAIL) {
  // eslint-disable-next-line no-console
  console.warn(
    `[Platos boot] FROM_EMAIL is unset — outbound mail will send from the legacy trigger.dev domain (${DEFAULT_FROM_EMAIL}). ` +
      `Set FROM_EMAIL to your own domain before production.`,
  );
}

const client = singleton(
  "email-client",
  () =>
    new EmailClient({
      transport: buildTransportOptions(),
      imagesBaseUrl: env.APP_ORIGIN,
      from: env.FROM_EMAIL ?? DEFAULT_FROM_EMAIL,
      replyTo: env.REPLY_TO_EMAIL ?? DEFAULT_REPLY_TO_EMAIL,
    })
);

const alertsClient = singleton(
  "alerts-email-client",
  () =>
    new EmailClient({
      transport: buildTransportOptions(true),
      imagesBaseUrl: env.APP_ORIGIN,
      from: env.ALERT_FROM_EMAIL ?? DEFAULT_ALERT_FROM_EMAIL,
      // Fallback to `REPLY_TO_EMAIL` for backwards compat
      replyTo: env.ALERT_REPLY_TO_EMAIL ?? env.REPLY_TO_EMAIL ?? DEFAULT_REPLY_TO_EMAIL,
    })
);

function buildTransportOptions(alerts?: boolean): MailTransportOptions {
  const transportType = alerts ? env.ALERT_EMAIL_TRANSPORT : env.EMAIL_TRANSPORT;
  logger.debug(
    `Constructing email transport '${transportType}' for usage '${alerts ? "alerts" : "general"}'`
  );

  switch (transportType) {
    case "aws-ses":
      return { type: "aws-ses" };
    case "resend":
      return {
        type: "resend",
        config: {
          apiKey: alerts ? env.ALERT_RESEND_API_KEY : env.RESEND_API_KEY,
        },
      };
    case "smtp":
      return {
        type: "smtp",
        config: {
          host: alerts ? env.ALERT_SMTP_HOST : env.SMTP_HOST,
          port: alerts ? env.ALERT_SMTP_PORT : env.SMTP_PORT,
          secure: alerts ? env.ALERT_SMTP_SECURE : env.SMTP_SECURE,
          auth: {
            user: alerts ? env.ALERT_SMTP_USER : env.SMTP_USER,
            pass: alerts ? env.ALERT_SMTP_PASSWORD : env.SMTP_PASSWORD,
          },
        },
      };
    default:
      return { type: undefined };
  }
}

export async function sendMagicLinkEmail(
  options: SendEmailOptions<{ userId: string }>
): Promise<void> {
  // Promoted to INFO so operators can see the full dispatch timing on
  // every magic-link login attempt without flipping debug on. If a user
  // reports "no email received", grep for "Magic link email" in logs to
  // see whether the strategy even reached this function. A missing log
  // line means the auth strategy failed before calling sendEmail.
  logger.info("Magic link email: entering sendMagicLinkEmail", {
    emailAddress: options.emailAddress,
    transport: env.EMAIL_TRANSPORT ?? "(unset — NullMailTransport)",
    from: env.FROM_EMAIL ?? "(default)",
  });

  try {
    await sendDashboardMagicLink(options.emailAddress, options.magicLink);
    logger.info("Magic link email: client.send resolved", {
      emailAddress: options.emailAddress,
    });
    return;
  } catch (error) {
    logger.error("Magic link email: client.send threw", {
      emailAddress: options.emailAddress,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : JSON.stringify(error),
    });
    throw error;
  }
}

export async function sendDashboardMagicLink(emailAddress: string, magicLink: string): Promise<void> {
  assertEmailAllowed(emailAddress);

  // Preserve the existing local-development UX: clicking "send" follows the
  // generated link immediately instead of requiring an email transport.
  if (env.NODE_ENV === "development") {
    throw redirect(magicLink);
  }

  await client.send({
    email: "magic_link",
    to: emailAddress,
    magicLink,
  });
}

export async function sendPlainTextEmail(options: SendPlainTextOptions) {
  return client.sendPlainText(options);
}

export async function scheduleEmail(data: DeliverEmail, delay?: { seconds: number }) {
  const availableAt = delay ? new Date(Date.now() + delay.seconds * 1000) : undefined;
  await commonWorker.enqueue({
    job: "scheduleEmail",
    payload: data,
    availableAt,
  });
}

export async function sendEmail(data: DeliverEmail) {
  return client.send(data);
}

export async function sendAlertEmail(data: DeliverEmail) {
  return alertsClient.send(data);
}
