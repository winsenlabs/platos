// The rest transport seam, and — from WIN-267 (M4.1) T2 — the CHASSIS every
// route sits on.
//
// M4 STILL OWNS THE SURFACE. Not one business route lands in this tranche, and
// that is deliberate: the routes are worthless if each one has to decide for
// itself what a failure looks like, what a page looks like, and where the
// correlation identifier comes from. So T2 builds the parts that are the same
// for all 300 of them, and the later tranches spend their budget on the domain.
//
// WHAT IS HERE, AND WHAT EACH PIECE REFUSES TO LET A ROUTE DECIDE:
//
//   envelope.ts          the ITEM and COLLECTION shapes M0.4 §2 fixes, the build
//                        stamp that rides on both, and opaque cursors. A route
//                        chooses its DATA; it does not choose its shape.
//   page.ts              `?limit=&cursor=`, the BFF's 25/100, and a refusal
//                        carrying `fields[]` instead of a silent coercion.
//   transport-errors.ts  the four codes the envelope itself owns, and the reason
//                        no bounded context can mint them.
//   fault.ts             how a `DomainError` VALUE becomes something the
//                        framework routes — the one place a refusal is thrown.
//
// The Nest-shaped halves are in `src/http/`, deliberately: the filter, the pipe
// and the terminal 404 controller are the only parts that name a framework, and
// keeping them out of here is what lets everything above be exercised in a unit
// test with no server — the same split `runtime/lifecycle.ts` keeps from
// `main.ts`, one layer in.
//
// The shape rule is unchanged and is what M4's transports must still obey: a
// transport receives the composed `AppModule` and reads the system through it.
// It never imports `packages/adapters/*` — rule (j) plus
// `scripts/arch/composition-root.mjs` make that a CI failure rather than a
// convention — and it holds no business rule, because ADR M0.3 §6 budgets a
// transport at 500 lines and 12 routes precisely to stop it accumulating one.

import type { AppModule } from "../../app.module.js";

export interface RestTransport {
  readonly kind: "rest";
  readonly app: AppModule;
}

export {
  CONTRACT_BUILD_ID,
  CONTRACT_VERSION_HEADER,
  TOTAL_COUNT_HEADER,
  collectionEnvelope,
  decodeCursor,
  encodeCursor,
  itemEnvelope,
  type CollectionEnvelope,
  type DegradedNotice,
  type ItemEnvelope,
  type ItemMeta,
  type PageBlock,
  type PageResult,
} from "./envelope.js";
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parsePageQuery,
  type PageRequest,
} from "./page.js";
export { DomainFault, domainErrorOf, isDomainError, raise } from "./fault.js";
export { requestInvalid, routeNotFound, shuttingDown, unhandledFault } from "./transport-errors.js";
