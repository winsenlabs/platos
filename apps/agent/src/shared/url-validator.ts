/**
 * validatePublicUrl — SSRF defence for every code path that fetches a
 * user-supplied URL.
 *
 * EOBD.9 / EOBD.10 — closes two server-side request forgery vectors:
 *   - Budget `alertWebhookUrl` (monitoring/budget.service.ts + trigger-tasks/
 *     budget-alert.task.ts) — admin could set AWS IMDS or any internal
 *     service URL and the agent would fetch it server-side.
 *   - Skill import `url` (skills/skill-importer.service.ts) — parse errors
 *     even reflected the fetched content back in the error message.
 *
 * This helper is the single choke-point. Every fetch of a user-supplied
 * URL MUST call `validatePublicUrl(url)` first and respect the
 * returned Result.
 *
 * H11 — DNS rebinding. Re-validating by hostname before the fetch is NOT
 * sufficient: `fetch()` performs its own second, independent DNS
 * resolution, so an attacker-controlled low-TTL record can flip to
 * 169.254.169.254 (IMDS) in the window between the check and the
 * connect. `fetchWithValidatedRedirects` therefore PINS the addresses
 * validated here into the actual socket via an undici Agent whose
 * `connect.lookup` can only return already-validated IPs, and fails
 * closed for any host it did not validate.
 *
 * Policy:
 *   - Only http: / https: allowed (https: by default; http: opt-in via
 *     PLATOS_ALLOW_HTTP_WEBHOOKS=1 — useful for localhost dev).
 *   - Reject credentials in URL (user:pass@host).
 *   - Reject when the hostname is an IP in a private / loopback /
 *     link-local / multicast / reserved range.
 *   - Reject when DNS resolves (at submit time AND at fetch time) to
 *     any A/AAAA record in the above ranges.
 *   - Reject ports known to be infrastructure-risky (22/SSH, 25/SMTP,
 *     53/DNS, 6379/Redis, 5432/Postgres, 9042/Cassandra, 27017/Mongo,
 *     9200/ES, 11211/Memcached, 2375/Docker, 10250/Kubelet).
 */
import { promises as dns } from "node:dns";
import * as net from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type UrlValidationError =
  | { kind: "invalid_url"; reason: string }
  | { kind: "scheme_blocked"; scheme: string }
  | { kind: "credentials_forbidden" }
  | { kind: "port_blocked"; port: number }
  | { kind: "ip_private_or_reserved"; ip: string }
  | { kind: "dns_resolves_to_private"; ip: string };

/**
 * `URL.hostname` returns IPv6 literals in their BRACKETED form ("[::1]"),
 * but `net.isIP` / `isPrivateOrReservedIp` only accept the bare address.
 * Strip the brackets before any IP test. Getting this wrong is not cosmetic:
 * a bracketed literal silently fails every isIP check, skips the literal-IP
 * rejection, and resolves to nothing — which read as "public, unresolvable"
 * and let `https://[::ffff:169.254.169.254]/` through to IMDS.
 */
function unbracketHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export type UrlValidationResult =
  | {
      ok: true;
      url: URL;
      /**
       * The A/AAAA records that were resolved AND checked for this
       * hostname. `fetchWithValidatedRedirects` pins these into the
       * connection so the socket cannot be steered elsewhere by a
       * rebind (H11). Absent when the hostname is already a literal IP
       * (nothing to resolve, hence nothing to rebind) or when the host
       * could not be resolved at all.
       */
      addresses?: string[];
    }
  | { ok: false; error: UrlValidationError };

const BLOCKED_PORTS = new Set<number>([
  22, 23, 25, 53, 69, 110, 143, 389, 445, 465, 587, 636, 1433, 1521, 2375, 2376,
  3306, 3389, 5432, 5984, 6379, 7000, 7001, 7199, 8086, 9042, 9092, 9200, 9300,
  10250, 10255, 11211, 27017, 27018, 27019,
]);

