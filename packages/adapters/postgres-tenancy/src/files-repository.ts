// `files`' canonical store — one port, two tables, one connection, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// ONE COMPOSITE AND NOT THREE PROPERTIES. `FilesRepository` is a single port with
// fifteen methods whose names collide with nothing this directory already
// publishes — not with tenancy's thirty-one, identity-access's ten store
// properties, tools' twenty-five, agents' thirty-five, cost-monitoring's
// twenty-two, channels' seventeen, providers' eighteen, conversations' four
// stores or the outbox's two — so the three halves below are spread into one
// object and the composite is SPREAD INTO the adapter. That is what lets
// `PORT_SATISFACTION` in the composition root resolve
// `Satisfies<PostgresTenancyAdapter, FilesRepository>` at compile time, which a
// nested property could not.
//
// ONE TRANSACTION ACROSS BOTH TABLES, AND ACROSS THE OTHER TWELVE OWNERS. They
// are handed the SAME `TenancyTransactions`, which is what makes the erasure
// atomic: `files-erasure-target.ts` destroys a subject's attachment rows one by
// one and then deletes every artifact revision the subject authored, and both
// halves take the CALLER's `TransactionScope`. A thirteenth adapter package
// holding only this context's repository would have had its own pool and its own
// ambient frame, and a scope minted by one would be refused by the other as
// `scope_unknown` — a refusal naming the right fact and the wrong cause.
//
// WHAT IS NOT HERE, AND WHY. `files` declares TWO driven ports in
// `application/ports/index.ts` and this satisfies the ONE that is a canonical
// store.
//
//   `object-store.ts` is the OBJECT STORE, and it is this context's own
//   adapter-facing port (ADR M0.3 §13) with an adapter of its own:
//   `packages/adapters/objectstore-minio`, bound as `objectstore-minio:ObjectStore`
//   in the composition root and named as `files`' owner edge in
//   `EXPECTED_ADAPTER_OWNERS`. Its own header is explicit that it "names no
//   vendor" and that every operation addresses a `StorageKey` — a bucket, a
//   region, an endpoint and a presigning credential, none of which a PostgreSQL
//   client holds. `presignUpload` and `presignDownload` mint a signature over an
//   absolute expiry; `put`, `get` and `copy` move or duplicate BYTES server-side.
//   Satisfying any of the seven from here would put a blob store's contract in a
//   package that opens no bucket, and would make `files` a two-adapter context
//   whose two adapters both claimed the same port.
//
// AND THE ROW/BLOB SPLIT IS WHY THAT SEPARATION IS LOAD-BEARING RATHER THAN
// TIDY. `domain/destruction.ts` fixes the order — blob first, row second —
// precisely because the two live in different systems and no transaction spans
// them. A store that held both would have made that ordering look like an
// implementation detail it could optimise away.

import type { FilesRepository } from "@platos/context-files/application/ports/index.js";

import { createArtifactStore } from "./files-artifacts.js";
import { createAttachmentStore } from "./files-attachments.js";
import { createFilesErasureStore } from "./files-erasure.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the store over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown`.
 *
 * IT STAMPS NOTHING, unlike `skills`' store and `governance`'s five. Every
 * identifier and every instant this context writes arrives ON the value:
 * `Attachment.attachmentId` is derived by `presign-attachment-upload.ts` from
 * the kernel `IdGenerator` before the storage key is derived from it, and
 * `ArtifactRevision.createdAt` comes off the kernel `Clock`. A store that minted
 * either would have been the second place a row's identity is decided — and for
 * an attachment it would be the second place, because `deriveAttachmentStorageKey`
 * has already put the id inside the blob's address.
 */
export function createFilesRepository(transactions: TenancyTransactions): FilesRepository {
  return {
    ...createAttachmentStore(transactions),
    ...createArtifactStore(transactions),
    ...createFilesErasureStore(transactions),
  };
}
