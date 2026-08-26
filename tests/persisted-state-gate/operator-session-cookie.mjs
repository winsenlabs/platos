import { createCookie } from "@remix-run/node";

const productionOperatorSessionCookie = createCookie("__Host-platos_operator_session", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: true,
});

export async function productionOperatorSessionCookieHeader(token, expiresAt) {
  const serialized = await productionOperatorSessionCookie.serialize(token, { expires: expiresAt });
  return serialized.split(";", 1)[0];
}
