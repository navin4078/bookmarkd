# bookmarkd

**AI search over your own X/Twitter bookmarks. Runs entirely on your machine.**

You bookmarked something months ago. You remember roughly what it said and
nothing about how it was worded. X gives you a scroll bar and a keyword box that
only matches exact words, so you scroll for ten minutes and give up.

bookmarkd fixes that. Point it at your bookmarks, ask for the thing you half
remember, get it back.

```
$ bookmarkd search "how to do customer discovery quickly with an AI"

  @fin465  2026-08-10
  theres a method you learn in YCombinator to compress a month of GTM
  research into 3 hours. you dont ask Claude to "research the market."
  instead you feed it: 30+ competitor fully indexed websites...
```

Not one word of that query appears in that bookmark.

## Quick start

```bash
npx bookmarkd capture                            # prints a snippet to paste in your browser
npx bookmarkd import ~/Downloads/bookmarks.json  # loads it, builds the index
npx bookmarkd serve                              # opens the search interface
```

Three commands, no account, no API key, no signup. Node 20 or newer.

## Getting your bookmarks out

This is the part every similar tool gets stuck on, so here is exactly how it
works.

X keeps your bookmarks behind a private GraphQL endpoint. The official API does
not expose them on the free tier. The endpoint's query ID changes every time X
deploys, and it needs a bearer token plus a CSRF header that live inside the
page.

So bookmarkd does not guess at any of that. `bookmarkd capture` gives you a
snippet you paste into your browser console on the bookmarks page. It wraps
`fetch`, waits for the page to make its own bookmarks request, and **learns the
live URL and headers from that request**. Then it replays that exact request
with its own cursors to page through everything at 100 per page, instead of
making you scroll for ten minutes.

It self heals when X ships a change, because it never hardcodes what X ships.
Nothing is uploaded. The snippet finishes by downloading a `bookmarks.json` to
your own machine.

If you would rather read the snippet before pasting it, it is
[`public/capture.js`](public/capture.js). It is about 150 lines.

## How the search works

Two searches run on every query and their **rankings** are fused.

**Keyword (BM25)** nails exact terms: a library name, a handle, a number, a
typo you remember. It is completely blind to paraphrase.

**Meaning (embeddings)** nails paraphrase. It is also easy to fool on short
social text, where a spam post can land closer to your query than the thing you
actually want.

Neither is trustworthy on its own, so bookmarkd runs both and combines them with
Reciprocal Rank Fusion: each result scores `1 / (60 + rank)` in each list.
Fusing ranks rather than raw scores means the two scales never have to be made
comparable, which is the step that usually goes wrong. Each result card tells
you which of the two found it.

Embeddings are `all-MiniLM-L6-v2` quantised to int8, running locally through
transformers.js. About 25 MB, downloaded once. **No API key, no network calls
after that first download.** Twenty thousand bookmarks embed in a few minutes
and search in milliseconds.

## Ask mode

Optional. Type a question instead of a search, and a model answers it using only
your bookmarks, with citations.

```
$ bookmarkd ask "what did people say about using AI for market research?"
```

bookmarkd retrieves the twelve most relevant bookmarks and hands only those to
the model, which is instructed to use nothing else and to say so plainly when
your bookmarks do not answer the question.

It picks whichever provider you already have:

| Provider  | How it is enabled |
|-----------|-------------------|
| Claude    | `ANTHROPIC_API_KEY` set |
| OpenAI    | `OPENAI_API_KEY` set |
| Ollama    | running locally, any chat model pulled |

Ollama keeps the whole thing offline. Override the model with `BOOKMARKD_MODEL`.

**Search works with none of these.** Ask mode is the only part that can send
anything off your machine, and only to the provider you configured yourself.

## Privacy

Everything lives in `~/.bookmarkd`. Delete that folder and the tool forgets
everything. There is no server, no account, no telemetry, and no third party.
The web interface binds to `127.0.0.1` only.

Your bookmarks reveal a lot about you. That is exactly why this runs locally.

## Commands

```
bookmarkd capture              print the browser snippet that exports your bookmarks
bookmarkd import <file.json>   load an export and build the search index
bookmarkd index                rebuild embeddings for what is already imported
bookmarkd serve [--port 4477]  open the search interface
bookmarkd search <query>       search from the terminal
bookmarkd ask <question>       answer a question from your bookmarks
bookmarkd stats                what is currently indexed
```

## What it does not do

Being straight about the edges:

* **It does not sync.** Re-run the capture when you want fresh bookmarks. A
  re-import replaces the previous set.
* **It does not read threads.** A bookmarked reply is stored as that one post,
  not the whole conversation around it.
* **It does not transcribe video or read images.** Media is stored and shown as
  thumbnails, but only text is searchable.
* **It does not touch your account.** Read only, always. Nothing is posted,
  liked, deleted, or unbookmarked.
* **X rate limits the bookmarks endpoint.** Very large collections may pause
  partway. The snippet waits it out and keeps what it already has.

## Why the parser is the way it is

If you fork this, one warning. X moved the author fields out of
`user_results.result.legacy`, which is now an empty object, and into
`user_results.result.core`. Every parser written against an older example
returns `undefined` for every author and silently produces bookmarks with no
name attached. This one was written against a live capture, not from memory.
`src/ingest.js` has the current shape.

## License

MIT.
