// ADR M0.3 §4 kernel port: Logger.
//
// Structured only. There is no `log(string)` overload, because a formatted
// sentence cannot be redacted, indexed or correlated after the fact, and the
// cross-cutting observability gate requires all three.
//
// Redaction is the adapter's contract, not the caller's discipline: an adapter
// implementing this port is responsible for ensuring no field it emits carries a
// secret. The port makes that possible by keeping fields structured and separate
// from the message.

import type { JsonValue } from "../vo/domain-event.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, JsonValue>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  /** A logger that stamps `fields` onto everything it emits, for request scope. */
  child(fields: LogFields): Logger;
}
