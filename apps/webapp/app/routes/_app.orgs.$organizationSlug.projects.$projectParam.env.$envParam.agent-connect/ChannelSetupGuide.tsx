import { ArrowTopRightOnSquareIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { Callout } from "~/components/primitives/Callout";
import { CopyButton } from "~/components/primitives/CopyButton";

/**
 * Per-provider "how to configure this channel on the provider side" guidance.
 * Two surfaces:
 *   - <ChannelSetupGuide>   — collapsible, shown inside the create form. Tells
 *                             the user what to create on the provider and which
 *                             value goes into which field of THIS form.
 *   - <ChannelWebhookGuide> — shown on the post-create (and rotate) reveal step.
 *                             The "now wire the webhook" steps, with the real
 *                             revealed URL substituted into copyable snippets.
 *
 * Facts are sourced from chat-sdk.dev's provider docs; kept here (client-only)
 * next to the route that renders them.
 */

// ── Provider console links + pre-create field mapping ────────────────────────

type FieldMap = { field: string; source: string };

type PreCreateSpec = {
  console: { label: string; url: string };
  create: string[];
  fields: FieldMap[];
};

const PRE_CREATE: Record<string, PreCreateSpec> = {
  slack: {
    console: { label: "api.slack.com/apps", url: "https://api.slack.com/apps" },
    create: [
      'Create an app at api.slack.com/apps — "From an app manifest" is the fastest path.',
      "Install the app to your workspace so Slack generates the Bot User OAuth Token.",
    ],
    fields: [
      { field: "Bot token", source: "OAuth & Permissions → Bot User OAuth Token (xoxb-…)" },
      {
        field: "Signing secret",
        source: "Basic Information → App Credentials → Signing Secret",
      },
      { field: "Team ID (optional)", source: "your workspace/team ID, e.g. T01234567" },
    ],
  },
  telegram: {
    console: { label: "@BotFather", url: "https://t.me/BotFather" },
    create: [
      "Open @BotFather in Telegram and send /newbot, then follow the prompts to name the bot.",
      "Choose any random string as your webhook secret token — you paste it below and use it again when registering the webhook.",
    ],
    fields: [
      { field: "Bot token", source: "the token @BotFather returns (123456:ABC-DEF…)" },
      { field: "Webhook secret token", source: "the random string you chose above" },
    ],
  },
  whatsapp: {
    console: {
      label: "Meta for Developers",
      url: "https://developers.facebook.com/apps",
    },
    create: [
      "In Meta for Developers open your app and add the WhatsApp product.",
      "Create a System User and generate a permanent access token for it.",
    ],
    fields: [
      { field: "Access token", source: "the permanent token from your System User" },
      { field: "App secret", source: "App Settings → Basic → App Secret" },
      { field: "Phone number ID", source: "WhatsApp → API Setup → Phone number ID" },
      { field: "Verify token", source: "any string you choose (re-enter it in Meta's webhook config)" },
      { field: "Business account ID (optional)", source: "WhatsApp → API Setup → WhatsApp Business Account ID" },
    ],
  },
  discord: {
    console: {
      label: "discord.com/developers",
      url: "https://discord.com/developers/applications",
    },
    create: [
      "Create an application at discord.com/developers, then add a Bot to it.",
    ],
    fields: [
      { field: "Bot token", source: "Bot tab → Reset/Copy Token" },
      { field: "Public key", source: "General Information → Public Key" },
      { field: "Application ID", source: "General Information → Application ID" },
      { field: "Guild ID (optional)", source: "your server's ID (Developer Mode → right-click server → Copy ID)" },
    ],
  },
};

const chipClass = "shrink-0 rounded bg-charcoal-700 px-1.5 py-0.5 font-mono text-text-bright";

function SetupCodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-charcoal-700 bg-charcoal-900">
      <div className="flex items-center justify-between border-b border-charcoal-700 bg-charcoal-850 px-3 py-1.5">
        <span className="text-xs text-text-dimmed">{language}</span>
        <CopyButton value={code} variant="icon" size="small" showTooltip={false} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-xs leading-relaxed text-text-bright">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Collapsible pre-create guide (rendered inside the create form) ────────────

export function ChannelSetupGuide({ provider }: { provider: string }) {
  const spec = PRE_CREATE[provider];
  if (!spec) return null;

  return (
    <details className="group rounded-lg border border-charcoal-700 bg-charcoal-850">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-text-bright [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-4 shrink-0 text-text-dimmed transition-transform group-open:rotate-90" />
        Setup guide
        <span className="font-normal text-text-dimmed">— what to prepare on the provider side</span>
      </summary>
      <div className="space-y-4 border-t border-charcoal-700 px-3 py-3">
        <a
          href={spec.console.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-400 transition-colors hover:text-blue-300"
        >
          Open {spec.console.label}
          <ArrowTopRightOnSquareIcon className="size-3.5" />
        </a>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-text-bright">1. Create on the provider</div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-text-dimmed">
            {spec.create.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-text-bright">2. Paste into this form</div>
          <div className="flex flex-col gap-1.5">
            {spec.fields.map((f) => (
              <div key={f.field} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <code className={chipClass}>{f.field}</code>
                <span className="text-text-dimmed">← {f.source}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

// ── Post-create webhook wiring guide (rendered on the reveal step) ────────────

function OrderedSteps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-xs text-text-dimmed">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

export function ChannelWebhookGuide({
  provider,
  webhookUrl,
  webhookUrlIsComplete,
}: {
  provider: string;
  /** Full URL when a public origin is configured, else a `<YOUR_PUBLIC_ORIGIN>…` shaped placeholder. */
  webhookUrl: string;
  webhookUrlIsComplete: boolean;
}) {
  let body: React.ReactNode = null;

  if (provider === "slack") {
    const manifest = `display_information:
  name: Platos Agent
features:
  bot_user:
    display_name: Platos Agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    request_url: ${webhookUrl}
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
    request_url: ${webhookUrl}`;
    body = (
      <div className="space-y-3">
        <OrderedSteps
          steps={[
            <>
              In your Slack app's manifest, set <strong className="text-text-bright">both</strong>{" "}
              <code className={chipClass}>event_subscriptions.request_url</code> and{" "}
              <code className={chipClass}>interactivity.request_url</code> to the webhook URL above.
            </>,
            "Subscribe to bot events: app_mention, message.channels, message.groups, message.im, message.mpim.",
            "Add OAuth bot scopes: app_mentions:read, channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, mpim:history, mpim:read, reactions:read, reactions:write, users:read.",
            "Reinstall the app to your workspace after saving.",
          ]}
        />
        <div>
          <div className="mb-1 text-xs text-text-dimmed">
            Minimal manifest (URL already filled in)
          </div>
          <SetupCodeBlock language="Slack app manifest (YAML)" code={manifest} />
        </div>
      </div>
    );
  } else if (provider === "telegram") {
    const curl = `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \\
  -H "Content-Type: application/json" \\
  -d "{\\"url\\":\\"${webhookUrl}\\",\\"secret_token\\":\\"<YOUR_SECRET>\\"}"`;
    body = (
      <div className="space-y-3">
        <OrderedSteps
          steps={[
            <>
              Register the webhook with Telegram by running the command below. Replace{" "}
              <code className={chipClass}>&lt;TOKEN&gt;</code> with your bot token and{" "}
              <code className={chipClass}>&lt;YOUR_SECRET&gt;</code> with the webhook secret token you
              chose.
            </>,
          ]}
        />
        <SetupCodeBlock language="Terminal" code={curl} />
        <Callout variant="warning">
          Your bot token appears in this command — run it in a private terminal, not in shared logs
          or history.
        </Callout>
      </div>
    );
  } else if (provider === "whatsapp") {
    body = (
      <div className="space-y-3">
        <OrderedSteps
          steps={[
            "In the Meta app, go to WhatsApp → Configuration → Webhook.",
            <>
              Set <strong className="text-text-bright">Callback URL</strong> to the webhook URL above
              and <strong className="text-text-bright">Verify Token</strong> to the string you chose.
              Meta sends a GET handshake — Platos answers it automatically.
            </>,
            <>
              Subscribe to the <code className={chipClass}>messages</code> webhook field.
            </>,
          ]}
        />
        <Callout variant="info">
          Outside the 24-hour customer-service window only pre-approved template messages can be
          sent; the agent replies within that window.
        </Callout>
      </div>
    );
  } else if (provider === "discord") {
    body = (
      <div className="space-y-3">
        <OrderedSteps
          steps={[
            <>
              In <strong className="text-text-bright">General Information</strong>, set the{" "}
              Interactions Endpoint URL to the webhook URL above. Discord PINGs it to verify — Platos
              answers automatically.
            </>,
            <>
              Invite the bot to your server with the <code className={chipClass}>bot</code> scope and
              the Send Messages permission.
            </>,
          ]}
        />
        <Callout variant="info">
          Regular channel messages arrive over Discord's Gateway, which Platos maintains
          automatically once this connection is enabled.
        </Callout>
      </div>
    );
  } else {
    return null;
  }

  return (
    <div className="space-y-3 rounded-lg border border-charcoal-700 bg-charcoal-850 p-3">
      <div className="text-xs font-medium text-text-bright">Now wire the webhook</div>
      {!webhookUrlIsComplete && (
        <p className="text-xs text-text-dimmed">
          Replace <code className={chipClass}>&lt;YOUR_PUBLIC_ORIGIN&gt;</code> in the URL with your
          agent service's public https origin (see the warning above) before using it.
        </p>
      )}
      {body}
      <p className="border-t border-charcoal-700 pt-2 text-xs text-text-dimmed">
        The webhook URL embeds a secret — treat it like a password. If it leaks, rotate it from the
        channel row on this page.
      </p>
    </div>
  );
}
