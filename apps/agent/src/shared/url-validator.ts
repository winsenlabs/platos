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
 * returned Result; callers must ALSO re-validate right before the
 * actual fetch (defence-in-depth against DNS rebinding — a public
 * hostname could resolve to a private IP at fetch time even if it
 * resolved to a public one at submit time).
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
import { env } from "./env";

export type UrlValidationError =
  | { kind: "invalid_url"; reason: string }
  | { kind: "scheme_blocked"; scheme: string }
  | { kind: "credentials_forbidden" }
  | { kind: "port_blocked"; port: number }
  | { kind: "ip_private_or_reserved"; ip: string }
  | { kind: "dns_resolves_to_private"; ip: string };

export type UrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; error: UrlValidationError };

const BLOCKED_PORTS = new Set<number>([
  22, 23, 25, 53, 69, 110, 143, 389, 445, 465, 587, 636, 1433, 1521, 2375, 2376,
  3306, 3389, 5432, 5984, 6379, 7000, 7001, 7199, 8086, 9042, 9092, 9200, 9300,
  10250, 10255, 11211, 27017, 27018, 27019,
]);

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
    // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded v4.
    if (lower.startsWith("::ffff:")) {
      const v4 = ip.split(":").pop();
      if (v4 && net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
    }
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
  const allowHttp =
    opts.allowHttp ?? env.PLATOS_ALLOW_HTTP_WEBHOOKS === true;

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

  // Literal IP in the hostname.
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { ok: false, error: { kind: "ip_private_or_reserved", ip: hostname } };
    }
    return { ok: true, url };
  }

  // Hostname → DNS resolve (A + AAAA). Reject if any resolved address
  // is private/reserved. We don't attempt to "pin" the IP — callers
  // should re-validate at fetch time.
  let addrs: string[] = [];
  try {
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);
    if (v4.status === "fulfilled") addrs.push(...v4.value);
    if (v6.status === "fulfilled") addrs.push(...v6.value);
  } catch {
    // Fall through — we'll return ok and let the fetch fail normally.
  }
  for (const ip of addrs) {
    if (isPrivateOrReservedIp(ip)) {
      return { ok: false, error: { kind: "dns_resolves_to_private", ip } };
    }
  }

  return { ok: true, url };
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
export async function fetchWithValidatedRedirects(
  rawUrl: string,
  maxRedirects: number = 3,
  init: RequestInit = {},
): Promise<Response> {
  let currentUrl = rawUrl;
  let hops = 0;

  while (true) {
    const check = await validatePublicUrl(currentUrl);
    if (!check.ok) {
      throw new Error(
        `URL blocked: ${describeUrlValidationError(check.error)} (${currentUrl})`,
      );
    }
    const res = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hops >= maxRedirects) {
      throw new Error(`Too many redirects (>${maxRedirects})`);
    }
    hops += 1;
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
