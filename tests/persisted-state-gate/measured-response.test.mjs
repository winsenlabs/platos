import assert from "node:assert/strict";
import { test } from "node:test";
import { measuredRemixJsonResponse } from "./measured-response.mjs";

test("accepts an exact successful Remix JSON data response", async () => {
  const response = new Response(JSON.stringify({ panel: { ok: true } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Remix-Response": "yes",
    },
  });

  assert.deepEqual(await measuredRemixJsonResponse(response, "agents.loader"), {
    panel: { ok: true },
  });
});

test("fails loudly when Remix rewrites an authentication redirect to an empty 204", async () => {
  const response = new Response(null, {
    status: 204,
    headers: {
      "X-Remix-Redirect": "/login?redirectTo=%2Forgs%2Falpha%2Fagents",
      "X-Remix-Status": "302",
    },
  });

  await assert.rejects(
    measuredRemixJsonResponse(response, "agents.loader"),
    /redirected instead of executing the authenticated loader:.*status=204.*x-remix-redirect=\/login.*x-remix-status=302/
  );
});
