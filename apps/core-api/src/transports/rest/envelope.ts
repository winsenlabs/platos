// THE TWO SUCCESS ENVELOPES M0.4 §2 FIXES, AND THE BUILD STAMP ON THEM.
//
// §2's REST row names three canonical shapes and `http/failure.ts` already
// serves the third. These are the other two, verbatim:
//
//   ITEM        { data, meta: { contractVersion } }
//   COLLECTION  { data[], page: { cursor, nextCursor|null, limit, hasMore,
//                total? } }  + `X-Total-Count`
//
// THE COLLECTION SHAPE HAS NO `meta`, AND THAT IS THE ADR'S SHAPE RATHER THAN AN
// OVERSIGHT THIS FILE TIDIED UP. The build stamp rides in the
// `X-Platos-Contract-Version` header on EVERY response, item and collection
// alike; `meta.contractVersion` is the item envelope's additional copy of it,
// for a client holding a persisted response with no headers left. Inventing a
// `meta` on collections would be a field the ADR does not declare, and §1's
// "unknown-tolerance + additive-only" promise is worth exactly as much as the
// discipline of not quietly adding shapes to a frozen envelope.
//
// TWO DIFFERENT VERSIONS TRAVEL ON ONE RESPONSE, AND CONFUSING THEM IS THE TRAP.
//   * the MAJOR — `"1"` — is the break axis. It is in the URL, and it is what
//     `error.version` carries. `http/failure.ts` owns it as `CONTRACT_VERSION`
//     and explains why it must not move on a release.
//   * the BUILD ID — `manifestVersion` — is the additive stamp. It moves every
//     milestone, it is advisory, and it is what `contractVersion` names here and
//     in the `X-Platos-Contract-Version` header.
// A single client reads both: it PINS the major and ASSERTS A FLOOR on the build
// id. Putting the build id in `error.version` would make a caller's branch on an
// immutable code fail on a routine release; putting the major here would make
// the floor assertion useless.
//
// THE BUILD ID IS NOT DECIDED HERE. ADR M0.4 §1.1: "the version is generated,
// never hand-written. It is read out of `operation-manifest.generated.json` and
// stamped onto the wire; a hand-edit that disagrees with the manifest fails CI."
// This process cannot import that manifest — it belongs to `apps/agent`, which
// is not a dependency of this deployable and must not become one — so the
// constant below is a COPY, and the copy is joined to its source by a named case
// in `rest-chassis.test.ts` that reads the manifest off disk. That is the same
// join `http/idempotency.integration.test.ts` makes for statuses against
// `docs/error-taxonomy.json`: a literal is allowed as long as something outside
// the file it lives in decides whether it is right.

import type { JsonValue } from "@platos/kernel";

/**
 * The additive build stamp, equal to `manifestVersion` in
 * `apps/agent/src/control-plane/operation-manifest.generated.json`.
 *
 * IT IS `M0.1` AND NOT `M0.4`, WHICH LOOKS WRONG AND IS NOT. The ADR is the
 * M0.4 document and says "this milestone = M0.4", but the stamp is defined as
 * whatever the ONE manifest says, and that manifest still reads `M0.1` on both
 * the frozen oracle and on `v1`. Writing `M0.4` here would make this file
 * disagree with the artifact the ADR names as the single source, which is the
 * one thing §1.1 forbids. Bumping the manifest is the generator's decision and a
 * different tranche's; when it moves, the named join below fails and this
 * constant moves with it.
 */
export const CONTRACT_BUILD_ID = "M0.1";

/** The build stamp's header. M0.4 §2, spelled once. */
export const CONTRACT_VERSION_HEADER = "X-Platos-Contract-Version";

/** The collection envelope's companion header. M0.4 §2, spelled once. */
export const TOTAL_COUNT_HEADER = "X-Total-Count";

/**
 * A degraded read, as M0.4 §2 defines it: "Degraded -> 200 + meta.degraded
 * {service, fallback}".
 *
 * It is on the SUCCESS envelope and not the failure one on purpose. A recall
 * that fell back from embeddings to keyword search answered the question; a
 * caller that received a 503 instead would retry a request that was already
 * served, and a caller that received a bare 200 would never learn that the
 * answer was second-best.
 */
