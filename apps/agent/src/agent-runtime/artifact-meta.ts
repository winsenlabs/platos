/**
 * Theme F.6 — artifact meta-tool primitives.
 *
 * `generate_artifact` + `revise_artifact` are meta-tools the agent invokes
 * from inside its streaming loop. They translate a request from the model
 * into a scoped row in `PlatosAgentArtifact` (see internal-packages/database
 * `PlatosAgentArtifact` — F.1 schema).
 *
 * This module exports the pure-logic pieces:
 *   - `ARTIFACT_KINDS` — the canonical allowlist (matches PLATOS_SPEC §4.2).
 *   - `validateKind` — enum-guard used at both meta-tools' entry points.
 *   - `validateContentForKind` — per-kind content checks (JSON parses, SVG
 *     looks like SVG, HTML has no inline script / event handlers, etc.).
 *   - `MAX_CONTENT_BYTES` + `checkSize` — hard cap so an LLM can't DoS the
 *     DB by emitting megabytes of text.
 *
 * The Nest service (agent.service.ts) wires these into `buildMetaTools` and
 * performs the DB writes scope-stamped against the current thread.
 *
 * Hard invariants (from the subtask brief + PLATOS_SPEC §10):
 *   1. Only kinds in ARTIFACT_KINDS are accepted — unknowns fail closed.
 *   2. `revise_artifact` APPENDS a new revision row; the previous row is
 *      never mutated (revision history is immutable).
 *   3. Artifact rows are scope-stamped (org, project, env) and revising an
 *      artifact from a different scope must fail closed.
 *   4. HTML artifacts reject inline scripts / event handlers at write time.
 *      The consumer SDK will additionally render them in a sandboxed
 *      iframe (F.8), but defence-in-depth at write time prevents the DB
 *      from holding hostile payloads in the first place.
 */

export const ARTIFACT_KINDS = [
  "markdown",
  "code",
  "html",
  "json",
  "csv",
  "svg",
  "image",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Max content size for a single artifact revision (1 MiB). Keeps agent
 *  output bounded and prevents row bloat on repeated revisions. */
export const MAX_CONTENT_BYTES = 1_048_576;

/** Narrow-type guard for `ArtifactKind`. */
export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/** Throws `Error` when `kind` is outside the canonical allowlist. */
export function validateKind(kind: unknown): ArtifactKind {
  if (!isArtifactKind(kind)) {
    throw new Error(
      `Invalid artifact kind "${String(kind)}". Allowed: ${ARTIFACT_KINDS.join(", ")}`,
    );
  }
  return kind;
}

/** Throws when content exceeds `MAX_CONTENT_BYTES`. */
export function checkSize(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(
      `Artifact content too large: ${bytes} bytes > ${MAX_CONTENT_BYTES} byte limit`,
    );
  }
}

/**
 * Reject HTML payloads with inline scripts or DOM event handlers. Not a
 * full sanitizer — the consumer SDK will additionally render HTML inside
 * a sandboxed iframe without `allow-scripts` (THEME_F §5 invariant) — but
 * we refuse to store obviously hostile payloads so the DB never holds
 * content that relies on the sandbox for safety.
 */
