/**
 * Ask mode: retrieve first, then have a model answer from what was retrieved.
 *
 * Search is the product; this is the layer on top. It is optional on purpose —
 * bookmarkd is fully usable with no model and no key at all, and nothing leaves
 * your machine unless you deliberately configure a hosted provider here.
 */

const SYSTEM = `You answer questions using only the saved X/Twitter bookmarks provided below.

Rules:
- Every claim must come from the numbered bookmarks. Never use outside knowledge.
- Cite the bookmarks you used inline as [1], [2] and so on.
- If the bookmarks do not answer the question, say so plainly and describe what
  they do cover. Do not guess and do not pad.
- Be concise. Lead with the answer, then the supporting detail.`;

/**
 * Picks a provider from whatever the user has configured. Ollama is checked
 * last because it needs a running process, not just an environment variable.
 */
export async function detectProvider() {
  const forced = process.env.BOOKMARKD_PROVIDER;
  if (forced) return forced;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (await ollamaReachable()) return "ollama";
  return null;
}

async function ollamaReachable() {
  try {
    const response = await fetch(`${ollamaHost()}/api/tags`, {
      signal: AbortSignal.timeout(600),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const ollamaHost = () =>
  process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

function buildPrompt(question, results) {
  const context = results
    .map((result, i) => {
      const b = result.bookmark;
      const parts = [
        `[${i + 1}] @${b.handle || "unknown"}` +
          (b.created_at ? ` on ${b.created_at.slice(0, 10)}` : ""),
        b.text,
      ];
      if (b.quoted?.text) parts.push(`quoting @${b.quoted.handle}: ${b.quoted.text}`);
      if (b.card?.title) parts.push(`link: ${b.card.title}`);
      if (b.links?.length) parts.push(`urls: ${b.links.join(" ")}`);
      if (b.url) parts.push(b.url);
      return parts.join("\n");
    })
    .join("\n\n---\n\n");

  return `Bookmarks:\n\n${context}\n\n---\n\nQuestion: ${question}`;
}

/** Async generator of answer text chunks. */
export async function* ask(question, results, provider) {
  const prompt = buildPrompt(question, results);
  if (provider === "anthropic") yield* anthropic(prompt);
  else if (provider === "openai") yield* openai(prompt);
  else if (provider === "ollama") yield* ollama(prompt);
  else
    throw new Error(
      "No model configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run Ollama locally."
    );
}

async function* anthropic(prompt) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk").catch(() => {
    throw new Error(
      "Ask mode with Claude needs the SDK: npm install @anthropic-ai/sdk"
    );
  });

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: process.env.BOOKMARKD_MODEL || "claude-opus-5",
    max_tokens: 4096,
    output_config: { effort: "low" },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

async function* openai(prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.BOOKMARKD_MODEL || "gpt-4.1-mini",
      stream: true,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI: ${await response.text()}`);

  for await (const line of lines(response.body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const chunk = JSON.parse(payload);
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield text;
    } catch {
      /* keep-alive or partial frame */
    }
  }
}

/**
 * Everyone's Ollama has a different set of models pulled, so naming one here
 * would fail for most people. Ask Ollama what it actually has and skip the
 * embedding-only models, which cannot answer a chat request.
 */
async function ollamaModel() {
  if (process.env.BOOKMARKD_MODEL) return process.env.BOOKMARKD_MODEL;
  const response = await fetch(`${ollamaHost()}/api/tags`);
  const names = (await response.json()).models?.map((m) => m.name) || [];
  const usable = names.filter((n) => !/embed/i.test(n));
  if (!usable.length) {
    throw new Error("Ollama has no chat model pulled. Try: ollama pull llama3.2");
  }
  return usable[0];
}

async function* ollama(prompt) {
  const response = await fetch(`${ollamaHost()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: await ollamaModel(),
      stream: true,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama: ${await response.text()}`);

  for await (const line of lines(response.body)) {
    if (!line.trim()) continue;
    try {
      const chunk = JSON.parse(line);
      if (chunk.message?.content) yield chunk.message.content;
    } catch {
      /* partial frame */
    }
  }
}

/** Splits a byte stream into lines without buffering the whole response. */
async function* lines(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer) yield buffer;
}
