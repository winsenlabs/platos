/**
 * @internal/docs — content reader + lexical search for `content/docs/*.md`
 * + `content/guides/*.md`. Consumed by:
 *   - `apps/webapp/app/routes/api.v1.public.*` — HTTP API for the
 *     marketing site / external consumers.
 *   - `apps/agent/src/mcp-platform/docs-mcp.controller.ts` — public-tier
 *     MCP service exposing docs as MCP resources + a `search_docs` tool.
 *
 * Both consumers MUST use this package so search semantics stay identical
 * across surfaces (per Phase 3 spec).
 */

export {
  splitFrontmatter,
  parseYamlBlock,
  normalizeFrontmatter,
  parseDoc,
  type DocFrontmatter,
} from "./frontmatter.js";

export { renderMarkdown, buildSnippet } from "./markdown.js";

export {
  DocRepository,
  type DocEntry,
  type DocKind,
  type DocSummary,
  type SearchResult,
  type RepositoryConfig,
} from "./repository.js";

import { DocRepository, type RepositoryConfig } from "./repository.js";

let _shared: DocRepository | null = null;

/**
 * Process-singleton — the typical case for both webapp + agent. The
 * `contentRoot` is resolved once on first call. Tests should construct
 * their own `DocRepository` directly to avoid bleeding state between
 * test files.
 */
export function getSharedRepository(config: RepositoryConfig): DocRepository {
  if (_shared) return _shared;
  _shared = new DocRepository(config);
  return _shared;
}

/** Reset the singleton — only meaningful for tests. */
export function resetSharedRepository(): void {
  _shared = null;
}
