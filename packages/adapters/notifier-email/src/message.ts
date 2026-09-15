// Writing one plain-text message as RFC 5322 bytes a relay will carry unchanged.
//
// THE BODY IS BASE64 AND THAT IS THE WHOLE TRANSFER-SAFETY STORY. A base64 body
// has no line over 76 characters, no bare CR or LF, no line beginning with `.`
// (so SMTP dot-stuffing can never alter it) and no byte above 0x7F (so no relay
// needs 8BITMIME). Every alternative — `8bit`, `quoted-printable` — is a set of
// edge cases this adapter would own; this has none.
//
// HEADERS ARE WHERE INJECTION LIVES, so every header value is REFUSED, not
// cleaned, if it carries a CR or LF. An address is additionally refused unless it
// is ASCII with one `@`: no SMTPUTF8 capability is claimed, and a relay
// discovering that mid-transaction is a worse failure than this one. A subject
// that is not ASCII is written as an RFC 2047 encoded-word, which is lossless.

import { err, ok, type Result } from "@platos/context-identity-access/application/ports/index.js";

import { messageRefused } from "./errors.js";

export interface PlainTextMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Without angle brackets: `local@domain`. */
  readonly messageId: string;
  readonly date: Date;
}

const LINE_BREAK = /[\r\n]/u;
const ASCII_ADDRESS = /^[\x21-\x7e]+@[\x21-\x7e]+$/u;

/** An envelope address, or a refusal naming the field. */
export function admitAddress(field: string, value: string): Result<string> {
  if (LINE_BREAK.test(value)) return err(messageRefused(field, "contains a line break"));
  const oneAt = value.indexOf("@") === value.lastIndexOf("@");
  if (!ASCII_ADDRESS.test(value) || !oneAt || value.includes("<") || value.includes(">")) {
    return err(messageRefused(field, "must be an ASCII address with one @"));
  }
  return ok(value);
}

/** The domain half of an admitted address. */
export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/u.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** 76-character base64 lines, CRLF-joined. RFC 2045 §6.8. */
function base64Body(text: string): string {
  const encoded = Buffer.from(text.replace(/\r?\n/gu, "\r\n"), "utf8").toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
  return lines.join("\r\n");
}

/**
 * The DATA payload, WITHOUT the terminating `CRLF.CRLF` — the session writes that,
 * because it is SMTP framing and not part of the message.
 */
export function renderMessage(message: PlainTextMessage): Result<string> {
  const from = admitAddress("from", message.from);
  if (!from.ok) return from;
  const to = admitAddress("to", message.to);
  if (!to.ok) return to;
  if (LINE_BREAK.test(message.subject)) return err(messageRefused("subject", "contains a line break"));
  if (LINE_BREAK.test(message.messageId) || !ASCII_ADDRESS.test(message.messageId)) {
    return err(messageRefused("messageId", "must be local@domain in ASCII"));
  }
  const headers = [
    `From: <${from.value}>`,
    `To: <${to.value}>`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${message.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${message.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  return ok(`${headers.join("\r\n")}\r\n\r\n${base64Body(message.text)}`);
}
