// The one place a vector is produced, and the one place its width is checked.
//
// Three call sites need an embedding — writing a memory, revising one, and
// running a recall query — and all three go through here, so the two rules that
// govern vectors in this context are stated once:
//
//   A `profile` ROW IS STORED WITHOUT ONE. The source computes no vector for a
//   profile and clears any vector a row had when it BECOMES a profile. The
//   reason is a product decision, not an optimisation: a profile is read by key
//   from the turn-start injector, never by similarity, and an embedded profile
//   would surface as a semantic-search hit for a query it was never meant to
//   answer — usually as the single closest row, because it is a summary of
//   everything about the subject.
//
//   A VECTOR THAT CANNOT BE STORED IS REFUSED BEFORE THE ROW IS BUILT. The
//   column is `vector(1536)`; a model that returned another width, or a `NaN`
//   component, produces a row that either fails to insert or — worse — inserts
//   and then makes every distance computation involving it return `NaN`, which
//   sorts unpredictably rather than failing. `isStorableEmbedding` is the check
//   and `MEMORY_EMBEDDING_UNAVAILABLE` is what a caller sees.

import { err, ok, type Result } from "@platos/kernel";

import { embeddingUnavailable, type MemoryKind } from "../domain/index.js";
import type { MemoryDependencies } from "./dependencies.js";
import { CLEAR_EMBEDDING, isStorableEmbedding, type EmbeddingDirective } from "./ports/index.js";

/** What a write does to the vector column, for a row of this kind. */
export async function embedForStorage(
  dependencies: MemoryDependencies,
  kind: MemoryKind,
  content: string,
): Promise<Result<EmbeddingDirective>> {
  if (kind === "profile") return ok(CLEAR_EMBEDDING);
  const vector = await embedQuery(dependencies, content);
  if (!vector.ok) return err(vector.error);
  return ok({ action: "set", vector: vector.value });
}

/** A query vector, checked to the same width as a stored one. */
export async function embedQuery(
  dependencies: MemoryDependencies,
  text: string,
): Promise<Result<readonly number[]>> {
  const embedded = await dependencies.embeddings.embed(text);
  if (!embedded.ok) return err(embedded.error);
  if (!isStorableEmbedding(embedded.value)) {
    return err(
      embeddingUnavailable(
        `the model returned ${embedded.value.length} component(s); the column is vector(1536)`,
      ),
    );
  }
  return ok(embedded.value);
}
