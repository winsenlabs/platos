/**
 * @platosdev/client — message rating API surface (issue: thumbs up/down SDK gap).
 *
 * Wraps the message-rating REST endpoints on the agent service
 * (`apps/agent/src/agent-runtime/agent.controller.ts`):
 *   - POST   /api/v1/agent/messages/:messageId/rating   (upsert a vote)
 *   - DELETE /api/v1/agent/messages/:messageId/rating   (remove the vote)
 *   - GET    /api/v1/agent/messages/:messageId/rating    (current vote + counts)
 *
 * The backend, MCP tool (`messages.rate`), memory-feedback loop, and dashboard
 * satisfaction views all shipped previously — but the rating action was never
 * reachable from the published SDK, so embedded chat surfaces (the react-widget,
 * custom apps) had no way to let end users vote. This namespace closes that gap.
 *
 * `messageId` is the SERVER-side `PlatosAgentMessage.id` — surfaced to streaming
 * clients on the `message_persisted` event (see PlatosStreamEvent), NOT the
 * provisional client-generated bubble id.
 */

import type { PlatosClient } from "../client.js";
import { PlatosNotFoundError } from "../errors.js";
import type { PlatosScope } from "../types.js";

/** Up = thumbs up (+1), down = thumbs down (-1). */
export type PlatosRatingDirection = "up" | "down";

export interface PlatosMessageRating {
  readonly id: string;
  readonly messageId: string;
  readonly rating: 1 | -1;
  readonly comment: string | null;
  readonly userId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatosMessageRatingState {
  /** The current user's vote on this message, or null if they haven't voted. */
  readonly userRating: PlatosMessageRating | null;
  /** Anonymized aggregate counts across all users in scope. */
  readonly aggregate: { ups: number; downs: number };
}

function dirToInt(dir: PlatosRatingDirection): 1 | -1 {
  return dir === "up" ? 1 : -1;
}

export class MessagesApi {
  constructor(private readonly client: PlatosClient) {}

  /**
   * Cast (or change) a thumbs up/down vote on an assistant message. Idempotent
   * per (message, user) — re-rating overwrites the prior vote. Pass a `comment`
   * to attach free-text feedback (surfaced in the dashboard +, for thumbs-down,
   * carried into the memory-feedback flag).
   *
   * `messageId` MUST be the server message id from the `message_persisted`
   * stream event, not a provisional client id.
   */
  async rate(
    messageId: string,
    direction: PlatosRatingDirection,
    opts: { comment?: string | null } = {},
    scope?: PlatosScope,
  ): Promise<PlatosMessageRating> {
    const res = await this.client._fetch<{ rating: PlatosMessageRating; error?: string }>(
      `/api/v1/agent/messages/${encodeURIComponent(messageId)}/rating`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: dirToInt(direction),
          ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
        }),
      },
      scope,
    );
    if (!res?.rating) {
      throw new Error(res?.error || "rating failed");
    }
    return res.rating;
  }

  /**
   * Remove the current user's vote on a message (the neutral "un-rate" state).
   * Returns true if a row was deleted.
   */
  async unrate(messageId: string, scope?: PlatosScope): Promise<boolean> {
    const res = await this.client._fetch<{ removed: boolean }>(
      `/api/v1/agent/messages/${encodeURIComponent(messageId)}/rating`,
      { method: "DELETE" },
      scope,
    );
    return res?.removed ?? false;
  }

  /**
   * Fetch the current user's vote + anonymized aggregate counts for a message.
   * Returns null if the message doesn't exist / isn't in scope.
   */
  async getForMessage(
    messageId: string,
    scope?: PlatosScope,
  ): Promise<PlatosMessageRatingState | null> {
    try {
      return await this.client._fetch<PlatosMessageRatingState>(
        `/api/v1/agent/messages/${encodeURIComponent(messageId)}/rating`,
        { method: "GET" },
        scope,
      );
    } catch (err) {
      if (err instanceof PlatosNotFoundError) return null;
      throw err;
    }
  }
}
