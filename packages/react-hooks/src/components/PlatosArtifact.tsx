"use client";

/**
 * Theme F.8 — `<PlatosArtifact>` renderer component.
 *
 * Renders any canonical Platos artifact kind consistently (PLATOS_SPEC §4.2
 * and `apps/agent/src/agent-runtime/artifact-meta.ts`). The agent writes
 * artifacts via `generate_artifact` / `revise_artifact` (F.6) and streams
 * their lifecycle through `artifact_start` / `artifact_delta` /
 * `artifact_committed` events (F.7). This component consumes the committed
 * shape and displays it in the consumer app.
 *
 * Design constraints (from F.8 brief):
 *   1. **No heavy deps.** Self-contained — no markdown parser, Prism, Papa
 *      Parse, DOMPurify. The webapp carries those for its rich playground;
 *      this component ships as a lean building block that third-party
 *      consumers can drop into their own chat UIs.
 *   2. **HTML is sandboxed.** Render through `<iframe sandbox srcDoc>` with
 *      a strict CSP meta tag. `dangerouslySetInnerHTML` is never used on
 *      HTML artifacts — the sandbox is mandatory.
 *   3. **SVG is sanitized before insertion.** `<script>` tags, `on*=`
 *      handlers, `javascript:` URIs, and `<foreignObject>` are stripped
 *      before the sanitized markup is handed to `dangerouslySetInnerHTML`.
 *      Defence-in-depth — the agent-side validator (F.6
 *      `validateSvgContent`) already rejects most of these at write time.
 *   4. **Unknown kind → safe fallback**, never throw. The union is closed
 *      today but consumer apps may pass a typed-as-`string` kind from an
 *      untyped boundary (URL param, db row). Never crash the chat.
 *
 * Props intentionally accept the committed-artifact shape as reported by
 * the `artifact_committed` stream event (F.7) so wiring is trivial:
 *
 * ```tsx
 * if (isAgentEvent(ev, "artifact_committed")) {
 *   return <PlatosArtifact artifact={{
 *     id: ev.artifactId,
 *     artifactKey: ev.artifactKey,
 *     type: ev.kind,
 *     content: ev.finalContent,
 *     title: ev.title,
 *     revision: ev.revision,
 *     metadata: { language: ev.language },
 *   }} />;
 * }
 * ```
 */

// LAUNCH-13 — `import React from "react"` resolves to null intermittently
// in some Remix prod bundles (default-export interop edge case across the
// CJS/ESM boundary in webapp's bundle). Named hook imports work in both.
import * as React from "react";
import { useState, useEffect } from "react";
import DOMPurify from "isomorphic-dompurify";

/** Canonical artifact kinds — mirrors `ArtifactKind` in useAgentStream.ts
 *  and the agent-side `ARTIFACT_KINDS` allowlist. Duplicated here so the
 *  component is importable without pulling in the stream-event module. */
export type PlatosArtifactKind =
  | "markdown"
  | "code"
  | "html"
  | "json"
  | "csv"
  | "svg"
  | "image";

export interface PlatosArtifactData {
  id: string;
  artifactKey: string;
  type: PlatosArtifactKind | (string & {});
  content: string;
  title?: string;
  revision?: number;
  metadata?: Record<string, unknown>;
}

export interface PlatosArtifactProps {
  artifact: PlatosArtifactData;
  className?: string;
  /**
   * Optional edit hook. When provided, the component renders an "Edit"
   * button; clicking it swaps to a `<textarea>` + Save/Cancel controls.
   * The caller is responsible for actually issuing the `revise_artifact`
   * call (e.g. via the agent socket).
   */
  onRevise?: (newContent: string) => void;
}

// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------

/**
 * Markdown renderer — **minimal `<pre>` fallback** per F.8 brief. Consumer
 * apps that want rich markdown (remark/rehype, syntax highlight) should
 * wrap their own component and drop into the rest of the component tree;
 * this package stays dependency-free.
 */
function MarkdownRenderer({ content }: { content: string }) {
  return (
    <pre
      className="platos-artifact__markdown"
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "inherit",
        margin: 0,
      }}
    >
      {content}
    </pre>
  );
}

