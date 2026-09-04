// This system's `Prompt`, on the framework's wire.
//
// The domain owns a message array in which every role may carry any content
// part, because what a ROLE may carry is a wire fact and not a domain one. This
// file is where that fact lives. Four roles, four different content shapes:
//
//   system     a plain STRING. Not a part array, on any provider in the
//              catalogue. Its text parts are joined; anything else is refused.
//   user       text, image and file parts.
//   assistant  text, reasoning, file, tool-call and tool-result parts. No image:
//              the wire has nowhere to put one on an assistant turn.
//   tool       tool-result parts only.
//
// A part with no place is REFUSED under `PROVIDERS_MESSAGE_NOT_REPRESENTABLE`
// rather than dropped. Dropping would change what the model sees without saying
// so, which is the failure mode the domain's media-type rule already exists to
// prevent one instance of.
//
// THE CACHE MARKER IS THE OTHER HALF OF `prompt-cache.ts`. The domain decides
// WHICH messages carry a breakpoint; this file decides what a breakpoint IS on
// the wire — `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`.
// That split is deliberate and it is why `honoursExplicitCacheBreakpoints` stays
// in the domain: `placeCacheBreakpoints` needs it to decide whether to place
// markers at all, and this file needs it for the ONE message the domain
// deliberately never touches — the system message, whose marker is set where the
// prompt is assembled and must survive every step. A route that honours no
// explicit marker gets none emitted, including that one, so a prompt assembled
// for one provider and re-routed to another does not spend a budget the new
// provider never agreed to.

import {
  err,
  honoursExplicitCacheBreakpoints,
  messageNotRepresentable,
  ok,
  type ContentPart,
  type ModelRoutePlan,
  type Prompt,
  type PromptMessage,
  type Result,
} from "@platos/context-providers/application/ports/index.js";
import type { ModelMessage } from "ai";

import { embeddableToolResult } from "./json-value.js";

/** The marker an explicit-breakpoint route understands. */
export const EPHEMERAL_CACHE_CONTROL = Object.freeze({
  anthropic: { cacheControl: { type: "ephemeral" as const } },
});

type WireOptions = { providerOptions?: typeof EPHEMERAL_CACHE_CONTROL };

function markerFor(message: PromptMessage, honoured: boolean): WireOptions {
  return message.cacheBreakpoint && honoured ? { providerOptions: EPHEMERAL_CACHE_CONTROL } : {};
}

function fail(role: string, part: ContentPart): Result<never> {
  return err(messageNotRepresentable(role, part.kind));
}

function systemMessage(message: PromptMessage, options: WireOptions): Result<ModelMessage> {
  const text: string[] = [];
  for (const part of message.content) {
    if (part.kind !== "text") return fail("system", part);
    text.push(part.text);
  }
  return ok({ role: "system", content: text.join("\n"), ...options });
}

function userMessage(message: PromptMessage, options: WireOptions): Result<ModelMessage> {
  const content: NonNullable<Extract<ModelMessage, { role: "user" }>["content"]> = [];
  for (const part of message.content) {
    if (part.kind === "text") content.push({ type: "text", text: part.text });
    // An image and a file are both bytes plus a media type, and they are kept
    // apart because the providers treat them as different content blocks. The
    // bytes travel whole: nothing downstream fetches anything, and no provider
    // is handed a URL into this installation's storage.
    else if (part.kind === "image") {
      content.push({ type: "image", image: part.bytes, mediaType: part.mediaType });
    } else if (part.kind === "file") {
      content.push({ type: "file", data: part.bytes, mediaType: part.mediaType });
    } else return fail("user", part);
  }
  return ok({ role: "user", content, ...options });
}

function assistantMessage(message: PromptMessage, options: WireOptions): Result<ModelMessage> {
  const content: NonNullable<Extract<ModelMessage, { role: "assistant" }>["content"]> = [];
  for (const part of message.content) {
    if (part.kind === "text") content.push({ type: "text", text: part.text });
    else if (part.kind === "reasoning") content.push({ type: "reasoning", text: part.text });
    else if (part.kind === "file") content.push({ type: "file", data: part.bytes, mediaType: part.mediaType });
    else if (part.kind === "tool-call") {
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      });
    } else if (part.kind === "tool-result") content.push(toolResultPart(part));
    else return fail("assistant", part);
  }
  return ok({ role: "assistant", content, ...options });
}

function toolMessage(message: PromptMessage, options: WireOptions): Result<ModelMessage> {
  const content: NonNullable<Extract<ModelMessage, { role: "tool" }>["content"]> = [];
  for (const part of message.content) {
    if (part.kind !== "tool-result") return fail("tool", part);
    content.push(toolResultPart(part));
  }
  return ok({ role: "tool", content, ...options });
}

/**
 * One tool result, in the tagged output shape the wire uses.
 *
 * `failed` selects `error-json` rather than `json`, which is what tells the
 * model the tool failed. A failed tool that arrived as an ordinary result would
 * be read as an answer, and the model would build on it.
 */
function toolResultPart(part: Extract<ContentPart, { kind: "tool-result" }>) {
  const value = embeddableToolResult(part.output);
  return {
    type: "tool-result" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: part.failed
      ? ({ type: "error-json" as const, value })
      : ({ type: "json" as const, value }),
  };
}

/**
 * The whole prompt, or the first message that cannot be expressed.
 *
 * Refusing on the FIRST failure rather than collecting them all is deliberate:
 * the caller assembled this prompt, and one named role-and-part pair is what it
 * needs to find the assembler that is wrong.
 */
