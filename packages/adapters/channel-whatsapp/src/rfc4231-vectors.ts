// RFC 4231 §4 — "Test Vectors for HMAC-SHA-224, HMAC-SHA-256, HMAC-SHA-384, and
// HMAC-SHA-512", ALL SEVEN CASES, the HMAC-SHA-256 half, TRANSCRIBED.
//
// Source: RFC 4231, section 4 (§4.2 through §4.8), as published at
// https://www.rfc-editor.org/rfc/rfc4231.txt. Each case's `Key`, `Data` and
// `HMAC-SHA-256` hex, joined across the RFC's line wraps, and nothing else.
//
// WHY THIS FILE EXISTS AT ALL — AND IT IS THE DIFFERENCE FROM `channel-slack`.
// Slack publishes a complete worked request-verification example, so
// `channel-slack/src/published-vector.ts` can transcribe a real signature and
// prove the adapter against the vendor's own arithmetic. META PUBLISHES NO SUCH
// VECTOR for `X-Hub-Signature-256`: the Webhooks "Payload validation" page gives
// the construction in prose and code and never a worked example with concrete
// bytes. So the adapter's primitive is joined to the STANDARD instead — these
// vectors — and its CONSTRUCTION is joined to Meta's documented prose, which
// `vendor.ts` transcribes with provenance. The two joins are different in kind
// and `rfc4231.test.ts` says which is which, so nobody later mistakes the second
// for the first.
//
// WHY ALL SEVEN AND NOT THE FIRST. Each exercises a different edge of the same
// primitive, and the ones that matter here are the KEY-LENGTH edges, because
// HMAC's key schedule is where implementations actually differ: a key SHORTER
// than the 64-byte block (cases 1, 2, 5), a key exactly at 20 bytes with a long
// message (case 3), a 25-byte key with non-repeating bytes (case 4), and a key
// LONGER than the block, which must be hashed first (cases 6 and 7). A verifier
// that skipped the hash-the-long-key step would pass a suite built on case 1
// alone and refuse every real delivery from a business whose app secret is long.
//
// NOTHING IN THIS REPOSITORY GENERATED THESE VALUES, and `rfc4231.test.ts`
// re-derives every digest twice from the inputs — once through `node:crypto`'s
// `createHmac`, which is what `hmac.ts` uses, and once through an HMAC BUILT HERE
// from `node:crypto`'s raw SHA-256 exactly as RFC 2104 §2 defines it. A
// transcription error fails both; an error in `hmac.ts` fails the first; an error
// in the hand-built one fails the second. One mistyped digit anywhere fails at
// least one of those.
//
// THE KEYS ARE NOT SECRETS. They are published in an IETF standard so that every
// HMAC implementation in the world can be checked against them, and no Meta app
// secret is among them.

/** One RFC 4231 §4 vector. Every field is the RFC's lower-case hex. */
export interface Rfc4231Vector {
  /** The RFC's own section number, so a reader can find the case. */
  readonly name: string;
  readonly key: string;
  /** The length the RFC STATES for the key, checked against `key` rather than trusted. */
  readonly keyLength: number;
  readonly data: string;
  readonly dataLength: number;
  /**
   * The RFC's `HMAC-SHA-256` line. Case 5 publishes a TRUNCATED digest
   * (HMAC-SHA-256-128, the first 16 bytes), which is why comparisons are made
   * against the first `digest.length` hex digits rather than the whole 64.
   */
  readonly hmacSha256: string;
  /** True for the one case whose published digest is truncated. */
  readonly truncated: boolean;
}

export const RFC4231_HMAC_SHA256_VECTORS: readonly Rfc4231Vector[] = Object.freeze([
  Object.freeze({
    name: "Test Case 1",
    key: "0b".repeat(20),
    keyLength: 20,
    // "Hi There"
    data: "4869205468657265",
    dataLength: 8,
    hmacSha256: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    truncated: false,
  }),
  Object.freeze({
    name: "Test Case 2",
    // "Jefe" — a key SHORTER than the digest, which is legal and is where a
    // padding bug hides.
    key: "4a656665",
    keyLength: 4,
    // "what do ya want for nothing?"
    data: "7768617420646f2079612077616e7420666f72206e6f7468696e673f",
    dataLength: 28,
    hmacSha256: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    truncated: false,
  }),
  Object.freeze({
    name: "Test Case 3",
    key: "aa".repeat(20),
    keyLength: 20,
    data: "dd".repeat(50),
    dataLength: 50,
    hmacSha256: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
    truncated: false,
  }),
  Object.freeze({
    name: "Test Case 4",
    key: "0102030405060708090a0b0c0d0e0f10111213141516171819",
    keyLength: 25,
    data: "cd".repeat(50),
    dataLength: 50,
    hmacSha256: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b",
    truncated: false,
  }),
  Object.freeze({
    name: "Test Case 5",
    key: "0c".repeat(20),
    keyLength: 20,
    // "Test With Truncation"
    data: "546573742057697468205472756e636174696f6e",
    dataLength: 20,
    // HMAC-SHA-256-128: the RFC publishes only the first 128 bits for this case.
    hmacSha256: "a3b6167473100ee06e0c796c2955552b",
    truncated: true,
  }),
  Object.freeze({
    name: "Test Case 6",
    // 131 bytes — LONGER than SHA-256's 64-byte block, so the key is hashed first.
    key: "aa".repeat(131),
    keyLength: 131,
    // "Test Using Larger Than Block-Size Key - Hash Key First"
    data:
      "54657374205573696e67204c6172676572205468616e20426c6f636b2d53697a" +
      "65204b6579202d2048617368204b6579204669727374",
    dataLength: 54,
    hmacSha256: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    truncated: false,
  }),
  Object.freeze({
    name: "Test Case 7",
    key: "aa".repeat(131),
    keyLength: 131,
    // "This is a test using a larger than block-size key and a larger than
    //  block-size data. The key needs to be hashed before being used by the HMAC
    //  algorithm."
    data:
      "5468697320697320612074657374207573696e672061206c6172676572207468" +
      "616e20626c6f636b2d73697a65206b657920616e642061206c61726765722074" +
      "68616e20626c6f636b2d73697a6520646174612e20546865206b6579206e6565" +
      "647320746f20626520686173686564206265666f7265206265696e6720757365" +
      "642062792074686520484d414320616c676f726974686d2e",
    dataLength: 152,
    hmacSha256: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    truncated: false,
  }),
]);
