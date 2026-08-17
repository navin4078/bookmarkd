import fs from "node:fs";
import { files } from "./paths.js";
import { searchableText } from "./ingest.js";
import { buildIndex } from "./bm25.js";
import { DIMENSIONS } from "./embed.js";

/** Reads what is on disk and rebuilds the in-memory keyword index. */
export function load() {
  if (!fs.existsSync(files.bookmarks())) return null;

  const bookmarks = JSON.parse(fs.readFileSync(files.bookmarks(), "utf8"));
  const meta = fs.existsSync(files.meta())
    ? JSON.parse(fs.readFileSync(files.meta(), "utf8"))
    : {};

  let vectors = null;
  if (fs.existsSync(files.vectors())) {
    // Copy out of the Buffer rather than viewing it: Node may hand back a slice
    // of a pooled ArrayBuffer whose offset is not 4-byte aligned, which a
    // Float32Array view rejects outright.
    const buffer = fs.readFileSync(files.vectors());
    const candidate = new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );
    // A stale vector file (bookmarks re-imported, embeddings not rebuilt) would
    // silently pair every query with the wrong bookmark. Refuse it instead.
    if (candidate.length === bookmarks.length * DIMENSIONS) vectors = candidate;
  }

  const documents = bookmarks.map(searchableText);
  return { bookmarks, vectors, meta, keyword: buildIndex(documents), documents };
}

export function saveBookmarks(bookmarks, meta = {}) {
  fs.writeFileSync(files.bookmarks(), JSON.stringify(bookmarks));
  fs.writeFileSync(
    files.meta(),
    JSON.stringify({ ...meta, count: bookmarks.length }, null, 2)
  );
}

export function saveVectors(vectors) {
  fs.writeFileSync(
    files.vectors(),
    Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
  );
}

export function hasVectors() {
  return fs.existsSync(files.vectors());
}
