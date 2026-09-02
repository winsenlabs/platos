// The `DestinationScreen` port — "may this system be made to fetch that URL?"
//
// This is the SSRF boundary, and it is a port because answering the question
// requires DNS resolution, which is I/O. The legacy implementation is
// `validatePublicUrl` in `apps/agent/src/shared/url-validator.ts`; the adapter
// that satisfies this interface is where that code lands, and it is the sole
// holder of the resolver.
//
// SCREENED TWICE, ON PURPOSE. The legacy service validates a URL when a rule is
// REGISTERED or UPDATED, and validates it again at DISPATCH — its own comment
// says "we re-validate at dispatch time per defence-in-depth", and the H11 note
// on `fetchWithValidatedRedirects` explains why the second check is not
// redundant: "a bare fetch re-resolves DNS and is rebindable to IMDS/private
// space between the validatePublicUrl check above and the connect". A name that
// resolved publicly when the rule was saved can resolve to link-local an hour
// later. Both call sites are preserved:
//
//   - registration/update calls `screen` here, so a bad URL never persists;
//   - the delivery adapter re-screens and pins the address into the socket.
//
// The second half is a property of the ADAPTER, not of this context, and it is
// stated here so that whoever writes the adapter knows that satisfying this
// interface once is not the whole obligation.
//
// FAILURE IS A VALUE. A destination that is refused is `ok({ admitted: false })`
// with a reason, not an error: "this URL points at private space" is a business
// outcome the caller renders to an operator. `err` is reserved for the screen
// being UNABLE to decide — resolver down, timeout — which is a different thing
// and must not be confused with a denial, because failing open on it would be
// the vulnerability.

import type { Result } from "@platos/kernel";

export interface ScreenedDestination {
  /** False when the destination was refused. Still a successful screening. */
  readonly admitted: boolean;
  /** Operator-facing reason for a refusal; null when admitted. */
  readonly reason: string | null;
}

export interface DestinationScreen {
  /**
   * Decide whether this system may be made to send a request to `url`.
   *
   * An implementation MUST refuse loopback, link-local, private and
   * unique-local address space, and MUST resolve the name rather than pattern-
   * matching the string — `http://127.0.0.1.nip.io/` is a public-looking name
   * that resolves to loopback.
   */
  screen(url: string): Promise<Result<ScreenedDestination>>;
}
