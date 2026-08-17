import { files } from "./paths.js";

/**
 * Local sentence embeddings. No API key, no network after the first run.
 *
 * all-MiniLM-L6-v2 quantised to int8 is about 25 MB and is downloaded once
 * into ~/.bookmarkd/models. Vectors are 384-dim and L2-normalised, so cosine
 * similarity is a plain dot product.
 */

export const DIMENSIONS = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";

let pipe = null;

export async function loadEmbedder(onStatus = () => {}) {
  if (pipe) return pipe;
  onStatus("loading the embedding model (one-time ~25 MB download)");
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = files.models();
  pipe = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  onStatus("embedding model ready");
  return pipe;
}

/** Returns a Float32Array of texts.length * DIMENSIONS. */
export async function embedAll(texts, onProgress = () => {}) {
  const embedder = await loadEmbedder();
  const out = new Float32Array(texts.length * DIMENSIONS);
  const BATCH = 32;

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map(truncate);
    const result = await embedder(batch, { pooling: "mean", normalize: true });
    out.set(result.data, i * DIMENSIONS);
    onProgress(Math.min(i + BATCH, texts.length), texts.length);
  }
  return out;
}

export async function embedOne(text) {
  const embedder = await loadEmbedder();
  const result = await embedder([truncate(text)], {
    pooling: "mean",
    normalize: true,
  });
  return Float32Array.from(result.data);
}

/**
 * The model's window is 256 word pieces. Cutting on characters keeps the
 * meaningful head of a long thread rather than letting the tokenizer clip it
 * somewhere arbitrary.
 */
function truncate(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > 1200 ? clean.slice(0, 1200) : clean || " ";
}

/**
 * Brute-force cosine over every vector. At 20,000 bookmarks this is roughly
 * 8 million multiply-adds, which is a few milliseconds — an index would add a
 * dependency and a failure mode to save time nobody would notice.
 */
export function rank(vectors, query, limit = 200) {
  const count = vectors.length / DIMENSIONS;
  const scored = new Array(count);
  for (let i = 0; i < count; i++) {
    let dot = 0;
    const base = i * DIMENSIONS;
    for (let d = 0; d < DIMENSIONS; d++) dot += vectors[base + d] * query[d];
    scored[i] = { index: i, score: dot };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
