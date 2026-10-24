import { config } from '../config.js';

// Minimal Ollama client. Gemma never receives tools: it can only return data,
// so instructions spoken in a call cannot trigger actions (TC15 / F15).

async function post(pathname, body, timeoutMs) {
  const res = await fetch(`${config.ollamaUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama ${pathname} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export class OllamaClient {
  constructor({ model = config.llmModel, embedModel = config.embedModel } = {}) {
    this.model = model;
    this.embedModel = embedModel;
  }

  // Returns the raw string content; validation happens in the caller.
  async chatJson({ system, user, schema, temperature = 0.1 }) {
    const data = await post('/api/chat', {
      model: this.model,
      stream: false,
      think: false,
      keep_alive: '30m',
      format: schema ?? 'json',
      options: { temperature, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }, config.llmTimeoutMs);
    return data.message?.content ?? '';
  }

  // EmbeddingGemma expects task prefixes for retrieval.
  async embed(texts, { kind = 'document' } = {}) {
    const input = texts.map((t) => (kind === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}`));
    const data = await post('/api/embed', { model: this.embedModel, input, keep_alive: '30m' }, 30000);
    return data.embeddings;
  }

  // `busy: true` = no answer in time (Ollama loading/generating), which is not
  // the same as being down: callers keep their last known state.
  async status() {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(8000) });
      const { models = [] } = await res.json();
      const names = models.map((m) => m.name);
      const has = (n) => names.some((x) => x === n || x === `${n}:latest`);
      return { reachable: true, llm: has(this.model), embed: has(this.embedModel), models: names };
    } catch (err) {
      return { reachable: false, busy: err.name === 'TimeoutError', llm: false, embed: false, models: [] };
    }
  }
}
