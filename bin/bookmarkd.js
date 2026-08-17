#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBookmarks, searchableText } from "../src/ingest.js";
import { load, saveBookmarks, saveVectors } from "../src/store.js";
import { embedAll } from "../src/embed.js";
import { search } from "../src/search.js";
import { ask, detectProvider } from "../src/ask.js";
import { serve } from "../src/server.js";
import { dataDir } from "../src/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const HELP = `
bookmarkd — AI search over your own X/Twitter bookmarks, entirely on your machine

  bookmarkd capture              print the browser snippet that exports your bookmarks
  bookmarkd import <file.json>   load an export and build the search index
  bookmarkd index                rebuild embeddings for what is already imported
  bookmarkd serve [--port 4477]  open the search interface
  bookmarkd search <query>       search from the terminal
  bookmarkd ask <question>       answer a question from your bookmarks
  bookmarkd stats                what is currently indexed

Everything lives in ${dataDir()}
`;

try {
  await main();
} catch (error) {
  console.error("\n  " + error.message + "\n");
  process.exit(1);
}

async function main() {
  switch (command) {
    case "capture": return capture();
    case "import": return await importFile(positional[0]);
    case "index": return await buildIndex();
    case "serve": return await runServer();
    case "search": return await runSearch(positional.join(" "));
    case "ask": return await runAsk(positional.join(" "));
    case "stats": return showStats();
    default: console.log(HELP);
  }
}

function capture() {
  const snippet = fs.readFileSync(path.join(here, "..", "public", "capture.js"), "utf8");
  console.log(`
  Step 1  Open https://x.com/i/bookmarks in your browser, logged in.
  Step 2  Open the developer console (Cmd+Option+J on Mac, Ctrl+Shift+J elsewhere).
  Step 3  Paste everything between the lines below and press Enter.

          Chrome and Brave block pasting into the console the first time.
          If asked, type  allow pasting  then paste again.

  Step 4  Leave the tab open. It downloads bookmarks.json when it finishes.
  Step 5  bookmarkd import ~/Downloads/bookmarks.json

──────────────────────────────────────────────────────────────────────────────
${snippet}
──────────────────────────────────────────────────────────────────────────────
`);
}

async function importFile(file) {
  if (!file) throw new Error("Usage: bookmarkd import <file.json>");
  const resolved = path.resolve(file.replace(/^~/, process.env.HOME || "~"));
  if (!fs.existsSync(resolved)) throw new Error(`No such file: ${resolved}`);

  const bookmarks = parseBookmarks(JSON.parse(fs.readFileSync(resolved, "utf8")));
  if (!bookmarks.length) {
    throw new Error(
      "No bookmarks found in that file. It should be the bookmarks.json the capture snippet downloaded."
    );
  }

  saveBookmarks(bookmarks, { imported: new Date().toISOString(), source: resolved });
  const withMedia = bookmarks.filter((b) => b.media.length).length;
  const authors = new Set(bookmarks.map((b) => b.handle)).size;
  console.log(
    `\n  Imported ${bookmarks.length} bookmarks from ${authors} accounts (${withMedia} with media).`
  );
  await buildIndex();
}

async function buildIndex() {
  const state = load();
  if (!state) throw new Error("Nothing imported yet. Run `bookmarkd import <file>` first.");

  console.log("  Building embeddings so search understands meaning, not just words.");
  const texts = state.bookmarks.map(searchableText);
  let lastShown = 0;
  const vectors = await embedAll(texts, (done, total) => {
    if (done - lastShown >= 200 || done === total) {
      lastShown = done;
      process.stdout.write(`\r  embedded ${done}/${total}`);
    }
  });
  saveVectors(vectors);
  console.log(`\n  Ready. Run: bookmarkd serve\n`);
}

async function runServer() {
  const port = Number(flag("port", 4477));
  const info = await serve(port);
  const url = `http://127.0.0.1:${info.port}`;
  console.log(`
  bookmarkd is running at ${url}

  ${info.count} bookmarks indexed
  meaning search  ${info.semantic ? "on" : "off (run: bookmarkd index)"}
  ask mode        ${info.provider || "off (set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run Ollama)"}
`);
  await open(url);
}

async function runSearch(query) {
  if (!query) throw new Error("Usage: bookmarkd search <query>");
  const state = load();
  if (!state) throw new Error("Nothing imported yet.");

  const results = await search(state, query, { limit: 10 });
  if (!results.length) return console.log("\n  Nothing matched.\n");

  console.log("");
  for (const { bookmark } of results) {
    const when = bookmark.created_at?.slice(0, 10) || "";
    const body = bookmark.text.replace(/\s+/g, " ").slice(0, 220);
    console.log(`  @${bookmark.handle}  ${when}`);
    console.log(`  ${body}`);
    console.log(`  ${bookmark.url}\n`);
  }
}

async function runAsk(question) {
  if (!question) throw new Error("Usage: bookmarkd ask <question>");
  const state = load();
  if (!state) throw new Error("Nothing imported yet.");

  const provider = await detectProvider();
  if (!provider) {
    throw new Error(
      "Ask needs a model. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run Ollama locally."
    );
  }

  const results = await search(state, question, { limit: 12 });
  console.log("");
  for await (const chunk of ask(question, results, provider)) process.stdout.write(chunk);
  console.log("\n\n  Sources:");
  results.forEach((r, i) => console.log(`  [${i + 1}] ${r.bookmark.url}`));
  console.log("");
}

function showStats() {
  const state = load();
  if (!state) return console.log("\n  Nothing imported yet.\n");
  const dates = state.bookmarks.map((b) => b.created_at).filter(Boolean).sort();
  console.log(`
  ${state.bookmarks.length} bookmarks
  ${new Set(state.bookmarks.map((b) => b.handle)).size} accounts
  ${dates[0]?.slice(0, 10)} to ${dates.at(-1)?.slice(0, 10)}
  meaning search ${state.vectors ? "on" : "off — run: bookmarkd index"}
  stored in ${dataDir()}
`);
}

async function open(url) {
  const { spawn } = await import("node:child_process");
  const command =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* the URL is printed above either way */
  }
}
