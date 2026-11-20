// stats-93: third-party boards we deliberately do NOT scrape — HTML-only
// (GDPx) or a metric semantics that cannot sit in a model column (RLI's
// automation rates measure the agent+harness pair, not the model). Linked
// from the model page so a reader can check coverage themselves; the boards
// are never compared, scored or ranked here.
// Keys of each `models` array are OUR canonical display names; every entry
// was verified present on the live board on 2026-11-20 (GDPx board HTML +
// dashboard.safe.ai RLI listing). Re-verify before extending.
export const MEASURED_ELSEWHERE = [
  {
    key: 'gdpx',
    label: 'GDPx (SemiAnalysis)',
    url: 'https://gdpx.semianalysis.com/',
    note: '206 multi-step tasks across 11 economically valuable domains (equal-weight domain average, 3 attempts). Independent board — not scraped, not compared here.',
    models: [
      'Claude Fable 5.1', 'Claude Fable 5.2', 'Claude Haiku 5.5',
      'Claude Opus 5.5', 'Claude Sonnet 5.5', 'DeepSeek V4.1 Flash 1017',
      'GLM-5.3', 'GPT-6.1 Sol', 'GPT-6.1 Terra', 'GPT-6 Astra',
      'GPT-6 Luna', 'Gemini 4 Argon', 'Gemini 4 Carbon', 'Grok 4.7',
      'Kimi K3',
    ],
  },
  {
    key: 'rli',
    label: 'Remote Labor Index (CAIS + Scale AI)',
    url: 'https://www.remotelabor.ai/',
    note: 'Automation rates on real freelance projects — the score belongs to the agent+harness pair, not the model alone, so it never becomes a leaderboard column here.',
    models: [
      'Claude Fable 5', 'Claude Fable 5.1', 'Claude Fable 5.2',
      'Claude Opus 4.6', 'Claude Opus 4.8', 'Claude Opus 5.5',
      'GPT-5.2', 'GPT-5.5', 'GPT-6 Astra', 'Gemini 3.7 Flash',
      'Gemini 3.8 Flash',
    ],
  },
];

// Boards covering a given canonical model name (order = MEASURED_ELSEWHERE)
export function elsewhereFor(name) {
  if (!name) return [];
  return MEASURED_ELSEWHERE.filter(b => b.models.includes(name))
    .map(({ key, label, url, note }) => ({ key, label, url, note }));
}
