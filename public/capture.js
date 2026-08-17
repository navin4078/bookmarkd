/**
 * bookmarkd capture snippet — paste into the browser console on
 * https://x.com/i/bookmarks while logged in.
 *
 * How it works, and why it is built this way:
 *
 * X's bookmarks live behind a private GraphQL endpoint whose query ID changes
 * every time they deploy, and whose auth needs a bearer token plus a CSRF
 * header. Hard-coding any of that breaks within weeks.
 *
 * So this does not guess. It wraps window.fetch, waits for the page to make its
 * own bookmarks request, and learns the live URL and headers from it. Then it
 * replays that exact request with its own cursors to page through everything
 * quickly, instead of scrolling for ten minutes.
 *
 * Nothing is uploaded. The result is a file that downloads to your machine.
 */
(async () => {
  "use strict";

  if (!location.hostname.endsWith("x.com") && !location.hostname.endsWith("twitter.com")) {
    alert("Run this on https://x.com/i/bookmarks while logged in.");
    return;
  }

  // ---------------------------------------------------------------- overlay
  const box = document.createElement("div");
  box.style.cssText = [
    "position:fixed", "top:16px", "right:16px", "z-index:2147483647",
    "background:#0b0b0f", "color:#e8e8ef", "font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:14px 16px", "border-radius:12px", "min-width:290px", "max-width:340px",
    "box-shadow:0 10px 40px rgba(0,0,0,.5)", "border:1px solid #26263a", "white-space:pre-wrap",
  ].join(";");
  document.body.appendChild(box);
  const say = (msg) => { box.textContent = "bookmarkd\n\n" + msg; };
  say("waking up…");

  // -------------------------------------------------- learn the live request
  const original = window.fetch;
  let learned = null;

  const readHeaders = (source) => {
    const out = {};
    if (!source) return out;
    if (typeof source.forEach === "function" && !Array.isArray(source)) {
      source.forEach((value, key) => (out[key.toLowerCase()] = value));
      return out;
    }
    if (Array.isArray(source)) {
      for (const [key, value] of source) out[String(key).toLowerCase()] = value;
      return out;
    }
    for (const key of Object.keys(source)) out[key.toLowerCase()] = source[key];
    return out;
  };

  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (url && /\/graphql\/[^/]+\/Bookmarks/.test(url) && !learned) {
        const headers = {
          ...readHeaders(typeof input === "object" ? input.headers : null),
          ...readHeaders(init?.headers),
        };
        if (headers.authorization) learned = { url, headers };
      }
    } catch { /* never break the page */ }
    return original.apply(this, arguments);
  };

  // The page fires its own request when you scroll. Nudge it, then wait.
  say("watching for the bookmarks request…\n\n(scrolling the page to trigger it)");
  const nudge = setInterval(() => window.scrollBy(0, 2000), 900);
  const deadline = Date.now() + 20000;
  while (!learned && Date.now() < deadline) await sleep(250);
  clearInterval(nudge);
  window.fetch = original;

  if (!learned) {
    say(
      "Could not see a bookmarks request.\n\n" +
      "Make sure you are on x.com/i/bookmarks and logged in,\n" +
      "then reload the page and paste this again."
    );
    return;
  }

  // ------------------------------------------------------------ page through
  const endpoint = new URL(learned.url);
  const baseVariables = JSON.parse(endpoint.searchParams.get("variables") || "{}");

  const requestPage = async (cursor, count) => {
    const variables = { ...baseVariables, count };
    if (cursor) variables.cursor = cursor; else delete variables.cursor;
    const url = new URL(endpoint);
    url.searchParams.set("variables", JSON.stringify(variables));

    const response = await original(url.toString(), {
      headers: learned.headers,
      credentials: "include",
      referrer: location.href,
    });

    if (response.status === 429) {
      const reset = Number(response.headers.get("x-rate-limit-reset")) * 1000;
      const waitMs = Math.max(5000, Math.min(15 * 60000, reset - Date.now()));
      say(`rate limited by X — waiting ${Math.ceil(waitMs / 1000)}s\n\nkeep this tab open`);
      await sleep(waitMs + 1000);
      return requestPage(cursor, count);
    }
    if (!response.ok) throw new Error(`X returned ${response.status}`);
    return response.json();
  };

  const tweetCount = (body) => {
    let total = 0;
    for (const inst of body?.data?.bookmark_timeline_v2?.timeline?.instructions || []) {
      for (const entry of inst.entries || []) {
        if (entry?.content?.itemContent?.itemType === "TimelineTweet") total++;
      }
    }
    return total;
  };

  const bottomCursor = (body) => {
    for (const inst of body?.data?.bookmark_timeline_v2?.timeline?.instructions || []) {
      for (const entry of inst.entries || []) {
        if (entry?.content?.cursorType === "Bottom") return entry.content.value;
      }
    }
    return null;
  };

  // 100 per page instead of the UI's 20 means five times fewer requests, which
  // matters because X rate-limits this endpoint. Fall back if it is rejected.
  let pageSize = 100;
  const pages = [];
  let cursor = null;
  let total = 0;
  let emptyPages = 0;

  try {
    for (let page = 0; page < 600; page++) {
      let body;
      try {
        body = await requestPage(cursor, pageSize);
      } catch (error) {
        if (pageSize !== 20) { pageSize = 20; body = await requestPage(cursor, 20); }
        else throw error;
      }

      const found = tweetCount(body);
      const next = bottomCursor(body);
      if (found > 0) { pages.push(body); total += found; emptyPages = 0; }
      else emptyPages++;

      say(`collected ${total} bookmarks\npage ${page + 1}\n\nkeep this tab open`);

      // X keeps handing back a bottom cursor past the end, so stop on content.
      if (emptyPages >= 2 || !next || next === cursor) break;
      cursor = next;
      await sleep(400);
    }
  } catch (error) {
    if (!pages.length) { say("Failed: " + error.message); return; }
    say(`stopped early (${error.message})\nsaving the ${total} collected so far…`);
    await sleep(1500);
  }

  // ------------------------------------------------------------------ deliver
  const blob = new Blob([JSON.stringify(pages)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "bookmarks.json";
  document.body.appendChild(link);
  link.click();
  link.remove();

  say(
    `done — ${total} bookmarks\n\n` +
    "saved as bookmarks.json in your Downloads.\n\n" +
    "next:\n  npx bookmarkd import ~/Downloads/bookmarks.json\n  npx bookmarkd serve"
  );
  setTimeout(() => box.remove(), 60000);

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();
