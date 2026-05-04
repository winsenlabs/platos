/**
 * `GET /api/v1/public/docs/:slug` — full doc body (frontmatter + raw
 * markdown + rendered HTML). Public, no auth, CORS open. 60 req/min/IP.
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

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/;

function emptyOk(): Response {
  const headers = publicDocsResponseHeaders();
  return new Response(null, { status: 204, headers });
}

function notFound(): Response {
  const headers = publicDocsResponseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers,
  });
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") return emptyOk();

  const ip = clientIpFromRequest(request);
  const rl = await checkPublicDocsRateLimit(ip);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  const slug = (params.slug ?? "").trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) return notFound();

  const repo = getPublicDocsRepository();
  const entry = await repo.getDoc(slug);
  if (!entry) return notFound();

  const headers = publicDocsResponseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({
      slug: entry.slug,
      kind: entry.kind,
      frontmatter: entry.frontmatter,
      markdown: entry.markdown,
      html: entry.html ?? "",
      fetchedAt: new Date().toISOString(),
    }),
    { status: 200, headers },
  );
}

export const action = loader;