export function toModelMessages(source: Prompt, plan: ModelRoutePlan): Result<ModelMessage[]> {
  const honoured = honoursExplicitCacheBreakpoints(plan);
  const messages: ModelMessage[] = [];
  for (const message of source.messages) {
    const options = markerFor(message, honoured);
    const mapped =
      message.role === "system"
        ? systemMessage(message, options)
        : message.role === "user"
          ? userMessage(message, options)
          : message.role === "assistant"
            ? assistantMessage(message, options)
            : toolMessage(message, options);
    if (!mapped.ok) return err(mapped.error);
    messages.push(mapped.value);
  }
  return ok(messages);
}

// --- and back again ----------------------------------------------------------
//
// WHY A REVERSE MAPPING EXISTS AT ALL. `rewritePrompt` is called before EVERY
// step, including the ones the framework builds itself: between steps it appends
// the assistant message that asked for tools and the tool message that answered,
// and the cache breakpoint has to move onto them or every later step re-pays
// full price for the whole history. The port is explicit that an implementation
// "MUST call this with the prompt it is about to send, INCLUDING the assistant
// and tool messages the previous steps added, and MUST send what comes back".
// The prompt it is about to send is a wire value at that moment, so honouring
// that sentence means being able to read one back.
//
// IT REFUSES RATHER THAN APPROXIMATES. A wire message carrying something this
// vocabulary has no word for — a provider-executed tool call, an approval part,
// a file the provider holds by reference rather than by bytes — comes back as
// null, and the caller then leaves that step's messages exactly as the framework
// built them. That costs the moving breakpoint for one step, which is money;
// rebuilding the message without the part would cost correctness, which is the
// turn. The first prompt is rewritten before the request is built, so a
// single-step generation is never affected either way.

function toBytes(data: unknown): Uint8Array | null {
  return data instanceof Uint8Array ? data : null;
}

function fromToolOutput(output: unknown): { value: unknown; failed: boolean } | null {
  if (output === null || typeof output !== "object") return null;
  const tagged = output as { type?: unknown; value?: unknown };
  if (tagged.type === "json" || tagged.type === "text") return { value: tagged.value, failed: false };
  if (tagged.type === "error-json" || tagged.type === "error-text") {
    return { value: tagged.value, failed: true };
  }
  return null;
}

function fromWireParts(role: PromptMessage["role"], parts: readonly unknown[]): ContentPart[] | null {
  const content: ContentPart[] = [];
  for (const raw of parts) {
    if (raw === null || typeof raw !== "object") return null;
    const part = raw as Record<string, unknown>;
    switch (part.type) {
      case "text":
        content.push({ kind: "text", text: String(part.text ?? "") });
        break;
      case "reasoning":
        content.push({ kind: "reasoning", text: String(part.text ?? "") });
        break;
      case "image": {
        const bytes = toBytes(part.image);
        if (bytes === null || typeof part.mediaType !== "string") return null;
        content.push({ kind: "image", mediaType: part.mediaType, bytes });
        break;
      }
      case "file": {
        const bytes = toBytes(part.data);
        if (bytes === null || typeof part.mediaType !== "string") return null;
        content.push({ kind: "file", mediaType: part.mediaType, bytes });
        break;
      }
      case "tool-call":
        if (part.providerExecuted === true) return null;
        content.push({
          kind: "tool-call",
          toolCallId: String(part.toolCallId ?? ""),
          toolName: String(part.toolName ?? ""),
          input: part.input,
        });
        break;
      case "tool-result": {
        const output = fromToolOutput(part.output);
        if (output === null) return null;
        content.push({
          kind: "tool-result",
          toolCallId: String(part.toolCallId ?? ""),
          toolName: String(part.toolName ?? ""),
          output: output.value,
          failed: output.failed,
        });
        break;
      }
      default:
        return null;
    }
  }
  return content.length === 0 ? null : content;
}

function carriesMarker(message: ModelMessage): boolean {
  const options = (message as { providerOptions?: Record<string, unknown> }).providerOptions;
  if (options === undefined) return false;
  const anthropic = options.anthropic as Record<string, unknown> | undefined;
  return anthropic !== undefined && anthropic.cacheControl !== undefined;
}

/** A wire message array read back into a `Prompt`, or null when one cannot be. */
export function fromModelMessages(messages: readonly ModelMessage[]): Prompt | null {
  const read: PromptMessage[] = [];
  for (const message of messages) {
    const cacheBreakpoint = carriesMarker(message);
    if (message.role === "system") {
      read.push({ role: "system", content: [{ kind: "text", text: message.content }], cacheBreakpoint });
      continue;
    }
    const raw = message.content;
    const content =
      typeof raw === "string"
        ? ([{ kind: "text", text: raw }] as ContentPart[])
        : fromWireParts(message.role, raw);
    if (content === null) return null;
    read.push({ role: message.role, content, cacheBreakpoint });
  }
  return read.length === 0 ? null : { messages: read };
}

/**
 * Move the markers onto the messages the framework is about to send.
 *
 * Returns the rewritten array, or null when the array could not be read back —
 * in which case the caller sends the framework's own array unchanged. Nothing
 * here invents a placement: the whole decision is `rewritePrompt`'s, which the
 * use case binds to this environment's cache policy.
 */
export function rewriteWireMessages(
  messages: readonly ModelMessage[],
  plan: ModelRoutePlan,
  rewritePrompt: (prompt: Prompt) => Prompt,
): ModelMessage[] | null {
  const read = fromModelMessages(messages);
  if (read === null) return null;
  const rewritten = toModelMessages(rewritePrompt(read), plan);
  return rewritten.ok ? rewritten.value : null;
}
