/**
 * BM25 — pure TypeScript implementation for tool discovery.
 *
 * Indexes tool descriptions at registration time. Searches in ~1ms
 * for 500+ tools. No external dependencies, no embedding API calls.
 *
 * Standard BM25 parameters: k1=1.5, b=0.75
 */

const K1 = 1.5;
const B = 0.75;

// Simple tokenizer: lowercase, split on non-alphanumeric, remove stopwords
const STOPWORDS = new Set([
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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface IndexedDoc {
  id: string;
  tokens: string[];
  tokenFreqs: Map<string, number>;
  length: number;
}

export class BM25Index {
  private docs: Map<string, IndexedDoc> = new Map();
  private docFreqs: Map<string, number> = new Map(); // term → number of docs containing it
  private avgDocLength = 0;
  private totalDocs = 0;

  /**
   * Drop every document.
   *
   * `addDocument` is idempotent per id, so a rebuild could refresh and add, but
   * never drop a doc that had left the source set — the index could only grow.
   * A rebuild that cannot shrink is not a rebuild.
   */
  clear(): void {
    this.docs.clear();
    this.docFreqs.clear();
    this.avgDocLength = 0;
    this.totalDocs = 0;
  }

  /**
   * Add a document to the index.
   * Call this when a tool is registered. The text should be:
   * `${tool.name} ${tool.description} ${paramNames.join(" ")}`
   */
  addDocument(id: string, text: string): string[] {
    // Remove old version if exists (re-registration)
    this.removeDocument(id);

    const tokens = tokenize(text);
    const tokenFreqs = new Map<string, number>();
    for (const token of tokens) {
      tokenFreqs.set(token, (tokenFreqs.get(token) || 0) + 1);
    }

    const doc: IndexedDoc = { id, tokens, tokenFreqs, length: tokens.length };
    this.docs.set(id, doc);

    // Update document frequencies
    for (const term of tokenFreqs.keys()) {
      this.docFreqs.set(term, (this.docFreqs.get(term) || 0) + 1);
    }

    // Update stats
    this.totalDocs = this.docs.size;
    this.avgDocLength = this._computeAvgLength();

    return tokens; // Return for storage in DB (bm25Tokens column)
  }

  /**
   * Remove a document from the index.
   */
  removeDocument(id: string): void {
    const existing = this.docs.get(id);
    if (!existing) return;

    // Decrement document frequencies
    for (const term of existing.tokenFreqs.keys()) {
      const current = this.docFreqs.get(term) || 0;
      if (current <= 1) {
        this.docFreqs.delete(term);
      } else {
        this.docFreqs.set(term, current - 1);
      }
    }

    this.docs.delete(id);
    this.totalDocs = this.docs.size;
    this.avgDocLength = this._computeAvgLength();
  }

  /**
   * Search the index. Returns document IDs sorted by BM25 score (descending).
   *
   * @param query — natural language query, e.g., "search for a person"
   * @param limit — max results to return
   * @param filterIds — optional set of doc IDs to restrict search to
   * @returns Array of { id, score } sorted by score descending
   */
  search(
    query: string,
    limit: number = 15,
    filterIds?: Set<string>,
  ): Array<{ id: string; score: number }> {
    if (this.totalDocs === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores: Array<{ id: string; score: number }> = [];

    for (const [docId, doc] of this.docs) {
      if (filterIds && !filterIds.has(docId)) continue;

      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.tokenFreqs.get(term) || 0;
        if (tf === 0) continue;

        const df = this.docFreqs.get(term) || 0;
        const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);

        const numerator = tf * (K1 + 1);
        const denominator = tf + K1 * (1 - B + B * (doc.length / this.avgDocLength));

        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ id: docId, score });
      }
    }

    scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scores.slice(0, limit);
  }

  /**
   * Get index stats for debugging/monitoring.
   */
  getStats(): { totalDocs: number; uniqueTerms: number; avgDocLength: number } {
    return {
      totalDocs: this.totalDocs,
      uniqueTerms: this.docFreqs.size,
      avgDocLength: Math.round(this.avgDocLength * 100) / 100,
    };
  }

  private _computeAvgLength(): number {
    if (this.docs.size === 0) return 0;
    let total = 0;
    for (const doc of this.docs.values()) {
      total += doc.length;
    }
    return total / this.docs.size;
  }
}
