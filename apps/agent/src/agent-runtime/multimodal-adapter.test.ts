/**
 * PPR-39 — multimodal-adapter non-native fallback test.
 *
 * The canRouteNatively → textFallbackDescription pipeline is what keeps the
 * agent from silently dropping attachments when the user picks a text-only
 * model. Exercises:
 *   - capabilitiesFor by provider/model
 *   - canRouteNatively: true for empty set + multimodal models
 *   - canRouteNatively: FALSE when the model can't read the attachment kind
 *   - textFallbackDescription emits a clear structured stub
 *
 * CLAUDE.md §9.11: Vitest only, no mocks — everything in this module is pure.
 */
import { describe, it, expect } from "vitest";
import {
  capabilitiesFor,
  canRouteNatively,
  textFallbackDescription,
} from "./multimodal-adapter";
import type { ResolvedAttachment } from "./attachments.service";

function makeAttachment(
  kind: "image" | "audio" | "video" | "document",
  overrides: Partial<ResolvedAttachment> = {},
): ResolvedAttachment {
  return {
    id: "att_1",
    kind,
    mimeType:
      kind === "image"
        ? "image/png"
        : kind === "audio"
          ? "audio/mpeg"
          : kind === "video"
            ? "video/mp4"
            : "application/pdf",
    bytes: 1024,
    data: new Uint8Array([1, 2, 3]),
    originalName: `file.${kind}`,
    ...overrides,
  };
}

describe("capabilitiesFor — by provider", () => {
  it("anthropic claude-3+ accepts image + document, not audio/video", () => {
    const caps = capabilitiesFor("anthropic:claude-sonnet-4-6");
    expect(caps.image).toBe(true);
    expect(caps.document).toBe(true);
    expect(caps.audio).toBe(false);
    expect(caps.video).toBe(false);
  });

  it("openai gpt-4o accepts image + document, not audio/video", () => {
    const caps = capabilitiesFor("openai:gpt-4o");
    expect(caps.image).toBe(true);
    expect(caps.document).toBe(true);
    expect(caps.audio).toBe(false);
  });

  it("openai gpt-3.5 accepts nothing multimodal", () => {
    const caps = capabilitiesFor("openai:gpt-3.5-turbo");
    expect(caps.image).toBe(false);
    expect(caps.document).toBe(false);
  });

  it("google gemini-2.5 accepts everything", () => {
    const caps = capabilitiesFor("google:gemini-2.5-pro");
    expect(caps.image).toBe(true);
    expect(caps.audio).toBe(true);
    expect(caps.video).toBe(true);
    expect(caps.document).toBe(true);
  });

  it("unknown provider defaults to no multimodal", () => {
    const caps = capabilitiesFor("weird-provider:foo");
    expect(caps.image).toBe(false);
    expect(caps.audio).toBe(false);
    expect(caps.video).toBe(false);
    expect(caps.document).toBe(false);
  });
});

describe("canRouteNatively", () => {
  it("empty attachment array → true (short-circuit)", () => {
    expect(canRouteNatively("openai:gpt-3.5-turbo", [])).toBe(true);
  });

  it("claude-sonnet-4-6 + image → true (native multimodal)", () => {
    expect(canRouteNatively("anthropic:claude-sonnet-4-6", [makeAttachment("image")])).toBe(true);
  });

  it("gpt-3.5-turbo + image → FALSE (non-multimodal fallback path)", () => {
    expect(canRouteNatively("openai:gpt-3.5-turbo", [makeAttachment("image")])).toBe(false);
  });

  it("anthropic + audio → false (claude doesn't take audio)", () => {
    expect(canRouteNatively("anthropic:claude-sonnet-4-6", [makeAttachment("audio")])).toBe(false);
  });

  it("one multimodal + one unsupported → false (all-or-nothing)", () => {
    expect(
      canRouteNatively("anthropic:claude-sonnet-4-6", [
        makeAttachment("image"), // supported
        makeAttachment("audio"), // not supported by claude
      ]),
    ).toBe(false);
  });

  it("gemini-2.5-pro + video → true", () => {
    expect(canRouteNatively("google:gemini-2.5-pro", [makeAttachment("video")])).toBe(true);
  });
});

describe("textFallbackDescription", () => {
  it("produces a clear stub for image when model lacks vision", () => {
    const fallback = textFallbackDescription(makeAttachment("image"));
    expect(fallback).toContain("Image attachment");
    expect(fallback).toContain("cannot read images");
    expect(fallback).toContain("multimodal model");
  });

  it("produces a clear stub for audio", () => {
    const fallback = textFallbackDescription(makeAttachment("audio"));
    expect(fallback).toContain("Audio attachment");
    expect(fallback).toContain("cannot read audio");
  });

  it("produces a clear stub for video", () => {
    const fallback = textFallbackDescription(makeAttachment("video"));
    expect(fallback).toContain("Video attachment");
  });

  it("produces a clear stub for document", () => {
    const fallback = textFallbackDescription(makeAttachment("document"));
    expect(fallback).toContain("Document attachment");
  });

  it("includes file size in human-readable form", () => {
    const bigFile = makeAttachment("image", { bytes: 2 * 1024 * 1024 });
    const stub = textFallbackDescription(bigFile);
    expect(stub).toMatch(/2\.0MB/);
  });

  it("includes originalName when available", () => {
    const named = makeAttachment("image", { originalName: "vacation.png" });
    const stub = textFallbackDescription(named);
    expect(stub).toContain("vacation.png");
  });

  it("omits name gracefully when originalName is null", () => {
    const unnamed = makeAttachment("image", { originalName: null });
    const stub = textFallbackDescription(unnamed);
    // Should not include any double-quote mark from the `"${originalName}"` template.
    expect(stub).not.toMatch(/"null"/);
    expect(stub).toContain("Image attachment");
  });
});

describe("Integration — non-multimodal fallback path end-to-end", () => {
  /**
   * Simulates what AgentService does: for each attachment, check if the
   * model can route natively; if not, substitute a text stub.
   */
  it("fallback text is emitted when canRouteNatively returns false", () => {
    const model = "openai:gpt-3.5-turbo";
    const attachment = makeAttachment("image", { originalName: "pic.png", bytes: 500 });
    const native = canRouteNatively(model, [attachment]);
    expect(native).toBe(false);
    // When not native, the runtime picks textFallbackDescription — downstream
    // the agent receives ONLY the stub text (not raw bytes, which the model
    // would ignore or error on).
    const stub = textFallbackDescription(attachment);
    expect(stub).toContain("pic.png");
    expect(stub).toContain("500B");
  });
});
