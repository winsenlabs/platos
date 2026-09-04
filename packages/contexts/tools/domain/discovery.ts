// BM25 tool discovery — the ranking function `find_tools` is.
//
// A scope can expose hundreds of tools and a turn's prompt has room for
// fifteen. Something has to choose, and this is it: an Okapi BM25 index over
// each tool's name, description and parameter names, built in memory from the
// dispatchable exposures and searched in about a millisecond. No embedding
// call, no vector store, no network on the path between a model asking for a
// tool and being told which ones exist.
//
// THIS IS A VALUE, NOT A SERVICE. The source holds a mutable `BM25Index` class
// with `addDocument` / `removeDocument` and a comment explaining that
// `addDocument` is idempotent per id so a rebuild "could refresh and add, but
// never drop a doc that had left the source set — a rebuild that cannot shrink
// is not a rebuild". The class then works around its own mutability by
// discarding the instance and building a new one on every change. Building the
// whole index from a document set is therefore the ONLY operation the running
// system actually uses, and it is the only one here: `buildIndex` takes the
// documents and returns a frozen index. There is no way to add one and no way
// to forget to drop one.
//
// SCORES ARE NOT COMPARABLE ACROSS INDEXES. `idf` is computed against this
// index's document count, so a tool's score depends on what else is indexed.
// Nothing here exposes a threshold for that reason — the ranking is the answer,
// the number is not.

import type { ToolDiscoveryPolicy } from "./policy.js";

/**
 * Words carrying no discriminating power in a tool description.
 *
 * Transcribed verbatim. It is deliberately an English function-word list and
 * not a domain list: "create", "delete", "file" and "search" are exactly the
 * terms a query is made of, and a stoplist that reached them would make the
 * commonest searches unanswerable.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "and", "but", "or", "nor", "not", "so",
  "yet", "both", "either", "neither", "each", "every", "all", "any",
  "few", "more", "most", "other", "some", "such", "no", "only", "own",
  "same", "than", "too", "very", "just", "because", "if", "when", "where",
  "how", "what", "which", "who", "whom", "this", "that", "these", "those",
  "it", "its", "i", "me", "my", "we", "our", "you", "your", "he", "him",
  "his", "she", "her", "they", "them", "their",
]);

/**
 * Lowercase, split on anything that is not a letter, digit or underscore, drop
 * single characters and stopwords.
 *
 * The underscore SURVIVES on purpose: `create_issue` is one token, not two, and
 * splitting it would make every snake_case tool name score as its parts. The
 * dot does not survive, so `github.create_issue` yields `github` and
 * `create_issue` — a query for either finds it.
 */
export function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** One indexed document: an id and the text it is found by. */
export interface DiscoveryDocument {
  readonly id: string;
  readonly text: string;
}

interface IndexedDocument {
  readonly id: string;
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

/** A built index. Opaque: nothing outside this file reads its shape. */
export interface DiscoveryIndex {
  readonly documents: readonly IndexedDocument[];
  readonly documentFrequencies: ReadonlyMap<string, number>;
  readonly averageLength: number;
  readonly termSaturation: number;
  readonly lengthNormalisation: number;
}

export interface DiscoveryHit {
  readonly id: string;
  readonly score: number;
}

/**
 * Build the index from the complete document set.
 *
 * A repeated id is indexed once, at its FIRST occurrence, matching the source's
 * `indexed` guard while it builds. That is not a tidiness rule: the same
 * `Tool` row can be exposed by several entities in one environment, and
 * counting it twice would inflate its own document frequency and depress the
 * score of every tool that shares a term with it.
 */
export function buildIndex(
  documents: readonly DiscoveryDocument[],
  policy: ToolDiscoveryPolicy,
): DiscoveryIndex {
  const indexed: IndexedDocument[] = [];
  const seen = new Set<string>();
  const documentFrequencies = new Map<string, number>();

  for (const document of documents) {
    if (seen.has(document.id)) continue;
    seen.add(document.id);

    const termFrequencies = new Map<string, number>();
    const tokens = tokenize(document.text);
    for (const token of tokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    for (const term of termFrequencies.keys()) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
    }
    indexed.push({ id: document.id, termFrequencies, length: tokens.length });
  }

  const totalLength = indexed.reduce((sum, document) => sum + document.length, 0);
  return Object.freeze({
    documents: Object.freeze(indexed),
    documentFrequencies,
    averageLength: indexed.length === 0 ? 0 : totalLength / indexed.length,
    termSaturation: policy.termSaturation,
    lengthNormalisation: policy.lengthNormalisation,
  });
}

export const EMPTY_DISCOVERY_INDEX: DiscoveryIndex = Object.freeze({
  documents: Object.freeze([]),
  documentFrequencies: new Map<string, number>(),
  averageLength: 0,
  termSaturation: 0,
  lengthNormalisation: 0,
});

/**
 * Rank the index against a query.
 *
 * Documents scoring zero are dropped rather than returned last. A tool that
 * shares no term with the query is not a weak answer, it is not an answer, and
 * padding fifteen slots with them would spend a model's context on noise.
 *
 * Ties break on id, ascending, so a query that cannot distinguish two tools
 * still returns them in the same order every time. A ranking that is only
 * deterministic when the scores differ is one an evaluation cannot pin.
 */
export function searchIndex(
  index: DiscoveryIndex,
  query: string,
  limit: number,
  restrictTo?: ReadonlySet<string>,
): readonly DiscoveryHit[] {
  if (index.documents.length === 0 || limit <= 0) return [];
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const hits: DiscoveryHit[] = [];
  for (const document of index.documents) {
    if (restrictTo !== undefined && !restrictTo.has(document.id)) continue;
    const score = scoreDocument(index, document, terms);
    if (score > 0) hits.push({ id: document.id, score });
  }

  hits.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return hits.slice(0, limit);
}

function scoreDocument(
  index: DiscoveryIndex,
  document: IndexedDocument,
  terms: readonly string[],
): number {
  let score = 0;
  for (const term of terms) {
    const termFrequency = document.termFrequencies.get(term) ?? 0;
    if (termFrequency === 0) continue;

    // Robertson/Sparck-Jones inverse document frequency with the +1 that keeps
    // it non-negative. Without the +1 a term present in more than half the
    // documents scores NEGATIVE, and a tool could be pushed below a tool that
    // does not contain the query term at all.
    const documentFrequency = index.documentFrequencies.get(term) ?? 0;
    const idf = Math.log(
      (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1,
    );

    const numerator = termFrequency * (index.termSaturation + 1);
    const denominator =
      termFrequency +
      index.termSaturation *
        (1 - index.lengthNormalisation +
          index.lengthNormalisation * (document.length / index.averageLength));
    score += idf * (numerator / denominator);
  }
  return score;
}

export interface DiscoveryStats {
  readonly documentCount: number;
  readonly uniqueTerms: number;
  readonly averageLength: number;
}

/** What an operator sees when they ask whether discovery is working. */
export function indexStats(index: DiscoveryIndex): DiscoveryStats {
  return {
    documentCount: index.documents.length,
    uniqueTerms: index.documentFrequencies.size,
    averageLength: Math.round(index.averageLength * 100) / 100,
  };
}
