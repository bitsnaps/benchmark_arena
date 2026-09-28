// Unit tests for src/lib/myProviders.js — the My Providers pure core.
// Locks: ID cleanup ([1m] ctx tags, :free twins, org prefixes), tolerant
// listing parsing (fetch + paste), the STAGED conservative matcher
// (exact → dated → thinking, plus the stats-39 raw-anchored
// preview/route/thinksearch strips; prefix matching is deliberately
// absent — see the Fable-5 regression test), and OpenRouter-style
// pricing math.
import { describe, it, expect } from 'vitest';
import {
  parseProviderId, parseModelListing,
  buildCatalogIndex, matchOne, matchListing,
  extractPricing,
  sanitizeKeyPath, normalizePriceKeys, resolveKeyPath, parsePriceValue,
  extractPricingFor, previewPricingKeys,
  buildMineOverlay, headlineSku, undercutsMine,
} from '../../src/lib/myProviders.js';

describe('parseProviderId', () => {
  it('strips org prefixes, ctx tags and free suffixes into a normKey', () => {
    expect(parseProviderId('anthropic/claude-fable-5.1[1m]')).toMatchObject({
      raw: 'anthropic/claude-fable-5.1[1m]', base: 'anthropic/claude-fable-5.1',
      key: 'claudefable51', variant: '1m', free: false,
    });
    expect(parseProviderId('agnes-2.0-flash:free')).toMatchObject({
      key: 'agnes20flash', free: true, variant: null,
    });
    expect(parseProviderId('Qwen/Qwen3.8-Max')).toMatchObject({ key: 'qwen38max' });
    expect(parseProviderId('gpt-5.6-luna')).toMatchObject({ key: 'gpt56luna' });
  });

  it('returns null for empty/garbage ids', () => {
    expect(parseProviderId('')).toBeNull();
    expect(parseProviderId(null)).toBeNull();
    expect(parseProviderId('///')).toMatchObject({ key: null });
  });
});

