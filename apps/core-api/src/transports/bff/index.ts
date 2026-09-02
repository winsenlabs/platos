// The bff transport seam.
//
// M4 OWNS THE SURFACE. This file is deliberately not a controller, a gateway or
// a route table: WIN-297 delivers the process and the wiring seam, and the
// business transports are M4's. What it does own is the SHAPE every transport
// must have, so M4 lands routes rather than also having to decide how a
// transport reaches the system.
//
// The shape is one rule: a transport receives the composed `AppModule` and reads
// the system through it. It never imports `packages/adapters/*` — rule (j) plus
// `scripts/arch/composition-root.mjs` make that a CI failure rather than a
// convention — and it holds no business rule, because ADR M0.3 §6 budgets a
// transport at 500 lines and 12 routes precisely to stop it accumulating one.

import type { AppModule } from "../../app.module.js";

export interface BffTransport {
  readonly kind: "bff";
  readonly app: AppModule;
}
