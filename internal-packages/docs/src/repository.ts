/**
 * Phase 3 — content repository.
 *
 * Reads markdown files from `content/docs/*.md` + `content/guides/*.md`,
 * parses + caches them in memory, and exposes list/get/search helpers
 * that both the webapp HTTP API + the agent MCP service consume.
 *
 * Contract:
 *   - `loadAll()` is idempotent; subsequent calls reuse the cached index
 *     unless `mtime` on a source file has changed (dev-friendly).
 *   - In production the cache is read-once-at-boot — calling `loadAll`
 *     repeatedly only re-stats directories, not the whole content tree.
 *   - All search routines are pure / side-effect free given a loaded index.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseDoc, type DocFrontmatter } from "./frontmatter.js";
import { renderMarkdown, buildSnippet } from "./markdown.js";

export type DocKind = "docs" | "guides";

export interface DocEntry {
  kind: DocKind;
  slug: string;
  filePath: string;
  mtimeMs: number;
  frontmatter: DocFrontmatter;
  /** Raw markdown body (no frontmatter). */
  markdown: string;
  /** Lazily computed; populated on first read via `getEntry`. */
  html?: string;
}

export interface DocSummary {
  slug: string;
  kind: DocKind;
  title: string;
  description: string;
  category: string;
  order: number;
  trigger_dev_primitive: boolean;
  trigger_dev_link: string;
  questions: string[];
  related: string[];
}

export interface SearchResult {
  slug: string;
  kind: DocKind;
  title: string;
  category: string;
  score: number;
  /** The matched question text when the hit came from `questions[]`. */
  matchedQuestion: string | null;
  /** Plain-text snippet from the body (or `null` if matched on title only). */
  snippet: string | null;
}

export interface RepositoryConfig {
  /**
   * Absolute path to the repo root. The repository looks for
   * `content/docs/*.md` and `content/guides/*.md` under here.
   */
  contentRoot: string;
  /**
   * In tests we want to disable mtime-based invalidation so we can warm
   * the cache once and trust the result. Production callers leave this
   * defaulted (`true`).
   */
  watchMtime?: boolean;
}

interface IndexState {
  loadedAt: number;
  docs: Map<string, DocEntry>;
  guides: Map<string, DocEntry>;
}

export class DocRepository {
  private state: IndexState | null = null;
  private loadingPromise: Promise<IndexState> | null = null;

  constructor(private readonly config: RepositoryConfig) {}

  private get watchMtime(): boolean {
    return this.config.watchMtime ?? true;
  }

  private docsDir(): string {
    return path.join(this.config.contentRoot, "content", "docs");
  }

  private guidesDir(): string {
    return path.join(this.config.contentRoot, "content", "guides");
  }

