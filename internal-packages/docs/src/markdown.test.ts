import { describe, expect, it } from "vitest";
import { buildSnippet, renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders headings + paragraphs", () => {
    const html = renderMarkdown("# Hello\n\nworld");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<p>world</p>");
  });

  it("preserves code-fence language class", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("language-ts");
    expect(html).toContain("const x = 1;");
  });
});

describe("buildSnippet", () => {
  it("returns null on no match", () => {
    expect(buildSnippet("hello world", "missing", 10)).toBeNull();
  });

  it("returns context around match", () => {
    const snippet = buildSnippet("a b c hello world d e f", "hello", 3);
    expect(snippet).toContain("hello");
    expect(snippet).toMatch(/^…/);
    expect(snippet).toMatch(/…$/);
  });
});
