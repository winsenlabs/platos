/**
 * Phase 3 — Docs MCP service.
 *
 * Read-only public catalog of `content/docs/*.md` + `content/guides/*.md`
 * exposed as MCP resources + a `search_docs` tool. Mounted at
 * `/mcp/docs` on the agent process. Intentionally UNAUTHENTICATED so:
 *   - The marketing site (platos.dev) can call it without managing tokens.
 *   - The future "Talk to Platos" agent on play.platos.dev (operator
 *     wires it manually) can read product docs without credentials.
 *   - Any third-party MCP client can register the endpoint as a public
 *     reference doc-source.
 *
 * Per-IP rate limit (60 req/min) is enforced inside the controller via
 * the same Redis bucket pattern the webapp public docs API uses, so
 * abuse from one IP can't spam either surface.
 */

import { Injectable, Inject } from "@nestjs/common";
import { DocRepository, getSharedRepository, type DocEntry, type DocSummary, type SearchResult } from "@internal/docs";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DocResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

@Injectable()
export class DocsMcpService {
  private repo: DocRepository;

  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {
    const contentRoot = resolveContentRoot();
    // Singleton — both the webapp + agent point at the same content tree
    // when running in the same container. In split deployments each
    // process keeps its own cache.
    this.repo = getSharedRepository({ contentRoot, watchMtime: true });
  }

  /**
   * MCP `resources/list` — every doc + guide rendered as a single resource.
   *
   * URI scheme:
   *   docs://platos/<category>/<slug>      — `content/docs/<slug>.md`
   *   guides://platos/<category>/<slug>    — `content/guides/<slug>.md`
   *
   * Description carries the frontmatter `description` so MCP clients can
   * render a sensible label without round-tripping `read_resource`.
   */
  async listResources(): Promise<DocResource[]> {
    const [docs, guides] = await Promise.all([
      this.repo.listDocs(),
      this.repo.listGuides(),
    ]);
    const out: DocResource[] = [];
    for (const item of docs) out.push(this.summaryToResource(item, "docs"));
    for (const item of guides) out.push(this.summaryToResource(item, "guides"));
    return out;
  }

  /**
   * MCP `resources/read` — return the rendered HTML body for a URI from
   * `listResources`. Returns null if the URI doesn't match a doc.
   *
   * We return HTML rather than markdown because:
   *   - LLM clients can extract semantic content from HTML cleanly.
   *   - Browsers consuming the resource via MCP-over-HTTP get a render-
   *     ready blob.
   *   - Markdown is also available — clients that prefer the source can
   *     call the webapp REST endpoint instead.
   */
  async readResource(uri: string): Promise<ResourceContent | null> {
    const parsed = parseResourceUri(uri);
    if (!parsed) return null;
    const entry = await this.getEntry(parsed.kind, parsed.slug);
    if (!entry) return null;
    return {
      uri,
      mimeType: "text/html; charset=utf-8",
      text: entry.html ?? "",
    };
  }

  /**
   * `search_docs` tool body. Same lexical search the webapp public API
   * exposes — backed by the identical `DocRepository.search` so the
   * marketing site + agents see consistent ranking.
   */
  async searchDocs(input: {
    query: string;
    kind?: "docs" | "guides" | "all";
    limit?: number;
  }): Promise<SearchResult[]> {
    const query = (input.query ?? "").trim();
    if (!query) return [];
    const kind = input.kind ?? "all";
    const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
    return this.repo.search(query, kind, limit);
  }

  /**
   * Per-IP rate-limit. Reuses the agent's Redis client with a dedicated
   * key prefix. Fail-open on Redis outage — public read endpoint should
   * never 500 from infra.
   */
  async checkRateLimit(ip: string): Promise<{ ok: boolean; retryAfter: number; remaining: number }> {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:mcp-docs:ip:${ip}:${minuteBucket}`;
    const limit = 60;
    try {
      const pipeline = this.redis.pipeline();
      pipeline.incr(key);
      pipeline.expire(key, 65);
      const results = await pipeline.exec();
      const count = (results?.[0]?.[1] as number) || 0;
      if (count > limit) {
        const ttl = await this.redis.ttl(key);
        return { ok: false, retryAfter: ttl > 0 ? ttl : 60, remaining: 0 };
      }
      return { ok: true, retryAfter: 0, remaining: Math.max(0, limit - count) };
    } catch {
      // Redis down → fail open.
      return { ok: true, retryAfter: 0, remaining: limit };
    }
  }

  // ─── internals ───────────────────────────────────────────────────

  private summaryToResource(item: DocSummary, kind: "docs" | "guides"): DocResource {
    const scheme = kind === "docs" ? "docs" : "guides";
    return {
      uri: `${scheme}://platos/${item.category}/${item.slug}`,
      name: item.title,
      description: item.description || `${kind === "docs" ? "Doc" : "Guide"}: ${item.title}`,
      mimeType: "text/html; charset=utf-8",
    };
  }

  private async getEntry(kind: "docs" | "guides", slug: string): Promise<DocEntry | null> {
    return kind === "docs" ? this.repo.getDoc(slug) : this.repo.getGuide(slug);
  }
}

/**
 * Resolve `content/` root: explicit env var first, otherwise walk up from
 * `process.cwd()` looking for `content/docs`. Mirrors the webapp helper
 * so both surfaces find the same tree in Docker (where cwd is `/app`
 * and content lives at `/app/content`) + dev (where cwd is `apps/agent`
 * + content is two levels up).
 */
function resolveContentRoot(): string {
  const configured = process.env.PLATOS_DOCS_CONTENT_ROOT;
  if (configured && configured.trim()) return path.resolve(configured.trim());
  let current = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(current, "content", "docs");
    try {
      if (fs.statSync(candidate).isDirectory()) return current;
    } catch {
      // not here
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/** Parse a `docs://platos/<category>/<slug>` URI back to {kind, slug}. */
export function parseResourceUri(uri: string): { kind: "docs" | "guides"; slug: string } | null {
  if (!uri || typeof uri !== "string") return null;
  const docsMatch = /^docs:\/\/platos\/[^/]+\/([a-z0-9][a-z0-9_-]{0,80})$/i.exec(uri);
  if (docsMatch?.[1]) return { kind: "docs", slug: docsMatch[1].toLowerCase() };
  const guidesMatch = /^guides:\/\/platos\/[^/]+\/([a-z0-9][a-z0-9_-]{0,80})$/i.exec(uri);
  if (guidesMatch?.[1]) return { kind: "guides", slug: guidesMatch[1].toLowerCase() };
  return null;
}
