// Playground: chat client helpers, safe markdown, model options, store.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  chatUrl, buildPayload, parseChunk, createSseParser, estimateTokens,
  estimateCost, errorFromResponse, sendChat, CORS_MESSAGE,
} from '../../src/lib/chat.js';
import { renderMarkdown } from '../../src/lib/miniMarkdown.js';
import { buildPlaygroundGroups, filterGroups, filterByProvider, findOption, optionsForArenaName } from '../../src/lib/playgroundModels.js';
import { parseModelListing } from '../../src/lib/myProviders.js';

describe('chatUrl', () => {
  it.each([
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://api.example.com/', 'https://api.example.com/v1/chat/completions'],
    ['api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://gw.test/v1/models', 'https://gw.test/v1/chat/completions'],
    ['https://gw.test/v1/chat/completions', 'https://gw.test/v1/chat/completions'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions'],
    ['', ''],
  ])('%s', (base, url) => expect(chatUrl(base)).toBe(url));
});

describe('buildPayload', () => {
  it('prepends the system prompt and drops UI-only messages and fields', () => {
    const p = buildPayload({
      model: 'm', system: 'be brief', temperature: 0.3, maxTokens: 256,
      messages: [
        { role: 'user', content: 'hi', id: 'x', at: 'now' },
        { role: 'assistant', content: '', error: 'boom' },
        { role: 'assistant', content: 'hello', meta: {} },
      ],
    });
    expect(p).toEqual({
      model: 'm', stream: true, temperature: 0.3, max_tokens: 256,
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    });
  });
  it('sends no temperature / max_tokens when left at provider default', () => {
    const p = buildPayload({ model: 'm', messages: [{ role: 'user', content: 'q' }], stream: false });
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('max_tokens');
    expect(p.stream).toBe(false);
  });
});

describe('stream parsing', () => {
  it('reads content, reasoning, usage and errors', () => {
    expect(parseChunk({ choices: [{ delta: { content: 'a', reasoning_content: 'r' } }] })).toMatchObject({ content: 'a', reasoning: 'r' });
    expect(parseChunk({ choices: [{ message: { content: 'full' }, finish_reason: 'stop' }] })).toMatchObject({ content: 'full', finish: 'stop' });
    expect(parseChunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } }).usage).toEqual({ input: 3, output: 5 });
    expect(parseChunk({ error: { message: 'nope' } }).error).toBe('nope');
  });
  it('reassembles events split across network chunks', () => {
    const s = createSseParser();
    expect(s.push('data: {"choices":[{"delta":{"content":"He')).toEqual([]);
    const evs = s.push('llo"}}]}\n\n: keep-alive\ndata: [DONE]\n');
    expect(evs[0].json.choices[0].delta.content).toBe('Hello');
    expect(evs[1]).toEqual({ done: true });
  });
});

describe('estimates and errors', () => {
  it('estimates tokens and cost; unknown price → null', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    expect(estimateCost({ input: 1e6, output: 1e6 }, { in: 1, out: 4 })).toBe(5);
    expect(estimateCost({ input: 10, output: 10 }, null)).toBeNull();
  });
  it('turns HTTP failures into readable messages with the provider detail', () => {
    expect(errorFromResponse(401, '{"error":{"message":"bad key"}}', 'u')).toMatch(/rejected the key \(HTTP 401\) — bad key/);
    expect(errorFromResponse(404, '', 'https://x/v1/chat/completions')).toMatch(/404 at https:\/\/x/);
    expect(errorFromResponse(500, '<html><b>oops</b></html>', 'u')).toBe('Provider returned HTTP 500 — oops.');
  });
});

