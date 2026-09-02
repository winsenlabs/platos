// The `SkillSourceFetcher` port — loading a skill manifest from a URL.
//
// The domain decides WHICH URL to fetch (`domain/import-source.ts`). This port
// is the half that cannot be pure: resolving a hostname to an address, refusing
// the ranges that must never be reached, following a redirect, and stopping a
// body that will not stop arriving.
//
// THE CONTRACT AN IMPLEMENTATION MUST HONOUR, in full, because every clause is
// load-bearing and none of it is verifiable from this side:
//
//   1. RESOLVE AND REFUSE. Before a connection is opened, the hostname is
//      resolved and the resulting ADDRESS is checked. Loopback, private,
//      link-local, unique-local and cloud-metadata ranges are refused. Checking
//      the NAME is not sufficient — a public name may resolve to a private
//      address, which is the whole technique.
//
//   2. EVERY HOP, NOT JUST THE FIRST. Redirects are followed manually and each
//      destination is put through clause 1 again. An implementation that hands
//      redirect-following to a client library and checks only the first URL
//      satisfies nothing: a public host answering 302 to an internal address is
//      the ordinary case, not an exotic one.
//
//   3. STOP AT THE CEILING WHILE READING. `maxBytes` is enforced as the body
//      arrives and the read is abandoned when it is passed. Buffering the whole
//      response and measuring afterwards makes the ceiling a report rather than
//      a limit, and a body with no end has already won by then.
//
//   4. NO REMOTE CONTENT IN AN ERROR. A failure names the URL and the status.
//      It never carries any part of what was fetched. Reflecting remote bytes
//      into an error message turns an import into a content-injection surface.
//
//   5. NO VENDOR ERROR ESCAPES. Failures come back as this context's codes, so
//      a caller can tell "the source is missing" from "the network is down"
//      without catching a typed exception from a library it is forbidden to
//      import.

import type { Result } from "@platos/kernel";

export interface SkillSourceRequest {
  /** The URL to fetch — already rewritten and already admitted by the domain. */
  readonly url: string;
  readonly maxBytes: number;
  readonly timeoutSeconds: number;
  readonly maxRedirects: number;
}

export interface SkillSourceDocument {
  /**
   * The URL the bytes actually came from, after every redirect.
   *
   * Returned rather than assumed: a caller recording provenance must record
   * where the content came from, not where it started asking.
   */
  readonly resolvedUrl: string;
  readonly body: string;
  readonly bytes: number;
}

export interface SkillSourceFetcher {
  fetch(request: SkillSourceRequest): Promise<Result<SkillSourceDocument>>;
}
