// `ContentDigest` — the one primitive this context needs and may not import.
//
// Two domain rules end in a hash and neither may take one itself:
//
//   `Tool.schemaHash` is the truncated digest of the canonical tool document,
//   which is what makes a tool row content-addressed and a re-registration
//   idempotent.
//
//   the MCP session pool key is the digest of the canonical resolved header
//   set, which is what stops two credentials sharing one session.
//
// Both canonical FORMS are domain rules and are stated in `domain/tool.ts` and
// `domain/mcp-client.ts`. Only the digest is infrastructure, so only the digest
// is a port. Splitting it this way is what lets the canonicalisation — the part
// that can be subtly wrong, and that decides whether two things are one thing —
// be unit-tested with no crypto at all.
//
// SHA-256, HEX, LOWERCASE. Named in the method rather than left to an adapter's
// discretion: `Tool.schemaHash` is persisted, so changing the algorithm remints
// every tool row in the installation. That is a migration, and it should look
// like one.
//
// THIS IS NOT AN ENCRYPTION SEAM. `secrets` is the encryption boundary and the
// only holder of data keys (ADR M0.3 §1 row 3). A digest is one-way, keyless
// and reveals nothing, which is exactly why it can live behind a port this
// context owns while sealing an audit row's arguments cannot.

export interface ContentDigest {
  /** Lowercase hex SHA-256 of the UTF-8 bytes of `input`. */
  sha256Hex(input: string): string;
}
