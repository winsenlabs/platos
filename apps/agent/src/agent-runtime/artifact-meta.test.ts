/**
 * Theme F.6 — unit tests for the artifact meta-tool pure-logic validators.
 *
 * Network / DB / filesystem are not touched (CLAUDE.md §9.11 — Vitest only,
 * never mock — but this module is pure so nothing needs to be mocked).
 * The end-to-end wiring (DB row write + scope stamp) is exercised on the
 * VPS test endpoints after deploy.
 */

import { describe, it, expect } from "vitest";
import {
  ARTIFACT_KINDS,
  MAX_CONTENT_BYTES,
  checkSize,
  isArtifactKind,
  newArtifactKey,
  validateContentForKind,
  validateHtmlContent,
  validateImageContent,
  validateJsonContent,
  validateKind,
  validateSvgContent,
} from "./artifact-meta";

describe("artifact-meta: kind allowlist", () => {
  it("ARTIFACT_KINDS matches the canonical list (PLATOS_SPEC §4.2)", () => {
    expect([...ARTIFACT_KINDS]).toEqual([
      "markdown",
      "code",
      "html",
      "json",
      "csv",
      "svg",
      "image",
    ]);
  });

  it("isArtifactKind narrows valid + rejects unknown", () => {
    expect(isArtifactKind("markdown")).toBe(true);
    expect(isArtifactKind("pdf")).toBe(false);
    expect(isArtifactKind(null)).toBe(false);
    expect(isArtifactKind(42)).toBe(false);
    expect(isArtifactKind("")).toBe(false);
  });

  it("validateKind throws on unknown", () => {
    expect(() => validateKind("pdf")).toThrow(/Invalid artifact kind/);
    expect(() => validateKind(null)).toThrow(/Invalid artifact kind/);
    expect(() => validateKind("markdown")).not.toThrow();
  });
});

describe("artifact-meta: size cap", () => {
  it("accepts content at the limit", () => {
    expect(() => checkSize("x".repeat(1024))).not.toThrow();
  });

  it("rejects content over MAX_CONTENT_BYTES", () => {
    const tooBig = "x".repeat(MAX_CONTENT_BYTES + 1);
    expect(() => checkSize(tooBig)).toThrow(/too large/);
  });
});

describe("artifact-meta: HTML validator", () => {
  it("accepts plain tags", () => {
    expect(() => validateHtmlContent("<h1>Hello</h1><p>world</p>")).not.toThrow();
  });

  it("rejects <script>", () => {
    expect(() => validateHtmlContent("<p>x</p><script>alert(1)</script>")).toThrow(/<script>/);
    expect(() => validateHtmlContent("< script >alert(1)< / script >")).toThrow(/<script>/);
  });

  it("rejects inline event handlers", () => {
    expect(() => validateHtmlContent('<div onclick="alert(1)">x</div>')).toThrow(/event handler/);
    expect(() => validateHtmlContent('<img onerror="x" />')).toThrow(/event handler/);
  });

  it("rejects javascript: URIs", () => {
    expect(() => validateHtmlContent('<a href="javascript:alert(1)">x</a>')).toThrow(
      /javascript:/,
    );
  });

  it("rejects iframe srcdoc smuggling", () => {
    expect(() => validateHtmlContent('<iframe srcdoc="<script>x</script>"></iframe>')).toThrow(
      /srcdoc/,
    );
  });
});

describe("artifact-meta: JSON validator", () => {
  it("accepts valid JSON", () => {
    expect(() => validateJsonContent('{"a":1,"b":[1,2]}')).not.toThrow();
    expect(() => validateJsonContent("[]")).not.toThrow();
    expect(() => validateJsonContent('"a string"')).not.toThrow();
  });

  it("rejects invalid JSON", () => {
    expect(() => validateJsonContent("{a:1}")).toThrow(/did not parse/);
    expect(() => validateJsonContent("not json")).toThrow(/did not parse/);
  });
});

describe("artifact-meta: SVG validator", () => {
  it("accepts a plain SVG", () => {
    expect(() => validateSvgContent('<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>')).not.toThrow();
  });

  it("accepts SVG with XML declaration", () => {
    expect(() =>
      validateSvgContent(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>',
      ),
    ).not.toThrow();
  });

  it("rejects content that is not SVG", () => {
    expect(() => validateSvgContent("<div>hi</div>")).toThrow(/must start with <svg>/);
  });

  it("rejects <script> inside SVG", () => {
    expect(() => validateSvgContent("<svg><script>x</script></svg>")).toThrow(/<script>/);
  });

  it("rejects inline event handlers inside SVG", () => {
    expect(() => validateSvgContent('<svg><rect onclick="x"/></svg>')).toThrow(/event handler/);
  });
});

describe("artifact-meta: image validator", () => {
  it("accepts platos-attachment:// reference", () => {
    expect(() => validateImageContent("platos-attachment://abc123")).not.toThrow();
  });

  it("accepts data:image URL", () => {
    expect(() => validateImageContent("data:image/png;base64,iVBORw0KGgo=")).not.toThrow();
    expect(() => validateImageContent("data:image/svg+xml;base64,PHN2ZyAv")).not.toThrow();
  });

  it("rejects raw binary or random strings", () => {
    expect(() => validateImageContent("raw png bytes...")).toThrow(/platos-attachment/);
    expect(() => validateImageContent("http://example.com/x.png")).toThrow(/platos-attachment/);
  });
});

describe("artifact-meta: validateContentForKind", () => {
  it("rejects empty content", () => {
    expect(() => validateContentForKind("markdown", "")).toThrow(/cannot be empty/);
  });

  it("accepts markdown + code + csv as-is (non-empty)", () => {
    expect(() => validateContentForKind("markdown", "# hi")).not.toThrow();
    expect(() =>
      validateContentForKind("code", "function x() { return 1; }"),
    ).not.toThrow();
    expect(() => validateContentForKind("csv", "a,b,c\n1,2,3")).not.toThrow();
  });

  it("routes html/svg/json/image to their validators", () => {
    expect(() => validateContentForKind("html", "<script>x</script>")).toThrow();
    expect(() => validateContentForKind("svg", "not svg")).toThrow();
    expect(() => validateContentForKind("json", "{bad}")).toThrow();
    expect(() => validateContentForKind("image", "nope")).toThrow();
  });
});

describe("artifact-meta: newArtifactKey", () => {
  it("returns distinct keys across calls", () => {
    const a = newArtifactKey();
    const b = newArtifactKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^a_[a-z0-9]+_[a-z0-9]+$/);
  });
});
