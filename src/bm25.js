/**
 * BM25 keyword ranking, in plain JavaScript. No native modules, no database.
 *
 * This exists because embeddings alone are unreliable on short social text:
 * a spam post can land closer to your query than the thing you actually want.
 * Keyword and vector search fail in different directions, so bookmarkd runs
 * both and fuses the two rankings (see search.js).
 */

const K1 = 1.5;
const B = 0.75;

const STOP = new Set(
  ("a an and are as at be but by for from has have how i if in is it its of on " +
    "or that the this to was were what when where which who will with you your")
    .split(" ")
);

export function tokenize(input) {
  return (input || "")
    .toLowerCase()
    // Keep @handles, #tags and $tickers whole; split everything else on non-word.
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9_@#$']+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function buildIndex(documents) {
  const postings = new Map(); // term -> Map(docIndex -> term frequency)
  const lengths = new Array(documents.length);
  let total = 0;

  documents.forEach((doc, i) => {
    const terms = tokenize(doc);
    lengths[i] = terms.length;
    total += terms.length;
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
    for (const [term, tf] of counts) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = new Map()));
      list.set(i, tf);
    }
  });

  return {
    postings,
    lengths,
    count: documents.length,
    avgLength: documents.length ? total / documents.length : 0,
  };
}

/** Returns [{ index, score }], best first. */
export function search(index, query, limit = 200) {
  const terms = tokenize(query);
  if (!terms.length) return [];

  const scores = new Map();
  for (const term of new Set(terms)) {
    const list = index.postings.get(term);
    if (!list) continue;
    const idf = Math.log(
      1 + (index.count - list.size + 0.5) / (list.size + 0.5)
    );
    for (const [doc, tf] of list) {
      const norm =
        tf * (K1 + 1) /
        (tf + K1 * (1 - B + (B * index.lengths[doc]) / (index.avgLength || 1)));
      scores.set(doc, (scores.get(doc) || 0) + idf * norm);
    }
  }

  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
