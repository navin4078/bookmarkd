/**
 * bookmarkd capture snippet — paste into the browser console on
 * https://x.com/i/bookmarks while logged in.
 *
 * How it works, and why it is built this way:
 *
 * X keeps bookmarks behind a private GraphQL endpoint whose query ID and
 * `features` blob change every time they deploy. Hard-coding either breaks
 * within weeks, so this never hard-codes them. It finds the real request the
 * page already makes, then replays that exact request with its own cursors to
 * page through everything, instead of making you scroll for ten minutes.
 *
 * There are three ways it finds that request, tried in order, because the one
 * obvious way fails often:
 *
 *   1. The browser's own performance log. The page fetched your bookmarks when
 *      it loaded, which is before you pasted this, so intercepting alone would
 *      miss it. The performance log still has the full URL.
 *   2. Wrapping fetch and nudging the page to load more.
 *   3. window.BOOKMARKD_URL, if you set it yourself (see the README).
 *
 * Auth is the session you are already logged into: the public web bearer token
 * plus the CSRF value from your own cookie. Nothing is uploaded, and the result
 * downloads to your machine as bookmarks.json.
 */
(async () => {
  "use strict";

  const IS_X = /(^|\.)(x|twitter)\.com$/.test(location.hostname);
  if (!IS_X) {
    alert("Run this on https://x.com/i/bookmarks while logged in.");
    return;
  }

  // ---------------------------------------------------------------- overlay
  const box = document.createElement("div");
  box.style.cssText = [
    "position:fixed", "top:16px", "right:16px", "z-index:2147483647",
    "background:#0b0b0f", "color:#e8e8ef",
    "font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace",
    "padding:14px 16px", "border-radius:12px", "min-width:290px", "max-width:360px",
    "box-shadow:0 10px 40px rgba(0,0,0,.5)", "border:1px solid #26263a",
    "white-space:pre-wrap",
  ].join(";");
  document.body.appendChild(box);
  const say = (msg) => { box.textContent = "bookmarkd\n\n" + msg; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const IS_BOOKMARKS_URL = /\/graphql\/[^/]+\/Bookmarks\b/;

  say("looking for your bookmarks request…");

  // ------------------------------------------------- 1. the performance log
  const original = window.fetch;
  let endpointUrl = window.BOOKMARKD_URL || null;
  let learnedHeaders = null;

  if (!endpointUrl) {
    endpointUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .reverse()
      .find((name) => IS_BOOKMARKS_URL.test(name)) || null;
  }

  // ------------------------------------------------------ 2. wrapping fetch
  if (!endpointUrl) {
    const readHeaders = (source) => {
      const out = {};
      if (!source) return out;
      if (typeof source.forEach === "function" && !Array.isArray(source)) {
        source.forEach((value, key) => (out[String(key).toLowerCase()] = value));
      } else if (Array.isArray(source)) {
        for (const [key, value] of source) out[String(key).toLowerCase()] = value;
      } else {
        for (const key of Object.keys(source)) out[key.toLowerCase()] = source[key];
      }
      return out;
    };

    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input?.url;
        if (url && IS_BOOKMARKS_URL.test(url) && !endpointUrl) {
          endpointUrl = url;
          const headers = {
            ...readHeaders(typeof input === "object" ? input.headers : null),
            ...readHeaders(init?.headers),
          };
          if (headers.authorization) learnedHeaders = headers;
        }
      } catch { /* never break the page */ }
      return original.apply(this, arguments);
    };

    say("watching for the bookmarks request…\n\n(scrolling to make the page load more)");
    const nudge = setInterval(() => window.scrollBy(0, 2400), 900);
    const deadline = Date.now() + 20000;
    while (!endpointUrl && Date.now() < deadline) await sleep(250);
    clearInterval(nudge);
    window.fetch = original;
  }

  if (!endpointUrl) {
    say(
      "Could not find a bookmarks request.\n\n" +
      "Reload x.com/i/bookmarks, wait for your bookmarks to\n" +
      "appear, then paste this again on the loaded page.\n\n" +
      "If x.com/i/bookmarks redirects you somewhere else,\n" +
      "see the README section 'when the page redirects'."
    );
    return;
  }

  // ------------------------------------------------------------------ auth
  // Prefer the headers the page itself used. Otherwise rebuild them: the web
  // bearer is a public constant in X's own bundle, and the CSRF value is the
  // ct0 cookie already set on this session.
  const csrf = document.cookie.match(/ct0=([^;]+)/)?.[1];
  const headers = learnedHeaders || {
    authorization:
      "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
    "x-csrf-token": csrf,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "content-type": "application/json",
  };
  if (!learnedHeaders && !csrf) {
    say("You do not look logged in (no session cookie). Log in and try again.");
    return;
  }

  // ------------------------------------------------------------ page through
  const endpoint = new URL(endpointUrl, location.origin);
  const baseVariables = JSON.parse(endpoint.searchParams.get("variables") || "{}");

  const requestPage = async (cursor, count) => {
    const variables = { ...baseVariables, count };
    if (cursor) variables.cursor = cursor; else delete variables.cursor;
    const url = new URL(endpoint);
    url.searchParams.set("variables", JSON.stringify(variables));

    const response = await original(url.toString(), {
      headers,
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

  const walk = (body, visit) => {
    const timeline = body?.data?.bookmark_timeline_v2?.timeline
      || body?.data?.bookmark_timeline?.timeline;
    for (const instruction of timeline?.instructions || []) {
      for (const entry of instruction.entries || []) visit(entry);
    }
  };
  const tweetCount = (body) => {
    let n = 0;
    walk(body, (e) => { if (e?.content?.itemContent?.itemType === "TimelineTweet") n++; });
    return n;
  };
  const bottomCursor = (body) => {
    let found = null;
    walk(body, (e) => { if (e?.content?.cursorType === "Bottom") found = e.content.value; });
    return found;
  };

  // 100 per page instead of the interface's 20 means five times fewer requests,
  // which matters because X rate-limits this endpoint hard.
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
})();
