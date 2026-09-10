// THE REFUSALS THE STREAM LANE OWNS, AND WHY EACH ONE IS ITS OWN CODE.
//
// `http/idempotency-errors.ts` opened this seam and `rest/transport-errors.ts`
// widened it, and both state the rule: "the request envelope's own failures
// belong to the edge that owns the envelope. No context mints one of these,
// because no context knows a header exists." A resume cursor is exactly that kind
// of thing. `Last-Event-ID` is an HTTP header, `sv` is a wire negotiation, and a
// trimmed retention window is a property of the journal the EDGE reads — the
// kernel's `StreamJournal` deliberately reports FACTS and mints no code, for the
// reason `RequestIdempotency` mints none: a kernel that minted
// `STREAM_CURSOR_EXPIRED` would hide the mint from the transport that answers
// with it.
//
// SIX CODES AND NOT ONE, and the reason is the one `error-taxonomy.mjs` states as
// the whole point of that gate: "two guards returning the same error code cannot
// be told apart". Every pair below has a DIFFERENT operator response:
//
//   MALFORMED vs EXPIRED cursor — one is a broken or probing client, the other is
//   a retention window too short for its readers. Collapsing them would send an
//   operator to read client code when the answer is a configuration number.
//
//   UNKNOWN vs EXPIRED stream — one is a stream that never existed under this
//   scope, which is a bad request OR A FORGED SCOPE, and the other is one whose
//   frames aged out. The first is a security event and the second is capacity.
//
//   VERSION vs everything else — the caller and this build do not agree on the
//   envelope at all, so nothing further about the request is meaningful.
//
//   CREDENTIAL_EXPIRED — the credential that authorised this stream ran out WHILE
//   IT WAS OPEN. It is not `UNAUTHENTICATED` and it is not `SESSION_EXPIRED`:
//   both of those are answers to a REQUEST, and this is a mid-stream event a
//   client must be able to tell from every other reason a stream stopped, because
//   it is the one whose fix is "get a new token and resume".
//
//   FRAME_TOO_LARGE — the journal holds a frame this lane cannot honestly put on
//   the wire. See `sse.ts` for why that ENDS the stream rather than skipping the
//   frame.
//
// EVERY ONE OF THEM IS IN `docs/error-taxonomy.json` AND JOINED BY E1/E4, and the
// codes are written here as STRING LITERALS rather than through constants
// deliberately: `scripts/error-taxonomy.mjs` reads a mint as a `domainError(...)`
// call whose FIRST ARGUMENT IS A STRING LITERAL, so a code passed through a
// `const` is invisible to E1. Five codes in `packages/kernel/src/vo/retry.ts` are
// invisible for exactly that reason and carry no taxonomy entry; this file does
// not join them.
//
// NOTHING HERE ECHOES CALLER-CONTROLLED TEXT. `Last-Event-ID` is attacker-supplied
// on any lane a browser can reach, and a refusal that quoted the cursor it could
// not read would hand any caller a log-forging primitive through a header —
// `rest/transport-errors.ts` refuses to echo the unmatched PATH for the same
// reason. The stream id is not echoed either: on the forged-scope path it is the
// one value a prober is trying to confirm.

import { domainError, type DomainError } from "@platos/kernel";

/**
 * The caller sent a `Last-Event-ID` this build cannot read.
 *
 * `invalid_input` -> 400. The request is malformed, not unauthorised: a client
 * holding a cursor from a build with a different encoding is told so and starts
 * over, which is a different instruction from "your window closed".
 */
export function streamCursorUnreadable(): DomainError {
  return domainError(
    "STREAM_CURSOR_UNREADABLE",
    "invalid_input",
    "This resume position could not be read. Start the stream without one.",
    {
      fields: [
        {
          field: "Last-Event-ID",
          code: "malformed",
          // The FIELD, never the value. See the banner.
          message: "Send back an id this service issued on this stream.",
        },
      ],
    },
  );
}

/**
 * The cursor is well-formed and the frames after it are gone.
 *
 * `conflict` -> 409, which is the honest category and not a convenience. The
 * caller's request is valid and the SERVER's state makes it unanswerable, and the
 * only correct client behaviour is to abandon the position and start over — the
 * same instruction a 409 carries everywhere else in this surface. A 404 would say
 * the stream does not exist, which is false and would stop a client retrying a
 * stream that is still being written.
 *
 * IT IS THE ONE REFUSAL THIS WHOLE LANE EXISTS FOR. Answering with a page from the
 * oldest retained frame instead would hand the client a sequence that looks
 * continuous from its own next read onward while the state it renders is silently
 * missing everything in between.
 */
export function streamCursorExpired(): DomainError {
  return domainError(
    "STREAM_CURSOR_EXPIRED",
    "conflict",
    "The frames after this resume position are no longer retained. Start the stream again.",
  );
}

/**
 * No such stream under the scope this caller was authorised for.
 *
 * `not_found` -> 404, AND IT IS ALSO THE FORGED-SCOPE ANSWER, deliberately. The
 * journal key is built from the authorization tenancy re-derived, never from the
 * path, so a caller who names one environment and a stream created under another
 * reaches a key that does not exist. Answering 403 there would confirm the
 * stream's existence to a prober; answering 404 tells them nothing they did not
 * already supply.
 */
export function streamUnknown(): DomainError {
  return domainError(
    "STREAM_NOT_FOUND",
    "not_found",
    "No stream with this identifier exists in this environment.",
  );
}

/**
 * The journal is unreachable.
 *
 * `unavailable` -> 503, with NO `retryAfterSeconds`. The kernel populates that
 * field "only for `rate_limited` and `unavailable`" — permission, not obligation —
 * and a hint would be a guess: this lane does not know whether the store is
 * restarting or gone. `/readyz` says which binding is missing.
 */
export function streamJournalUnavailable(): DomainError {
  return domainError(
    "STREAM_JOURNAL_UNAVAILABLE",
    "unavailable",
    "The stream journal is unreachable, so this stream cannot be read or resumed.",
  );
}

/**
 * The credential that authorised this stream expired while it was open.
 *
 * `unauthenticated` -> 401 when it happens BEFORE the first byte. Once the stream
 * is open the status is already sent, so this code travels as a terminal
 * `stream.error` FRAME instead — which is why it must be distinguishable from
 * every other reason a stream ends, and why it is not `SESSION_EXPIRED`.
 * `identity-access` mints that one as an answer to a REQUEST; this is an answer
 * about a stream, and a client that conflated them would refresh its token and
 * then not know whether to resume.
 */
export function streamCredentialExpired(): DomainError {
  return domainError(
    "STREAM_CREDENTIAL_EXPIRED",
    "unauthenticated",
    "The credential that authorised this stream has expired. Present a new one and resume.",
  );
}

/**
 * The journal holds a frame this lane will not put on the wire.
 *
 * `invalid_input` -> 400 before the first byte, and a terminal `stream.error`
 * frame after it. The offending input is the PRODUCER's, not this reader's, which
 * is why it is `invalid_input` rather than `internal`: nothing is broken here, and
 * a client retrying will get the same frame.
 */
export function streamFrameTooLarge(): DomainError {
  return domainError(
    "STREAM_FRAME_TOO_LARGE",
    "invalid_input",
    "This stream holds a frame larger than one frame may be, so it cannot be delivered in order.",
  );
}
