// Building the message array one turn is run against.
//
// THE SYSTEM MESSAGE RIDES INSIDE THE ARRAY, AND THAT IS NOT A STYLE CHOICE.
// `providers`' `Prompt` is a list of `PromptMessage`, each of which can carry a
// `cacheBreakpoint`; a bare `system: string` field cannot. The source's
// non-streaming path passes `instructions:` instead of a system message and
// therefore cannot attach provider options to it — which is why its cached
// prefix works on one code path and not the other. One shape here, both paths.
//
// THE ORDER IS THE CACHE ORDER, LONGEST-LIVED FIRST:
//
//   1. system      — the composed skill runtime. Stable across the whole thread.
//   2. summary     — the compaction summary, when there is one. Changes rarely.
//   3. transcript  — the history. Grows at the end.
//   4. memory      — retrieved context. RECOMPUTED EVERY TURN, so it goes AFTER
//                    the history rather than in the stable prefix. Putting it
//                    earlier would invalidate the cached prefix on every turn,
//                    which is the single most expensive mistake available here.
//   5. the message — what the end user just said.
//
// THIS CONTEXT PLACES NO CACHE BREAKPOINTS AND CANNOT. `placeCacheBreakpoints`
// and `selectCacheBreakpoints` are deliberately NOT on `providers`' published
// surface; the port's `rewritePrompt` hook is bound inside `providers` from
// them, and it re-places the markers before EVERY step. So the array built here
// carries no markers, `withinCacheBudget` finds none over budget, and the
// placement stays behind the boundary that owns it. What this file controls is
// the ORDER, which is the half of cache economics that lives on this side.
//
// ATTACHMENTS ARE NAMED, NOT EMBEDDED, AND THE LIMIT IS STATED RATHER THAN HIDDEN.
// `providers`' `ImagePart` and `FilePart` carry `bytes: Uint8Array`. `files`
// publishes an attachment's metadata (`describeAttachment`) and a download
// address (`requestDownload`); it publishes no method that answers bytes, and a
// context whose `application/` may not perform I/O cannot dereference an
// address. So an admitted attachment enters the prompt as a text reference
// carrying its name, media type and size, and native multimodal routing needs
// one bytes-returning method on `files`' contract — which is `files`' to add,
// not this context's to work around. `admitAttachments` still runs in full: all
// four ceilings are enforced, so a turn cannot smuggle a gigabyte past them by
// the reference path.

import { prompt, promptMessage, textPart } from "@platos/context-providers";
import type { Prompt, PromptMessage } from "@platos/context-providers";
import { err, ok, type Result } from "@platos/kernel";

import type { AttachmentCandidate, Transcript } from "../domain/index.js";

export interface PromptRequest {
  /** `skills.composeRuntime` already joined the base prompt to the blocks. */
  readonly systemPrompt: string;
  readonly transcript: Transcript;
  /** Rendered memory context, or null when there was none or it was skipped. */
  readonly memoryBlock: string | null;
  readonly userText: string;
  readonly attachments: readonly AttachmentCandidate[];
}

function message(role: PromptMessage["role"], text: string): Result<PromptMessage> {
  return promptMessage({ role, content: [textPart(text)] });
}

/** One line per admitted attachment. Deterministic, so a cached prefix stays cached. */
export function renderAttachmentReferences(attachments: readonly AttachmentCandidate[]): string {
  const lines = attachments.map(
    (attachment) => `- ${attachment.fileId} (${attachment.mediaType}, ${attachment.bytes} bytes)`,
  );
  return `The user attached ${attachments.length} file(s):\n${lines.join("\n")}`;
}

/**
 * Assemble the prompt, or refuse.
 *
 * Every refusal here is `providers`' own — an empty message, a content part with
 * no media type, a tool result answering a call nobody made. They are returned
 * unchanged rather than re-coded, because a caller that sees
 * `PROVIDERS_PROMPT_EMPTY` learns exactly what is wrong, and re-labelling it
 * `CONVERSATIONS_TURN_INPUT_INVALID` would put a second, less precise name on a
 * decision this context did not make.
 */
export function buildPrompt(request: PromptRequest): Result<Prompt> {
  const messages: PromptMessage[] = [];

  const system = message("system", request.systemPrompt);
  if (!system.ok) return err(system.error);
  messages.push(system.value);

  if (request.transcript.summary !== null) {
    const summary = message("system", `Summary of earlier turns:\n${request.transcript.summary}`);
    if (!summary.ok) return err(summary.error);
    messages.push(summary.value);
  }

  for (const entry of request.transcript.entries) {
    const built = message(entry.role, entry.text);
    if (!built.ok) return err(built.error);
    messages.push(built.value);
  }

  if (request.memoryBlock !== null && request.memoryBlock !== "") {
    const memory = message("system", request.memoryBlock);
    if (!memory.ok) return err(memory.error);
    messages.push(memory.value);
  }

  const userText =
    request.attachments.length === 0
      ? request.userText
      : `${request.userText}\n\n${renderAttachmentReferences(request.attachments)}`;
  const user = message("user", userText);
  if (!user.ok) return err(user.error);
  messages.push(user.value);

  return prompt(messages);
}

/**
 * Render retrieved memory into one block, or answer null.
 *
 * NULL WHEN THERE IS NOTHING, never an empty block. An empty `<memory>` section
 * is prompt an installation pays for on every step of every turn for no
 * information, and it changes the cache prefix in a way an absent section does
 * not.
 */
export function renderMemoryBlock(memories: readonly string[]): string | null {
  if (memories.length === 0) return null;
  return `Relevant context from earlier conversations:\n${memories.map((line) => `- ${line}`).join("\n")}`;
}

/** Convenience for a caller that has already refused everything it means to. */
export function unwrapPrompt(built: Result<Prompt>): Result<Prompt> {
  return built.ok ? ok(built.value) : err(built.error);
}
