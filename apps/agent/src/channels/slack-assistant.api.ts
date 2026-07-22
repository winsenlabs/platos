/**
 * Connect v3 — Slack "Agents & AI Apps" surface Web API helpers.
 *
 * Slack apps that enable the "Agents & AI Apps" toggle + hold the
 * `assistant:write` scope get a first-class split-view assistant panel. Its
 * thread-decoration methods live here, split out of channel-runtime.service.ts
 * so the runtime bridge stays focused on turn execution. Every call is:
 *   - BEST-EFFORT: a status/title/prompt failure must NEVER fail the turn, so
 *     these functions swallow all errors and return void (they never throw).
 *   - Bounded by a 10s `AbortSignal.timeout` (same budget as chat.postMessage).
 *   - Token-safe: the bot token + any user text are NEVER logged — only the
 *     Slack method name + error code on failure, at debug level (cosmetic surface).
 *
 * All are POST https://slack.com/api/<method> with a JSON body and
 * `Authorization: Bearer <bot token>`; Slack answers `{ ok: boolean, ... }`.
 *
 * SCOPES (recommend in the app manifest): `assistant:write` for the assistant
 * thread methods, plus `chat:write` to post replies (which also clears the
 * thinking status). Per Slack's 2026-03-05 change `assistant.threads.setStatus`
 * additionally accepts `chat:write`, but the other `assistant.threads.*` methods
 * still want `assistant:write` — request BOTH.
 *
 * Streaming is OUT OF SCOPE for v1 (setStatus + a single final chat.postMessage).
 * The upgrade path is a throttled `chat.update` loop over a placeholder message
 * (Slack recommends ≤1 update/sec) driven off the SDK's streaming turn — it can
 * slot in behind postSlackMessage without touching these decoration helpers.
 */

import { Logger } from "@nestjs/common";

const SLACK_API_BASE = "https://slack.com/api";
const ASSISTANT_TIMEOUT_MS = 10_000;
/** Slack renders the prompt `title` as a compact chip — keep it short. */
const PROMPT_TITLE_MAX = 40;
/** Defensive cap on the click-to-send `message` body. */
const PROMPT_MESSAGE_MAX = 500;
const MAX_PROMPTS = 4;

const logger = new Logger("SlackAssistantApi");

export interface AssistantPrompt {
  /** Compact chip label shown in the split-view panel. */
  title: string;
  /** The message text sent as the user when the chip is clicked. */
  message: string;
}

/**
 * Generic starter prompts used when the bound agent has no description to
 * derive from. Slack requires 1–4 prompts; this set is 3.
 */
const GENERIC_PROMPTS: AssistantPrompt[] = [
  { title: "What can you help me with?", message: "What can you help me with?" },
  {
    title: "Give me an example",
    message: "Give me an example of something you can help with.",
  },
  { title: "Help me get started", message: "Help me get started." },
];

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Derive up to 4 suggested prompts for the assistant panel from the bound
 * agent's description. Split on newlines OR sentence boundaries, phrase each
 * fragment as a starter prompt; fall back to the generic set when there is no
 * usable description.
 *
 * NOTE: the current PlatosAgent schema models `name` but NOT `description`
 * (Phase B is schema-free by design), so `description` is effectively always
 * absent today → generic defaults. This function is written to light up
 * automatically if/when a `description` column is added, with no code change.
 */
export function buildAssistantPrompts(
  description?: string | null,
): AssistantPrompt[] {
  if (typeof description === "string" && description.trim()) {
    const parts = description
      // sentence boundary (keep the terminator via lookbehind) OR newline
      .split(/\n+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_PROMPTS);
    if (parts.length > 0) {
      return parts.map((p) => ({
        title: truncate(p, PROMPT_TITLE_MAX),
        message: p.slice(0, PROMPT_MESSAGE_MAX),
      }));
    }
  }
  return GENERIC_PROMPTS;
}

/**
 * POST an assistant.threads.* method, swallowing every failure. Returns void —
 * callers treat this as fire-and-forget decoration. Never throws; never logs
 * the token or body.
 */
async function callAssistantMethod(
  method: string,
  botToken: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!botToken) return;
  let res: Response;
  try {
    res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ASSISTANT_TIMEOUT_MS),
    });
  } catch {
    logger.debug(`[channel-apps] ${method} request failed`);
    return;
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON — treated as failure below */
  }
  if (!json?.ok) {
    logger.debug(
      `[channel-apps] ${method} rejected error=${json?.error ?? res.status}`,
    );
  }
}

/**
 * assistant.threads.setStatus — show an ephemeral "is thinking…" status in the
 * assistant thread. Cleared automatically when the bot next posts a message.
 *   POST https://slack.com/api/assistant.threads.setStatus
 *   body: { channel_id, thread_ts, status }
 */
export async function setAssistantStatus(
  botToken: string,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  if (!channelId || !threadTs) return;
  await callAssistantMethod("assistant.threads.setStatus", botToken, {
    channel_id: channelId,
    thread_ts: threadTs,
    status,
  });
}

/**
 * assistant.threads.setTitle — name the assistant thread (shown in the split
 * view's history list).
 *   POST https://slack.com/api/assistant.threads.setTitle
 *   body: { channel_id, thread_ts, title }
 */
export async function setAssistantTitle(
  botToken: string,
  channelId: string,
  threadTs: string,
  title: string,
): Promise<void> {
  if (!channelId || !threadTs || !title) return;
  await callAssistantMethod("assistant.threads.setTitle", botToken, {
    channel_id: channelId,
    thread_ts: threadTs,
    title,
  });
}

/**
 * assistant.threads.setSuggestedPrompts — seed the split view with 1–4 starter
 * prompt chips (with an optional heading `title`).
 *   POST https://slack.com/api/assistant.threads.setSuggestedPrompts
 *   body: { channel_id, thread_ts, prompts: [{ title, message }], title? }
 */
export async function setAssistantSuggestedPrompts(
  botToken: string,
  channelId: string,
  threadTs: string,
  prompts: AssistantPrompt[],
  title?: string,
): Promise<void> {
  if (!channelId || !threadTs) return;
  const trimmed = (Array.isArray(prompts) ? prompts : [])
    .filter((p) => p && p.title && p.message)
    .slice(0, MAX_PROMPTS);
  if (trimmed.length === 0) return;
  await callAssistantMethod("assistant.threads.setSuggestedPrompts", botToken, {
    channel_id: channelId,
    thread_ts: threadTs,
    prompts: trimmed,
    ...(title ? { title } : {}),
  });
}
