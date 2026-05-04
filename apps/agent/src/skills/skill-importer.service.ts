import { Injectable, Logger } from "@nestjs/common";
import { parseSkill } from "./skill-manifest.parser";
import type { ParsedSkill } from "./skill-manifest.types";
import { SkillParseError } from "./skill-manifest.types";
import {
  validatePublicUrl,
  describeUrlValidationError,
  fetchWithValidatedRedirects,
} from "../shared/url-validator";

/**
 * Theme S.3 — Claude-skills-format import.
 *
 * Fetches a skill manifest from a URL (claude.ai skill library, raw
 * github, gist, etc.) and parses it into the canonical ParsedSkill shape
 * that SkillRegistryService consumes.
 *
 * URL rewriting rules:
 *   - `https://claude.ai/skills/<id>`       → `https://claude.ai/skills/<id>/skill.md`
 *   - `https://github.com/<owner>/<repo>/blob/<ref>/<path>`
 *                                            → `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
 *   - `https://gist.github.com/<user>/<id>`
 *                                            → `https://gist.githubusercontent.com/<user>/<id>/raw`
 *   - anything else is fetched as-is.
 *
 * Safety:
 *   - We only follow http(s) URLs. No `file://` / `data:` / SSRF paths.
 *   - Max body size 256 KiB to prevent DoS via giant manifests.
 *   - 10s timeout via AbortController.
 *
 * The returned ParsedSkill has `manifest.importedFrom` pre-filled with the
 * original URL so the library UI can show "Imported from ...".
 */
@Injectable()
export class SkillImporterService {
  private readonly logger = new Logger(SkillImporterService.name);
  private readonly MAX_BYTES = 256 * 1024;
  private readonly TIMEOUT_MS = 10_000;

  /** Fetch + parse a skill from an external URL. */
  async importFromUrl(urlString: string): Promise<ParsedSkill> {
    // EOBD.10 — SSRF defence. Ban private / loopback / link-local / cloud-metadata
    // IPs at BOTH submit time (here) and fetch time (below after rewriteToRaw).
    const check = await validatePublicUrl(urlString);
    if (!check.ok) {
      throw new SkillParseError(
        `Skill import URL rejected: ${describeUrlValidationError(check.error)}`,
        "invalid_url",
      );
    }
    const url = this.validateUrl(urlString);
    const fetchUrl = this.rewriteToRaw(url);
    // Re-validate the rewritten URL — github.com → raw.githubusercontent.com etc.
    const rewriteCheck = await validatePublicUrl(fetchUrl.toString());
    if (!rewriteCheck.ok) {
      throw new SkillParseError(
        `Rewritten URL rejected: ${describeUrlValidationError(rewriteCheck.error)}`,
        "invalid_url",
      );
    }
    const source = await this.fetchBody(fetchUrl);
    try {
      return parseSkill(source, { importedFrom: urlString });
    } catch (err) {
      if (err instanceof SkillParseError) throw err;
      // EOBD.10 — never reflect fetched content in the error message.
      // Log the full err for debugging but surface an opaque reason.
      this.logger.warn({
        msg: "Skill parse failed",
        url: urlString,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new SkillParseError(
        `Failed to parse skill from ${urlString} (see server logs for details).`,
        "parse_failed",
      );
    }
  }

  /** Validate + parse a skill from raw source text (no network). */
  importFromSource(source: string, importedFrom?: string): ParsedSkill {
    return parseSkill(source, importedFrom ? { importedFrom } : {});
  }

  private validateUrl(urlString: string): URL {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch {
      throw new SkillParseError(`Invalid URL: ${urlString}`, "invalid_url");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SkillParseError(
        `Only http/https URLs are supported (got ${url.protocol}).`,
        "invalid_protocol",
      );
    }
    return url;
  }

  private rewriteToRaw(url: URL): URL {
    // claude.ai skill library → append skill.md if not already
    if (url.hostname === "claude.ai" && url.pathname.startsWith("/skills/")) {
      if (!url.pathname.endsWith(".md") && !url.pathname.endsWith("/skill.md")) {
        return new URL(
          `${url.origin}${url.pathname.replace(/\/$/, "")}/skill.md${url.search}`,
        );
      }
    }
    // github.com/<o>/<r>/blob/<ref>/<path> → raw.githubusercontent.com/<o>/<r>/<ref>/<path>
    if (url.hostname === "github.com") {
      const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
      if (m) {
        const [, owner, repo, ref, path] = m;
        return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
      }
    }
    // gist.github.com/<user>/<id> → raw
    if (url.hostname === "gist.github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && !url.pathname.includes("/raw")) {
        return new URL(`https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`);
      }
    }
    return url;
  }

  private async fetchBody(url: URL): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.TIMEOUT_MS);
    try {
      // EOBD.10 follow-up — previous `redirect: "follow"` bypassed SSRF
      // defence: a public hostname could 302-redirect to 127.0.0.1 and
      // stock fetch would chase it. `fetchWithValidatedRedirects` sets
      // redirect:"manual", validates each Location hop (up to 3).
      const res = await fetchWithValidatedRedirects(url.toString(), 3, {
        signal: ctrl.signal,
        headers: {
          accept: "text/markdown,text/plain,*/*",
          "user-agent": "Platos-Skills-Importer/1.0",
        },
      });
      if (!res.ok) {
        throw new SkillParseError(
          `Skill import failed: ${res.status} ${res.statusText} for ${url.toString()}`,
          "fetch_failed",
        );
      }
      const reader = res.body?.getReader();
      if (!reader) {
        const text = await res.text();
        if (text.length > this.MAX_BYTES) {
          throw new SkillParseError(`Skill source too large (>${this.MAX_BYTES} bytes).`, "too_large");
        }
        return text;
      }
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > this.MAX_BYTES) {
          reader.cancel().catch(() => {});
          throw new SkillParseError(
            `Skill source too large (>${this.MAX_BYTES} bytes).`,
            "too_large",
          );
        }
        chunks.push(value);
      }
      return new TextDecoder("utf-8").decode(concat(chunks));
    } finally {
      clearTimeout(timer);
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
