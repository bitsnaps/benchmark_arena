// Unit tests for src/lib/myProviders.js — the My Providers pure core.
// Locks: ID cleanup ([1m] ctx tags, :free twins, org prefixes), tolerant
// listing parsing (fetch + paste), the STAGED conservative matcher
// (exact → dated → thinking; prefix matching is deliberately absent —
// see the Fable-5 regression test), and OpenRouter-style pricing math.
import { describe, it, expect } from 'vitest';
import {
  parseProviderId, parseModelListing,
  buildCatalogIndex, matchOne, matchListing,
  extractPricing,
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