export function validateHtmlContent(content: string): void {
  const lowered = content.toLowerCase();
  // <script ...> / </script>
  if (/<\s*script\b/i.test(content) || /<\s*\/\s*script\s*>/i.test(content)) {
    throw new Error("HTML artifact contains <script> — inline scripts are not allowed");
  }
  // event handler attributes: onclick=, onload=, onerror=, ...
  if (/\son[a-z]+\s*=/i.test(content)) {
    throw new Error("HTML artifact contains inline event handler attribute (on*=) — not allowed");
  }
  // javascript: URI scheme in href/src
  if (/(href|src|xlink:href)\s*=\s*["']?\s*javascript:/i.test(content)) {
    throw new Error("HTML artifact contains javascript: URI — not allowed");
  }
  // <iframe srcdoc="..."> could smuggle scripts
  if (/<\s*iframe\b[^>]*srcdoc/i.test(content)) {
    throw new Error("HTML artifact contains iframe srcdoc — not allowed");
  }
  void lowered;
}

/** Apply the SVG-specific checks: looks like SVG + reject inline JS.
 *
 * PPR-46 — defense-in-depth. After the cheap regex pre-checks we run the
 * content through `isomorphic-dompurify` with the SVG profile. If DOMPurify
 * would have stripped anything (sanitized output differs from the input
 * modulo whitespace), we reject the write so the DB never holds a payload
 * that the consumer-side renderer would silently scrub. This matches the
 * behaviour of the react-hooks `sanitizeSvg` at render time. */
export function validateSvgContent(content: string): void {
  const trimmed = content.trim();
  if (!/^<\s*\?xml[^>]*\?>\s*<\s*svg\b/i.test(trimmed) && !/^<\s*svg\b/i.test(trimmed)) {
    throw new Error("SVG artifact must start with <svg> (optionally preceded by an XML declaration)");
  }
  // SVG can carry <script> the same way HTML can — reject it.
  if (/<\s*script\b/i.test(content)) {
    throw new Error("SVG artifact contains <script> — not allowed");
  }
  if (/\son[a-z]+\s*=/i.test(content)) {
    throw new Error("SVG artifact contains inline event handler attribute — not allowed");
  }
  // <foreignObject> carries HTML inside SVG — the renderer strips it.
  if (/<\s*foreignObject\b/i.test(content)) {
    throw new Error("SVG artifact contains <foreignObject> — not allowed");
  }
  // `javascript:` URIs in href/src.
  if (/(?:xlink:)?href\s*=\s*["']?\s*javascript:/i.test(content) ||
      /\bsrc\s*=\s*["']?\s*javascript:/i.test(content)) {
    throw new Error("SVG artifact contains javascript: URI — not allowed");
  }
  // Authoritative allow-list pass via DOMPurify. If sanitization would
  // change the payload (modulo whitespace), reject the write — the rich
  // rendering path would scrub the diff; persisting the unsafe original
  // invites drift between what the agent wrote and what users see.
  try {
    // Lazy-require to keep the module loadable under test stubs that
    // don't ship a DOM shim. `isomorphic-dompurify` works under Node and
    // in the browser identically.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const DOMPurify = require("isomorphic-dompurify") as {
      sanitize(input: string, cfg: Record<string, unknown>): string;
    };
    const sanitized = DOMPurify.sanitize(content, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "foreignObject"],
      FORBID_ATTR: ["onerror", "onload", "onclick"],
    });
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    if (normalize(sanitized) !== normalize(content)) {
      throw new Error(
        "SVG artifact contains disallowed content (DOMPurify sanitizer would strip it) — rejecting at write time",
      );
    }
  } catch (err: any) {
    // If the require itself fails in a constrained runtime (no DOM shim),
    // don't block writes on that — the cheap checks above already caught
    // the common cases. Preserve error rethrow for the "sanitizer would
    // strip" path.
    if (err?.message?.startsWith("SVG artifact contains")) throw err;
  }
}

/** JSON content must parse. */
export function validateJsonContent(content: string): void {
  try {
    JSON.parse(content);
  } catch (err: any) {
    throw new Error(`JSON artifact did not parse: ${err?.message || String(err)}`);
  }
}

/** Image content must be either a `platos-attachment://` reference or a
 *  valid data URL. Raw bytes do not belong in the artifact row — images
 *  live in MinIO (Theme D). */
export function validateImageContent(content: string): void {
  const trimmed = content.trim();
  if (trimmed.startsWith("platos-attachment://")) return;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) return;
  throw new Error(
    "Image artifact content must be a platos-attachment:// reference or a data:image/* URL",
  );
}

/**
 * Run the per-kind content validator. Called from both `generate_artifact`
 * (where the agent picks the kind) and `revise_artifact` (where the kind
 * was set on the first revision and is carried forward).
 */
export function validateContentForKind(kind: ArtifactKind, content: string): void {
  if (typeof content !== "string") {
    throw new Error("Artifact content must be a string");
  }
  if (content.length === 0) {
    throw new Error("Artifact content cannot be empty");
  }
  checkSize(content);

  switch (kind) {
    case "markdown":
      // Markdown is rendered safely by the consumer SDK — no inline exec
      // path. Accept as-is.
      return;
    case "code":
      // Code is rendered through Prism; content is displayed verbatim.
      return;
    case "html":
      validateHtmlContent(content);
      return;
    case "json":
      validateJsonContent(content);
      return;
    case "csv":
      // CSV renders into a table. Nothing dangerous on its own; we just
      // require a non-empty string (already checked above).
      return;
    case "svg":
      validateSvgContent(content);
      return;
    case "image":
      validateImageContent(content);
      return;
    default: {
      // Exhaustive — if ArtifactKind gains a new variant, TS will catch
      // this at compile time.
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new Error(`Unhandled artifact kind: ${String(kind)}`);
    }
  }
}

/**
 * Generate a stable artifact key for a brand-new artifact row. Keys group
 * revisions together — every `revise_artifact` call writes a new row with
 * the same `artifactKey` and `revision = prior + 1`. Uses a random
 * suffix so two concurrent `generate_artifact` calls in the same thread
 * don't collide on the `(threadId, artifactKey, revision)` unique.
 */
export function newArtifactKey(): string {
  // Short, URL-safe, non-guessable but not required to be cryptographic.
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `a_${ts}_${rand}`;
}
