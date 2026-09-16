/**
 * WIN-268 (M4.2) — THE SSRF SCREEN'S IPv6 SPELLINGS, WITH NO SERVICES.
 *
 * WHY THIS FILE EXISTS. `validatePublicUrl` is the single choke-point every
 * fetch of a user-supplied URL goes through, and this tranche changed it: an
 * IPv4-mapped or IPv4-compatible IPv6 literal used to be reported PUBLIC,
 * because `new URL()` rewrites `[::ffff:169.254.169.254]` into
 * `[::ffff:a9fe:a9fe]` before the screen sees it and the screen read only the
 * dotted form. The regression test for that fix lived — and still lives, as the
 * end-to-end proof — inside `tool-gateway/tool-call-parity.integration.test.ts`,
 * which SKIPS unless a PostgreSQL and a Redis are present. So on a laptop, on a
 * job with no services, and on any future pipeline that drops them, a security
 * fix had no gate at all. These cases need nothing: no database, no Redis, no
 * network. Every address below is a literal, so `validatePublicUrl` answers from
 * `isPrivateOrReservedIp` and never reaches DNS.
 *
 * THE ORACLE IS NOT THIS FILE. The spellings are the ones RFC 4291 §2.5.5
 * defines (IPv4-mapped `::ffff:a.b.c.d` and IPv4-compatible `::a.b.c.d`) of
 * addresses RFC 5735 / RFC 6890 reserve — 127.0.0.0/8 loopback, 169.254.0.0/16
 * link-local (which is what carries cloud instance metadata) and 10.0.0.0/8
 * private — plus one address in neither table, 8.8.8.8, which must still be
 * admitted so the refusal is about the ADDRESS and not about the spelling.
 */

import { describe, expect, it } from "vitest";

import { validatePublicUrl } from "./url-validator";

// Ports are irrelevant to the judgement and are here only because a loopback
// backend in a test binds one; 8081 is not in `BLOCKED_PORTS`.
const REFUSED = [
  // Loopback, 127.0.0.0/8 (RFC 6890) — the dotted, hex and fully expanded
  // spellings of one address, all of which `new URL()` folds into the hex form.
  "http://[::ffff:127.0.0.1]:8081/tools",
  "http://[::ffff:7f00:1]:8081/tools",
  "http://[0:0:0:0:0:ffff:7f00:0001]:8081/tools",
  // …and the IPv4-COMPATIBLE spelling of the same address, which has no
  // `ffff` marker at all.
  "http://[::7f00:1]:8081/tools",
  // Link-local, 169.254.0.0/16 — cloud instance metadata.
  "http://[::ffff:169.254.169.254]/latest/meta-data/",
  "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
  "http://[::a9fe:a9fe]/latest/meta-data/",
  // Private, 10.0.0.0/8.
  "http://[::ffff:10.1.2.3]/",
  // The plain IPv4 and IPv6 forms, which were never the defect but are the
  // control for "the screen is on at all".
  "http://127.0.0.1:8081/tools",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]:8081/tools",
];

const ADMITTED = [
  // 8.8.8.8 is public in every table above. Both the mapped spelling and the
  // dotted form must pass, or the fix would be refusing a spelling rather than
  // an address — which is the failure mode that would quietly break webhooks.
  "http://[::ffff:8.8.8.8]/",
  "http://[::ffff:808:808]/",
  "http://8.8.8.8/",
];

describe("validatePublicUrl on IPv6 spellings of reserved IPv4 addresses", () => {
  it.each(REFUSED)("refuses %s as a private or reserved address", async (url) => {
    const result = await validatePublicUrl(url, { allowHttp: true });
    expect({ url, ok: result.ok }).toEqual({ url, ok: false });
    // The KIND matters: a refusal for `invalid_url` or `port_blocked` would
    // also be `ok: false` and would mean the address was never judged.
    expect(result.ok === false && result.error.kind).toBe("ip_private_or_reserved");
  });

  it.each(ADMITTED)("admits %s, so the refusal is about the address and not the spelling", async (url) => {
    const result = await validatePublicUrl(url, { allowHttp: true });
    expect({ url, ok: result.ok }).toEqual({ url, ok: true });
  });

  it("still refuses a public address on a blocked port, and http: when it is not opted into", async () => {
    // Two independent rules on the same admitted address — so the cases above
    // cannot be passing because the screen stopped judging anything else.
    const blockedPort = await validatePublicUrl("http://[::ffff:8.8.8.8]:6379/", { allowHttp: true });
    expect(blockedPort.ok === false && blockedPort.error).toEqual({ kind: "port_blocked", port: 6379 });
    const httpNotAllowed = await validatePublicUrl("http://[::ffff:8.8.8.8]/", { allowHttp: false });
    expect(httpNotAllowed.ok === false && httpNotAllowed.error).toEqual({ kind: "scheme_blocked", scheme: "http" });
  });
});
