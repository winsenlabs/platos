/**
 * Phase 3 — markdown → HTML renderer.
 *
 * Uses `marked` v4 (already in the workspace). Default config:
 *   - GFM tables + strikethrough enabled.
 *   - `mangle: false` + `headerIds: true` for stable anchor links.
 *   - Code-fence rendering keeps the language class so a downstream
 *     client-side highlighter (Prism, Shiki) can colorize without us
 *     bundling a heavy syntax engine on the server.
 *
 * The content under `content/docs` + `content/guides` is authored by us
 * (not user-generated), so we don't run a server-side HTML sanitizer.
 * `marked@4.x` escapes raw HTML in code blocks by default; raw inline HTML
 * is allowed but our docs don't use any. If we ever accept community-
 * contributed docs we'll wire DOMPurify (already used client-side in
 * AskAI.tsx).
 */

import { marked } from "marked";

let configured = false;
function configure(): void {
  if (configured) return;
  marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: true,
    mangle: false,
    smartLists: true,
  });
  configured = true;
}

/** Render markdown body text to HTML. Synchronous + cheap. */
export function renderMarkdown(body: string): string {
  configure();
  return marked.parse(body) as string;
}

/**
 * Extract a plain-text snippet around the first occurrence of `query`
 * (case-insensitive) in `body`. Returns `null` if no match. Used by the
 * search endpoint to highlight where a hit landed.
 */
export function buildSnippet(body: string, query: string, ctxChars = 120): string | null {
  if (!query.trim()) return null;
  const lower = body.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - ctxChars);
  const end = Math.min(body.length, idx + query.length + ctxChars);
  let snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < body.length) snippet += "…";
  return snippet;
}
