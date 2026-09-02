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
// THE REWRITE CHANGES THE HOST, so a URL an operator approved is not always the
// URL that gets fetched. What follows is what this module enforces and what it
// does NOT — stated separately, because an earlier version of this header
// claimed an address check on the submitted URL that no code here, and no code
// downstream, performs.
//
// WHAT THIS MODULE ENFORCES. Two things, both pure:
//
//   PROTOCOL ADMISSION. `admitImportUrl` refuses anything that is not http or
//   https, and anything unparseable, before the rest of the pipeline sees it.
//
//   HOST CLOSURE. The rewrite cannot send a fetch to a host the operator did
//   not already name. Every rule is guarded by exact `hostname` equality, and
//   each produces either the SAME host (`claude.ai`, carried over as
//   `url.origin`) or one of two hardcoded literals (`raw.githubusercontent.com`,
//   `gist.githubusercontent.com`). The attacker-influenced parts of a URL —
//   path, query, userinfo — are only ever interpolated AFTER the authority has
//   been terminated, so they cannot reach the host position. A URL matching no
//   rule is returned unchanged. Therefore the fetched host is always either the
//   submitted host or one of those two constants.
//
// WHAT THIS MODULE DOES NOT ENFORCE. There is no address check here, and
// admission is not safety: `http://169.254.169.254/…`, `http://127.0.0.1/…` and
// `http://10.0.0.5/…` are all admitted by this module and pass through the
// rewrite untouched. Resolving a hostname to an address and refusing loopback,
// private, link-local, unique-local and metadata ranges is I/O. It is stated as
// clause 1 of the `SkillSourceFetcher` port contract
// (`application/ports/skill-source-fetcher.ts`), to be applied to the URL that
// is ACTUALLY FETCHED — the rewritten one — and to every redirect hop under
// clause 2. It is NOT applied to the submitted URL, and does not need to be: by
// HOST CLOSURE, a submitted host that differs from the fetched host is one of
// the two constants above, and any attacker-chosen host IS the fetched host.
//
// AND NO ADAPTER SATISFIES THAT PORT YET. The only `SkillSourceFetcher` in this
// repository is the in-memory double under `application/testing/`, which
// resolves nothing. The refusal of private and metadata addresses is an
// obligation this context has WRITTEN DOWN, not one it has MET. Read the port
// contract as a specification for the adapter still to be built — one that must
// arrive with a control proving it rejects a name that resolves to a forbidden
// address — and not as evidence that the boundary is enforced today.
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
