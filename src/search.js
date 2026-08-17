import * as bm25 from "./bm25.js";
import { embedOne, rank } from "./embed.js";

/**
 * Hybrid retrieval.
 *
 * Keyword search nails exact terms (a library name, a handle, a number) and is
 * blind to paraphrase. Vector search nails paraphrase and is easily fooled by
 * short text that merely sounds similar. Neither is trustworthy alone, so both
 * run and their *rankings* are fused with Reciprocal Rank Fusion: each result
 * scores 1/(k + rank) in each list. Fusing ranks rather than raw scores means
 * the two scales never have to be made comparable, which is the part that
 * usually goes wrong.
 */
const RRF_K = 60;

export async function search(state, query, options = {}) {
  const { limit = 30, filters = {}, semantic = true } = options;
  const { bookmarks, vectors, keyword } = state;

  const allowed = applyFilters(bookmarks, filters);
  if (!query?.trim()) {
    // No query: this is browsing, so newest first is the useful order.
    return [...allowed]
      .sort((a, b) => (bookmarks[b].created_at || "").localeCompare(bookmarks[a].created_at || ""))
      .slice(0, limit)
      .map((index) => ({ bookmark: bookmarks[index], score: 0, matched: [] }));
  }

  const pool = 200;
  const keywordHits = bm25.search(keyword, query, pool);

  let vectorHits = [];
  if (semantic && vectors) {
    vectorHits = rank(vectors, await embedOne(query), pool);
  }

  const fused = new Map();
  const add = (hits, source) => {
    hits.forEach((hit, position) => {
      const entry = fused.get(hit.index) || { index: hit.index, score: 0, matched: [] };
      entry.score += 1 / (RRF_K + position + 1);
      entry.matched.push(source);
      fused.set(hit.index, entry);
    });
  };
  add(keywordHits, "keyword");
  add(vectorHits, "meaning");

  return [...fused.values()]
    .filter((entry) => allowed.has(entry.index))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      bookmark: bookmarks[entry.index],
      score: entry.score,
      matched: entry.matched,
    }));
}

function applyFilters(bookmarks, filters) {
  const allowed = new Set();
  const handle = filters.handle?.toLowerCase().replace(/^@/, "");
  const since = filters.since ? new Date(filters.since).toISOString() : null;
  const until = filters.until ? new Date(filters.until).toISOString() : null;

  bookmarks.forEach((b, index) => {
    if (handle && b.handle?.toLowerCase() !== handle) return;
    if (filters.hasMedia && !b.media?.length) return;
    if (filters.hasLinks && !b.links?.length) return;
    if (since && (b.created_at || "") < since) return;
    if (until && (b.created_at || "") > until) return;
    allowed.add(index);
  });
  return allowed;
}

/** Handles that appear most often, for the sidebar filter. */
export function topAuthors(bookmarks, limit = 25) {
  const counts = new Map();
  for (const b of bookmarks) {
    if (!b.handle) continue;
    counts.set(b.handle, (counts.get(b.handle) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([handle, count]) => ({ handle, count }));
}