const sseResponse = (events) => new Response(new ReadableStream({
  start(c) {
    const enc = new TextEncoder();
    for (const e of events) c.enqueue(enc.encode(e));
    c.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('sendChat', () => {
  it('streams deltas, posts to the chat URL with the bearer key, returns usage', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n',
      'data: [DONE]\n',
    ]));
    let text = '';
    const r = await sendChat({ baseUrl: 'https://gw.test/v1', key: 'sk-1', payload: { model: 'm', messages: [], stream: true }, fetchImpl, onDelta: (c) => { text += c.content; } });
    expect(text).toBe('Hello');
    expect(r).toEqual({ usage: { input: 7, output: 2 }, finish: 'stop' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://gw.test/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-1');
  });
  it('handles a non-streamed JSON reply', async () => {
    const fetchImpl = async () => new Response('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}', { status: 200, headers: { 'content-type': 'application/json' } });
    let text = '';
    await sendChat({ baseUrl: 'gw.test', payload: { stream: false }, fetchImpl, onDelta: (c) => { text += c.content; } });
    expect(text).toBe('ok');
  });
  it('maps network failures to the CORS explanation, keeps AbortError, sends no auth header without a key', async () => {
    const seen = [];
    await expect(sendChat({ baseUrl: 'gw.test', payload: {}, fetchImpl: async (u, i) => { seen.push(i); throw new TypeError('Failed to fetch'); } })).rejects.toThrow(CORS_MESSAGE);
    expect(seen[0].headers).not.toHaveProperty('Authorization');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(sendChat({ baseUrl: 'gw.test', payload: {}, fetchImpl: async () => { throw abort; } })).rejects.toBe(abort);
  });
  it('surfaces an error event inside the stream', async () => {
    const fetchImpl = async () => sseResponse(['data: {"error":{"message":"overloaded"}}\n']);
    await expect(sendChat({ baseUrl: 'gw.test', payload: { stream: true }, fetchImpl })).rejects.toThrow('overloaded');
  });
});

describe('renderMarkdown', () => {
  it('escapes raw HTML from the model', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **hi**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>hi</strong>');
  });
  it('renders code fences verbatim, lists, headings, and only http(s) links', () => {
    const html = renderMarkdown('# T\n\n- a\n- b\n\n```js\nconst x = 1 < 2 && **y**;\n```\n[ok](https://a.b) [bad](javascript:alert(1))');
    expect(html).toContain('<h3>T</h3>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<pre data-lang="js"><code>const x = 1 &lt; 2 &amp;&amp; **y**;</code></pre>');
    expect(html).toContain('<a href="https://a.b" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).not.toContain('href="javascript');
  });
  it('keeps inline code literal', () => {
    expect(renderMarkdown('use `**not bold**`')).toBe('<p>use <code>**not bold**</code></p>');
  });
});

describe('playground model options', () => {
  const rows = new Map([['Model A', { name: 'Model A' }], ['Model B', { name: 'Model B' }]]);
  const index = new Map([['modela', { name: 'Model A' }], ['modelb', { name: 'Model B' }]]);
  const ctx = {
    catalogIndex: index, rowByName: rows,
    scoreForModel: (r) => (r.name === 'Model A' ? 70 : 90),
    priceFor: (r) => (r.name === 'Model A' ? { input: 1, output: 2 } : null),
    isOlder: () => false, isUnranked: () => false, slugOf: (n) => n.toLowerCase().replace(/\s+/g, '-'),
  };
  const listing = parseModelListing(JSON.stringify({ data: [
    { id: 'model-a' }, { id: 'model-b', pricing: { prompt: '0.000003', completion: '0.000009' } },
    { id: 'zeta-private' }, { id: 'img-x', supported_endpoint_types: ['image-generation'] },
  ] })).models;
  const groups = buildPlaygroundGroups([
    { id: 'p1', label: 'Gateway', baseUrl: 'https://gw', key: 'k', models: listing, priceKeys: null },
    { id: 'p2', label: 'Empty', baseUrl: 'https://e', key: '', models: [] },
  ], ctx);

  it('lists chat models only, best-rated first, with arena joins and price sources', () => {
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map(i => i.modelId)).toEqual(['model-b', 'model-a', 'zeta-private']);
    const [b, a, z] = groups[0].items;
    expect(b).toMatchObject({ arenaName: 'Model B', score: 90, slug: 'model-b', price: { in: 3, out: 9, source: 'provider' } });
    expect(a.price).toEqual({ in: 1, out: 2, source: 'arena' });
    expect(z).toMatchObject({ arenaName: null, score: null, price: null });
  });
  it('filters, finds, and maps arena names back to options', () => {
    expect(filterGroups(groups, 'zeta')[0].items.map(i => i.modelId)).toEqual(['zeta-private']);
    expect(filterGroups(groups, 'gateway')[0].items).toHaveLength(3);
    expect(filterGroups(groups, 'nothing')).toEqual([]);
    expect(findOption(groups, 'p1', 'model-a').arenaName).toBe('Model A');
    expect(findOption(groups, 'p2', 'model-a')).toBeNull();
    expect(optionsForArenaName(groups, 'Model A').map(o => o.modelId)).toEqual(['model-a']);
  });

  it('narrow by provider, compose with the text search', () => {
    expect(filterByProvider(groups, 'p1')).toHaveLength(1);
    expect(filterByProvider(groups, '')).toBe(groups);
    expect(filterByProvider(groups, 'nope')).toEqual([]);
    const narrowed = filterByProvider(groups, 'p1');
    expect(filterGroups(narrowed, 'zeta')[0].items.map(i => i.modelId)).toEqual(['zeta-private']);
    expect(filterGroups(narrowed, 'nothing')).toEqual([]);
  });
});

describe('playground store v2 — conversations in a driver', () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  let S, drv;
  beforeEach(async () => {
    mem.clear();
    vi.resetModules();
    S = await import('../../src/stores/playground.js');
    drv = (await import('../../src/lib/idb.js')).createMemoryDriver();
    S.setDriver(drv);
  });

  it('boots with one fresh chat; ops persist into the driver without transient fields', async () => {
    await S.ensurePlaygroundLoaded();
    const { conversations, activeId } = S.usePlayground();
    expect(conversations.value).toHaveLength(1);
    expect(activeId.value).toBe(conversations.value[0].id);
    S.setSettings({ providerId: 'p', modelId: 'm', temperature: 0.4 });
    S.addMessage({ role: 'user', content: 'q' });
    const aid = S.addMessage({ role: 'assistant', content: 'partial', pending: true, reasoning: 'thoughts' });
    S.updateMessage(aid, { content: 'answer' });
    await S.flushPersist();
    const recs = await drv.listConversations();
    expect(recs).toHaveLength(1);
    expect(recs[0].settings).toMatchObject({ providerId: 'p', modelId: 'm', temperature: 0.4, stream: true });
    expect(recs[0].messages.map(m => m.content)).toEqual(['q', 'answer']);
    expect(recs[0].messages[1]).not.toHaveProperty('pending');
    expect(recs[0].messages[1]).not.toHaveProperty('reasoning');
    expect(JSON.stringify(recs)).not.toMatch(/sk-/i);
  });

  it('migrates the legacy single-chat localStorage doc once, then drops the key', async () => {
    mem.set('ba.playground.v1', JSON.stringify({
      settings: { providerId: 'p1', modelId: 'm1' },
      messages: [{ id: 'a', role: 'user', content: 'hello world' }, { id: 'b', role: 'assistant', content: 'hi' }],
    }));
    await S.ensurePlaygroundLoaded();
    const { conversations } = S.usePlayground();
    expect(conversations.value).toHaveLength(1);
    expect(conversations.value[0].title).toBe('hello world');
    expect(conversations.value[0].settings.modelId).toBe('m1');
    expect(conversations.value[0].messages.map(m => m.content)).toEqual(['hello world', 'hi']);
    expect(mem.has('ba.playground.v1')).toBe(false);
    const recs = await drv.listConversations();
    expect(recs[0].messages).toHaveLength(2);
  });

  it('restores conversations, ui prefs and the active chat across a reload', async () => {
    await S.ensurePlaygroundLoaded();
    S.setUi({ railOpen: false, providerFilter: 'p9' });
    const id1 = S.newConversation({ providerId: 'x', modelId: 'y' });
    S.renameConversation(id1, 'My chat');
    S.addMessage({ role: 'user', content: 'persisted?' });
    await S.flushPersist();
    vi.resetModules();
    S = await import('../../src/stores/playground.js');
    S.setDriver(drv);
    await S.ensurePlaygroundLoaded();
    const { conversations, activeId, ui, messages } = S.usePlayground();
    expect(conversations.value).toHaveLength(2);
    expect(activeId.value).toBe(id1);
    expect(ui.value).toMatchObject({ railOpen: false, providerFilter: 'p9' });
    expect(messages.value.map(m => m.content)).toEqual(['persisted?']);
    const c = conversations.value.find(c => c.id === id1);
    expect(c.title).toBe('My chat');
    expect(c.settings).toMatchObject({ providerId: 'x', modelId: 'y' });
  });

  it('switches, deletes, and falls back to the most recent chat', async () => {
    await S.ensurePlaygroundLoaded();
    const { conversations, activeId } = S.usePlayground();
    const a = activeId.value;
    const b = S.newConversation();
    S.switchTo(a);
    expect(activeId.value).toBe(a);
    S.deleteConversation(a);
    expect(activeId.value).toBe(b);
    S.deleteConversation(b);
    expect(conversations.value).toHaveLength(1);
    expect(activeId.value).toBe(conversations.value[0].id);
    await S.flushPersist();
    expect(await drv.listConversations()).toHaveLength(1);
  });

  it('truncates from a message and caps stored messages per chat at 200', async () => {
    await S.ensurePlaygroundLoaded();
    const { messages, activeId } = S.usePlayground();
    const u1 = S.addMessage({ role: 'user', content: 'one' });
    S.addMessage({ role: 'assistant', content: 'two' });
    S.truncateFrom(u1);
    expect(messages.value).toEqual([]);
    for (let i = 0; i < 205; i++) S.addMessage({ role: 'user', content: 'm' + i });
    await S.flushPersist();
    const rec = (await drv.listConversations()).find(r => r.id === activeId.value);
    expect(rec.messages).toHaveLength(200);
    expect(rec.messages.at(-1).content).toBe('m204');
  });

  it('deleteAllHistory leaves one fresh chat and a clean driver', async () => {
    await S.ensurePlaygroundLoaded();
    S.newConversation();
    S.deleteAllHistory();
    const { conversations, messages, activeId } = S.usePlayground();
    expect(conversations.value).toHaveLength(1);
    expect(messages.value).toEqual([]);
    await S.flushPersist();
    const recs = await drv.listConversations();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(activeId.value);
  });
});