describe('parseModelListing', () => {
  it('parses the OpenAI {data:[...]} shape with endpoint-aware chat detection', () => {
    const doc = JSON.stringify({
      object: 'list',
      data: [
        { id: 'claude-fable-5.1[1m]', object: 'model', created: 1626777600, owned_by: 'claude', supported_endpoint_types: ['openai'], context_length: 1000000 },
        { id: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
        { id: 'bge-embed', supported_endpoint_types: ['openai', 'embedding'], context_length: 8192 },
        { id: 'plain-openai-style', owned_by: 'openai' }, // no endpoints → chat fallback
      ],
    });
    const r = parseModelListing(doc);
    expect(r.format).toBe('openai');
    expect(r.warnings).toHaveLength(0);
    const byId = Object.fromEntries(r.models.map(m => [m.id, m]));
    expect(byId['claude-fable-5.1[1m]']).toMatchObject({ chat: true, variant: '1m', context_length: 1000000, key: 'claudefable51' });
    expect(byId['gpt-image-2'].chat).toBe(false);
    expect(byId['bge-embed'].chat).toBe(true); // openai endpoint wins over embedding
    expect(byId['plain-openai-style'].chat).toBe(true);
    // provider `created` is never persisted by the parser
    expect(byId['claude-fable-5.1[1m]'].created).toBeUndefined();
  });

  it('accepts bare arrays, string arrays and plain id lists (paste mode)', () => {
    expect(parseModelListing('[{"id":"a"},{"id":"b"}]').models).toHaveLength(2);
    expect(parseModelListing('["x","y"]').models.map(m => m.id)).toEqual(['x', 'y']);
    const list = parseModelListing('# my gateway\ngpt-5.6-luna\nclaude-opus-4.6\n\nglm-5.2');
    expect(list.format).toBe('ids');
    expect(list.models.map(m => m.id)).toEqual(['gpt-5.6-luna', 'claude-opus-4.6', 'glm-5.2']);
  });

  it('warns honestly instead of throwing on junk shapes', () => {
    expect(parseModelListing('{"foo":1}').format).toBe('bad-json');
    expect(parseModelListing('<html>login page</html>').warnings.length).toBeGreaterThan(0);
    expect(parseModelListing('').format).toBe('empty');
    const dupes = parseModelListing('a\na\nb');
    expect(dupes.models).toHaveLength(2);
    expect(dupes.warnings[0]).toContain('1 entry dropped');
  });
});

describe('buildCatalogIndex + staged matching', () => {
  const rows = [
    { name: 'Claude Fable 5' }, { name: 'Claude Fable 5.1' },
    { name: 'Claude Haiku 4.5' }, { name: 'DeepSeek R1' }, { name: 'GPT-5.6 Luna' },
    { name: 'Claude Opus 4.8' },
  ];
  const meta = {
    'Claude Fable 5': { superseded_by: 'Claude Fable 5.1' }, // older row
    'Qwen3.8-Max': { or_id: 'qwen/qwen3.8-max-0902' },
    'Some HF Model': { hugging_face_id: 'org/some-hf-model' },
  };
  const index = buildCatalogIndex(rows, meta);

  it('indexes display names plus or_id and hugging_face_id keys', () => {
    expect(index.get('claudefable51').name).toBe('Claude Fable 5.1');
    expect(index.get('qwen38max0902').name).toBe('Qwen3.8-Max');
    expect(index.get('somehfmodel').name).toBe('Some HF Model');
  });

  it('prefers the live row on normKey collisions (older loses)', () => {
    // 'claude fable 5' collides with 'Claude Fable 5' — kept — but a key
    // shared with the non-older sibling must resolve to the live one.
    expect(index.get('claudefable5').name).toBe('Claude Fable 5'); // unique key, older but unique
    const idx2 = buildCatalogIndex(
      [{ name: 'Dup Model' }, { name: 'Dup Model' }],
      { 'Dup Model': { superseded_by: 'X' } },
    );
    expect(idx2.get('dupmodel').name).toBe('Dup Model');
  });

  it('pass 1 exact; pass 2 dated (8- and 4-digit); pass 3 thinking', () => {
    expect(matchOne('gpt56luna', index)).toMatchObject({ pass: 'exact', name: 'GPT-5.6 Luna' });
    expect(matchOne('claudehaiku4520251001', index)).toMatchObject({ pass: 'dated', name: 'Claude Haiku 4.5' });
    expect(matchOne('deepseekr10528', index)).toMatchObject({ pass: 'dated', name: 'DeepSeek R1' });
    expect(matchOne('claudeopus48thinking', index)).toMatchObject({ pass: 'thinking', name: 'Claude Opus 4.8' });
  });

  it('REGRESSION: prefix matching stays forbidden (Fable 5 ≠ Fable 5.1)', () => {
    // 'claudefable5' IS in the index (exact) — but the dangerous case is a
    // provider id that is a strict PREFIX of a longer catalog key:
    expect(matchOne('claudefable', index)).toBeNull();
    expect(matchOne('claudefable5x', index)).toBeNull();
    expect(matchOne('nonexistent', index)).toBeNull();
  });

  it('matchListing splits a listing and reports honest stats', () => {
    const models = [
      { id: 'gpt-5.6-luna[1m]', key: 'gpt56luna', chat: true, variant: '1m', free: false },
      { id: 'claude-opus-4-8-thinking', key: 'claudeopus48thinking', chat: true, variant: null, free: false },
      { id: 'deepseek-r1-0528', key: 'deepseekr10528', chat: true, variant: null, free: false },
      { id: 'my-private-model', key: 'myprivatemodel', chat: true, variant: null, free: false },
    ];
    const r = matchListing(models, index);
    expect(r.stats).toEqual({ total: 4, matched: 3 });
    expect(r.matched.map(m => [m.name, m.pass])).toEqual([
      ['GPT-5.6 Luna', 'exact'],
      ['Claude Opus 4.8', 'thinking'],
      ['DeepSeek R1', 'dated'],
    ]);
    expect(r.unlisted.map(m => m.id)).toEqual(['my-private-model']);
  });
});

describe('stats-39 extra passes (raw-anchored, revertible)', () => {
  const rows = [
    { name: 'Gemini 3 Pro' }, { name: 'GLM-5.3' }, { name: 'GLM-5.3-Flash' },
    { name: 'GLM-5.2' }, { name: 'Quark' }, { name: 'Ab' },
  ];
  const index = buildCatalogIndex(rows, {});
  const K = (raw) => parseProviderId(raw).key;

  it('preview pass strips -preview (and a single-chunk trailing date)', () => {
    expect(matchOne(K('gemini-3-pro-preview'), index, 'gemini-3-pro-preview'))
      .toMatchObject({ pass: 'preview', name: 'Gemini 3 Pro' });
    expect(matchOne(K('gemini-3-pro-preview-0605'), index, 'gemini-3-pro-preview-0605'))
      .toMatchObject({ pass: 'preview', name: 'Gemini 3 Pro' });
  });

  it('route pass strips nitro/online/search/exp/latest route tags', () => {
    expect(matchOne(K('glm-5.3-search'), index, 'glm-5.3-search'))
      .toMatchObject({ pass: 'route', name: 'GLM-5.3' });
    expect(matchOne(K('glm-5.3-flash-search'), index, 'glm-5.3-flash-search'))
      .toMatchObject({ pass: 'route', name: 'GLM-5.3-Flash' });
  });

  it('thinksearch pass strips the compound think(ing)-search token', () => {
    expect(matchOne(K('glm-5.2-think-search'), index, 'glm-5.2-think-search'))
      .toMatchObject({ pass: 'thinksearch', name: 'GLM-5.2' });
    // the -thinking-search double form: the route strip removes -search
    // first, then the SHIPPED thinking pass completes — combo label, same
    // honest arena name (this shape never occurred in the measured dump).
    expect(matchOne(K('glm-5.2-thinking-search'), index, 'glm-5.2-thinking-search'))
      .toMatchObject({ pass: 'route+thinking', name: 'GLM-5.2' });
  });

  it('strip + shipped-pass combos work (route+dated)', () => {
    // date BEFORE the token: shipped passes miss glm530901search, the route
    // strip hands glm-5.3-0901 back to the staged matcher → dated fires.
    expect(matchOne(K('glm-5.3-0901-search'), index, 'glm-5.3-0901-search'))
      .toMatchObject({ pass: 'route+dated', name: 'GLM-5.3' });
  });

  it('guards: separator mandatory, remainder >= 5, index hit required', () => {
    // NO separator before the token — 'quarksearch' is its own word
    expect(matchOne(K('quarksearch'), index, 'quarksearch')).toBeNull();
    // stripped remainder too short even though 'Ab' exists
    expect(matchOne(K('ab-search'), index, 'ab-search')).toBeNull();
    // strip fires but the remainder is not a catalog model
    expect(matchOne(K('ghost-search'), index, 'ghost-search')).toBeNull();
    // org-prefixed raw still strips on the last segment
    expect(matchOne(K('zhipu/glm-5.2-search'), index, 'zhipu/glm-5.2-search'))
      .toMatchObject({ pass: 'route', name: 'GLM-5.2' });
  });

  it('PIN: 2-arg callers keep byte-identical behavior (direction B)', () => {
    // The compare-pivot join calls matchOne(r.key, index) — no rawBase,
    // extra passes must never fire from the key alone.
    expect(matchOne(K('glm-5.3-search'), index)).toBeNull();
    expect(matchOne(K('glm-5.2-think-search'), index)).toBeNull();
    expect(matchOne('glm53', index)).toMatchObject({ pass: 'exact', name: 'GLM-5.3' });
  });

  it('matchListing threads the raw base end-to-end', () => {
    const parsed = parseModelListing(JSON.stringify({
      data: [
        { id: 'glm-5.3-search', supported_endpoint_types: ['openai'] },
        { id: 'glm-5.3' },
      ],
    }));
    const r = matchListing(parsed.models, index);
    expect(r.stats).toEqual({ total: 2, matched: 2 });
    expect(r.matched.map(m => [m.name, m.pass])).toEqual([
      ['GLM-5.3', 'route'],
      ['GLM-5.3', 'exact'],
    ]);
  });
});

describe('extractPricing', () => {
  it('converts OpenRouter per-token USD strings to per-1M numbers', () => {
    expect(extractPricing({ prompt: '0.0000015', completion: '0.000006' })).toEqual({ in: 1.5, out: 6 });
    expect(extractPricing({ prompt: '0', completion: '0' })).toEqual({ in: 0, out: 0 });
  });
  it('yields null honestly when pricing is absent or malformed', () => {
    expect(extractPricing(null)).toBeNull();
    expect(extractPricing({})).toBeNull();
    expect(extractPricing({ prompt: 'free' })).toBeNull();
    expect(extractPricing({ prompt: '0.0000015' })).toEqual({ in: 1.5, out: null });
  });
});

// ── stats-38: Compare-pivot overlay ("my gateways" columns) ───────────
describe('buildMineOverlay', () => {
  const INDEX = new Map([
    ['claudefable51', { name: 'Claude Fable 5.1' }],
    ['gpt56luna', { name: 'GPT-5.6 Luna' }],
  ]);
  const PROV = {
    id: 'gw1',
    models: [
      { id: 'claude-fable-5.1', key: 'claudefable51', chat: true, pricing: { prompt: '0.000002', completion: '0.00001' } },
      { id: 'gpt-5.6-luna[1m]', key: 'gpt56luna', variant: '1m', chat: true, pricing: null },
      { id: 'img-forge', key: 'imgforge', chat: false, pricing: { prompt: '0', completion: '0' } },
    ],
  };

  it('groups matched SKUs per arena name and per provider, chat-only', () => {
    const ov = buildMineOverlay([PROV], INDEX);
    const perProvider = ov.get('Claude Fable 5.1');
    expect(perProvider.get('gw1')).toHaveLength(1);
    expect(perProvider.get('gw1')[0]).toMatchObject({
      key: 'claude-fable-5.1', in: 2, out: 10, free: false, pass: 'exact',
    });
    // the :free-less [1m] variant lands on its own arena row with honest nulls
    const luna = ov.get('GPT-5.6 Luna').get('gw1');
    expect(luna[0]).toMatchObject({ key: 'gpt-5.6-luna[1m]', variant: '1m', in: null, out: null });
    // non-chat models never enter the overlay
    expect([...ov.keys()].sort()).toEqual(['Claude Fable 5.1', 'GPT-5.6 Luna']);
  });

  it('splits SKUs of the same model across two providers and two gateways', () => {
    const two = [PROV, { id: 'gw2', models: [{ id: 'claude-fable-5.1:free', key: 'claudefable51', free: true, chat: true }] }];
    const ov = buildMineOverlay(two, INDEX);
    const perProvider = ov.get('Claude Fable 5.1');
    expect(perProvider.get('gw1')).toHaveLength(1);
    expect(perProvider.get('gw2')[0]).toMatchObject({ key: 'claude-fable-5.1:free', free: true });
  });

  it('returns an empty map without an index (snapshot not loaded yet)', () => {
    expect(buildMineOverlay([PROV], null).size).toBe(0);
  });
});

describe('headlineSku', () => {
  it('prefers the cheapest PAID sku over a free twin (3:1 blend)', () => {
    const head = headlineSku([
      { key: 'x:free', free: true, in: 0, out: 0 },
      { key: 'x', free: false, in: 2, out: 10 },   // blend 4
      { key: 'y', free: false, in: 1, out: 4 },    // blend 1.75
    ]);
    expect(head.kind).toBe('paid');
    expect(head.sku.key).toBe('y');
    expect(head.blend).toBeCloseTo(1.75);
  });

  it('falls back to the free twin when no paid blend exists', () => {
    const head = headlineSku([{ key: 'x:free', free: true, in: null, out: null }]);
    expect(head.kind).toBe('free');
    expect(head.blend).toBe(0);
  });

  it('zero-priced SKUs count as free (the catalog isFreeRow rule)', () => {
    const head = headlineSku([{ key: 'x', free: false, in: 0, out: 0 }]);
    expect(head.kind).toBe('free');
  });

  it('listed-but-unpriced SKUs stay an honest unpriced headline', () => {
    expect(headlineSku([{ key: 'x', free: false, in: null, out: null }]).kind).toBe('unpriced');
    // completion-only pricing is not blendable — honest null, not a guess
    const head = headlineSku([{ key: 'x', free: false, in: null, out: 6 }]);
    expect(head.kind).toBe('unpriced');
  });

  it('returns null for an empty sku list', () => {
    expect(headlineSku([])).toBeNull();
    expect(headlineSku(null)).toBeNull();
  });
});

describe('undercutsMine', () => {
  it('fires strictly below the catalog blend, never on a tie', () => {
    expect(undercutsMine(3, 4)).toBe(true);
    expect(undercutsMine(4, 4)).toBe(false);
    expect(undercutsMine(5, 4)).toBe(false);
  });
  it('stays silent when either side is unpriced', () => {
    expect(undercutsMine(null, 4)).toBeNull();
    expect(undercutsMine(3, null)).toBeNull();
    expect(undercutsMine(0, null)).toBeNull();
  });
});

// ── stats-51: user-configured pricing keys ───────────────────────────
describe('sanitizeKeyPath + normalizePriceKeys', () => {
  it('normalizes dot paths and bracket indexes', () => {
    expect(sanitizeKeyPath(' pricing.input_per_1M_tokens ')).toBe('pricing.input_per_1M_tokens');
    expect(sanitizeKeyPath('tiers[0].input')).toBe('tiers.0.input');
    expect(sanitizeKeyPath('a..b')).toBe('a.b');
    expect(sanitizeKeyPath('cost.per-1M')).toBe('cost.per-1M');
  });
  it('rejects garbage, oversize and prototype-dangerous paths', () => {
    expect(sanitizeKeyPath('')).toBeNull();
    expect(sanitizeKeyPath('has space')).toBeNull();
    expect(sanitizeKeyPath('__proto__')).toBeNull();
    expect(sanitizeKeyPath('a.__proto__.b')).toBeNull();
    expect(sanitizeKeyPath('constructor.prototype')).toBeNull();
    expect(sanitizeKeyPath('a.'.repeat(20) + 'b')).toBeNull(); // >16 segments
    expect(sanitizeKeyPath('x'.repeat(129))).toBeNull();
  });
  it('normalizePriceKeys: off / one-side / unit pinning / error', () => {
    expect(normalizePriceKeys({}).priceKeys).toBeNull();
    expect(normalizePriceKeys(null).priceKeys).toBeNull();
    expect(normalizePriceKeys({ input: 'pricing.in' }).priceKeys).toEqual({ input: 'pricing.in', output: null, unit: 'token' });
    expect(normalizePriceKeys({ input: 'a', output: 'b', unit: '1m' }).priceKeys).toEqual({ input: 'a', output: 'b', unit: '1m' });
    const bad = normalizePriceKeys({ input: 'bad path!' });
    expect(bad.priceKeys).toBeNull();
    expect(bad.error).toContain('Invalid pricing key path');
  });
});

describe('resolveKeyPath', () => {
  const doc = { pricing: { input_per_1M_tokens: 2.11, note: null }, tiers: [{ input: 1 }, { input: 3 }], id: 'x' };
  it('resolves deep nesting and array indexes', () => {
    expect(resolveKeyPath(doc, 'pricing.input_per_1M_tokens')).toEqual({ found: true, value: 2.11 });
    expect(resolveKeyPath(doc, 'tiers.1.input')).toEqual({ found: true, value: 3 });
    expect(resolveKeyPath(doc, 'id')).toEqual({ found: true, value: 'x' });
    expect(resolveKeyPath(doc, 'pricing.note')).toEqual({ found: true, value: null });
  });
  it('misses honestly and never throws or pollutes', () => {
    expect(resolveKeyPath(doc, 'pricing.deeper.still').found).toBe(false);
    expect(resolveKeyPath(doc, 'tiers.input').found).toBe(false); // array by name
    expect(resolveKeyPath(null, 'a').found).toBe(false);
    expect(resolveKeyPath(doc, '__proto__.polluted').found).toBe(false);
    expect(({}).polluted).toBeUndefined();
    expect(resolveKeyPath(doc, '')).toEqual({ found: false, value: undefined });
  });
});

describe('parsePriceValue', () => {
  it('accepts numbers and currency-decorated strings', () => {
    expect(parsePriceValue(2.11)).toBe(2.11);
    expect(parsePriceValue(0)).toBe(0);
    expect(parsePriceValue('2.11')).toBe(2.11);
    expect(parsePriceValue('$2.11')).toBe(2.11);
    expect(parsePriceValue('USD 1,234.50')).toBe(1234.5);
    expect(parsePriceValue('0')).toBe(0);
  });
  it('rejects garbage honestly', () => {
    expect(parsePriceValue('free')).toBeNull();
    expect(parsePriceValue('')).toBeNull();
    expect(parsePriceValue(null)).toBeNull();
    expect(parsePriceValue(-1)).toBeNull();
    expect(parsePriceValue('N/A')).toBeNull();
    expect(parsePriceValue({ v: 1 })).toBeNull();
  });
});

describe('extractPricingFor', () => {
  // Ibrahim's real-world shape (stats-51 kickoff example): prices nested
  // under pricing.input_per_1M_tokens as per-1M numbers — NOT OpenRouter
  // prompt/completion per-token strings.
  const GPT6_SOL = {
    id: 'gpt-6-sol',
    pricing: null,
    raw: { id: 'gpt-6-sol', pricing: { type: 'per_token', currency: 'USD', input_per_1M_tokens: 2.11, output_per_1M_tokens: 10.55 } },
  };
  const KEYS = { input: 'pricing.input_per_1M_tokens', output: 'pricing.output_per_1M_tokens', unit: '1m' };

  it('extracts Ibrahim-shaped nested per-1M pricing via custom keys', () => {
    expect(extractPricingFor(GPT6_SOL, KEYS)).toEqual({ in: 2.11, out: 10.55, viaKeys: true });
  });
  it('per-token unit multiplies by 1e6 (explicit, never guessed)', () => {
    expect(extractPricingFor(GPT6_SOL, { ...KEYS, unit: 'token' })).toEqual({ in: 2110000, out: 10550000, viaKeys: true });
  });
  it('null priceKeys degrades exactly to extractPricing', () => {
    const m = { pricing: { prompt: '0.000002', completion: '0.00001' }, raw: { id: 'x' } };
    expect(extractPricingFor(m, null)).toEqual({ in: 2, out: 10, viaKeys: false });
    expect(extractPricingFor(m, undefined)).toEqual({ in: 2, out: 10, viaKeys: false });
  });
  it('falls back PER SIDE: custom key wins when it resolves, built-in otherwise', () => {
    const m = {
      pricing: { prompt: '0.000002', completion: '0.00001' },
      raw: { id: 'x', cost: { input: 0.5 } }, // only the input key exists here
    };
    expect(extractPricingFor(m, { input: 'cost.input', output: 'cost.output', unit: '1m' }))
      .toEqual({ in: 0.5, out: 10, viaKeys: true });
  });
  it('key found but garbage value -> honest null for that side (no fallback)', () => {
    const m = { pricing: { prompt: '0.000002', completion: '0.00001' }, raw: { id: 'x', pricing: { input: 'free' } } };
    // input: key hit with garbage -> honest null (garbage must not silently
    // un-fall-back into a number of the wrong shape). output: no custom key
    // -> built-in completion fallback still applies per side.
    expect(extractPricingFor(m, { input: 'pricing.input', output: null, unit: '1m' }))
      .toEqual({ in: null, out: 10, viaKeys: false });
  });
  it('legacy pre-raw records still resolve pricing.* paths via the shim', () => {
    const legacy = { id: 'kimi-k3', pricing: { input_per_1M_tokens: 0.6, output_per_1M_tokens: 2.5 } }; // no raw
    expect(extractPricingFor(legacy, KEYS)).toEqual({ in: 0.6, out: 2.5, viaKeys: true });
  });
  it('legacy records with deeper paths miss honestly (re-sync suggested)', () => {
    const legacy = { id: 'x', pricing: { prompt: '0.000001' } };
    expect(extractPricingFor(legacy, { input: 'cost.input', output: null, unit: '1m' }))
      .toEqual({ in: 1, out: null, viaKeys: false }); // falls back to prompt
  });
  it('string entries (id lists) have nothing to resolve — built-ins only', () => {
    const s = { id: 'm', pricing: null, raw: 'just-an-id' };
    expect(extractPricingFor(s, KEYS)).toBeNull();
  });
});

describe('previewPricingKeys', () => {
  const models = [
    { id: 'gpt-6-sol', pricing: null, raw: { id: 'gpt-6-sol', pricing: { input_per_1M_tokens: 2.11, output_per_1M_tokens: 10.55 } } },
    { id: 'kimi-k3', pricing: null, raw: { id: 'kimi-k3', pricing: { input_per_1M_tokens: 0.6, output_per_1M_tokens: 2.5 } } },
    { id: 'no-price', pricing: null, raw: { id: 'no-price' } },
    { id: 'garbage', pricing: null, raw: { id: 'garbage', pricing: { input_per_1M_tokens: 'free' } } },
  ];
  const KEYS = { input: 'pricing.input_per_1M_tokens', output: 'pricing.output_per_1M_tokens', unit: '1m' };
  it('counts hits, samples, misses and garbage honestly', () => {
    const s = previewPricingKeys(models, KEYS);
    expect(s.total).toBe(4);
    expect(s.viaKeys).toBe(2);
    expect(s.priced).toBe(2);
    expect(s.badCount).toBe(1); // garbage hit, never guessed
    expect(s.samples[0]).toEqual({ id: 'gpt-6-sol', in: 2.11, out: 10.55 });
    expect(s.legacy).toBe(false);
  });
  it('flags legacy (pre-raw) models so the UI can suggest a re-sync', () => {
    const legacy = [{ id: 'old', pricing: { input_per_1M_tokens: 1 } }];
    expect(previewPricingKeys(legacy, KEYS).legacy).toBe(true);
    expect(previewPricingKeys(legacy, null).legacy).toBe(false);
  });
  it('keys off -> all counts zero, no samples', () => {
    const s = previewPricingKeys(models, null);
    expect(s.viaKeys).toBe(0);
    expect(s.samples).toEqual([]);
  });
});

describe('buildMineOverlay + priceKeys (stats-51)', () => {
  const INDEX = new Map([['gpt6sol', { name: 'GPT-6 Sol' }]]);
  it('overlay SKUs carry key-resolved prices and provenance', () => {
    const prov = {
      id: 'gw1',
      priceKeys: { input: 'pricing.input_per_1M_tokens', output: 'pricing.output_per_1M_tokens', unit: '1m' },
      models: [{ id: 'gpt-6-sol', key: 'gpt6sol', chat: true, pricing: null, raw: { id: 'gpt-6-sol', pricing: { input_per_1M_tokens: 2.11, output_per_1M_tokens: 10.55 } } }],
    };
    const sku = buildMineOverlay([prov], INDEX).get('GPT-6 Sol').get('gw1')[0];
    expect(sku).toMatchObject({ in: 2.11, out: 10.55, viaKeys: true });
    // headline works over key-priced SKUs exactly like listing-priced ones
    expect(headlineSku([sku]).kind).toBe('paid');
    expect(headlineSku([sku]).blend).toBeCloseTo((3 * 2.11 + 10.55) / 4);
  });
  it('a provider without keys is untouched (byte-equal legacy behavior)', () => {
    const prov = { id: 'gw2', models: [{ id: 'gpt-6-sol', key: 'gpt6sol', chat: true, pricing: { prompt: '0.000002', completion: '0.00001' } }] };
    const sku = buildMineOverlay([prov], INDEX).get('GPT-6 Sol').get('gw2')[0];
    expect(sku).toMatchObject({ in: 2, out: 10, viaKeys: false });
  });
});
