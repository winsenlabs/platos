// The driven ports this context owns, published for the adapters that implement
// them (ADR M0.3 §13).
//
// FOUR PORTS AND NOT ONE MORE. Every other collaborator a turn needs — the model,
// the tools, the memory, the budget, the files, the durable seam — belongs to a
// context this one is permitted to depend on, and is reached through that
// context's published CONTRACT rather than through a port declared here. A fifth
// port named `ModelPort` or `ToolExecutorPort` would be this context re-declaring
// a neighbour's surface, and would give the composition root a second thing to
// wire where the ADR gives it one.
//
// THAT IS WHY `inference-sdk-only` IS SATISFIABLE AT ALL. The turn engine's
// inference seam is `providers`' `ModelRouter`, published on `providers`'
// contract as `runModelGeneration` and `streamModelGeneration`. This context asks
// for a generation; it does not own the port that performs one, and it names no
// vendor type anywhere.
//
// `application/index.js` IS NOT A PUBLISHED ENTRYPOINT. `package.json` exports
// exactly two subpaths — the contracts barrel and this one — so anything an
// adapter needs must be reachable from here and anything a peer needs must be
// reachable from `contracts/`.

export type {
  ThreadPage,
  ThreadPageQuery,
  ThreadRepository,
} from "./thread-repository.js";

export type {
  TurnPage,
  TurnPageQuery,
  TurnRepository,
  TurnWithSteps,
} from "./turn-repository.js";

export type {
  PostmanPage,
  PostmanPageQuery,
  PostmanRepository,
} from "./postman-repository.js";

export type {
  ConversationsErasureStore,
  ErasureCensus,
} from "./erasure-store.js";

// The refusals an adapter is expected to translate its store's errors into.
// Published from here rather than from `contracts/` for the reason `providers`
// gives of its own: these are adapter-facing, and a peer context has no business
// constructing this context's infrastructure errors.
export { queueUnavailable, repositoryUnavailable } from "../../domain/index.js";
