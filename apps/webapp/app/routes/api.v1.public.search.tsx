/**
 * `GET /api/v1/public/search?q=<query>&kind=docs|guides|all&limit=<n>`
 *
 * Lexical search across docs + guides. Public, no auth, CORS open.
 * 60 req/min/IP.
 *
 * Phase 3.
 */

import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import {
  checkPublicDocsRateLimit,
  clientIpFromRequest,
  getPublicDocsRepository,
  publicDocsResponseHeaders,
  rateLimitedResponse,
} from "~/services/publicDocs.server";

function emptyOk(): Response {
  const headers = publicDocsResponseHeaders();
  return new Response(null, { status: 204, headers });
}

function badRequest(message: string): Response {
  const headers = publicDocsResponseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error: "bad_request", message }), {
    status: 400,
    headers,
  });
}

function parseKind(raw: string | null): "docs" | "guides" | "all" {
  if (raw === "docs" || raw === "guides") return raw;
  return "all";
}

const MAX_QUERY_LEN = 200;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") return emptyOk();

  const ip = clientIpFromRequest(request);
  const rl = await checkPublicDocsRateLimit(ip);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LEN).trim();
  if (!query) return badRequest("Missing required `q` parameter.");

  const kind = parseKind(url.searchParams.get("kind"));
  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const n = parseInt(limitRaw, 10);
    if (Number.isFinite(n) && n > 0) {
      limit = Math.min(n, MAX_LIMIT);
    }
  }

  const repo = getPublicDocsRepository();
  const results = await repo.search(query, kind, limit);

  const headers = publicDocsResponseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({
      query,
      kind,
      limit,
      count: results.length,
      results,
      fetchedAt: new Date().toISOString(),
    }),
    { status: 200, headers },
  );
}

export const action = loader;
