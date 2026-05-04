/**
 * `GET /api/v1/public/guides` — list every guide with frontmatter-only
 * metadata. Public, no auth, CORS open. 60 req/min/IP.
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

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") return emptyOk();

  const ip = clientIpFromRequest(request);
  const rl = await checkPublicDocsRateLimit(ip);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  const repo = getPublicDocsRepository();
  const items = await repo.listGuides();
  const byCategory: Record<string, string[]> = {};
  for (const item of items) {
    const slugs = byCategory[item.category] ?? (byCategory[item.category] = []);
    slugs.push(item.slug);
  }

  const headers = publicDocsResponseHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify({
      kind: "guides",
      count: items.length,
      items,
      byCategory,
      fetchedAt: new Date().toISOString(),
    }),
    { status: 200, headers },
  );
}

export const action = loader;
