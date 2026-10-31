// ── Playground chat client (pure helpers + one streaming call) ────────
// The site is static (GitHub Pages): there is no proxy. A Playground
// request goes straight from the browser to the base URL of one of the
// user's own My Providers entries, with that entry's key — the same
// contract the listing fetch already follows. Only OpenAI-compatible
// `/chat/completions` is spoken; providers that block browser calls
// (CORS) get an honest error instead of a silent fallback.

export function chatUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/models$/i, '');
  if (/\/chat\/completions$/i.test(b)) return b;
  if (/\/v\d+[a-z]*$/i.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

// GET {base}/models — same normalization rules as chatUrl, so a base URL
// that works for chat works for the listing too (setup modal's Test button).
export function modelsUrl(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  b = b.replace(/\/models$/i, '');
  if (/\/chat\/completions$/i.test(b)) b = b.replace(/\/chat\/completions$/i, '');
  if (/\/v\d+[a-z]*$/i.test(b)) return b + '/models';
  return b + '/v1/models';
}

// Connection check for the setup modal, BEFORE the user commits: GET the
// model list with the given key and report honestly — connected (+ how
// many models, + the ids for the view's "is my model id listed?" check),
// key rejected, no model list at this URL, or CORS/network blocked.
// Never throws; the result is shown as-is.
export async function testConnection({ baseUrl, key, fetchImpl = globalThis.fetch } = {}) {
  const url = modelsUrl(baseUrl);
  if (!url) return { ok: false, message: 'Add a base URL first — there is nothing to test yet.' };
  let res;
  try {
    res = await fetchImpl(url, { headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}) } });
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, aborted: true, message: 'Test cancelled.' };
    return { ok: false, cors: true, message: CORS_MESSAGE };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, message: `The provider rejected the key (HTTP ${res.status}). Check the API key.` };
  }
  if (res.status === 404 || res.status === 405) {
    return { ok: false, status: res.status, message: `HTTP ${res.status} at ${url} — the base URL may be wrong, or the provider does not expose a model list. You can still save and chat.` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: `Provider returned HTTP ${res.status} for the model list.` };
  }
  let ids = [];
  try {
    const j = await res.json();
    const arr = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : (Array.isArray(j?.models) ? j.models : []));
    ids = arr
      .map((m) => (typeof m === 'string' ? m : String(m?.id ?? m?.name ?? m?.model ?? '')).trim())
      .filter(Boolean);
  } catch {
    return { ok: true, status: 200, message: 'Connected — the endpoint answered, but the model list was not readable JSON.' };
  }
  return {
    ok: true, status: 200, models: ids, count: ids.length,
    message: `Connected — ${ids.length} model${ids.length === 1 ? '' : 's'} listed.`,
  };
}

// Messages are {role, content}; UI-only fields never leave the browser.
export function buildPayload({ model, messages, system = '', temperature = null, maxTokens = null, stream = true }) {
  const out = [];
  if (String(system || '').trim()) out.push({ role: 'system', content: String(system) });
  for (const m of messages || []) {
    if (!m || !m.content || (m.role !== 'user' && m.role !== 'assistant')) continue;
    out.push({ role: m.role, content: String(m.content) });
  }
  const p = { model, messages: out, stream: !!stream };
  if (Number.isFinite(temperature)) p.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) p.max_tokens = Math.round(maxTokens);
  return p;
}

// One SSE `data:` payload → {content, reasoning, usage, finish, error}.
// Providers disagree on where reasoning lives; both common spellings are read.
export function parseChunk(json) {
  const r = { content: '', reasoning: '', usage: null, finish: null, error: null };
  if (!json || typeof json !== 'object') return r;
  if (json.error) {
    r.error = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
    return r;
  }
  const ch = Array.isArray(json.choices) ? json.choices[0] : null;
  const d = ch?.delta || ch?.message || null;
  if (d) {
    if (typeof d.content === 'string') r.content = d.content;
    const rs = d.reasoning_content ?? d.reasoning;
    if (typeof rs === 'string') r.reasoning = rs;
  }
  if (ch?.finish_reason) r.finish = ch.finish_reason;
  if (json.usage && typeof json.usage === 'object') r.usage = normUsage(json.usage);
  return r;
}

