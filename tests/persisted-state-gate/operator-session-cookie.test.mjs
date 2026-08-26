import assert from "node:assert/strict";
import { test } from "node:test";
import { createCookie } from "@remix-run/node";
import { productionOperatorSessionCookieHeader } from "./operator-session-cookie.mjs";

test("serializes the performance runner session through the production Remix cookie contract", async () => {
  const token = "plt_os_test-session-token";
  const expiresAt = new Date("2026-08-26T00:00:00.000Z");
  const header = await productionOperatorSessionCookieHeader(token, expiresAt);
  const cookie = createCookie("__Host-platos_operator_session", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });

  assert.match(header, /^__Host-platos_operator_session=/);
  assert.notEqual(header, `__Host-platos_operator_session=${token}`);
  assert.equal(await cookie.parse(header), token);
});
