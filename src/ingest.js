/**
 * Turns raw X GraphQL Bookmarks responses into flat bookmark records.
 *
 * Written against a real capture taken 17 Aug 2026, not from an old example.
 * That matters: X moved the author fields out of `user_results.result.legacy`
 * (now an empty object) and into `user_results.result.core`. Parsers written
 * before that change return undefined authors on every bookmark.
 */

const CURSOR_PREFIX = "cursor-";

/** Accepts the whole capture file, a single response body, or an array of either. */
export function collectEntries(raw) {
  const bodies = [];
  const push = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(push);
    if (v.body) return push(v.body);
    if (v.data) bodies.push(v);
  };
  push(raw);

  const entries = [];
  for (const body of bodies) {
    const timeline =
      body?.data?.bookmark_timeline_v2?.timeline ||
      body?.data?.bookmark_timeline?.timeline;
    for (const instruction of timeline?.instructions || []) {
      if (instruction.type !== "TimelineAddEntries") continue;
      for (const entry of instruction.entries || []) entries.push(entry);
    }
  }
  return entries;
}

/** The bottom cursor tells the capture snippet where the next page starts. */
export function bottomCursor(body) {
  for (const entry of collectEntries(body)) {
    if (entry.content?.cursorType === "Bottom") return entry.content.value;
    if (entry.entryId?.startsWith("cursor-bottom")) {
      return entry.content?.value ?? entry.content?.itemContent?.value;
    }
  }
  return null;
}

function unwrap(result) {
  if (!result) return null;
  // A tweet from a protected or limited-visibility account is nested one deeper.
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet;
  if (result.__typename === "TweetTombstone") return null;
  return result;
}

function author(tweet) {
  const user = tweet?.core?.user_results?.result;
  if (!user) return null;
  // `core` is where name/screen_name live now; `legacy` is present but empty.
  const core = user.core || {};
  const legacy = user.legacy || {};
  return {
    handle: core.screen_name || legacy.screen_name || null,
    name: core.name || legacy.name || null,
    avatar: user.avatar?.image_url || legacy.profile_image_url_https || null,
    verified: Boolean(user.is_blue_verified || user.verification?.verified),
    bio: user.profile_bio?.description || legacy.description || null,
  };
}

/** Long posts keep their full text in note_tweet; legacy.full_text is truncated. */
function text(tweet) {
  const note = tweet?.note_tweet?.note_tweet_results?.result?.text;
  return note || tweet?.legacy?.full_text || "";
}

function media(tweet) {
  const list =
    tweet?.legacy?.extended_entities?.media ||
    tweet?.legacy?.entities?.media ||
    [];
  return list.map((m) => ({
    type: m.type, // photo | video | animated_gif
    thumb: m.media_url_https || null,
    url: m.expanded_url || null,
  }));
}

function links(tweet) {
  return (tweet?.legacy?.entities?.urls || [])
    .map((u) => u.expanded_url)
    .filter(Boolean);
}

/**
 * Link-preview cards often carry the substance of a bookmarked post (the tweet
 * itself is just "this is great"). Pull the title and description into the
 * searchable text so those bookmarks are findable at all.
 */
function card(tweet) {
  const values = tweet?.card?.legacy?.binding_values;
  if (!Array.isArray(values)) return null;
  const get = (key) =>
    values.find((v) => v.key === key)?.value?.string_value || null;
  const title = get("title");
  const description = get("description");
  if (!title && !description) return null;
  return { title, description, domain: get("domain") };
}

function normalise(result, { quoted = false } = {}) {
  const tweet = unwrap(result);
  if (!tweet) return null;
  const legacy = tweet.legacy || {};
  const who = author(tweet);

  const record = {
    id: tweet.rest_id || legacy.id_str,
    handle: who?.handle || null,
    name: who?.name || null,
    avatar: who?.avatar || null,
    verified: who?.verified || false,
    text: text(tweet),
    created_at: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
    lang: legacy.lang || null,
    likes: legacy.favorite_count ?? 0,
    retweets: legacy.retweet_count ?? 0,
    replies: legacy.reply_count ?? 0,
    quotes: legacy.quote_count ?? 0,
    bookmarks: legacy.bookmark_count ?? 0,
    views: Number(tweet.views?.count ?? 0) || 0,
    media: media(tweet),
    links: links(tweet),
    card: card(tweet),
    conversation_id: legacy.conversation_id_str || null,
    is_reply: Boolean(legacy.in_reply_to_status_id_str),
  };

  record.url =
    record.handle && record.id
      ? `https://x.com/${record.handle}/status/${record.id}`
      : null;

  if (!quoted) {
    record.quoted = normalise(tweet.quoted_status_result?.result, {
      quoted: true,
    });
  }
  return record.id ? record : null;
}

/** Everything a search should look at, as one string. */
export function searchableText(b) {
  const parts = [b.text];
  if (b.name) parts.push(b.name);
  if (b.handle) parts.push("@" + b.handle);
  if (b.card?.title) parts.push(b.card.title);
  if (b.card?.description) parts.push(b.card.description);
  if (b.quoted?.text) parts.push(b.quoted.text);
  if (b.quoted?.handle) parts.push("@" + b.quoted.handle);
  for (const link of b.links) parts.push(link);
  return parts.filter(Boolean).join("\n");
}

/** Raw capture -> deduped, newest-first bookmark records. */
export function parseBookmarks(raw) {
  const out = new Map();
  for (const entry of collectEntries(raw)) {
    if (entry.entryId?.startsWith(CURSOR_PREFIX)) continue;
    const item = entry.content?.itemContent;
    if (item?.itemType !== "TimelineTweet") continue;
    const record = normalise(item.tweet_results?.result);
    if (record && !out.has(record.id)) out.set(record.id, record);
  }
  const list = [...out.values()];
  list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return list;
}
