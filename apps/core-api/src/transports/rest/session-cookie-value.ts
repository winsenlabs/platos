// THE BYTES OF THE OPERATOR SESSION COOKIE'S VALUE, AND WHY THERE ARE TWO READINGS.
//
// D19 (2026-09-15): "A cookie minted by the legacy Remix code must authenticate
// through core-api. A forced re-login does NOT count as a permitted cutover."
//
// THE DEFECT THIS CLOSES, MEASURED. The webapp writes the session with Remix's
// `createCookie(name).serialize(token)`, and Remix does not write the token: it
// writes `base64(JSON.stringify(token))` (its `encodeData`), which the `cookie`
// package then percent-encodes. `createCookie('__Host-platos_operator_session')
// .serialize('abc123tokenvalue')` is `__Host-platos_operator_session=
// ImFiYzEyM3Rva2VudmFsdWUi`. core-api's `readCookie` percent-decoded and stopped,
// so every live browser session hashed to a digest no `OperatorSession` row
// holds, and the first request routed to core-api at the cutover would have
// answered 401 to every signed-in operator. The T5 shape test pinned the cookie's
// NAME and ATTRIBUTES and not its value encoding, which is how it survived.
//
// SO THE VALUE HAS TWO READINGS, AND THEY CANNOT BE CONFUSED.
//
//   LEGACY  base64 of a JSON STRING. Decodes to UTF-8 text that parses as a
//           non-empty JSON string, and that string is the token.
//   RAW     anything else, taken as the token itself.
//
// A real token can never take the legacy branch by accident: every operator
// session token starts `plt_os_`, and `_` is not in the base64 alphabet this
// accepts, so the strict decode refuses it before JSON is ever consulted. A value
// that is valid base64 and decodes to something other than a JSON string — the
// `{}` Remix falls back to on a bad value, a number, an object — is not a legacy
// session either, and is handed on raw, where it matches no row and gets the
// ordinary `UNAUTHENTICATED`.
//
// AND THE WRITER SPEAKS THE LEGACY DIALECT. `DELETE`/`POST /bff/session` and the
// magic-link completion write `encodeLegacySessionValue(token)`, so a cookie core-api
// sets is also one a Remix loader still in service can parse during the per-route
// cutover (D11). That direction is proven against the real library too: Remix's
// own `cookie.parse` reads back the token from core-api's `Set-Cookie` bytes.
//
// WHY THE ALGORITHM IS RESTATED RATHER THAN IMPORTED. `@remix-run/node` is the
// webapp's dependency and a framework; core-api may not take either. The encoding
// is four lines of a published library that has not changed shape since Remix 1,
// and `identity-rest-legacy-cookie.integration.test.ts` executes the REAL library
// in the webapp's own package to mint and to parse, so a divergence is a red test
// rather than a quiet 401.

/** Strict base64: the standard alphabet, whole quanta, at most two `=`. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The token inside a Remix-encoded session value, or null when the value is not
 * one. Null is not a refusal; it means "take the value as it is".
 */
export function decodeLegacySessionValue(value: string): string | null {
  if (value === "" || !BASE64.test(value)) return null;
  let text: string;
  try {
    text = UTF8.decode(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
  if (!text.startsWith('"')) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "string" && parsed !== "" ? parsed : null;
  } catch {
    return null;
  }
}

/** The token a cookie value carries, in either dialect. */
export function sessionTokenFromCookieValue(value: string): string {
  return decodeLegacySessionValue(value) ?? value;
}

/**
 * A token written the way Remix's `createCookie(...).serialize` writes it —
 * `base64(JSON.stringify(token))` — BEFORE the header's percent-encoding.
 *
 * The EMPTY value stays empty. Clearing a cookie is `Max-Age=0` and its value is
 * never read, and `=;` is what every client and every existing assertion expects.
 */
export function encodeLegacySessionValue(token: string): string {
  return token === "" ? "" : Buffer.from(JSON.stringify(token), "utf8").toString("base64");
}
