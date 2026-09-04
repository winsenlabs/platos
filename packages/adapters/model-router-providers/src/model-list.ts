// Reading a provider's published model list.
//
// `ModelListEndpoint` says where to look, how to present the credential, and
// which RESPONSE SHAPE to expect — three facts the domain already decided from
// the catalogue. What is left is HTTP and JSON, which is this file.
//
// AN ADAPTER THAT RETURNS NOTHING NARROWS THE PICKER, IT DOES NOT EMPTY IT. The
// caller unions what comes back under the curated list, so an unreachable
// provider costs the operator the models nobody curated and nothing else. That
// is why every failure below returns an empty list through a `Result` rather
// than inventing entries or throwing.

import {
  err,
  ok,
  providerRequestFailed,
  type ListModelsRequest,
  type ModelListShape,
  type Result,
} from "@platos/context-providers/application/ports/index.js";

import type { HttpTransport } from "./transport.js";

/** How each shape names its models. One row per `MODEL_LIST_SHAPES` entry. */
const SHAPE_READERS: Readonly<Record<ModelListShape, (body: unknown) => readonly string[]>> = {
  // `{ data: [{ id }] }` — the OpenAI list surface, which Together, Fireworks,
  // Mistral and Groq all copied.
  openai: (body) => idsFrom(body, "data", "id"),
  together: (body) => idsFrom(body, "data", "id"),
  fireworks: (body) => idsFrom(body, "data", "id"),
  mistral: (body) => idsFrom(body, "data", "id"),
  groq: (body) => idsFrom(body, "data", "id"),
  // `{ data: [{ id }] }` as well, and listed separately rather than merged: the
  // shapes are a per-provider decision the catalogue records, and collapsing two
  // rows that happen to agree today would hide the day one of them changes.
  anthropic: (body) => idsFrom(body, "data", "id"),
  // `{ models: [{ name: "models/gemini-x" }] }` — the segment after the last
  // slash is the bare id the caller qualifies.
  google: (body) => idsFrom(body, "models", "name").map(lastSegment),
};

function lastSegment(value: string): string {
  const cut = value.lastIndexOf("/");
  return cut < 0 ? value : value.slice(cut + 1);
}

function idsFrom(body: unknown, listKey: string, idKey: string): readonly string[] {
  if (body === null || typeof body !== "object") return [];
  const list = (body as Record<string, unknown>)[listKey];
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>)[idKey];
    if (typeof id === "string" && id !== "") ids.push(id);
  }
  return ids;
}

/** Present the credential the way this endpoint expects it. */
function authenticate(request: ListModelsRequest): { url: string; headers: Record<string, string> } {
  const material = request.credential.reveal();
  switch (request.endpoint.auth) {
    case "bearer":
      return { url: request.endpoint.url, headers: { authorization: `Bearer ${material}` } };
    case "header-key":
      // Anthropic's list surface. The key rides in its own header and the
      // version header is mandatory; without it the call is a 400, not a 401,
      // which would have read as a broken endpoint rather than a missing header.
      return {
        url: request.endpoint.url,
        headers: { "x-api-key": material, "anthropic-version": "2023-06-01" },
      };
    case "query-key":
      // Google puts the key in the query string. It is placed with
      // `encodeURIComponent` so a key containing a reserved character cannot
      // silently truncate the URL.
      return {
        url: `${request.endpoint.url}${request.endpoint.url.includes("?") ? "&" : "?"}key=${encodeURIComponent(material)}`,
        headers: {},
      };
  }
}

/**
 * Fetch and read one provider's list.
 *
 * The timeout is enforced with a signal of this call's own rather than left to
 * the transport: the budget belongs to the whole call including reading the
 * body, and a provider that streams a slow list would otherwise sit inside a
 * connect timeout indefinitely.
 */
export async function listPublishedModels(
  request: ListModelsRequest,
  transport: HttpTransport,
): Promise<Result<readonly string[]>> {
  const { url, headers } = authenticate(request);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), request.timeoutMs);
  try {
    const response = await transport(url, { headers, signal: deadline.signal });
    if (!response.ok) return err(providerRequestFailed(`model list returned ${response.status}`));
    const body: unknown = await response.json();
    return ok(SHAPE_READERS[request.endpoint.shape](body));
  } catch (thrown) {
    const reason = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : "model list failed";
    return err(providerRequestFailed(reason));
  } finally {
    clearTimeout(timer);
  }
}
