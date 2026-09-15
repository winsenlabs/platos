// WHICH THROWN VALUES MEAN "THE STORE DID NOT ANSWER".
//
// The exception filter receives, on its fourth arm, anything a route threw that
// is not a `DomainError`. Most of those are defects and are reported as
// `TRANSPORT_UNHANDLED_FAULT` at 500. ONE family is not: the database client
// failing because the database stopped answering. Measured through this process
// against a PostgreSQL container frozen with `docker pause`: an operator-session
// lookup held its request for the client's 20-second socket deadline and then
// answered 500 with an error id — a defect report for a process that was working,
// about a store that was down.
//
// RECOGNISED STRUCTURALLY, BECAUSE THE EDGE MAY NOT IMPORT THE CLIENT. ADR M0.3
// §15 gives the ORM one home (`tenancy-prisma-only` refuses its packages anywhere
// else), so this reads the shape the client documents for its errors — a `name`
// and a `code` — and imports nothing. The recognised set is closed and small:
//
//   request errors, by code:
//     P1001  the database server could not be reached
//     P1002  it was reached and did not answer in time
//     P1008  an operation timed out (the socket deadline a frozen server hits)
//     P1017  the server closed the connection
//     P2024  no pooled connection was free before the pool deadline
//   initialisation errors, whatever their code:
//     the client could not open a connection when the request needed one. The
//     configuration was validated before the process started, so at request time
//     this is the database refusing or not answering — measured with the server
//     paused (5 s connect deadline) and stopped (refused at once); the client
//     reports no code for either.
//
// Everything else — a unique violation that escaped its repository, a
// programming error, a malformed query — is still a defect and still a 500.

/** Request-error codes that mean the database did not answer or could not be used. */
export const STORE_UNAVAILABLE_REQUEST_CODES: ReadonlySet<string> = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);

const REQUEST_ERROR = "PrismaClientKnownRequestError";
const INITIALIZATION_ERROR = "PrismaClientInitializationError";

/** True when a thrown value is the database client reporting an unavailable store. */
export function isStoreUnavailableFault(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) return false;
  const { name, code } = thrown as { readonly name?: unknown; readonly code?: unknown };
  if (name === INITIALIZATION_ERROR) return true;
  return name === REQUEST_ERROR && typeof code === "string" && STORE_UNAVAILABLE_REQUEST_CODES.has(code);
}