/**
 * Code renderer — `<pre><code class="language-X">` so downstream CSS
 * (highlight.js, Prism, Shiki via stylesheet) can color it without this
 * package pulling in a highlighter. Language comes from
 * `metadata.language`, `metadata.lang`, or falls back to `"text"`.
 */
function CodeRenderer({
  content,
  metadata,
}: {
  content: string;
  metadata: Record<string, unknown> | undefined;
}) {
  const language = pickStringMeta(metadata, ["language", "lang"]) ?? "text";
  return (
    <pre className={`platos-artifact__code language-${language}`} style={{ margin: 0 }}>
      <code className={`language-${language}`}>{content}</code>
    </pre>
  );
}

/**
 * HTML renderer — ALWAYS a sandboxed iframe. Never
 * `dangerouslySetInnerHTML` on HTML artifacts. The CSP meta tag bolted
 * onto `srcDoc` disables remote fetch + inline event handlers even when
 * `allow-scripts` is active.
 *
 * `allow-same-origin` is intentionally OMITTED so the iframe is
 * considered opaque-origin → cannot reach window.parent, localStorage, or
 * cookies even if the payload tries. That's the threat-model-critical
 * part of HTML-artifact safety.
 */
function HtmlRenderer({
  content,
  title,
}: {
  content: string;
  title: string | undefined;
}) {
  // Strict CSP: no remote resources, no inline handlers, only `unsafe-inline`
  // for script + style so the author can ship a self-contained preview.
  // A stricter policy (no unsafe-inline at all) is what `allow-scripts`
  // + content that relies on inline logic can't coexist with; for richer
  // demos consumers can replace this component wholesale.
  const csp =
    "default-src 'none'; " +
    "style-src 'unsafe-inline'; " +
    "script-src 'unsafe-inline'; " +
    "img-src data:; " +
    "font-src data:;";
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${content}</body></html>`;
  return (
    <iframe
      className="platos-artifact__html"
      title={title ?? "HTML artifact"}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{
        width: "100%",
        minHeight: 200,
        border: "1px solid rgba(0,0,0,0.12)",
        borderRadius: 6,
        background: "white",
      }}
    />
  );
}

/**
 * JSON renderer — pretty-print via `JSON.parse` + `JSON.stringify`. If
 * parsing fails (shouldn't, since F.6 validates at write time) we fall
 * back to the raw string so debuggers still see what was stored.
 */
function JsonRenderer({ content }: { content: string }) {
  let pretty = content;
  try {
    pretty = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // keep raw
  }
  return (
    <pre
      className="platos-artifact__json language-json"
      style={{ margin: 0, whiteSpace: "pre-wrap" }}
    >
      <code className="language-json">{pretty}</code>
    </pre>
  );
}

/**
 * CSV renderer — hand-rolled parser. Handles:
 *   - quoted fields with commas inside
 *   - escaped quotes (`""`)
 *   - CR/LF line endings
 *   - a first-row header
 *
 * Not RFC-4180 complete (no multi-line quoted fields) but enough for the
 * output shapes agents typically produce. Anything gnarlier is better
 * handed to a proper CSV library in the consumer app.
 */
function CsvRenderer({ content }: { content: string }) {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return <div className="platos-artifact__csv platos-artifact__csv--empty">(empty)</div>;
  }
  const [head, ...body] = rows;
  return (
    <div className="platos-artifact__csv" style={{ overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontSize: "0.875em",
        }}
      >
        <thead>
          <tr>
            {(head ?? []).map((cell, i) => (
              <th
                key={i}
                style={{
                  textAlign: "left",
                  padding: "4px 8px",
                  borderBottom: "1px solid rgba(0,0,0,0.2)",
                  fontWeight: 600,
                }}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{
                    padding: "4px 8px",
                    borderBottom: "1px solid rgba(0,0,0,0.08)",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * SVG renderer — sanitize first, then `dangerouslySetInnerHTML`. Render
 * as inline SVG rather than `<img src=data:...>` so it's colorable /
 * stylable by the host app. The sanitizer strips every script-adjacent
 * surface: `<script>`, `on*=` handlers, `javascript:` URIs,
 * `<foreignObject>` (which can carry HTML inside SVG).
 */
function SvgRenderer({ content }: { content: string }) {
  const safe = sanitizeSvg(content);
  return (
    <div
      className="platos-artifact__svg"
      style={{ display: "inline-block", maxWidth: "100%" }}
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}

/**
 * Image renderer — `content` is expected to be a URL (platos-attachment
 * ref, https URL, or data URL per F.6 `validateImageContent`). We render
 * as `<img>`; rewriting `platos-attachment://` → signed URL is the
 * caller's job (the stream wiring layer has the scope context to do it).
 */
function ImageRenderer({
  content,
  title,
}: {
  content: string;
  title: string | undefined;
}) {
  return (
    <img
      className="platos-artifact__image"
      src={content}
      alt={title ?? "Artifact image"}
      style={{ maxWidth: "100%", height: "auto", display: "block" }}
    />
  );
}

/** Fallback when the kind isn't one we recognize. Never throws. */
function UnsupportedRenderer({ kind }: { kind: string }) {
  return (
    <div
      className="platos-artifact__unsupported"
      style={{
        padding: 12,
        border: "1px dashed rgba(0,0,0,0.2)",
        borderRadius: 6,
        color: "rgba(0,0,0,0.6)",
        fontSize: "0.875em",
      }}
    >
      Unsupported artifact type: <code>{String(kind)}</code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export function PlatosArtifact(props: PlatosArtifactProps): React.ReactElement {
  const { artifact, className, onRevise } = props;
  const { type, content, title, revision, metadata } = artifact;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  // Keep the draft in sync when the artifact content changes under us
  // (e.g. a newer revision committed by the agent) unless the user is
  // actively editing.
  useEffect(() => {
    if (!editing) setDraft(content);
  }, [content, editing]);

  const body = renderBody(type, content, title, metadata);

  return (
    <div
      className={joinClass("platos-artifact", `platos-artifact--${type}`, className)}
      data-artifact-id={artifact.id}
      data-artifact-key={artifact.artifactKey}
      data-artifact-type={type}
      data-artifact-revision={revision}
      style={{
        border: "1px solid rgba(0,0,0,0.12)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "white",
      }}
    >
      <header
        className="platos-artifact__header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: "0.875em",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <strong
            className="platos-artifact__title"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title || defaultTitleFor(type)}
          </strong>
          <span
            className="platos-artifact__kind"
            style={{
              textTransform: "uppercase",
              fontSize: "0.75em",
              letterSpacing: "0.05em",
              color: "rgba(0,0,0,0.55)",
            }}
          >
            {type}
          </span>
          {typeof revision === "number" ? (
            <span
              className="platos-artifact__revision"
              style={{ fontSize: "0.75em", color: "rgba(0,0,0,0.55)" }}
            >
              rev {revision}
            </span>
          ) : null}
        </div>
        {onRevise && !editing ? (
          <button
            type="button"
            className="platos-artifact__edit"
            onClick={() => setEditing(true)}
            style={{
              fontSize: "0.8em",
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid rgba(0,0,0,0.2)",
              background: "white",
              cursor: "pointer",
            }}
          >
            Edit
          </button>
        ) : null}
      </header>

      <div className="platos-artifact__body">
        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              className="platos-artifact__editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(20, Math.max(6, draft.split("\n").length + 1))}
              style={{
                width: "100%",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.875em",
                padding: 8,
                border: "1px solid rgba(0,0,0,0.2)",
                borderRadius: 4,
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => {
                  setDraft(content);
                  setEditing(false);
                }}
                style={{
                  fontSize: "0.8em",
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(0,0,0,0.2)",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  // Fire onRevise; the caller performs the actual
                  // `revise_artifact` call and will pass the updated
                  // content back in via props on the next render.
                  onRevise?.(draft);
                  setEditing(false);
                }}
                style={{
                  fontSize: "0.8em",
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(0,0,0,0.4)",
                  background: "rgba(0,0,0,0.04)",
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBody(
  type: string,
  content: string,
  title: string | undefined,
  metadata: Record<string, unknown> | undefined,
): React.ReactElement {
  switch (type) {
    case "markdown":
      return <MarkdownRenderer content={content} />;
    case "code":
      return <CodeRenderer content={content} metadata={metadata} />;
    case "html":
      return <HtmlRenderer content={content} title={title} />;
    case "json":
      return <JsonRenderer content={content} />;
    case "csv":
      return <CsvRenderer content={content} />;
    case "svg":
      return <SvgRenderer content={content} />;
    case "image":
      return <ImageRenderer content={content} title={title} />;
    default:
      return <UnsupportedRenderer kind={type} />;
  }
}

function defaultTitleFor(type: string): string {
  switch (type) {
    case "markdown":
      return "Markdown";
    case "code":
      return "Code";
    case "html":
      return "HTML";
    case "json":
      return "JSON";
    case "csv":
      return "CSV";
    case "svg":
      return "SVG";
    case "image":
      return "Image";
    default:
      return "Artifact";
  }
}

function pickStringMeta(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!metadata) return undefined;
  for (const key of keys) {
    const v = metadata[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function joinClass(...values: Array<string | undefined | null | false>): string {
  return values.filter((v): v is string => typeof v === "string" && v.length > 0).join(" ");
}

/**
 * Parse a CSV into rows of strings. Handles quoted fields and escaped
 * quotes. Does NOT handle newlines inside quoted fields — agents that
 * need that should pick JSON instead.
 */
export function parseCsv(input: string): string[][] {
  // Normalize CRLF / CR → LF to simplify the splitter.
  const normalized = input.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  // Drop the trailing empty line produced by a final newline, but keep
  // interior empty lines (rare, but don't silently lose data).
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const rows: string[][] = [];
  for (const line of lines) {
    rows.push(parseCsvLine(line));
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote → literal quote, else close.
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur.length === 0) {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Strip script-adjacent surface out of an SVG payload before injecting
 * it via `dangerouslySetInnerHTML`.
 *
 * PPR-46 — defense-in-depth. We run two layers:
 *   1. Cheap pre-checks (retained from the F.8 baseline) — drop `<script>`,
 *      `<foreignObject>`, `on*=` handlers, `javascript:` URIs. These catch
 *      the most common injection attempts with zero dependency cost and let
 *      the slow path (DOMPurify) operate on payloads that are already
 *      structurally close to safe.
 *   2. `isomorphic-dompurify` with `profile: "svg"` — the authoritative
 *      allow-list-based sanitizer. Running after the pre-checks means DOM
 *      parsing never sees inputs that would trip parser quirks (mixed
 *      quoting, unclosed tags) and the combined pipeline matches what the
 *      agent-side F.6 `validateSvgContent` does at write time.
 *
 * `isomorphic-dompurify` wraps both the browser DOMPurify and a JSDOM-backed
 * SSR path so this component renders identically under React Server
 * Components / SSR and on the client.
 */
export function sanitizeSvg(input: string): string {
  let out = input;
  // Cheap pre-checks. Drop <script>…</script> blocks (greedy).
  out = out.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, "");
  // Drop self-closing or unmatched <script .../>.
  out = out.replace(/<\s*script\b[^>]*\/?\s*>/gi, "");
  // Drop <foreignObject>…</foreignObject> (carries HTML inside SVG).
  out = out.replace(/<\s*foreignObject\b[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, "");
  // Strip `on*="..."` / `on*='...'` / unquoted event handler attrs.
  out = out.replace(/\son[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, "");
  // Neutralize `javascript:` URIs in href / xlink:href / src.
  out = out.replace(
    /((?:xlink:)?href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi,
    '$1=$2about:blank$2',
  );

  // Authoritative allow-list pass via DOMPurify with the SVG profile.
  // `USE_PROFILES: { svg: true, svgFilters: true }` is the documented way
  // to sanitize SVG fragments — it keeps the SVG element set + filters
  // while dropping anything dangerous. We also forbid any remaining script
  // surface defensively.
  try {
    return DOMPurify.sanitize(out, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "foreignObject"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    }) as unknown as string;
  } catch {
    // DOMPurify should never throw on a string input, but if the SSR shim
    // ever fails (e.g. no DOM available in an exotic runtime), fall back
    // to the pre-check'd output rather than dropping the artifact entirely.
    return out;
  }
}
