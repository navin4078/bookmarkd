import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Everything bookmarkd knows lives in one folder you own. Delete it and the
 * tool forgets everything. Nothing is written anywhere else.
 */
export function dataDir() {
  const dir =
    process.env.BOOKMARKD_HOME || path.join(os.homedir(), ".bookmarkd");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const files = {
  bookmarks: () => path.join(dataDir(), "bookmarks.json"),
  vectors: () => path.join(dataDir(), "vectors.bin"),
  meta: () => path.join(dataDir(), "meta.json"),
  models: () => path.join(dataDir(), "models"),
};