function normUsage(u) {
  const i = Number(u.prompt_tokens ?? u.input_tokens);
  const o = Number(u.completion_tokens ?? u.output_tokens);
  return {
    input: Number.isFinite(i) ? i : null,
    output: Number.isFinite(o) ? o : null,
  };
}

// Incremental SSE splitter: feed decoded text, get complete `data:` payloads.
export function createSseParser() {
  let buf = '';
  return {
    push(text) {
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      const out = [];
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { out.push({ done: true }); continue; }
        try { out.push({ json: JSON.parse(data) }); } catch { /* partial / keep-alive noise */ }
      }
      return out;
    },
  };
}

// Rough token estimate for when the provider sends no usage block
// (~4 chars/token Latin, ~2 for CJK). Always rendered with a "≈".
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
  return Math.ceil(s.length / (cjk / s.length > 0.3 ? 2 : 4));
}

// USD for one exchange from per-1M prices; null when either side is unknown.
export function estimateCost(usage, price) {
  if (!usage || !price) return null;
  const pi = Number(price.in), po = Number(price.out);
  if (!Number.isFinite(pi) || !Number.isFinite(po)) return null;
  if (!Number.isFinite(usage.input) || !Number.isFinite(usage.output)) return null;
  return (usage.input * pi + usage.output * po) / 1e6;
}

export function fmtCost(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return '$' + usd.toFixed(4);
  return '$' + usd.toFixed(usd < 1 ? 3 : 2);
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + ' s' : Math.round(ms) + ' ms';
}

export function errorFromResponse(status, bodyText, url) {
  let detail = '';
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || j?.detail || '';
  } catch { detail = String(bodyText || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240); }
  const tail = detail ? ' — ' + String(detail).slice(0, 300) : '';
  if (status === 401 || status === 403) return `The provider rejected the key (HTTP ${status})${tail}. Check the API key on the provider's My Providers card.`;
  if (status === 404) return `HTTP 404 at ${url}${tail}. The provider may not serve /chat/completions at this base URL, or the model id is wrong.`;
  if (status === 429) return `Rate limited or out of credit (HTTP 429)${tail}.`;
  if (status === 400 || status === 422) return `The provider refused the request (HTTP ${status})${tail}. Try lowering max tokens or resetting temperature.`;
  return `Provider returned HTTP ${status}${tail}.`;
}

export const CORS_MESSAGE = 'The browser blocked the request before it reached the provider — most likely CORS (this provider does not accept calls from web pages), or the network is down. Providers that allow browser calls (OpenRouter, OpenAI, Groq and many gateways) work here; for others, use a gateway that does.';

// Streams (or not) one completion. Callbacks fire as text arrives; the
// returned promise resolves {usage, finish} or rejects with a readable Error.
// AbortError propagates untouched so callers can tell "Stop" from failure.
export async function sendChat({ baseUrl, key, payload, signal, onDelta, fetchImpl = globalThis.fetch }) {
  const url = chatUrl(baseUrl);
  if (!url) throw new Error('This provider has no base URL — add one on its My Providers card.');
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(CORS_MESSAGE);
  }
  if (!res.ok) throw new Error(errorFromResponse(res.status, await res.text().catch(() => ''), url));

  let usage = null, finish = null;
  const ctype = res.headers?.get?.('content-type') || '';
  if (!payload.stream || !res.body || /application\/json/i.test(ctype)) {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('The provider answered with something that is not JSON.'); }
    const c = parseChunk(json);
    if (c.error) throw new Error(c.error);
    onDelta?.(c);
    return { usage: c.usage, finish: c.finish };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const sse = createSseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of sse.push(dec.decode(value, { stream: true }))) {
      if (ev.done) continue;
      const c = parseChunk(ev.json);
      if (c.error) throw new Error(c.error);
      if (c.usage) usage = c.usage;
      if (c.finish) finish = c.finish;
      if (c.content || c.reasoning) onDelta?.(c);
    }
  }
  return { usage, finish };
}