/** The eight hextets of an IPv6 literal in any valid spelling, or null. */
function ipv6Hextets(ip: string): number[] | null {
  let canonical: string;
  try {
    // The URL parser is the canonicaliser the fetch path itself uses: it folds
    // a dotted tail into hex and compresses zero runs, so one expansion below
    // covers every spelling a caller can write.
    canonical = unbracketHost(new URL(`http://[${ip}]/`).hostname);
  } catch {
    return null;
  }
  const doubleColon = canonical.indexOf("::");
  const head = doubleColon === -1 ? canonical : canonical.slice(0, doubleColon);
  const tail = doubleColon === -1 ? "" : canonical.slice(doubleColon + 2);
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const fill = doubleColon === -1 ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const hextets = [...left, ...Array<string>(fill).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  return hextets.length === 8 && hextets.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? hextets
    : null;
}

/**
 * The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible
 * (`::a.b.c.d`) IPv6 address embeds, or null. `::` and `::1` are not
 * IPv4-compatible; the caller already refuses both.
 */
function embeddedIpv4(ip: string): string | null {
  const hextets = ipv6Hextets(ip);
  if (hextets === null || !hextets.slice(0, 5).every((value) => value === 0)) return null;
  const mapped = hextets[5] === 0xffff;
  const compatible = hextets[5] === 0 && (hextets[6] !== 0 || hextets[7]! > 1);
  if (!mapped && !compatible) return null;
  return [hextets[6]! >> 8, hextets[6]! & 0xff, hextets[7]! >> 8, hextets[7]! & 0xff].join(".");
}

/**
 * Returns true if the given IPv4 / IPv6 address falls in a range we
 * refuse to reach from the agent.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;                    // 10.0.0.0/8
    if (a === 127) return true;                   // 127.0.0.0/8 loopback
    if (a === 0) return true;                     // 0.0.0.0/8
    if (a === 169 && b === 254) return true;      // 169.254.0.0/16 link-local (AWS IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;      // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                    // 224.0.0.0/4 multicast + reserved
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a === 192 && b === 0 && ip.startsWith("192.0.2")) return true; // TEST-NET-1
    if (a === 198 && b === 51 && ip.startsWith("198.51.100")) return true; // TEST-NET-2
    if (a === 203 && b === 0 && ip.startsWith("203.0.113")) return true; // TEST-NET-3
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;      // loopback + unspecified
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
    if (lower.startsWith("fe80")) return true;               // fe80::/10 link-local
    if (lower.startsWith("ff")) return true;                 // ff00::/8 multicast
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) IPv6 carry an
    // IPv4 address in their low 32 bits, and a socket connected to one reaches
    // that IPv4 host. The embedded address is checked in EITHER spelling.
    //
    // SECURITY (WIN-269 parity lane, found while building the suite's SSRF
    // control). This used to read the dotted tail only (`::ffff:169.254.169.254`),
    // but the WHATWG URL parser NORMALISES that literal to the HEX spelling
    // before this function sees it — `new URL("http://[::ffff:169.254.169.254]/")`
    // has hostname `[::ffff:a9fe:a9fe]` — so the dotted branch never ran on a
    // URL, the hex tail was not an IPv4 string, and the address was reported
    // PUBLIC. `http://[::ffff:a9fe:a9fe]/latest/meta-data` passed
    // `validatePublicUrl` and the loopback spelling `[::ffff:7f00:1]` reached a
    // local listener. The address is now expanded to its eight hextets first.
    const embedded = embeddedIpv4(lower);
    if (embedded !== null) return isPrivateOrReservedIp(embedded);
    return false;
  }
  return false;
}

/**
 * Validate a user-supplied URL for outbound fetch.
 *
 * Call this at submit time to reject obviously-bad URLs early. Call
 * again immediately before each actual fetch to catch DNS rebinding
 * (same hostname, different resolved IP).
 */
export async function validatePublicUrl(
  raw: string,
  opts: { allowHttp?: boolean } = {},
): Promise<UrlValidationResult> {
  // Keep this utility safe for external Trigger bundles: importing the full
  // agent env schema would also load/validate DATABASE_URL in the worker.
  const allowHttp =
    opts.allowHttp ??
    (process.env.PLATOS_ALLOW_HTTP_WEBHOOKS === "true" ||
      process.env.PLATOS_ALLOW_HTTP_WEBHOOKS === "1");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: { kind: "invalid_url", reason: "not a valid URL" } };
  }

  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    return {
      ok: false,
      error: { kind: "scheme_blocked", scheme: url.protocol.replace(":", "") },
    };
  }

  if (url.username || url.password) {
    return { ok: false, error: { kind: "credentials_forbidden" } };
  }

  const port = url.port
    ? parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (BLOCKED_PORTS.has(port)) {
    return { ok: false, error: { kind: "port_blocked", port } };
  }

  const hostname = url.hostname;
  // SECURITY (H11 follow-up) — `URL.hostname` keeps IPv6 literals BRACKETED
  // ("[::1]"), and `net.isIP` does not accept that form. Testing the raw
  // hostname therefore made every literal-IPv6 URL skip the literal-IP branch
  // below, fall through to DNS (which fails on a bracketed string), and exit
  // with an EMPTY address set and `ok: true` — i.e.
  // `https://[::ffff:169.254.169.254]/` passed validation, and a plain
  // `fetch()` (which strips the brackets and connects to the literal, never
  // calling lookup) reached cloud metadata. Always unbracket before any IP test.
  const hostIp = unbracketHost(hostname);

  // Literal IP in the hostname.
  if (net.isIP(hostIp)) {
    if (isPrivateOrReservedIp(hostIp)) {
      return { ok: false, error: { kind: "ip_private_or_reserved", ip: hostIp } };
    }
    return { ok: true, url };
  }

  // Hostname → DNS resolve (A + AAAA). Reject if any resolved address
  // is private/reserved, and hand the surviving set back to the caller
  // as `addresses` so it can be PINNED into the connection (H11).
  const addrs: string[] = [];
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  if (v4.status === "fulfilled") addrs.push(...v4.value);
  if (v6.status === "fulfilled") addrs.push(...v6.value);

  // resolve4/resolve6 query the nameservers directly and ignore
  // /etc/hosts, nsswitch and the Docker embedded resolver — but the
  // socket would have used getaddrinfo, which honours all of them. Fall
  // back to it so hosts that only resolve via the system resolver keep
  // working, and so what we pin is what the socket would really have
  // connected to.
  if (addrs.length === 0) {
    try {
      const looked = await dns.lookup(hostname, { all: true });
      addrs.push(...looked.map((l) => l.address));
    } catch {
      // Unresolvable — return ok and let the fetch fail normally.
    }
  }

  for (const ip of addrs) {
    if (isPrivateOrReservedIp(ip)) {
      return { ok: false, error: { kind: "dns_resolves_to_private", ip } };
    }
  }

  return { ok: true, url, addresses: addrs };
}