export interface DegradedNotice {
  readonly service: string;
  readonly fallback: string;
}

export interface ItemMeta {
  readonly contractVersion: string;
  readonly degraded?: DegradedNotice;
}

export interface ItemEnvelope<Data> {
  readonly data: Data;
  readonly meta: ItemMeta;
}

/**
 * The page block. `total` is OPTIONAL and that is a promise, not a convenience:
 * an exact count over a large filtered set is a second query with its own cost,
 * and a transport that always reported one would either always pay it or
 * sometimes lie. Absent means "not counted", never "zero".
 */
export interface PageBlock {
  /** The cursor this page was requested with; null for the first page. */
  readonly cursor: string | null;
  /** The cursor for the next page, or null when this is the last one. */
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly total?: number;
}

export interface CollectionEnvelope<Row> {
  readonly data: readonly Row[];
  readonly page: PageBlock;
}

export function itemEnvelope<Data>(data: Data, degraded?: DegradedNotice): ItemEnvelope<Data> {
  const meta: ItemMeta =
    degraded === undefined
      ? { contractVersion: CONTRACT_BUILD_ID }
      : { contractVersion: CONTRACT_BUILD_ID, degraded };
  return { data, meta };
}

export interface PageResult<Row> {
  readonly rows: readonly Row[];
  /** Echoed back as `page.cursor`. */
  readonly cursor: string | null;
  readonly limit: number;
  readonly nextCursor: string | null;
  /** Omit when the count was not taken. See `PageBlock.total`. */
  readonly total?: number;
}

/**
 * `hasMore` IS DERIVED FROM `nextCursor`, NOT SUPPLIED.
 *
 * They are the same fact — "there is another page" — and two fields carrying one
 * fact is two fields that can disagree. A caller that trusted `hasMore` and
 * found `nextCursor` null would loop forever or stop early depending on which it
 * read, and no test that supplies both consistently would ever see it.
 */
export function collectionEnvelope<Row>(page: PageResult<Row>): CollectionEnvelope<Row> {
  const block: PageBlock = {
    cursor: page.cursor,
    nextCursor: page.nextCursor,
    limit: page.limit,
    hasMore: page.nextCursor !== null,
    ...(page.total === undefined ? {} : { total: page.total }),
  };
  return { data: [...page.rows], page: block };
}

// `X-Platos-Contract-Version` IS STAMPED BY THE EDGE, NOT BY A ROUTE, which is
// why there is no header helper in this file for a route to call.
// `runtime/edge-middleware.ts` sets it on every response before anything is
// routed. A header three hundred handlers each have to remember is a header some
// of them will not carry, and the ones that forget are exactly the error paths —
// the 404, the shutdown refusal, the 500 — where a client working out which
// build answered it needs it most. It reads `CONTRACT_BUILD_ID` above, so the
// header and `meta.contractVersion` cannot disagree.
//
// `X-Total-Count` is the opposite case and stays a route's business: it asserts
// a count only the handler knows was taken, and a count nobody took is a lie
// with a number in it.

/**
 * An opaque cursor.
 *
 * OPAQUE IS A CONTRACT, NOT AN ENCRYPTION CLAIM. M0.4 §2 says "opaque cursors",
 * and what that buys is the freedom to change what a cursor means inside a
 * major — from an offset to a keyset to a snapshot id — without breaking a
 * client, because no client was entitled to read it. base64url of JSON is
 * therefore honest: a determined caller can decode it, and the contract says
 * that anything they learn by doing so may change without notice. Signing it
 * would be a different promise (tamper-evidence) at a different cost, and
 * nothing in V1 has yet named a decision that needs one.
 */
export function encodeCursor(value: JsonValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** The value inside a cursor, or null when it is not one this service minted. */
export function decodeCursor(raw: string): JsonValue | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    // A cursor round-trips. base64url decoding is lossy over arbitrary input —
    // it accepts bytes that were never base64 — so the parse is what actually
    // decides, and a value that parses to something JSON did not produce is
    // refused rather than handed to a repository.
    return JSON.parse(decoded) as JsonValue;
  } catch {
    return null;
  }
}