  private async readKind(kind: DocKind): Promise<Map<string, DocEntry>> {
    const dir = kind === "docs" ? this.docsDir() : this.guidesDir();
    const out = new Map<string, DocEntry>();
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Missing dir is treated as empty — keeps tests + early dev sane.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      const name = dirent.name;
      // Skip the inventory + drift markers + anything not a content doc.
      if (name.startsWith("_") || name.startsWith(".")) continue;
      if (!name.endsWith(".md")) continue;
      const slug = name.slice(0, -3);
      const filePath = path.join(dir, name);
      const stat = await fs.stat(filePath);
      const source = await fs.readFile(filePath, "utf8");
      const { frontmatter, body } = parseDoc(source, slug);
      out.set(slug, {
        kind,
        slug,
        filePath,
        mtimeMs: stat.mtimeMs,
        frontmatter,
        markdown: body,
      });
    }
    return out;
  }

  /** Force-reload everything from disk. */
  private async loadFresh(): Promise<IndexState> {
    const [docs, guides] = await Promise.all([this.readKind("docs"), this.readKind("guides")]);
    return { loadedAt: Date.now(), docs, guides };
  }

  /**
   * Ensure the index is loaded. Re-checks mtimes + reloads if any changed.
   * In prod this still walks the dir once per call but skips reading file
   * bodies when nothing has moved — fast enough for the request path.
   */
  private async ensureLoaded(): Promise<IndexState> {
    if (this.loadingPromise) return this.loadingPromise;
    if (!this.state) {
      this.loadingPromise = this.loadFresh().then((s) => {
        this.state = s;
        this.loadingPromise = null;
        return s;
      });
      return this.loadingPromise;
    }
    if (!this.watchMtime) return this.state;
    // mtime fast-path — if any file's mtime moved, drop the cache.
    const stale = await this.isStale(this.state);
    if (stale) {
      this.loadingPromise = this.loadFresh().then((s) => {
        this.state = s;
        this.loadingPromise = null;
        return s;
      });
      return this.loadingPromise;
    }
    return this.state;
  }

  private async isStale(state: IndexState): Promise<boolean> {
    const checkDir = async (kind: DocKind): Promise<boolean> => {
      const dir = kind === "docs" ? this.docsDir() : this.guidesDir();
      let dirents: import("node:fs").Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      const known = kind === "docs" ? state.docs : state.guides;
      const seen = new Set<string>();
      for (const d of dirents) {
        if (!d.isFile() || !d.name.endsWith(".md") || d.name.startsWith("_") || d.name.startsWith(".")) {
          continue;
        }
        const slug = d.name.slice(0, -3);
        seen.add(slug);
        const stat = await fs.stat(path.join(dir, d.name));
        const cached = known.get(slug);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) return true;
      }
      // File deleted from disk?
      for (const slug of known.keys()) {
        if (!seen.has(slug)) return true;
      }
      return false;
    };
    return (await checkDir("docs")) || (await checkDir("guides"));
  }

  async listDocs(): Promise<DocSummary[]> {
    const state = await this.ensureLoaded();
    return summariesFor(state.docs.values(), "docs");
  }

  async listGuides(): Promise<DocSummary[]> {
    const state = await this.ensureLoaded();
    return summariesFor(state.guides.values(), "guides");
  }

  async getDoc(slug: string): Promise<DocEntry | null> {
    const state = await this.ensureLoaded();
    return getEntry(state.docs, slug);
  }

  async getGuide(slug: string): Promise<DocEntry | null> {
    const state = await this.ensureLoaded();
    return getEntry(state.guides, slug);
  }

  async listAll(): Promise<DocSummary[]> {
    const state = await this.ensureLoaded();
    return [
      ...summariesFor(state.docs.values(), "docs"),
      ...summariesFor(state.guides.values(), "guides"),
    ];
  }

  /**
   * Lexical search across both docs + guides.
   *
   * Ranking:
   *   - 1.00 — exact phrase match on a question in `questions[]`.
   *   - 0.85 — all query terms appear in a single question (any order).
   *   - 0.70 — exact phrase match in title or description.
   *   - 0.55 — all query terms in title.
   *   - 0.30..0.50 — body matches, scaled by term coverage.
   *
   * Snippets prefer the body match if any; otherwise null.
   */
  async search(query: string, kind: DocKind | "all", limit = 10): Promise<SearchResult[]> {
    const state = await this.ensureLoaded();
    const trimmed = query.trim();
    if (!trimmed) return [];
    const corpus: DocEntry[] = [];
    if (kind === "docs" || kind === "all") corpus.push(...state.docs.values());
    if (kind === "guides" || kind === "all") corpus.push(...state.guides.values());

    const phrase = trimmed.toLowerCase();
    const terms = phrase.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const results: SearchResult[] = [];
    for (const entry of corpus) {
      const fm = entry.frontmatter;
      const title = fm.title.toLowerCase();
      const description = fm.description.toLowerCase();
      const body = entry.markdown.toLowerCase();
      let score = 0;
      let matchedQuestion: string | null = null;

      // 1. Question-exact phrase.
      for (const q of fm.questions) {
        const qLower = q.toLowerCase();
        if (qLower.includes(phrase)) {
          score = Math.max(score, 1.0);
          matchedQuestion = q;
          break;
        }
      }
      // 2. All terms in a single question.
      if (score < 0.85) {
        for (const q of fm.questions) {
          const qLower = q.toLowerCase();
          const allHit = terms.every((t) => qLower.includes(t));
          if (allHit) {
            score = Math.max(score, 0.85);
            if (!matchedQuestion) matchedQuestion = q;
            break;
          }
        }
      }
      // 3. Exact phrase in title or description.
      if (title.includes(phrase) || description.includes(phrase)) {
        score = Math.max(score, 0.7);
      }
      // 4. All terms in title.
      if (terms.every((t) => title.includes(t))) {
        score = Math.max(score, 0.55);
      }
      // 5. Body coverage.
      const bodyHits = terms.filter((t) => body.includes(t)).length;
      if (bodyHits > 0) {
        const coverage = bodyHits / terms.length;
        // 0.30 (single term) → 0.50 (all terms)
        score = Math.max(score, 0.3 + 0.2 * coverage);
      }

      if (score === 0) continue;

      // Snippet — prefer phrase, then first term that matches.
      let snippet = buildSnippet(entry.markdown, trimmed, 120);
      if (!snippet) {
        for (const t of terms) {
          snippet = buildSnippet(entry.markdown, t, 120);
          if (snippet) break;
        }
      }

      results.push({
        slug: entry.slug,
        kind: entry.kind,
        title: fm.title,
        category: fm.category,
        score: round(score),
        matchedQuestion,
        snippet,
      });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-breaker: prefer docs over guides (canonical reference); then alpha by slug.
      if (a.kind !== b.kind) return a.kind === "docs" ? -1 : 1;
      return a.slug.localeCompare(b.slug);
    });
    return results.slice(0, limit);
  }
}

function summariesFor(values: Iterable<DocEntry>, kind: DocKind): DocSummary[] {
  const out: DocSummary[] = [];
  for (const entry of values) {
    const fm = entry.frontmatter;
    out.push({
      slug: entry.slug,
      kind,
      title: fm.title,
      description: fm.description,
      category: fm.category,
      order: fm.order,
      trigger_dev_primitive: fm.trigger_dev_primitive,
      trigger_dev_link: fm.trigger_dev_link,
      questions: fm.questions,
      related: fm.related,
    });
  }
  out.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.order !== b.order) return a.order - b.order;
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

function getEntry(map: Map<string, DocEntry>, slug: string): DocEntry | null {
  const entry = map.get(slug);
  if (!entry) return null;
  // Lazy-render HTML once; cache on the entry.
  if (!entry.html) {
    entry.html = renderMarkdown(entry.markdown);
  }
  return entry;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
