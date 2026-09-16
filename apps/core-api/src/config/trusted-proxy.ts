// THE ONE PROXY HOP, AS CONFIGURATION (D-COOKIE).
//
// `PLATOS_CORE_API_TRUSTED_PROXY` names the reverse proxy whose
// `X-Forwarded-Proto` this process believes. This module turns the configured
// text into a range and answers one question about a TCP peer: is it that proxy?
// It is pure over its arguments and reads no environment; the per-request
// decision that uses it lives in `runtime/trusted-proxy.ts`.
//
// FAIL CLOSED, IN BOTH DIRECTIONS THAT MATTER.
//
//   * A value that is not an IPv4 or IPv6 address, optionally with a prefix
//     length, refuses startup. A hostname is refused too: the peer is compared
//     by address, and a name resolved once at boot would be a second, silent
//     source of truth about which machine is trusted.
//   * A range that contains every address (`0.0.0.0/0`, `::/0`) refuses startup.
//     Trusting everyone is the same as trusting the caller, and the setting
//     exists precisely so a caller cannot choose.
//
// IPv4-MAPPED PEERS. A dual-stack listener reports an IPv4 client as
// `::ffff:a.b.c.d`. That peer is compared as the IPv4 address it is, so an
// operator who wrote `172.18.0.1` does not have to know how the socket was bound.

import { BlockList, isIP } from "node:net";

import type { TrustedProxyRange } from "./schema.js";

/** Why a configured value was refused, in operator language. Never an echo. */
export type TrustedProxyRefusal = { readonly problem: string };

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu;

/** Parse the configured text, or say why not. */
export function parseTrustedProxy(value: string): TrustedProxyRange | TrustedProxyRefusal {
  const [address = "", prefix, ...rest] = value.split("/");
  const family = isIP(address);
  if (rest.length > 0 || (family !== 4 && family !== 6)) {
    return { problem: "must be an IPv4 or IPv6 address, optionally followed by /prefix-length" };
  }
  if (IPV4_MAPPED.test(address)) {
    // Peers in this form are compared as IPv4 (see the banner), so a range
    // written this way could never match one. Refused rather than converted.
    return { problem: "must write an IPv4-mapped address as the IPv4 address it maps" };
  }
  const width = family === 4 ? 32 : 128;
  let prefixLength = width;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/u.test(prefix) || Number(prefix) > width) {
      return { problem: `must carry a prefix length between 1 and ${width}` };
    }
    prefixLength = Number(prefix);
  }
  if (prefixLength === 0) {
    return { problem: "must not be a range containing every address; that trusts every caller" };
  }
  return Object.freeze({ source: value, family, address, prefixLength });
}

/**
 * A predicate over TCP peer addresses: true only inside the range.
 *
 * Built once per process rather than per request, because the range is fixed at
 * startup and the check runs on every request that reaches the listener.
 */
export function trustedProxyMatcher(range: TrustedProxyRange): (peer: string | undefined) => boolean {
  const list = new BlockList();
  list.addSubnet(range.address, range.prefixLength, range.family === 4 ? "ipv4" : "ipv6");
  return (peer) => {
    if (peer === undefined || peer === "") return false;
    const candidate = IPV4_MAPPED.exec(peer)?.[1] ?? peer;
    const family = isIP(candidate);
    if (family !== range.family) return false;
    return list.check(candidate, family === 4 ? "ipv4" : "ipv6");
  };
}
