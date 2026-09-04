// ── Static app configuration ──────────────────────────────────────────

export const BASE_TITLE = 'Benchmark Arena | LLM Leaderboard Aggregator';

// Column header shorthand per benchmark
export const SHORT = {
  'Artificial Analysis': 'AA',
  'BenchLM.ai': 'BenchLM',
  'Arena.ai Text': 'Arena',
  'SimpleBench.com': 'SimpleB',
  'ARC-AGI-2': 'ARC-2',
  'Design Arena': 'Design',
  'DeepSWE': 'DeepSWE',
  'VendingBench': 'Vending',
  'SWE-Marathon': 'SWE-M',
  'FrontierSWE': 'Frontier',
  'CyberGem': 'CyberG',
  'EQBench CW': 'EQB',
};

// Benchmarks counted in the composite Avg column — the DEFAULT selection.
// Users can override it per browser via the "Avg set" dropdown (stores/data.js);
// this list stays the shipped ranking formula and the parity-test anchor.
export const CORE_BENCHMARKS = [
  'Artificial Analysis', 'BenchLM.ai', 'Arena.ai Text',
  'SimpleBench.com', 'ARC-AGI-2', 'Design Arena',
  'SWE-Marathon', 'FrontierSWE',
];

// One-click selections for the "Avg set" dropdown. `benches: null` means
// "every benchmark in the snapshot" (resolved at runtime).
export const AVG_PRESETS = [
  { id: 'default', label: 'Default (8 core)', benches: CORE_BENCHMARKS },
  { id: 'creative', label: 'Default + Creative Writing', benches: [...CORE_BENCHMARKS, 'EQBench CW'] },
  { id: 'all', label: 'All benchmarks', benches: null },
];

// localStorage key persisting the user's custom average selection
export const AVG_STORAGE_KEY = 'arena.avg_selection';

// Benchmarks highlighted with leader cards on the overview
export const LEADER_BENCHES = ['Artificial Analysis', 'Arena.ai Text', 'ARC-AGI-2', 'SWE-Marathon'];

export const BLURBS = {
  'Artificial Analysis': 'Composite intelligence index blending reasoning, knowledge, math and code into one headline number.',
  'BenchLM.ai': 'Independent multi-task evaluation suite scoring applied accuracy.',
  'Arena.ai Text': 'Blind human preference battles on everyday prompts — the "does it feel smart" proxy.',
  'SimpleBench.com': 'Practical scenarios where agents must use tools, files and judgement, not just recall.',
  'ARC-AGI-2': 'Abstraction and reasoning puzzles designed to be Google-proof and memorization-resistant.',
  'Design Arena': 'Frontend and UI generation judged on real rendered output.',
  'DeepSWE': 'Agentic software engineering exercised on real repositories.',
  'VendingBench': 'Long-horizon planning and bookkeeping in a simulated vending-machine business.',
  'SWE-Marathon': 'Long, multi-step engineering sessions — stamina for real codebases.',
  'FrontierSWE': 'Hard, frontier-grade software engineering issues.',
  'CyberGem': 'Cybersecurity challenges in capture-the-flag style.',
  'EQBench CW': 'Creative writing judged by LLM panels (pairwise Elo). Non-core: thin coverage of current-gen models for now.',
};

// Leaderboard tier tabs (order matters — "all" first so the overall
// top model is immediately visible)
export const TIERS = [
  { value: 'all', label: 'All models', icon: 'globe' },
  { value: 'closed', label: 'Closed-source', icon: 'lock' },
  { value: 'open', label: 'Open-weight', icon: 'lock-open' },
];

// Provider detection for avatars
export const PROVIDER_MATCHERS = [
  { re: /claude|anthropic/i, name: 'Anthropic', color: '#d97757' },
  { re: /gpt|openai|chatgpt/i, name: 'OpenAI', color: '#10a37f' },
  { re: /gemini|gemma|google/i, name: 'Google', color: '#4285f4' },
  { re: /grok/i, name: 'xAI', color: '#cfd3dc' },
  { re: /deepseek/i, name: 'DeepSeek', color: '#4f6dff' },
  { re: /kimi|moonshot/i, name: 'Moonshot', color: '#14b8a6' },
  { re: /glm|zhipu/i, name: 'Z.ai', color: '#38bdf8' },
  { re: /minimax/i, name: 'MiniMax', color: '#ff4d6d' },
  { re: /qwen|qwq/i, name: 'Alibaba', color: '#c73b5f' },
  { re: /llama|meta/i, name: 'Meta', color: '#0668E1' },
  { re: /mistral|mixtral/i, name: 'Mistral', color: '#ff7000' },
  { re: /hunyuan/i, name: 'Tencent', color: '#0052d9' },
  { re: /ernie|baidu/i, name: 'Baidu', color: '#2932e1' },
  { re: /nova|amazon|aws/i, name: 'Amazon', color: '#ff9900' },
  { re: /phi|microsoft/i, name: 'Microsoft', color: '#00a4ef' },
  { re: /cohere|command/i, name: 'Cohere', color: '#39594d' },
];
