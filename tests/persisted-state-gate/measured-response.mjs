import assert from "node:assert/strict";

export async function measuredJsonResponse(response, id) {
  const body = await response.text();
  const diagnostics = responseDiagnostics(response);
  assert.ok(response.ok, `${id} failed: ${diagnostics} body=${JSON.stringify(body.slice(0, 300))}`);
  assert.ok(body.length > 0, `${id} returned an empty response: ${diagnostics}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `${id} did not return JSON: ${diagnostics} body=${JSON.stringify(body.slice(0, 300))}`
    );
  }
}

export async function measuredRemixJsonResponse(response, id) {
  const diagnostics = responseDiagnostics(response);
  assert.equal(
    response.headers.get("x-remix-redirect"),
    null,
    `${id} redirected instead of executing the authenticated loader: ${diagnostics}`
  );
  assert.equal(
    response.headers.get("x-remix-status"),
    null,
    `${id} returned Remix redirect status metadata: ${diagnostics}`
  );
  assert.equal(response.status, 200, `${id} did not return HTTP 200: ${diagnostics}`);
  assert.equal(
    response.headers.get("x-remix-response"),
    "yes",
    `${id} did not return a successful Remix data response: ${diagnostics}`
  );
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json(?:;|$)/i,
    `${id} did not return JSON content: ${diagnostics}`
  );
  return measuredJsonResponse(response, id);
}

export function responseDiagnostics(response) {
  return [
    `status=${response.status} ${response.statusText}`,
    `url=${response.url}`,
    `redirected=${response.redirected}`,
    `location=${response.headers.get("location") ?? "none"}`,
    `content-type=${response.headers.get("content-type") ?? "none"}`,
    `x-remix-redirect=${response.headers.get("x-remix-redirect") ?? "none"}`,
    `x-remix-status=${response.headers.get("x-remix-status") ?? "none"}`,
    `x-remix-response=${response.headers.get("x-remix-response") ?? "none"}`,
  ].join(" ");
}
