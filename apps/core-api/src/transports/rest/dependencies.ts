// WHAT A V1 TRANSPORT IS HANDED, AND THE ONE THING IT MAY NOT REACH THROUGH.
//
// Every controller in this tree takes exactly this and nothing else. It is a
// wrapper around the composed `AppModule` rather than the module itself for one
// reason that is worth the indirection: an injection token has to be a value, and
// a token whose value IS the application would make `@Inject(APP)` read like a
// service locator. Naming the dependency bundle keeps the shape a reader can grep
// for and matches `HEALTH_DEPENDENCIES` one directory over.
//
// IT DOES NOT NARROW `AppModule`, AND THAT IS ON PURPOSE. The obvious move is to
// hand a transport only `{ contexts, configuration, logger }` so it CANNOT read
// `adapters`. That would make the containment rule invisible: a reader of a
// controller would see a narrowed type and conclude somebody decided this, with
// no way to find the decision. `scripts/arch/composition-root.mjs` (C8) enforces
// it instead, over the whole `apps/core-api/src/transports/**` tree, by refusing
// any file that reads an `adapters` property at all — including one added
// tomorrow by somebody who never read this file. A type is a hint; the gate is
// the rule.

import type { AppModule } from "../../app.module.js";

/** The Nest injection token for the composed application. */
export const REST_APPLICATION = Symbol("platos.core-api.rest-application");

export interface RestApplication {
  readonly app: AppModule;
}