/**
 * Fetch a URL while validating the initial target AND every 3xx
 * redirect target. Redirect-follow is ordinarily a blind SSRF hole:
 * a public hostname can redirect to `http://169.254.169.254/...` and
 * the stock `fetch({redirect:"follow"})` will chase it without
 * re-checking. Use this helper instead of `fetch` for any path that
 * accepts a user-supplied URL.
 *
 * Applies: initial validatePublicUrl, then up to `maxRedirects` hops,
 * validating each Location header. Any validation failure throws.
 *
 * Opts mirror fetch RequestInit; `redirect` is forced to "manual".
 */
/**
 * Build an undici Agent whose DNS lookup is PINNED to addresses that
 * `validatePublicUrl` already resolved AND checked.
 *
 * This is what actually closes the H11 TOCTOU: the socket never performs
 * a second resolution, so there is no window for a rebind to steer it at
 * link-local/private space. Any hostname we did not validate — and any
 * address we did not pin — fails closed.
 *
 * The pin map is read at connect time, so the caller can add a hop's
 * addresses to it just before fetching that hop.
 *
 * NOTE: pinning does NOT weaken TLS. SNI servername and certificate
 * verification are still derived from the URL hostname (undici only
 * delegates address resolution here), so a pinned IP that does not serve
 * a valid cert for the hostname fails the handshake as usual.
 */
