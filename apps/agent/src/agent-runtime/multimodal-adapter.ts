/**
 * multimodal-adapter — Theme D.6.
 *
 * Turns "this model supports image/file parts" into a boolean so the agent
 * runtime can decide whether to route attachments as native multimodal
 * content OR fall back to a sidecar vision model + text summary.
 *
 * The registry is explicit so we don't silently ship attachments into
 * models that only see text (they'd be dropped or error out).
 *
 * Providers supported today (April 2026):
 *   - anthropic: all Claude 3+ models accept images (documents via pdf input)
 *   - openai: gpt-4o + gpt-4.1 families accept images; older models don't
 *   - google: gemini-1.5+ and gemini-2.5+ all accept images + video
 *   - google-vertex: mirrors google
 *
 * If we can't confidently say the model is multimodal, we fall back.
 */

import type { ResolvedAttachment } from "./attachments.service";

export interface ModelCapabilities {
  /** Accepts the ai-SDK `ImagePart`. */
  image: boolean;
  /** Accepts audio via FilePart (Gemini's native multimodal). */
  audio: boolean;
  /** Accepts video via FilePart (Gemini). */
  video: boolean;
  /** Accepts PDFs / other documents as file parts (Claude + Gemini). */
  document: boolean;
}

function matches(model: string, prefixes: string[]): boolean {
  const lower = model.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p));
}

export function capabilitiesFor(modelString: string): ModelCapabilities {
  const colon = modelString.indexOf(":");
  const provider = colon > 0 ? modelString.slice(0, colon) : "anthropic";
  const model = colon > 0 ? modelString.slice(colon + 1) : modelString;

  switch (provider) {
    case "anthropic": {
      // All Claude 3, 3.5, 3.7, 4, 4.5, 4.6, 4.7 accept images + PDFs.
      const isClaude3Plus = matches(model, [
        "claude-3",
        "claude-opus-",
        "claude-sonnet-",
        "claude-haiku-",
      ]);
      return {
        image: isClaude3Plus,
        audio: false,
        video: false,
        document: isClaude3Plus,
      };
    }
    case "openai": {
      // gpt-4o, gpt-4.1, o1-pro, gpt-4-vision families are multimodal.
      const isVision = matches(model, [
        "gpt-4o",
        "gpt-4.1",
        "gpt-4-vision",
        "gpt-4-turbo",
        "gpt-5",
        "o1",
        "o3",
        "o4",
      ]);
      // PPR-60 — PDF / document input is accepted by gpt-4o, gpt-4.1, and
      // gpt-5 families (per OpenAI docs circa 2025/2026). Older gpt-3.5 /
      // gpt-4-turbo / o* families do NOT take documents — leave those off
      // so we fall back to the sidecar / text-description path.
      const acceptsDocuments = matches(model, [
        "gpt-4o",
        "gpt-4.1",
        "gpt-5",
      ]);
      return {
        image: isVision,
        audio: false,
        video: false,
        document: acceptsDocuments,
      };
    }
    case "google":
    case "google-vertex": {
      // Gemini 1.5+ is fully multimodal (text, image, audio, video, file).
      const isGeminiMultimodal = matches(model, [
        "gemini-1.5",
        "gemini-2.",
        "gemini-flash",
        "gemini-pro",
      ]);
      return {
        image: isGeminiMultimodal,
        audio: isGeminiMultimodal,
        video: isGeminiMultimodal,
        document: isGeminiMultimodal,
      };
    }
    default:
      return { image: false, audio: false, video: false, document: false };
  }
}

/**
 * Decide, for a given model and attachment set, whether we can route the
 * attachments natively (returns true) or must fall back to a sidecar vision
 * pass (returns false). Fails fast if any attachment has a kind the model
 * doesn't support.
 */
export function canRouteNatively(
  modelString: string,
  attachments: ResolvedAttachment[],
): boolean {
  if (attachments.length === 0) return true;
  const caps = capabilitiesFor(modelString);
  return attachments.every((a) => caps[a.kind] === true);
}

/**
 * Build a text-only description stub when a model can't see the attachment.
 * In production this would call a sidecar vision model (e.g. gpt-4o-mini)
 * to produce a short caption. For v1 we return a clear structured summary
 * that names the file + size + type so the LLM can at least acknowledge it.
 *
 * A "sidecar" flag is kept so future expansions can replace this with a
 * real vision pass without changing the call site.
 */
export function textFallbackDescription(
  attachment: ResolvedAttachment,
): string {
  const size = humanizeBytes(attachment.bytes);
  const name = attachment.originalName ? ` "${attachment.originalName}"` : "";
  switch (attachment.kind) {
    case "image":
      return `[Image attachment${name} — ${attachment.mimeType}, ${size}. The selected model cannot read images; re-run with a multimodal model (e.g. gpt-4o, claude-sonnet-4-6, gemini-2.5-pro) to have the agent analyze it.]`;
    case "audio":
      return `[Audio attachment${name} — ${attachment.mimeType}, ${size}. The selected model cannot read audio; re-run with gemini-2.5-pro for audio.]`;
    case "video":
      return `[Video attachment${name} — ${attachment.mimeType}, ${size}. The selected model cannot read video; re-run with gemini-2.5-pro for video.]`;
    default:
      return `[Document attachment${name} — ${attachment.mimeType}, ${size}. The selected model cannot read documents; use a Claude or Gemini model for PDF/document understanding.]`;
  }
}

function humanizeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
