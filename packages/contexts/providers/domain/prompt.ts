// What a turn actually sends to a model, in this system's own vocabulary.
//
// ADR M0.3 §1 row 16 makes `conversations` the turn-execution engine and the
// deepest node in the DAG. It can only be lifted out of `apps/agent` if a turn
// can be composed WITHOUT the inference framework in scope, and a turn is
// mostly a message array. So the message array has to be a value this system
// owns rather than a vendor's type re-exported under a local alias — which is
// exactly what the extraction source does today (`type CoreMessage =
// ModelMessage`), and exactly why the ban in `inference-sdk-only` would
// otherwise be unsatisfiable.
//
// FOUR THINGS THIS SHAPE PRESERVES FROM THE RUNNING SYSTEM, each because
// getting it wrong there cost something real:
//
//   1. SYSTEM IS A MESSAGE, NOT A FIELD. The source deliberately carries the
//      system prompt inside the message array rather than as a separate
//      parameter, because a message can carry a cache breakpoint and a bare
//      string field cannot. `prompt-cache.ts` is the whole reason; putting
//      `system` back into a `string` here would silently un-cache the single
//      most valuable breakpoint in a turn.
//
//   2. A MEDIA PART WITHOUT A MEDIA TYPE IS REJECTED, not inferred. The source
//      once built these parts without one, and every non-image attachment threw
//      at the provider and failed the WHOLE turn; images survived only because
//      the bytes could be sniffed. `mediaType` is required here and its absence
//      is a named refusal a caller can handle, before any material moves.
//
//   3. BYTES, NOT A URL AND NOT BASE64. The source resolves an attachment to a
//      `Uint8Array` and hands that over. Keeping the bytes means the part is
//      complete: nothing downstream has to fetch anything, and no provider is
//      handed a URL into this installation's storage.
//
//   4. A TOOL RESULT NAMES THE CALL IT ANSWERS. A round trip is only a round
//      trip if the second half can be matched to the first, and a dangling
//      result is the shape a provider rejects the entire request over.
//
// NO VENDOR NAME APPEARS BELOW, and none may. The mapping from these parts onto
// a provider's wire format belongs to the one adapter that holds the SDK.

import { err, ok, type Result } from "@platos/kernel";

import {
  mediaTypeMissing,
  promptContentEmpty,
  promptEmpty,
  toolCallDuplicated,
  toolResultUnmatched,
} from "./errors.js";

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface TextPart {
  readonly kind: "text";
  readonly text: string;
}

/**
 * An image the model is expected to look at.
 *
 * Separate from `FilePart` even though both are bytes plus a media type,
 * because providers treat them as different content blocks and the source
 * branches on exactly this distinction.
 */
export interface ImagePart {
  readonly kind: "image";
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** Any other attachment: a document, audio, video. */
export interface FilePart {
  readonly kind: "file";
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** The model asking for a tool to be run. Produced by a model, never by a caller. */
export interface ToolCallPart {
  readonly kind: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** The answer to one `ToolCallPart`, fed back in on the next round trip. */
export interface ToolResultPart {
  readonly kind: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  /** True when the tool itself failed. The model is told, and may recover. */
  readonly failed: boolean;
}

/**
 * A model's own intermediate reasoning, where a provider emits it.
 *
 * Carried so a transcript can be replayed faithfully. Its tokens are already
 * inside `outputTokens` and are NOT priced again — see `generation.ts`.
 */
export interface ReasoningPart {
  readonly kind: "reasoning";
  readonly text: string;
}

export type ContentPart = TextPart | ImagePart | FilePart | ToolCallPart | ToolResultPart | ReasoningPart;

export interface PromptMessage {
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  /**
   * True when the prompt UP TO AND INCLUDING this message should be cached.
   *
   * A boolean and not a vendor marker: what a provider does with it — an
   * explicit breakpoint, an automatic prefix cache, or nothing at all — is the
   * adapter's business. `prompt-cache.ts` decides where these go.
   */
  readonly cacheBreakpoint: boolean;
}

/** A whole request's messages, in order. Never empty. */
export interface Prompt {
  readonly messages: readonly PromptMessage[];
}

export interface PromptMessageDraft {
  readonly role: MessageRole;
  readonly content: readonly ContentPart[];
  readonly cacheBreakpoint?: boolean;
}

export function textPart(text: string): TextPart {
  return { kind: "text", text };
}

/** One part's media type, or null for a part that has none. */
function mediaTypeOf(part: ContentPart): string | null {
  return part.kind === "image" || part.kind === "file" ? part.mediaType : null;
}

/**
 * Build one message, refusing the two shapes a provider rejects the request
 * over: an empty content array, and a media part with no media type.
 *
 * Both are refused HERE rather than at the wire because the wire is inside the
 * adapter, where the caller cannot catch anything: by the time the provider
 * complains, the turn has already been charged for the round trip it takes to
 * find out.
 */
export function promptMessage(draft: PromptMessageDraft): Result<PromptMessage> {
  if (draft.content.length === 0) return err(promptContentEmpty(draft.role));
  for (const part of draft.content) {
    const mediaType = mediaTypeOf(part);
    if (mediaType !== null && mediaType.trim() === "") {
      return err(mediaTypeMissing(draft.role, part.kind));
    }
  }
  return ok({
    role: draft.role,
    content: Object.freeze([...draft.content]),
    cacheBreakpoint: draft.cacheBreakpoint ?? false,
  });
}

/**
 * Assemble a prompt and check the one invariant that spans messages: every tool
 * result answers a tool call that was already asked for, and no call is
 * answered twice.
 *
 * This is a WHOLE-PROMPT rule and cannot be checked per message, which is why
 * `promptMessage` does not try. A duplicate id and an unmatched id are separate
 * refusals because they have separate causes — the first is a caller replaying
 * a result, the second is a caller dropping the assistant message that asked
 * for it — and an operator reading one code cannot tell which happened.
 */
export function prompt(messages: readonly PromptMessage[]): Result<Prompt> {
  if (messages.length === 0) return err(promptEmpty());

  const asked = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.kind === "tool-call") {
        if (asked.has(part.toolCallId)) return err(toolCallDuplicated(part.toolCallId));
        asked.add(part.toolCallId);
      }
      if (part.kind === "tool-result") {
        if (!asked.has(part.toolCallId) || answered.has(part.toolCallId)) {
          return err(toolResultUnmatched(part.toolCallId, part.toolName));
        }
        answered.add(part.toolCallId);
      }
    }
  }
  return ok({ messages: Object.freeze([...messages]) });
}

/**
 * How many content blocks a message occupies, as a provider counts them.
 *
 * Never zero: a message always occupies at least one block, and undercounting
 * would let the gap between two cache breakpoints exceed a provider's lookback
 * window. Transcribed from the source's `countContentBlocks`, whose comment
 * says the same thing for the same reason.
 */
export function countContentBlocks(message: PromptMessage): number {
  return Math.max(1, message.content.length);
}