function pinnedAgent(pins: Map<string, string[]>): Agent {
  // Declared with the shape we actually use, then cast to node's
  // `LookupFunction` for undici. The nominal type declares `address` as
  // REQUIRED on the callback, but the real dns.lookup contract passes only
  // `(err)` on failure — which is exactly what we do to fail closed. The
  // cast reconciles the two; the runtime contract is honoured.
  const pinLookup = (
    hostname: string,
    options: { family?: number; all?: boolean },
    cb: (
      err: NodeJS.ErrnoException | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const addrs = pins.get(hostname);
    if (!addrs || addrs.length === 0) {
      cb(new Error(`URL blocked: host ${hostname} was not IP-validated`));
      return;
    }
    let entries = addrs.map((address) => ({
      address,
      family: net.isIPv6(address) ? 6 : 4,
    }));
    if (options?.family === 4 || options?.family === 6) {
      entries = entries.filter((e) => e.family === options.family);
    }
    if (entries.length === 0) {
      cb(new Error(`URL blocked: no validated address for ${hostname}`));
      return;
    }
    // net/tls call this with `all: true`; honour the scalar form too.
    if (options?.all) cb(null, entries);
    else cb(null, entries[0].address, entries[0].family);
  };

  return new Agent({
    // Per-call agent: prefer short-lived sockets over pooling them across
    // calls that have different pin sets.
    keepAliveTimeout: 1_000,
    keepAliveMaxTimeout: 1_000,
    connect: {
      lookup: pinLookup as unknown as LookupFunction,
    },
  });
}

export async function fetchWithValidatedRedirects(
  rawUrl: string,
  maxRedirects: number = 3,
  init: RequestInit = {},
): Promise<Response> {
  let currentUrl = rawUrl;
  let hops = 0;

  // hostname → validated IPs, accumulated across hops. The agent is
  // created once per call so that a streaming response body (see
  // skill-importer.service.ts, which reads `res.body.getReader()`)
  // outlives this loop.
  const pins = new Map<string, string[]>();
  const agent = pinnedAgent(pins);

  while (true) {
    const check = await validatePublicUrl(currentUrl);
    if (!check.ok) {
      throw new Error(
        `URL blocked: ${describeUrlValidationError(check.error)} (${currentUrl})`,
      );
    }
    // Literal-IP hosts need no pin: net.connect short-circuits on isIP and
    // never calls lookup, and the IP we validated IS the connection target.
    // Unbracket first — `URL.hostname` gives "[::1]" for IPv6 literals, and
    // testing the bracketed form made literal-IPv6 URLs take the pin branch,
    // find no resolvable addresses, and throw on every request.
    const host = check.url.hostname;
    if (!net.isIP(unbracketHost(host))) {
      if (!check.addresses || check.addresses.length === 0) {
        throw new Error(
          `URL blocked: could not resolve ${host} to a validated IP`,
        );
      }
      pins.set(host, check.addresses);
    }
    const res = (await undiciFetch(currentUrl, {
      ...(init as Record<string, unknown>),
      redirect: "manual",
      dispatcher: agent,
    } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hops >= maxRedirects) {
      throw new Error(`Too many redirects (>${maxRedirects})`);
    }
    hops += 1;
    // Release the redirect's socket back to the pool — with a per-call
    // agent an undrained 3xx body would hold it open.
    await res.body?.cancel().catch(() => {});
    // Resolve relative Location against current URL.
    currentUrl = new URL(location, currentUrl).toString();
  }
}

/**
 * Stringify a validation error for logging (safe: does not echo the
 * user-supplied URL).
 */
export function describeUrlValidationError(err: UrlValidationError): string {
  switch (err.kind) {
    case "invalid_url":
      return `invalid URL (${err.reason})`;
    case "scheme_blocked":
      return `URL scheme "${err.scheme}" is not allowed (expected https)`;
    case "credentials_forbidden":
      return "URL must not contain credentials (user:pass@host)";
    case "port_blocked":
      return `port ${err.port} is blocked`;
    case "ip_private_or_reserved":
      return `host resolves to a private / reserved IP (${err.ip})`;
    case "dns_resolves_to_private":
      return `host DNS-resolves to a private / reserved IP (${err.ip})`;
  }
}
