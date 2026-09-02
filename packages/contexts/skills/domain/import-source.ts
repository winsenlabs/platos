// Where an imported skill may be fetched from, and what its URL becomes.
//
// An operator pastes the URL of a page. What must be fetched is the RAW file
// behind it, so three known hosts are rewritten and everything else is taken
// literally:
//
//   claude.ai/skills/<id>                 -> .../skill.md
//   github.com/<o>/<r>/blob/<ref>/<path>  -> raw.githubusercontent.com/<o>/<r>/<ref>/<path>
//   gist.github.com/<user>/<id>           -> gist.githubusercontent.com/<user>/<id>/raw
//
// THE REWRITE IS A SECURITY BOUNDARY, NOT A CONVENIENCE. It changes the HOST,
// which means a URL an operator approved is not the URL that gets fetched. The
// address check therefore has to run on BOTH — the submitted URL and the
// rewritten one — and the use case that owns the fetch does exactly that. This
// module is the pure half: protocol admission and the rewrite itself. The half
// that resolves a hostname to an address, and refuses loopback, private,
// link-local and metadata ranges, is I/O and lives behind the
// `SkillSourceFetcher` port.
//
// Redirects are the same problem one hop later: a public host answering with a
// 302 to an internal address defeats a check that only ran on the first URL. The
// port's contract requires each hop to be re-checked, and the ceiling on hops is
// policy.

import { err, ok, type Result } from "@platos/kernel";

import { sourceProtocolUnsupported, sourceUrlInvalid } from "./errors.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const GITHUB_BLOB = /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/u;

/** Parse and admit a submitted URL. Nothing else in this module accepts a string. */
export function admitImportUrl(candidate: string): Result<URL> {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return err(sourceUrlInvalid(candidate, "unparseable"));
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return err(sourceProtocolUnsupported(url.protocol));
  return ok(url);
}

function rewriteSkillLibrary(url: URL): URL | null {
  if (url.hostname !== "claude.ai" || !url.pathname.startsWith("/skills/")) return null;
  if (url.pathname.endsWith(".md")) return null;
  return new URL(`${url.origin}${url.pathname.replace(/\/$/u, "")}/skill.md${url.search}`);
}

function rewriteRepositoryBlob(url: URL): URL | null {
  if (url.hostname !== "github.com") return null;
  const match = GITHUB_BLOB.exec(url.pathname);
  if (match === null) return null;
  const [, owner, repository, ref, path] = match;
  return new URL(`https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${path}`);
}

function rewriteGist(url: URL): URL | null {
  if (url.hostname !== "gist.github.com") return null;
  if (url.pathname.includes("/raw")) return null;
  const parts = url.pathname.split("/").filter((part) => part !== "");
  if (parts.length < 2) return null;
  return new URL(`https://gist.githubusercontent.com/${parts[0]}/${parts[1]}/raw`);
}

/**
 * The URL that will actually be fetched.
 *
 * Total: a URL matching no rule is returned unchanged, because the common case
 * is an operator who already pasted a raw link. Whether the result is SAFE to
 * fetch is not decided here — see the header.
 */
export function rewriteToRawSource(url: URL): URL {
  return rewriteSkillLibrary(url) ?? rewriteRepositoryBlob(url) ?? rewriteGist(url) ?? url;
}

/** True when the rewrite moved the request to a different host. */
export function rewriteChangedHost(submitted: URL, rewritten: URL): boolean {
  return submitted.hostname !== rewritten.hostname;
}
