import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "./store.js";
import { search, topAuthors } from "./search.js";
import { ask, detectProvider } from "./ask.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export async function serve(port = 4477) {
  const state = load();
  if (!state) {
    throw new Error(
      "No bookmarks imported yet. Run `bookmarkd capture` first, then `bookmarkd import <file>`."
    );
  }
  const provider = await detectProvider();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (url.pathname === "/api/stats") return json(res, stats(state, provider));
      if (url.pathname === "/api/search") return await handleSearch(req, res, state);
      if (url.pathname === "/api/ask") return await handleAsk(req, res, state, provider);
      return serveStatic(url.pathname, res);
    } catch (error) {
      json(res, { error: error.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, provider, count: state.bookmarks.length, semantic: Boolean(state.vectors) };
}

function stats(state, provider) {
  return {
    count: state.bookmarks.length,
    semantic: Boolean(state.vectors),
    provider,
    authors: topAuthors(state.bookmarks),
    imported: state.meta.imported || null,
  };
}

async function handleSearch(req, res, state) {
  const body = await readJson(req);
  const results = await search(state, body.q || "", {
    limit: body.limit || 40,
    filters: body.filters || {},
    semantic: body.semantic !== false,
  });
  json(res, { results });
}

async function handleAsk(req, res, state, provider) {
  const body = await readJson(req);
  if (!provider) {
    return json(res, { error: "No model configured for Ask mode." }, 400);
  }

  // Retrieve a tight set: a long context makes the answer worse, not better.
  const results = await search(state, body.q || "", {
    limit: 12,
    filters: body.filters || {},
  });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("sources", results.map((r) => r.bookmark));
  try {
    for await (const chunk of ask(body.q, results, provider)) send("text", chunk);
    send("done", {});
  } catch (error) {
    send("error", { message: error.message });
  }
  res.end();
}

function serveStatic(pathname, res) {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const file = path.join(publicDir, path.basename(name));
  if (!fs.existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
