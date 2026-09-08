#!/usr/bin/env python3
"""
LLM Benchmark Aggregator v1.3
Scrapes 11 major LLM benchmark leaderboards using agent-browser (headless Chrome)
and web-reader, then synthesizes a unified comparison table with overall average scores.
Additionally enriches every unified model with catalog metadata from OpenRouter's
public API (params, active params, modalities, context, pricing, reasoning config)
so models can later be compared side-by-side in depth.

Usage: python3 bench_scraper.py            # full fresh scrape + metadata
       python3 bench_scraper.py --meta-only  # refresh metadata on last saved results

Benchmarks covered:
  1. Artificial Analysis  - https://artificialanalysis.ai/leaderboards/models
  2. BenchLM.ai           - https://benchlm.ai/
  3. Arena.ai Text        - https://arena.ai/leaderboard/text
  4. SimpleBench.com      - https://simple-bench.com/
  5. ARC-AGI-2           - https://arcprize.org/leaderboard (ARC-AGI-2 scores)
  6. Design Arena         - https://www.designarena.ai/leaderboard
  7. DeepSWE              - https://deepswe.datacurve.ai/
  8. VendingBench 2       - https://andonlabs.com/evals/vending-bench-2
  9. SWE-Marathon         - https://swe-marathon.org/
 10. FrontierSWE          - https://frontierswe.com/
 11. CyberGem             - https://www.cybergym.io/cybergym/
"""

import subprocess
import re
import json
import sys
import time
import os
import shutil
from collections import defaultdict
from datetime import date, datetime, timezone

# ── Configuration ──────────────────────────────────────────────────────────
TMP_DIR = "/tmp"
BENCHMARKS = {
    "Artificial Analysis": {
        "url": "https://artificialanalysis.ai/leaderboards/models",
        "wait_after_load": 4000,
        "snapshot_depth": 5,
        "type": "general",
        "closed_url": "https://artificialanalysis.ai/leaderboards/models?weights=closed",
        "open_url": "https://artificialanalysis.ai/leaderboards/models?weights=open",
    },
    "BenchLM.ai": {
        "url": "https://benchlm.ai/",
        "wait_after_load": 5000,
        "snapshot_depth": 5,
        "type": "general",
    },
    "Arena.ai Text": {
        "url": "https://arena.ai/leaderboard/text",
        "wait_after_load": 12000,
        "snapshot_depth": 6,
        "type": "general",
    },
    "SimpleBench.com": {
        "url": "https://simple-bench.com/",
        "wait_after_load": 8000,
        "snapshot_depth": 6,
        "type": "coding",
    },
    "ARC-AGI-2": {
        "url": "https://arcprize.org/leaderboard",
        "wait_after_load": 8000,
        "snapshot_depth": 8,
        "type": "reasoning",
    },
    "Design Arena": {
        "url": "https://www.designarena.ai/leaderboard",
        "type": "coding",
        "scale": "0-10",
    },
    "DeepSWE": {
        "url": "https://deepswe.datacurve.ai/",
        "type": "coding",
    },
    "VendingBench": {
        "url": "https://andonlabs.com/evals/vending-bench-2",
        "type": "agentic",
    },
    "SWE-Marathon": {
        "url": "https://swe-marathon.org/",
        "type": "coding",
    },
    "FrontierSWE": {
        "url": "https://frontierswe.com/",
        "type": "coding",
    },
    "CyberGem": {
        "url": "https://www.cybergym.io/cybergym/",
        "type": "security",
    },
}

SNAPSHOT_MAX_CHARS = 120000  # Truncate snapshots to avoid overwhelming the parser (raised: deeper per-source tables)
TOP_N = 25  # Number of top models to extract per category (raised from 10 for coverage)
MIN_CL_PERCENT = 25  # Min CL% to qualify for unified ranking (≥2/8 core benchmarks)

# ── Known Sub-Benchmark Overlap ────────────────────────────────────────────
# Tracks overlapping sub-benchmarks between sites that could inflate the
# unified average. Each entry: (site_a, site_b, [shared sub-benchmarks],
#   est_weight_a, est_weight_b) where est_weight is the approximate fraction
# that shared sub-benchmarks contribute to each site's aggregate score.
OVERLAP_PAIRS = [
    {
        "sites": ("Artificial Analysis", "BenchLM.ai"),
        "shared": ["Terminal-Bench", "SciCode", "HLE", "GPQA"],
        "weight_a": 0.33,   # ~3/9 components in AA's Intelligence Index
        "weight_b": 0.10,   # ~3/30 weighted benchmarks in BenchLM
    },
]
# Threshold: if Pearson correlation between a pair's scores exceeds this,
# flag a warning (suggesting overlap may be distorting the average).
OVERLAP_CORRELATION_THRESHOLD = 0.90
OVERLAP_MIN_SAMPLES_FOR_FLAG = 5  # Don't flag with fewer shared models (unreliable r)


# ── Browser Helpers ────────────────────────────────────────────────────────
def run_browser(*args, timeout=60):
    """Run an agent-browser command and return stdout."""
    cmd = ["agent-browser"] + list(args)
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0 and result.stderr:
            print(f"  [WARN] browser stderr: {result.stderr[:200]}")
        return result.stdout
    except subprocess.TimeoutExpired:
        # Timeout is not fatal — the browser may still be in a usable state
        if args and args[0] == "close":
            return ""  # close timeout is harmless
        print(f"  [TIMEOUT] Browser command timed out: {args[:2]}")
        return ""
    except Exception as e:
        print(f"  [ERROR] {e}")
        return ""


def load_and_snapshot(url, wait_ms=4000, depth=5):
    """Open a URL, wait for it to render, and return an accessibility snapshot."""
    run_browser("close", timeout=5)
    time.sleep(0.5)

    print(f"  Opening: {url}")
    run_browser("open", url, timeout=45)
    time.sleep(1)

    # Use 'load' instead of 'networkidle' — many sites never reach networkidle
    print(f"  Waiting for load event...")
    run_browser("wait", "--load", "load", timeout=30)
    time.sleep(1)

    print(f"  Additional wait: {wait_ms}ms")
    time.sleep(wait_ms / 1000)

    print(f"  Taking snapshot (depth={depth})...")
    snap = run_browser("snapshot", "-c", "-d", str(depth), timeout=30)

    if not snap or len(snap) < 100:
        print("  [WARN] Snapshot seems too short, retrying with longer wait...")
        time.sleep(3)
        snap = run_browser("snapshot", "-c", "-d", str(depth), timeout=30)

    run_browser("close", timeout=5)
    return snap[:SNAPSHOT_MAX_CHARS] if snap else ""


def load_and_eval(url, js_code, wait_ms=8000, timeouts=None):
    """
    Open a URL, wait for it to render, and evaluate JS to extract data.
    Returns parsed JSON or None.
    timeouts: dict with keys 'open', 'wait', 'eval', 'close' to override defaults.
    """
    t = {
        'open': 90,
        'wait': 60,
        'eval': 60,
        'close': 10,
    }
    if timeouts:
        t.update(timeouts)

    run_browser("close", timeout=t['close'])
    time.sleep(0.5)

    print(f"  Opening: {url}")
    run_browser("open", url, timeout=t['open'])
    time.sleep(1)

    print(f"  Waiting for load event...")
    run_browser("wait", "--load", "load", timeout=t['wait'])
    time.sleep(1)

    print(f"  Waiting {wait_ms}ms for JS rendering...")
    time.sleep(wait_ms / 1000)

    print(f"  Evaluating JavaScript...")
    raw = run_browser("eval", js_code, timeout=t['eval'])

    run_browser("close", timeout=t['close'])

    if not raw:
        return None
    # The output may have a checkmark line at the top from agent-browser
    # Also, agent-browser wraps eval results in outer quotes
    lines = raw.strip().split("\n")
    json_str = ""
    for line in lines:
        stripped = line.strip()
        # Strip outer quotes if present
        if stripped.startswith('"') and stripped.endswith('"'):
            stripped = stripped[1:-1]
        if stripped.startswith("[") or stripped.startswith("{"):
            json_str = stripped
            break
    if not json_str:
        for line in reversed(lines):
            stripped = line.strip()
            if stripped.startswith('"') and stripped.endswith('"'):
                stripped = stripped[1:-1]
            if stripped.startswith("[") or stripped.startswith("{"):
                json_str = stripped
                break
    if not json_str:
        return None

    try:
        # agent-browser eval returns the result as a JSON string wrapping the actual JSON.
        # e.g. '"[{\"name\":\"Claude\"},...]"' → parse once to get the string, parse again to get the array.
        parsed = json.loads(raw.strip())
        if isinstance(parsed, str):
            return json.loads(parsed)
        return parsed
    except json.JSONDecodeError as e:
        print(f"  [WARN] JSON parse error: {e}")
        print(f"  [WARN] Raw (first 200): {json_str[:200]}")
        return None


def load_and_eval_text(url, js_code, wait_ms=8000, timeouts=None):
    """
    Open a URL, wait for it to render, and evaluate JS to extract a string.
    Returns the raw string, or None on failure.
    Unlike load_and_eval, this returns the raw string (not parsed JSON).
    timeouts: dict with keys 'open', 'wait', 'eval', 'close' to override defaults.
    """
    t = {
        'open': 90,
        'wait': 60,
        'eval': 60,
        'close': 10,
    }
    if timeouts:
        t.update(timeouts)

    run_browser("close", timeout=t['close'])
    time.sleep(0.5)

    print(f"  Opening: {url}")
    run_browser("open", url, timeout=t['open'])
    time.sleep(1)

    print(f"  Waiting for load event...")
    run_browser("wait", "--load", "load", timeout=t['wait'])
    time.sleep(1)

    print(f"  Waiting {wait_ms}ms for JS rendering...")
    time.sleep(wait_ms / 1000)

    print(f"  Evaluating JavaScript...")
    raw = run_browser("eval", js_code, timeout=t['eval'])

    run_browser("close", timeout=t['close'])

    if not raw:
        return None
    # agent-browser wraps eval results in outer quotes for strings.
    # e.g. '"some text"' → parse once to get the actual string.
    # IMPORTANT: the raw output may contain literal newlines inside the JSON string,
    # so we must try parsing the FULL output before splitting by lines.
    cleaned = raw.strip()
    # Remove agent-browser status lines (lines starting with ✓)
    # But we need to be careful not to remove ✓ inside JSON strings.
    # Strategy 1: Try parsing the full cleaned output as JSON
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, str):
            return parsed
    except json.JSONDecodeError:
        pass

    # Strategy 2: Join all non-status lines and try parsing
    lines = cleaned.split("\n")
    non_status = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("✓") or not stripped:
            continue
        non_status.append(stripped)
    joined = "\n".join(non_status)
    try:
        parsed = json.loads(joined)
        if isinstance(parsed, str):
            return parsed
    except json.JSONDecodeError:
        pass

    # Strategy 3: Try each line individually (for single-line JSON)
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("✓") or not stripped:
            continue
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, str):
                return parsed
        except json.JSONDecodeError:
            pass

    return None


# ── Universal cell-table parser ───────────────────────────────────────────
def parse_cell_table(snap, model_col, score_col, skip_header=True, score_pct=True):
    """
    Parse an accessibility-tree snapshot containing a <table> with cell elements.

    Args:
        snap:          The snapshot text (one line per accessibility node).
        model_col:     0-based column index for the model name.
        score_col:     0-based column index for the score.
        skip_header:   Whether to skip the first row (column headers).
        score_pct:     If True, strip trailing '%' from score strings.
    """
    models = []
    lines = snap.split("\n")
    current_row_cells = []
    row_started = False

    for line in lines:
        stripped = line.strip()
        # Detect start of a new row
        if stripped.startswith("- row"):
            # Process previous row
            if row_started and len(current_row_cells) >= max(model_col, score_col) + 1:
                name = current_row_cells[model_col]
                score_str = current_row_cells[score_col]
                # Parse score
                if score_pct:
                    # '95.0%, $1.12/task' → '95.0' (percentage before first %)
                    score_str = score_str.split('%')[0].strip()
                try:
                    score = float(score_str)
                    if 0 < score <= 100 and name and not name.startswith('-'):
                        models.append((name, score))
                except (ValueError, IndexError):
                    pass
            current_row_cells = []
            row_started = True
            continue

        # Collect cell text within current row
        if row_started:
            cell_match = re.search(r'cell "([^"]+)"', stripped)
            if cell_match:
                current_row_cells.append(cell_match.group(1))
            # Stop collecting if we hit a non-row, non-cell element at same level
            elif stripped.startswith("- ") and not stripped.startswith("- row"):
                # New element at same level — row is done
                if current_row_cells:
                    pass  # Don't reset yet, some tables nest elements

    # Process last row
    if row_started and len(current_row_cells) >= max(model_col, score_col) + 1:
        name = current_row_cells[model_col]
        score_str = current_row_cells[score_col]
        if score_pct:
            score_str = score_str.replace('%', '')
        try:
            score = float(score_str)
            if 0 < score <= 100 and name and not name.startswith('-'):
                models.append((name, score))
        except (ValueError, IndexError):
            pass

    if skip_header and models:
        first = models[0][0]
        # Heuristic: if first entry looks like a header, drop it
        if first.lower() in ('model', 'ai system', 'name', 'rank', 'score'):
            models = models[1:]

    return models


# ── Site-specific parsers ─────────────────────────────────────────────────

def scrape_artificial_analysis():
    """
    AA uses a virtual table — data is in the DOM but not in the a11y tree.
    The ?weights= query param no longer works, so we load all models
    and classify them ourselves.
    JS eval: col 0 = model name, col 3 = intelligence score.

    stats-19: the SAME page load also mines the Next.js flight payload
    embedded in <script> tags for per-model AA list prices. The visible
    Price column shows only a blended "Cost per Task" number, while the
    payload carries price1mInputTokens / price1mOutputTokens /
    cacheHitPrice per model record — the labs' own list prices, no routing
    margin. They ride the module stash + AA_PRICING_CACHE into
    apply_aa_pricing() (models_meta), and the full payloads also carry
    medianTimeToFirstTokenSeconds (per-model latency — future layer).
    """
    url = "https://artificialanalysis.ai/leaderboards/models"
    print(f"  Scraping all models via JS eval (table + flight-payload pricing)...")
    # AA table: c[0]=Model, c[1]=Context, c[2]=Creator, c[3]=Intelligence Index
    # Intelligence Index is ~1-63 range, rescaled later via _benchmark_scale
    # Fetch up to 300 rows to cover the full leaderboard.
    #
    # Flight-payload mining: model records look like
    #   \"name\":\"GLM-4.5V (Non-reasoning)\",\"shortName\":\"…\",\"slug\":\"…\",
    #   ...,\"price1mInputTokens\":0.6,\"price1mOutputTokens\":1.8,\"cacheHitPrice\":…
    # anchored on the name→shortName→slug adjacency unique to model records.
    # The forward scan stops at the NEXT record boundary (\"shortName\": or
    # \"name\":) so a record without price keys can never steal its
    # neighbour's numbers. Duplicate arrays in the payload dedupe by name —
    # first valued record wins, conflicts counted.
    js = r"""(function(){
  var models = Array.from(document.querySelectorAll('table tbody tr')).slice(0,300).map(function(tr){
    var c = tr.querySelectorAll('td');
    return {name: c[0] ? c[0].textContent.trim() : '', score: c[3] ? c[3].textContent.trim().replace('*','') : ''};
  });
  var parts = [];
  var scripts = document.querySelectorAll('script');
  for (var i = 0; i < scripts.length; i++) {
    var t = scripts[i].textContent || '';
    if (t.length >= 10) parts.push(t);
  }
  var s = parts.join('\n');
  var pricing = {}, conflicts = 0;
  var re = /\\"name\\":\\"([^"\\]{2,150})\\",\\"shortName\\":\\"[^"\\]*\\",\\"slug\\":\\"[^"\\]*\\"/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    var name = m[1];
    var seg = s.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    var stopA = seg.indexOf('\\"shortName\\":');
    var stopB = seg.indexOf('\\"name\\":\\"');
    var stops = [stopA, stopB].filter(function(x){ return x >= 0; });
    if (stops.length) seg = seg.slice(0, Math.min.apply(null, stops));
    var grab = function(key) {
      var needle = '\\"' + key + '\\":';
      var at = seg.indexOf(needle);
      if (at === -1) return null;
      var rest = seg.slice(at + needle.length);
      var mm = rest.match(/^-?[0-9][0-9.eE+]*/);
      if (!mm) return null;
      var v = parseFloat(mm[0]);
      return isNaN(v) ? null : v;
    };
    var inp = grab('price1mInputTokens');
    var outp = grab('price1mOutputTokens');
    if (inp === null && outp === null) continue;
    var prev = pricing[name];
    if (prev) {
      if (prev.input === inp && prev.output === outp) continue;
      conflicts++;
      if (prev.input !== null) continue;
    }
    pricing[name] = {
      input: inp, output: outp,
      cache_read: grab('cacheHitPrice'),
      ttft_seconds: grab('medianTimeToFirstTokenSeconds')
    };
  }
  return JSON.stringify({models: models, pricing: pricing, conflicts: conflicts});
})()"""
    data = load_and_eval(url, js, wait_ms=8000)
    models = []
    pricing = {}
    conflicts = 0
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    if isinstance(data, dict):
        models_raw = data.get("models") or []
        pricing = data.get("pricing") or {}
        conflicts = int(data.get("conflicts") or 0)
        for item in models_raw:
            if not isinstance(item, dict):
                continue
            name = item.get("name", "")
            score_str = item.get("score", "")
            # Skip rank-only entries, empty names, or non-model rows
            if not name or len(name) < 3 or name.isdigit():
                continue
            if name == "No results.":
                continue
            try:
                score = float(score_str)
                if score > 0:
                    models.append((name, score))
            except (ValueError, TypeError):
                pass
        if pricing:
            global _AA_PRICING_LAST
            _AA_PRICING_LAST = pricing
            try:
                with open(AA_PRICING_CACHE, "w") as f:
                    json.dump({"mined_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                               "models": pricing}, f, ensure_ascii=False)
            except OSError as e:
                print(f"    [WARN] AA pricing cache write failed: {e}")
            print(f"    Mined AA list prices for {len(pricing)} models")
            if conflicts:
                print(f"    [AA pricing] {conflicts} conflicting duplicate record(s) — first valued wins")
        else:
            print(f"    [WARN] No AA pricing records mined (payload layout changed?)")
        print(f"    Extracted {len(models)} models")
    else:
        print(f"    [WARN] No data from AA")
    return models


# stats-19: AA list-price layer. The cache + module stash let --meta-only
# rebuilds attach AA prices without re-running the browser scrape.
AA_PRICING_CACHE = os.path.join(TMP_DIR, "aa_model_pricing.json")
_AA_PRICING_LAST = None  # set by scrape_artificial_analysis on each full load


def _load_aa_pricing_cache():
    """Load the AA pricing map mined by the last Artificial Analysis scrape."""
    if not os.path.exists(AA_PRICING_CACHE):
        return None
    try:
        with open(AA_PRICING_CACHE) as f:
            payload = json.load(f)
        age_h = (time.time() - os.path.getmtime(AA_PRICING_CACHE)) / 3600
        print(f"  [AA pricing] cache mined {payload.get('mined_at', '?')} "
              f"({age_h:.1f}h old, {len(payload.get('models') or {})} models)")
        return payload.get("models") or {}
    except (OSError, ValueError) as e:
        print(f"  [AA pricing] cache unreadable, skipping: {e}")
        return None


_AA_PAREN_TAIL_RE = re.compile(r"\s*\([^()]*\)\s*$")


def _aa_base_name(name):
    """Strip trailing parenthesized variant markers from an AA record name:
    'GPT-6 Astra (max)' -> 'GPT-6 Astra'; 'Claude Fable 5.1 (Adaptive
    Reasoning, Max Effort, Default Fallback)' -> 'Claude Fable 5.1'.
    AA's effort/fallback/fallback-config variants all bill the SAME per-token
    list price (verified live 2026-09-07) — only latency differs — so the
    family base is the right join key for our canonical (base) row names."""
    s = str(name).strip()
    while True:
        s2 = _AA_PAREN_TAIL_RE.sub("", s)
        if s2 == s:
            return s.strip()
        s = s2


def apply_aa_pricing(models_meta, aa_pricing=None):
    """stats-19: attach Artificial Analysis list prices to models_meta.

    AA prices are the labs' own list prices — no routing margin — so the UI
    prefers them over the OpenRouter snapshot. Join ladder (both exact):
      1. AA record name == canonical row name.
      2. AA record name minus its trailing '(variant)' marker == canonical
         name, AND every variant record in that family agrees on the
         in/out price. Disagreeing families are skipped — never guessed.
    The OpenRouter record stays in pricing_usd_per_1m for provenance; the
    frontend prefers pricing_aa_usd_per_1m when it carries a numeric input
    price (price_source='artificialanalysis').

    Also persists aa_ttft_seconds (AA's median time-to-first-token) — raw
    data for the latency layer wired in stats-18, still unrendered.

    Returns (n_attached, n_moves): n_moves counts models where AA and the
    OpenRouter snapshot disagree on any priced field by >0.5% (catalog
    churn / router margin signal for the report).
    """
    if aa_pricing is None:
        aa_pricing = _AA_PRICING_LAST or _load_aa_pricing_cache()
    if not aa_pricing or not models_meta:
        return (0, 0)

    exact = {}
    families = defaultdict(list)
    for name, p in aa_pricing.items():
        if not isinstance(p, dict):
            continue
        exact[name] = p
        base = _aa_base_name(name)
        if base and base != name:
            families[base].append(p)

    def _resolve(name):
        p = exact.get(name)
        if isinstance(p, dict) and isinstance(p.get("input"), (int, float)):
            return p, "exact"
        cands = [c for c in families.get(name, [])
                 if isinstance(c.get("input"), (int, float)) and c["input"] >= 0]
        if not cands:
            return None, "miss"
        prices = {(round(c["input"], 4),
                   round(c["output"], 4) if isinstance(c.get("output"), (int, float)) else None)
                  for c in cands}
        if len(prices) != 1:
            return ("CONFLICT", sorted(prices)), "conflict"
        return cands[0], "family"

    n_attached = n_family = n_conflict = n_moves = 0
    for name, rec in models_meta.items():
        p, how = _resolve(name)
        if how == "conflict":
            n_conflict += 1
            print(f"    [AA pricing] {name}: variant family disagrees on price "
                  f"{p[1]} — skipped (OpenRouter snapshot kept)")
            continue
        if p is None:
            continue
        inp = p["input"]
        outp = p.get("output")
        cache = p.get("cache_read")
        aa_rec = {
            "input": round(inp, 4),
            "output": round(outp, 4) if isinstance(outp, (int, float)) and outp >= 0 else None,
            "cache_read": round(cache, 4) if isinstance(cache, (int, float)) and cache >= 0 else None,
        }
        rec["pricing_aa_usd_per_1m"] = aa_rec
        rec["price_source"] = "artificialanalysis"
        n_attached += 1
        if how == "family":
            n_family += 1
        ttft = p.get("ttft_seconds")
        if isinstance(ttft, (int, float)) and ttft > 0:
            rec["aa_ttft_seconds"] = round(ttft, 3)
        orp = rec.get("pricing_usd_per_1m") or {}
        if (aa_rec["output"] is not None
                and isinstance(orp.get("input"), (int, float))
                and isinstance(orp.get("output"), (int, float))
                and (abs(orp["input"] - aa_rec["input"]) > 0.005 * max(orp["input"], 1e-9)
                     or abs(orp["output"] - aa_rec["output"]) > 0.005 * max(orp["output"], 1e-9))):
            n_moves += 1
    print(f"  [AA pricing] attached to {n_attached}/{len(models_meta)} meta records "
          f"({n_family} via variant-family join, {n_conflict} conflicted families skipped; "
          f"{n_moves} differ from the OpenRouter snapshot)")
    return (n_attached, n_moves)


def scrape_benchlm():
    """
    BenchLM.ai leaderboard (virtual table, 25 rows loaded initially).

    2026-09 UI layout (verified live):
      thead: Model | Provider | License | Status | Reasoning | Context |
             Price in/out | Tok/s | Latency | Score | AG | CO | RE | MM |
             KN | ML | IF | MA | Elo
      Model cell is a <th scope="row"> (rank span + compare button with
      aria-label "Add {model} to compare" + org + status tag); the 18 <td>s
      follow. The overall Score column index is derived from thead at runtime
      (was hardcoded col 9 = AG after the UI redesign — that bug produced
      org-name rows like ['Tencent', 70.0]).

    Strategy: click the visible+enabled "Load 25 more" button until it
    disappears (400 rows as of 2026-09), then extract model names from the
    compare-button aria-label and scores from the dynamic Score column.
    Rows without a score (unranked "Tracked" models) are skipped.
    Requires 1920x1080 viewport for hydration.
    """
    url = "https://benchlm.ai/"
    print(f"  Opening {url}...")
    run_browser("close", timeout=5)
    time.sleep(0.5)
    run_browser("set", "viewport", "1920", "1080", timeout=10)
    run_browser("open", url, timeout=45)
    time.sleep(1)
    run_browser("wait", "--load", "load", timeout=30)
    time.sleep(10)  # BenchLM is slow to hydrate

    all_models = []

    # JS: derive the Score column index from thead, then map every row.
    # Model name: compare button aria-label ("Add X to compare" /
    # "Remove X from compare") — cleanest source; fallback to th text.
    js_extract = ("(function() {"
                  "  var table = document.querySelector('table');"
                  "  if (!table) return '[]';"
                  "  var heads = Array.from(table.querySelectorAll('thead th'))"
                  "    .map(function(th) { return th.textContent.trim(); });"
                  "  var scoreIdx = heads.indexOf('Score');"
                  "  if (scoreIdx < 0) scoreIdx = 8;"
                  "  return JSON.stringify(Array.from(table.querySelectorAll('tbody tr'))"
                  "    .map(function(tr) {"
                  "      var th = tr.querySelector('th');"
                  "      var tds = tr.querySelectorAll('td');"
                  "      var btn = th ? th.querySelector('button[aria-label]') : null;"
                  "      var model = '';"
                  "      if (btn) {"
                  "        var al = btn.getAttribute('aria-label') || '';"
                  "        var m = al.match(/^(?:Add|Remove) (.+?) (?:to|from) compare$/);"
                  "        model = m ? m[1] : '';"
                  "      }"
                  "      if (!model && th) {"
                  "        var t = th.textContent.trim().replace(/^\\d+/, '');"
                  "        model = t;"
                  "      }"
                  "      var statusTd = tds[2] ? tds[2].textContent.trim() : '';"
                  "      var score = tds[scoreIdx] ? tds[scoreIdx].textContent.trim() : '';"
                  "      return {model: model, score: score, status: statusTd};"
                  "    }));"
                  "})()")

    # JS: click the last VISIBLE+ENABLED "Load 25 more" button (there are
    # duplicates in the DOM — sticky footer + table footer).
    js_click_load = ("(function() {"
                     "  var btns = Array.from(document.querySelectorAll('button'))"
                     "    .filter(function(b) {"
                     "      return /load 25 more/i.test(b.textContent)"
                     "        && !b.disabled && b.offsetParent !== null;"
                     "    });"
                     "  if (btns.length > 0) { btns[btns.length - 1].click(); return true; }"
                     "  return false;"
                     "})()")

    # Click "Load 25 more" until the button is gone (row-count growth check
    # guards against a stuck/disabled-but-visible button).
    MAX_LOAD_CLICKS = 25
    prev_rows = -1
    for click_round in range(MAX_LOAD_CLICKS):
        result = run_browser("eval", js_click_load, timeout=15)
        if not (result and "true" in result.strip()):
            if click_round == 0:
                print("  Load-more button not found, using initial rows only")
            break
        time.sleep(3)  # wait for rows to load
        n_res = run_browser("eval", "document.querySelectorAll('table tbody tr').length",
                            timeout=10)
        try:
            n_rows = int(str(n_res).strip().strip('"'))
        except ValueError:
            n_rows = -1
        print(f"  Clicked 'Load 25 more' (round {click_round+1}) → {n_rows} rows")
        if n_rows >= 0 and n_rows == prev_rows:
            print("  Row count stopped growing; pagination done")
            break
        prev_rows = n_rows

    # Extract all rows from the fully-loaded table
    js = js_extract
    data = None
    for attempt in range(3):
        print(f"  Evaluating JS (attempt {attempt+1})...")
        raw = run_browser("eval", js, timeout=45)
        if raw:
            # Try double-parse: agent-browser wraps eval in quotes
            try:
                parsed = json.loads(raw.strip())
                if isinstance(parsed, str):
                    data = json.loads(parsed)
                else:
                    data = parsed
            except (json.JSONDecodeError, ValueError):
                # Fallback: try stripping quotes manually
                lines_out = raw.strip().split("\n")
                json_str = ""
                for ln in lines_out:
                    s = ln.strip()
                    if s.startswith('"') and s.endswith('"'):
                        s = s[1:-1]
                    if s.startswith("["):
                        json_str = s
                        break
                if not json_str:
                    for ln in reversed(lines_out):
                        s = ln.strip()
                        if s.startswith('"') and s.endswith('"'):
                            s = s[1:-1]
                        if s.startswith("["):
                            json_str = s
                            break
                try:
                    data = json.loads(json_str)
                    if isinstance(data, str):
                        data = json.loads(data)
                except (json.JSONDecodeError, ValueError):
                    data = None
            if data and len(data) > 0:
                break
            data = None
            print("    Empty or parse error, retrying...")
        else:
            print("    No output, retrying...")
        time.sleep(5)

    if data:
        status_counts = {}
        superseded_names = []
        skipped_no_score = 0
        for item in data:
            status = (item.get("status") or "").strip()
            if status:
                status_counts[status] = status_counts.get(status, 0) + 1
            name = clean_model_name(item.get("model", ""))
            score_str = (item.get("score") or "").strip()
            if not score_str:
                skipped_no_score += 1  # unranked "Tracked" rows have no score
                continue
            try:
                score = float(score_str.replace("~", ""))  # ~89 → 89
                if 0 < score <= 100 and name:
                    all_models.append((name, score))
                    if status == "Superseded":
                        superseded_names.append(name)
            except (ValueError, TypeError):
                pass
        print(f"    Got {len(data)} table rows → {len(all_models)} scored models "
              f"({skipped_no_score} skipped: no score)")
        print(f"    BenchLM status column: {status_counts}")
        if superseded_names:
            print(f"    BenchLM marks {len(superseded_names)} model(s) 'Superseded' "
                  f"(monitoring signal only — see _monitor_benchlm_status): "
                  f"{superseded_names[:10]}")
        # Persist the status column as a monitoring sidecar (2026-09 dry run:
        # BenchLM 'Superseded' is a per-row lifecycle tag, NOT a model-line
        # death — GPT-5.6 Sol is tagged Superseded while being a current
        # flagship. So: saved + diffed for alerts, NEVER auto-wired into
        # supersession). Previous sidecar rotates to .prev for demotion diff.
        prio = {"Current": 0, "Established": 1, "Superseded": 2, "Tracked": 3}
        status_by_name = {}
        for item in data:
            name = clean_model_name(item.get("model", ""))
            status = (item.get("status") or "").strip()
            if not name or not status:
                continue
            try:
                key = normalize_model_name(name)
            except Exception:
                key = name.lower()
            old = status_by_name.get(key)
            # Aggregate variants: the MOST-current status wins (a model line
            # with any Current row is not superseded — matches the dry run).
            if old is None or prio.get(status, 4) < prio.get(old, 4):
                status_by_name[key] = status
        _save_benchlm_status(status_counts, status_by_name)
    else:
        print("    [WARN] BenchLM extraction failed after retries")

    run_browser("close", timeout=5)
    return all_models


def _kebab_to_model_name(kebab):
    """
    Convert Arena.ai text leaderboard kebab-case name to standard model name.
    Wraps effort levels in parentheses so the normalizer strips them for matching.

    Examples:
      'claude-opus-4-6-high'  -> 'claude opus 4.6 (High)'
      'gpt-5.6-sol-xhigh'    -> 'gpt 5.6 sol (xHigh)'
      'kimi-k3-max'          -> 'kimi k3 max'  (max stripped by normalizer)
      'muse-spark-1.2 (xHigh)' -> 'muse spark 1.2  (xHigh)'  (already has parens)
    """
    ARENA_EFFORT_LEVELS = {'high', 'xhigh', 'medium', 'low', 'minimal', 'adaptive'}
    EFFORT_DISPLAY = {'xhigh': 'xHigh', 'medium': 'Medium', 'low': 'Low',
                       'minimal': 'Minimal', 'adaptive': 'Adaptive'}

    # Handle existing parenthesized suffixes: "muse-spark-1.2 (xHigh)"
    parens = ''
    base = kebab
    if '(' in kebab:
        idx = kebab.index('(')
        parens = ' ' + kebab[idx:]
        base = kebab[:idx].rstrip('-')

    parts = base.split('-')

    # If last part is a known effort level, wrap in parens
    if parts and parts[-1].lower() in ARENA_EFFORT_LEVELS:
        effort = parts[-1].lower()
        effort_disp = EFFORT_DISPLAY.get(effort, effort.title())
        parts = parts[:-1]
        parens = f' ({effort_disp})' + parens

    # Merge consecutive digit-only parts: ["4", "6"] -> "4.6"
    merged = []
    i = 0
    while i < len(parts):
        if (i + 1 < len(parts)
                and parts[i].isdigit()
                and parts[i + 1].isdigit()):
            merged.append(f'{parts[i]}.{parts[i + 1]}')
            i += 2
        else:
            merged.append(parts[i])
            i += 1

    return ' '.join(merged) + parens


def scrape_arena_text():
    """
    Arena.ai text leaderboard (Elo-based, ~953-1508 range).
    Uses JS eval via load_and_eval to extract model name (from <a> tag) and Elo score.
    394 models with broad coverage across all model families.
    """
    url = "https://arena.ai/leaderboard/text"

    # JS eval: extract model name from <a> link in col 2 and Elo score from col 3
    js = ("JSON.stringify(Array.from(document.querySelectorAll('table tbody tr'))"
           ".slice(0,500).map(tr => {"
           "  var c = tr.querySelectorAll('td');"
           "  var link = c[2] ? c[2].querySelector('a') : null;"
           "  var model = link ? link.textContent.trim() : '';"
           "  var scoreText = c[3] ? c[3].textContent.trim() : '';"
           "  var scoreMatch = scoreText.match(/^(\\d+)/);"
           "  return {model: model, score: scoreMatch ? parseInt(scoreMatch[1]) : 0};"
           "}).filter(r => r.model && r.model.length > 3 && r.score > 0))")

    data = load_and_eval(url, js, wait_ms=12000)

    if not data or not isinstance(data, list):
        print(f"    [WARN] No data from Arena.ai text JS eval")
        return []

    models = []
    for item in data:
        if not isinstance(item, dict):
            continue
        kebab = item.get("model", "")
        elo = item.get("score", 0)
        if not kebab or elo < 900:
            continue
        name = _kebab_to_model_name(kebab)
        if name and len(name) > 3:
            models.append((name, float(elo)))

    print(f"    Got {len(models)} models (Elo {min(m[1] for m in models):.0f}-{max(m[1] for m in models):.0f})")
    return models


def scrape_simplebench():
    """
    Scrape SimpleBench.com leaderboard via browser JS eval.
    Table has columns: Rank, Model, Score (AVG@5), Organization.
    Col 1 = model name, Col 2 = score percentage.
    """
    url = "https://simple-bench.com/"
    js = (
        "Array.from(document.querySelectorAll('#leaderboardTable tr')).slice(0,35).map(function(r){"
        "  var c=r.querySelectorAll('td');"
        "  if(c.length<3) return null;"
        "  return {model:c[1]?c[1].textContent.trim():'',"
        "          score:c[2]?c[2].textContent.trim():''};"
        "}).filter(Boolean)"
    )
    data = load_and_eval(url, js, wait_ms=10000)

    models = []
    skip = {'highest human score*', 'human baseline*'}
    if data and isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            name = item.get("model", "").strip()
            score_str = item.get("score", "").strip().replace('%', '')
            if name.lower() in skip:
                continue
            try:
                score = float(score_str)
                if 0 < score <= 100 and name:
                    models.append((name, score))
            except (ValueError, TypeError):
                pass
        print(f"    Got {len(models)} models")
    else:
        print(f"    [WARN] No data from SimpleBench JS eval, trying snapshot fallback...")
        snap = load_and_snapshot(url, 8000, depth=6)
        models = parse_simplebench(snap)
    return models


def parse_simplebench(snap):
    """Parse SimpleBench.com snapshot — cell table, col 1=model, col 2=score%."""
    models = parse_cell_table(snap, model_col=1, score_col=2, score_pct=True)
    # Filter out non-model rows (Human Baseline, etc.)
    skip = {'highest human score*', 'human baseline*'}
    models = [(n, s) for n, s in models if n.lower() not in skip]
    return models


def scrape_arcprize():
    """
    Scrape ARC-AGI-2 from arcprize.org leaderboard via browser JS eval.

    2026-09 layout change (verified live): columns shrank to
      AI System | ARC-AGI-1 | ARC-AGI-2 | ARC-AGI-3
    (Author/Date/System Type columns removed) and each score cell now reads
    '95.0%, $1.12/task' — the percentage must be split off before float().
    The ARC-AGI-2 column index is derived from thead at runtime (fallback 2).
    All effort variants (None/Low/Medium/High/XHigh/Max) are extracted; the
    normalization pipeline strips config-level parentheticals and keeps the
    highest score per model.
    """
    url = "https://arcprize.org/leaderboard"
    js = (
        "(function() {"
        "  var table = document.querySelector('table');"
        "  if (!table) return '[]';"
        "  var heads = Array.from(table.querySelectorAll('thead th'))"
        "    .map(function(th) { return th.textContent.trim(); });"
        "  var scoreIdx = heads.indexOf('ARC-AGI-2');"
        "  if (scoreIdx < 0) scoreIdx = 2;"
        "  var rows = Array.from(table.querySelectorAll('tbody tr'));"
        "  var results = [];"
        "  for (var i = 0; i < rows.length; i++) {"
        "    var c = rows[i].querySelectorAll('td');"
        "    if (c.length <= scoreIdx) continue;"
        "    var name = c[0] ? c[0].textContent.trim() : '';"
        "    var score = c[scoreIdx] ? c[scoreIdx].textContent.trim() : '';"
        "    if (!name || name.toUpperCase() === 'AI SYSTEM' || name.charAt(0) === '-') continue;"
        "    results.push({model: name, score: score});"
        "  }"
        "  return JSON.stringify(results);"
        "})()"
    )
    data = load_and_eval(url, js, wait_ms=8000)

    models = []
    if data and isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            name = item.get("model", "").strip()
            # '95.0%, $1.12/task' → '95.0' (percentage before the first %)
            score_str = item.get("score", "").strip().split('%')[0].strip()
            try:
                score = float(score_str)
                if 0 < score <= 100 and name:
                    models.append((name, score))
            except (ValueError, TypeError):
                pass
        print(f"    Got {len(models)} entries (all variants, ARC-AGI-2)")
    else:
        print(f"    [WARN] No data from ARC-AGI-2")
    return models


def parse_arcprize(snap):
    """Parse ARC-AGI-2 snapshot — 2026-09 layout: col 0=model, ARC-AGI-2 is
    the 3rd column (score cell '95.0%, $1.12/task' → percentage before %)."""
    models = parse_cell_table(snap, model_col=0, score_col=2, score_pct=True)
    models = [(n, s) for n, s in models if n.upper() != 'AI SYSTEM' and not n.startswith('-')]
    return models


def scrape_design_arena():
    """
    Scrape Design Arena leaderboard via browser JS eval (site Elo-based layout).
    The leaderboard no longer renders an HTML table; each row is a div pair
    (leaf Elo number div + sibling model-name div) under the 'Overall' section:
      1396 | Kimi K3
      1355 | GPT-5.6 Sol (XHigh)
    Raw Elo (~800-1400) is returned and rescaled to 0-100 by _benchmark_scale.
    """
    url = "https://www.designarena.ai/leaderboard"
    js = (
        "Array.from(document.querySelectorAll('*')).filter(function(e){"
        "  return e.children.length === 0 && /^\\d{3,4}$/.test((e.textContent||'').trim()) "
        "    && +e.textContent.trim() >= 700 && +e.textContent.trim() <= 2000; "
        "}).map(function(e){"
        "  var cont = e.parentElement ? e.parentElement.parentElement : null;"
        "  var nameEl = cont ? cont.children[1] : null;"
        "  var nm = nameEl ? ((nameEl.innerText || nameEl.textContent || '')) : '';"
        "  return {elo: e.textContent.trim(), model: nm.trim().replace(/\\s+/g,' ')};"
        "})"
    )
    data = load_and_eval(url, js, wait_ms=10000,
                         timeouts={'open': 90, 'wait': 75, 'eval': 60, 'close': 10})

    models = []
    seen = set()
    if data and isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            name = item.get("model", "").strip()
            try:
                elo = float(item.get("elo", "").strip())
            except (ValueError, TypeError):
                continue
            if 700 <= elo <= 2000 and name and name.lower() not in seen:
                seen.add(name.lower())
                models.append((name, elo))
        print(f"    Got {len(models)} models (Elo {min(m[1] for m in models):.0f}-"
              f"{max(m[1] for m in models):.0f})" if models else "    Got 0 models")

    if not models:
        print("    [WARN] No data from Design Arena")
    return models


def scrape_deepswe():
    """
    Scrape DeepSWE leaderboard via browser innerText extraction.
    DeepSWE shows frontier models ranked by PASS@1 on long-horizon SWE tasks.
    Score is 0-100% (PASS@1). Model names are in kebab-case (e.g., claude-fable-5).

    The page now has two leaderboard views: a v1.1 chart (scores embedded in
    graphics, not text) and a v1 table (MODEL / PASS@1 / AVG COST / OUT TOK / STEPS).
    We target the v1 table by finding the "MODEL" + "PASS@1" header pair in the
    body text. Each row has: model-name, truncated effort tag (e.g. "ax]" from
    "[HIGH]"), score (e.g. "74%±4%"), then cost/tokens/steps.
    """
    url = "https://deepswe.datacurve.ai/"
    # Find the v1 table by locating MODEL + PASS@1 header lines in body text.
    # The v1 table may be outside <section> tags, so we search the full body.
    js = (
        "(function() {"
        "  var body = document.body.innerText || '';"
        "  var lines = body.split(String.fromCharCode(10));"
        "  var start = -1;"
        "  for (var i = 0; i < lines.length; i++) {"
        "    if (lines[i].trim() === 'MODEL' && i+1 < lines.length && lines[i+1].trim() === 'PASS@1') {"
        "      start = i; break;"
        "    }"
        "  }"
        "  if (start < 0) return 'MODEL HEADER NOT FOUND';"
        "  return lines.slice(start, start + 200).join(String.fromCharCode(10));"
        "})()"
    )
    # Use extended timeouts for DeepSWE (SPA can be slow to render)
    text = load_and_eval_text(url, js, wait_ms=12000,
                               timeouts={'open': 120, 'wait': 90, 'eval': 90, 'close': 15})

    models = []
    seen_names = set()
    if text and 'MODEL HEADER NOT FOUND' not in text:
        # Parse lines after the column headers (MODEL, PASS@1, ...)
        # Each model block is: model-name, truncated effort tag, score%±err%, $cost, tokens, steps
        # The effort tag is a truncated bracket label, e.g. "ax]" from "[HIGH]",
        # "[xhigh]", "igh]" from "[HIGH]", "edium]" from "[MEDIUM]".
        lines = text.split('\n')
        in_table = False
        for line in lines:
            stripped = line.strip()
            if stripped == 'MODEL':
                in_table = True
                continue
            if not in_table:
                continue
            # Stop at footer/pagination text
            if 'All models run on' in stripped or stripped.startswith('0%') and '20%' in stripped:
                break
            # Match model name (kebab-case with at least one hyphen)
            model_match = re.match(r'^([a-zA-Z][\w.]+-[\w.-]+)$', stripped)
            if model_match:
                raw_name = model_match.group(1)
                if raw_name.startswith('mini-') or raw_name.startswith('deep-'):
                    continue
                if raw_name in seen_names:
                    continue
                seen_names.add(raw_name)
                # Convert kebab-case to Title Case: "claude-fable-5" → "Claude Fable 5"
                display_name = raw_name.replace('-', ' ').title()
                # Fix known all-caps acronyms that Title Case mangles
                for acronym in ('GPT', 'GLM'):
                    display_name = re.sub(
                        rf'\b{acronym[0]}{acronym[1:].lower()}\b', acronym, display_name
                    )
                # Store the name; score will be on a subsequent line
                models.append({'name': display_name, 'score': None})
                continue
            # Skip truncated effort-level artifacts (e.g. "ax]", "igh]", "edium]", "[xhigh]")
            if re.match(r'^(\[?\w*\]?|\w+\])$', stripped) and models and models[-1]['score'] is None:
                continue
            # Match score line like "70%±4%" or "70% ±4%"
            score_match = re.match(r'^(\d+)%\s*[±]\s*\d+%$', stripped)
            if score_match and models and models[-1]['score'] is None:
                score = float(score_match.group(1))
                if 0 < score <= 100:
                    models[-1]['score'] = score
        # Convert to tuples, drop entries without scores
        result = [(m['name'], m['score']) for m in models if m['score'] is not None]
        print(f"    Got {len(result)} models (via innerText)")
        return result

    # Fallback 1: use page_reader and parse text content
    print("    Browser eval failed, trying page_reader fallback...")
    result = _scrape_deepswe_fallback()
    if result:
        return result

    # Fallback 2: use web-reader skill for raw HTML
    print("    page_reader failed, trying web-reader fallback...")
    return _scrape_deepswe_webreader()


def _scrape_deepswe_fallback():
    """Fallback: parse DeepSWE from page_reader text content."""
    url = "https://deepswe.datacurve.ai/"
    tmp_file = "/tmp/deepswe_webreader.json"
    cmd = ["z-ai", "function", "-n", "page_reader", "-a", json.dumps({"url": url}), "-o", tmp_file]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        print("    page_reader timed out")
        return []

    with open(tmp_file) as f:
        html = json.load(f).get('data', {}).get('html', '')

    # Extract text and find model-score pairs
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text).strip()

    # Match patterns like "claude-fable-5 [high] Default 70%±4%" or "claude-fable-5 70%"
    pattern = re.compile(r'([\w][\w.-]+)\s+(?:\[[\w]+\]\s+\w+\s+)?(\d+)\s*%\s*[±]')
    seen = {}
    models = []
    for m in pattern.finditer(text):
        raw_name = m.group(1)
        score = int(m.group(2))
        if raw_name.startswith('mini-') or raw_name.startswith('deep-'):
            continue
        if raw_name in seen:
            continue
        seen[raw_name] = True
        display_name = raw_name.replace('-', ' ').title()
        # Fix known all-caps acronyms that Title Case mangles
        for acronym in ('GPT', 'GLM'):
            display_name = re.sub(
                rf'\b{acronym[0]}{acronym[1:].lower()}\b', acronym, display_name
            )
        if 0 < score <= 100:
            models.append((display_name, float(score)))

    print(f"    Got {len(models)} models (via page_reader fallback)")
    return models


def _scrape_deepswe_webreader():
    """Fallback 2: parse DeepSWE using z-ai web-reader for HTML table extraction."""
    url = "https://deepswe.datacurve.ai/"
    tmp_file = "/tmp/deepswe_webreader2.json"
    cmd = ["z-ai", "function", "-n", "web_reader", "-a", json.dumps({"url": url}), "-o", tmp_file]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print("    web_reader timed out")
        return []

    try:
        with open(tmp_file) as f:
            result = json.load(f)
        html = result.get('data', {}).get('html', '') or result.get('html', '')
        if not html:
            # Try content field
            html = result.get('data', {}).get('content', '') or result.get('content', '')
    except Exception as e:
        print(f"    web_reader read error: {e}")
        return []

    if not html:
        print("    web_reader returned empty content")
        return []

    # Extract text and find model-score pairs from HTML
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text).strip()

    # Match patterns like "claude-fable-5 [high] Default 70%±4%" or "claude-fable-5 70%"
    pattern = re.compile(r'([\w][\w.-]+)\s+(?:\[[\w]+\]\s+\w+\s+)?(\d+)\s*%\s*[±]')
    seen = {}
    models = []
    for m in pattern.finditer(text):
        raw_name = m.group(1)
        score = int(m.group(2))
        if raw_name.startswith('mini-') or raw_name.startswith('deep-'):
            continue
        if raw_name in seen:
            continue
        seen[raw_name] = True
        display_name = raw_name.replace('-', ' ').title()
        for acronym in ('GPT', 'GLM'):
            display_name = re.sub(
                rf'\b{acronym[0]}{acronym[1:].lower()}\b', acronym, display_name
            )
        if 0 < score <= 100:
            models.append((display_name, float(score)))

    print(f"    Got {len(models)} models (via web_reader fallback)")
    return models


def _scrape_vending_bench_webreader():
    """Fallback: parse VendingBench from web-reader raw HTML."""
    url = "https://andonlabs.com/evals/vending-bench-2"
    tmp_file = "/tmp/vending_webreader.json"
    cmd = ["z-ai", "function", "-n", "page_reader", "-a", json.dumps({"url": url}), "-o", tmp_file]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        print("    page_reader timed out")
        return []

    try:
        with open(tmp_file) as f:
            html = json.load(f).get('data', {}).get('html', '')
    except Exception as e:
        print(f"    page_reader read error: {e}")
        return []

    # Extract table rows from HTML
    # Match <tr> blocks with <td> cells containing model name and dollar score
    raw_models = []
    # Find all table rows
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL | re.IGNORECASE)
    for row in rows:
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL | re.IGNORECASE)
        if len(cells) >= 3:
            # cell[0] = rank, cell[1] = model name, cell[2] = score
            name = re.sub(r'<[^>]+>', '', cells[1]).strip()
            score_str = re.sub(r'<[^>]+>', '', cells[2]).strip()
            name = re.sub(r'\s+New$', '', name)
            # Strip trailing provider parenthetical ("Kimi K3 (Moonshot)")
            name = re.sub(r'\s*\([^)]*\)\s*$', '', name).strip()
            # Score may contain variance: "$11,181.87 ± $2,094" — extract first
            # dollar amount (may be negative for bankrupt runs: "$-31.18")
            dollar_match = re.search(r'\$\s*(-?[\d,]+(?:\.\d+)?)', score_str)
            if not dollar_match:
                continue
            dollar_str = dollar_match.group(1).replace(',', '')
            try:
                dollars = float(dollar_str)
                if name:
                    raw_models.append((name, dollars))
            except (ValueError, TypeError):
                pass

    if not raw_models:
        return []

    # Normalize to 0-100 by top dollars; clamp negatives to 0.0; dedupe
    max_dollars = max(s for _, s in raw_models)
    models = [(n, max(0.0, round((s / max_dollars) * 100.0, 1))) for n, s in raw_models]
    models = _dedupe_vending_models(models)
    print(f"    Got {len(models)} models (web-reader fallback, max=${max_dollars:,.2f})")
    return models


def _dedupe_vending_models(models):
    """
    Collapse provider/effort variants into one entry per model, keep-best.

    VendingBench lists separate rows per inference provider ("Kimi K3
    (Moonshot)" vs "Kimi K3 (Fireworks)" — parenthetical already stripped
    by the caller) and per effort level ("Claude Opus 4.8 - High" vs
    "- Max").  We report a single score per model — the best — matching
    how other sources behave and how build_unified_table merges.
    """
    best = {}
    for n, s in models:
        k = normalize_model_name(n)
        if k and (k not in best or s > best[k][0]):
            best[k] = (s, n)
    return sorted([(n, s) for s, n in best.values()], key=lambda x: -x[1])


def scrape_vending_bench():
    """
    Scrape VendingBench 2 leaderboard via an interactive browser session.

    VendingBench scores are dollar amounts (roughly $-40 to $11,000)
    representing simulated vending machine business profit over a year
    (avg of 5 runs).  Scores are normalized to 0-100 by dividing by the
    top model's dollar amount, so they integrate cleanly with other
    benchmarks; negative balances (bankrupt runs) clamp to 0.0.

    Site UI (as of 2026-09): filter pills [Frontier | Open | All] with
    Frontier active by default — which hides open-weight models like
    Kimi K3 — and a "Show 51 more" button at the table footer (10 rows
    shown initially, 61 total under "All").  We click "All" first, then
    exhaust "Show N more" before extracting.  NOTE: the page has other
    sections with a plain "Show more" button, so the regex requires a
    digit to avoid clicking the wrong control.

    Name handling: the site suffixes inference providers in parentheses
    ("Kimi K3 (Moonshot)") and effort levels after a hyphen ("Claude
    Fable 5 - High"); trailing parentheticals are stripped and variants
    merged keep-best.  "New" badges are removed.
    """
    url = "https://andonlabs.com/evals/vending-bench-2"
    print(f"  Opening {url}...")
    run_browser("close", timeout=10)
    time.sleep(0.5)
    run_browser("set", "viewport", "1920", "1080", timeout=10)
    run_browser("open", url, timeout=60)
    time.sleep(1)
    run_browser("wait", "--load", "load", timeout=45)
    time.sleep(8)  # Svelte hydration

    # Click the "All" filter pill so open-weight models are listed too.
    js_click_all = ("(function(){var bs=Array.from(document.querySelectorAll('button'))"
                    ".filter(function(x){return x.textContent.trim()==='All'"
                    "&& x.offsetParent!==null;});"
                    "if(bs.length){bs[0].click();return 'clicked';}return 'notfound';})()")
    res = run_browser("eval", js_click_all, timeout=15)
    print(f"  'All' filter: {(res or '').strip()}")
    time.sleep(2)

    # Click "Show N more" until the button disappears (row-growth guard
    # against a stuck button).  Digit required — plain "Show more" buttons
    # belong to other page sections.
    js_click_more = ("(function(){var bs=Array.from(document.querySelectorAll('button'))"
                     ".filter(function(b){return /show\\s+\\d+\\s+more/i.test(b.textContent)"
                     "&& b.offsetParent!==null && !b.disabled;});"
                     "if(bs.length){bs[bs.length-1].click();"
                     "return bs[bs.length-1].textContent.trim();}return 'gone';})()")
    MAX_SHOW_MORE_CLICKS = 10
    prev_rows = -1
    for click_round in range(MAX_SHOW_MORE_CLICKS):
        res = run_browser("eval", js_click_more, timeout=15)
        if not res or "gone" in res.strip():
            if click_round == 0:
                print("  'Show N more' not found — using initial rows only")
            break
        time.sleep(2.5)  # wait for rows to render
        n_res = run_browser("eval",
                            "document.querySelectorAll('table tbody tr').length",
                            timeout=10)
        try:
            n_rows = int(str(n_res).strip().strip('"'))
        except ValueError:
            n_rows = -1
        print(f"  Clicked '{(res or '').strip()}' (round {click_round+1}) → {n_rows} rows")
        if 0 <= n_rows == prev_rows:
            print("  Row count stopped growing; pagination done")
            break
        prev_rows = n_rows

    # Extract every row: rank | model | money balance (th,td — rank is a th)
    js_extract = ("(function(){var t=document.querySelector('table');if(!t)return '[]';"
                  "return JSON.stringify(Array.from(t.querySelectorAll('tbody tr'))"
                  ".map(function(tr){var c=tr.querySelectorAll('th,td');"
                  "return {model:c[1]?c[1].textContent.trim():'',"
                  "score:c[2]?c[2].textContent.trim():''};}));})()")
    data = None
    for attempt in range(3):
        raw = run_browser("eval", js_extract, timeout=30)
        if raw:
            try:
                parsed = json.loads(raw.strip())
                data = json.loads(parsed) if isinstance(parsed, str) else parsed
                if data:
                    break
            except (json.JSONDecodeError, ValueError):
                pass
        time.sleep(2)

    run_browser("close", timeout=10)

    raw_models = []
    if data and isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            name = item.get("model", "").strip()
            score_str = item.get("score", "").strip()
            # Remove "New" badge
            name = re.sub(r'\s+New$', '', name)
            # Strip trailing provider parenthetical: "Kimi K3 (Moonshot)" → "Kimi K3"
            name = re.sub(r'\s*\([^)]*\)\s*$', '', name).strip()
            if not name:
                continue
            # Parse the mean dollar amount — may be negative ("$-31.18")
            # and carries run variance ("$11,181.87 ± $2,094").
            dollar_match = re.search(r'\$\s*(-?[\d,]+(?:\.\d+)?)', score_str)
            if not dollar_match:
                continue
            try:
                dollars = float(dollar_match.group(1).replace(',', ''))
            except (ValueError, TypeError):
                continue
            raw_models.append((name, dollars))

    if not raw_models:
        print("    [WARN] No data from VendingBench browser eval, trying web-reader fallback...")
        return _scrape_vending_bench_webreader()

    # Normalize to 0-100 by the top dollar amount; bankrupt (negative)
    # runs clamp to 0.0 — "no profit" is the floor on this scale.
    max_dollars = max(s for _, s in raw_models)
    clamped = sorted({n for n, s in raw_models if s <= 0})
    models = [(n, max(0.0, round((s / max_dollars) * 100.0, 1))) for n, s in raw_models]
    models = _dedupe_vending_models(models)
    if clamped:
        print(f"    Negative balances clamped to 0.0: {clamped}")
    print(f"    Got {len(models)} models across Frontier+Open (normalized from $, "
          f"max=${max_dollars:,.2f})")
    return models


def scrape_swe_marathon():
    """
    Scrape SWE-Marathon leaderboard via browser JS eval.
    SWE-Marathon benchmarks long-horizon SWE tasks (20 multi-hour, binary pass/fail).
    Score is Resolution Rate % (PASS@1), 0-100.
    Each leaderboard entry is a div with model name text lines and a "XX.X%" score.
    """
    url = "https://swe-marathon.org/"
    js = (
        # Find all divs that contain a score pattern like "29.0%"
        "var all=Array.from(document.querySelectorAll('div'));"
        "var entries=[];"
        "for(var i=0;i<all.length;i++){"
        "  var text=all[i].innerText;"
        "  if(!text)continue;"
        # Must contain a standalone percentage score (not part of a paragraph)
        "  var lines=text.split('\\n');"
        "  var scoreLine='';"
        "  var modelLines=[];"
        "  for(var j=0;j<lines.length;j++){"
        "    var l=lines[j].trim();"
        "    if(l.match(/^\\d+\\.?\\d*%$/)&&parseFloat(l)>0&&parseFloat(l)<=100){"
        "      scoreLine=l;"
        "    }else if(l.length>0&&!l.match(/^[\\d\\s%]+$/)&&l!=='NEW'){"
        "      modelLines.push(l);"
        "    }"
        "  }"
        # Only keep entries that have both model text and a score, and are actual
        # leaderboard entries (contain known model keywords, not just any text)
        "  if(scoreLine&&modelLines.length>0){"
        "    var mName=modelLines.join(' ');"
        # Skip non-model entries (paragraphs, descriptions, stats like "12.8%")
        "    if(mName.toLowerCase().indexOf('trials with')>=0)continue;"
        "    if(mName.toLowerCase().indexOf('task resolution')>=0)continue;"
        "    if(mName.length>80)continue;"
        "    entries.push({name:mName,score:scoreLine});"
        "  }"
        "}"
        # Deduplicate by model name (keep first/highest occurrence)
        "var seen={};var deduped=[];"
        "for(var k=0;k<entries.length;k++){"
        "  var e=entries[k];"
        "  if(!seen[e.name]){seen[e.name]=true;deduped.push(e);}"
        "}"
        "JSON.stringify(deduped);"
    )
    raw = load_and_eval(url, js, wait_ms=10000)

    models = []
    if raw and isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("name", "").strip()
            score_str = item.get("score", "").replace('%', '')

            # Clean: remove "NEW", "/ Agent", "†"
            name = re.sub(r'\s*NEW\s*', ' ', name)
            name = re.sub(r'\s*/\s*\S+.*$', '', name).strip()
            name = re.sub(r'\s*†\s*', '', name).strip()

            try:
                score = float(score_str)
            except (ValueError, TypeError):
                continue

            if not name or not re.search(r'[a-zA-Z]', name):
                continue
            if re.search(r'(CHEATING|ATTEMPT|PASS RATE|AXIS|CHART)', name.upper()):
                continue
            if score < 0 or score > 100:
                continue
            models.append((name, score))

        print(f"    Got {len(models)} models (via JS eval)")
        return models

    print("    [WARN] No data from SWE-Marathon")
    return []


def scrape_frontierswe():
    """
    Scrape FrontierSWE leaderboard via browser JS eval (site V2 layout).
    FrontierSWE benchmarks SWE skill at frontier difficulty (34 tasks, 5 trials
    per task, 20-hour budget). Score used: Mean@5 score % (0-100) from the
    home-page leaderboard, which lists the top 10 models as Tailwind grid rows:
      rank | model (+harness sub-label) | score% (+±CI sub-label) | avg cost | time
    The legacy V1 table (/v1) uses a different task set and scale — not mixed in.
    """
    url = "https://frontierswe.com/"
    js = (
        "Array.from(document.querySelectorAll('div.grid'))"
        ".filter(function(d){return (d.className||'').indexOf('grid-cols-')>=0 "
        "&& d.textContent.indexOf('%')>=0;})"
        ".filter(function(d){return !Array.from(d.querySelectorAll('div.grid'))"
        ".some(function(x){return x!==d && (x.className||'').indexOf('grid-cols-')>=0 "
        "&& x.textContent.indexOf('%')>=0;});})"
        ".map(function(r){var c=r.children;"
        "function fl(el){return ((el&&el.innerText)||'').split('\\n')[0].trim();}"
        "return {model:fl(c[3]),score:fl(c[4]),cost:fl(c[6]),time:fl(c[7])};})"
    )
    data = load_and_eval(url, js, wait_ms=10000)

    models = []
    if data and isinstance(data, list):
        for item in data:
            if not isinstance(item, dict):
                continue
            name = item.get("model", "").strip()
            score_str = item.get("score", "").strip().replace('%', '')
            try:
                score = float(score_str)
                if 0 <= score <= 100 and name:
                    models.append((name, score))
            except (ValueError, TypeError):
                pass
        print(f"    Got {len(models)} models")
    else:
        print(f"    [WARN] No data from FrontierSWE")
    return models


def scrape_cybergem():
    """
    Scrape CyberGem (CyberGym) leaderboard — cybersecurity vulnerability analysis.
    Data source: static JSON at /assets/data/cybergem.json fetched via page_reader.
    Score field: score_10 (0-1 range, multiply by 100 for percentage).

    Dedup strategy: when the same model appears under multiple agents, prefer
    the **vendor's own agent** (Anthropic Agent for Claude, OpenAI Agent for GPT, etc.)
    since those are official submissions. Fall back to best single-trial score.

    Entries skipped:
    - Multi-model systems (e.g. MDASH uses GPT-5.4 + Claude Opus 4.6)
    - Knowledge-base-augmented agents (e.g. Crystalline with pre-seeded KB)
    - Cybersecurity-specific fine-tunes (e.g. GPT-5.5-Cyber)
    - 30-trial runs (not comparable to 1-trial results)
    """
    url = "https://www.cybergym.io/cybergym/"
    tmp_file = "/tmp/cybergem_data.json"

    # Fetch the main leaderboard page (reliable via page_reader)
    cmd = ["z-ai", "function", "-n", "page_reader", "-a", json.dumps({"url": url}), "-o", tmp_file]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        print("    page_reader timed out")
        return []

    try:
        with open(tmp_file) as f:
            wrapper = json.load(f)
        html = wrapper.get('data', {}).get('html', '')
    except Exception as e:
        print(f"    page_reader read error: {e}")
        return []

    if not html:
        print("    page_reader returned empty content")
        return []

    # Try to extract JSON from a <script> tag containing level1 data
    # (the page may embed the data inline or load it via dataUrl)
    data = None

    # Strategy 1: find inline JSON data in script tags
    script_blocks = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
    for sb in script_blocks:
        if 'level1' in sb and 'score_10' in sb:
            # Found data embedded in script
            json_match = re.search(r'((?:\{[^{}]*\}[^{}]*)*"level1"\s*:\s*\[.*?\])', sb, re.DOTALL)
            if json_match:
                try:
                    data = json.loads('{' + json_match.group(1))
                    break
                except json.JSONDecodeError:
                    pass

    # Strategy 2: extract dataUrl and fetch the JSON via page_reader
    if data is None:
        data_url_match = re.search(r'dataUrl\s*:\s*"([^"]+)"', html)
        if data_url_match:
            rel_url = data_url_match.group(1)
            # Make absolute
            if rel_url.startswith('/'):
                abs_url = 'https://www.cybergym.io' + rel_url
            else:
                abs_url = rel_url

            json_tmp = "/tmp/cybergem_json.json"
            cmd2 = ["z-ai", "function", "-n", "page_reader", "-a", json.dumps({"url": abs_url}), "-o", json_tmp]
            try:
                subprocess.run(cmd2, capture_output=True, text=True, timeout=90)
                with open(json_tmp) as f:
                    wrapper2 = json.load(f)
                html2 = wrapper2.get('data', {}).get('html', '')
                if html2:
                    json_str = html2
                    pre_match = re.search(r'<pre[^>]*>(.*?)</pre>', html2, re.DOTALL)
                    if pre_match:
                        json_str = pre_match.group(1)
                    else:
                        json_str = re.sub(r'<[^>]+>', '', html2).strip()
                    if json_str.strip():
                        data = json.loads(json_str)
            except (subprocess.TimeoutExpired, Exception):
                pass

    # Strategy 3: parse the HTML table directly
    if data is None:
        data = {"level1": []}
        # Parse <tr> rows from the table body
        rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)
        for row in rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
            if len(cells) < 3:
                continue
            # Skip sub-rows (indented with arrow)
            if 'lb-subrow' in row:
                continue
            # Extract model name from lb-entry-name span
            name_match = re.search(r'lb-entry-name[^>]*>(.*?)</span>', cells[1], re.DOTALL)
            if not name_match:
                continue
            raw_name = re.sub(r'<[^>]+>', '', name_match.group(1)).strip()
            # Extract score from lb-score div
            score_match = re.search(r'lb-score[^>]*>([\d.]+)%', cells[2])
            if not score_match:
                continue
            score_val = float(score_match.group(1)) / 100.0
            # Determine focus (agent vs model)
            is_agent = 'lb-focus-agent' in row
            focus = 'agent' if is_agent else 'model'
            # Extract agent name from lb-entry-meta
            meta_match = re.search(r'lb-entry-meta[^>]*>(.*?)</span>', cells[1], re.DOTALL)
            agent_meta = re.sub(r'<[^>]+>', '', meta_match.group(1)).strip() if meta_match else ''
            # Determine agent name
            agent_name = ''
            if is_agent:
                agent_name = raw_name
            elif 'Anthropic Agent' in row or 'Anthropic' in cells[1]:
                agent_name = 'Anthropic Agent'
            elif 'OpenAI Agent' in row or 'OpenAI' in row:
                agent_name = 'OpenAI Agent'
            elif 'Meta Agent' in row:
                agent_name = 'Meta Agent'
            elif 'Claude Code' in row:
                agent_name = 'Claude Code'
            elif 'Gemini CLI' in row:
                agent_name = 'Gemini CLI'
            elif 'Kimi Agent' in row:
                agent_name = 'Kimi Agent'
            elif 'Codex CLI' in row:
                agent_name = 'Codex CLI'
            elif 'OpenHands' in row:
                agent_name = 'OpenHands'
            # For model-focused rows, the model name is in the first entry-name
            # For agent-focused rows, the model name is in the meta (uses X)
            if is_agent:
                model_name = agent_meta.replace('uses ', '').strip()
            else:
                model_name = raw_name

            if model_name and score_val > 0:
                data["level1"].append({
                    "model": model_name,
                    "score_10": score_val,
                    "agent": agent_name,
                    "focus": focus,
                    "trials": 1,
                })

    entries = data.get('level1', [])
    if not entries:
        print("    [WARN] No entries found in CyberGem data")
        return []

    # Model-to-vendor-agent mapping for priority selection
    VENDOR_AGENTS = {
        'claude': 'Anthropic Agent',
        'gpt-': 'OpenAI Agent',
        'gpt ': 'OpenAI Agent',
        'o3-': 'OpenAI Agent',
        'o4-': 'OpenAI Agent',
        'gemini': 'Gemini CLI',
        'glm-': 'Claude Code',
        'deepseek': 'Claude Code',
        'muse': 'Meta Agent',
        'minimax': 'MopMonk Agent',
        'kimi': 'Kimi Agent',
    }

    def _get_vendor_agent(model_name):
        mn = model_name.lower()
        for prefix, agent in VENDOR_AGENTS.items():
            if mn.startswith(prefix):
                return agent
        return None

    # Filter and dedup
    SKIP_PATTERNS = ['Multi-model', 'GPT-5.5-Cyber']
    model_best = {}

    for e in entries:
        model = e.get('model', '')
        trials = e.get('trials', 1)
        agent = e.get('agent', '')
        focus = e.get('focus', 'model')
        score = e.get('score_10', 0) * 100.0

        # Skip non-comparable entries
        if any(p in model for p in SKIP_PATTERNS):
            continue
        # Skip knowledge-base-augmented agents
        if 'pre-seeded' in agent.lower() or 'knowledge base' in agent.lower():
            continue
        # Skip 30-trial entries (not comparable to 1-trial)
        if trials != 1:
            continue
        # Skip agent-focused entries that wrap a model with custom scaffolding
        # (unless it's the vendor's own agent, which is the official submission)
        vendor = _get_vendor_agent(model)
        if focus == 'agent' and agent != vendor:
            continue

        # For same model, prefer vendor agent score, then best score
        if model not in model_best:
            model_best[model] = {'score': score, 'agent': agent}
        else:
            existing = model_best[model]
            existing_vendor = _get_vendor_agent(model)
            if existing['agent'] != existing_vendor and agent == existing_vendor:
                model_best[model] = {'score': score, 'agent': agent}
            elif (existing['agent'] == existing_vendor) == (agent == existing_vendor):
                if score > existing['score']:
                    model_best[model] = {'score': score, 'agent': agent}

    models = [(m, info['score']) for m, info in sorted(model_best.items(), key=lambda x: -x[1]['score'])]
    print(f"    Got {len(models)} models")
    return models


# ── EQBench Creative Writing v3 ────────────────────────────────────────────
# eqbench.com/creative_writing.html — LLM-judged creative writing leaderboard.
# Data lives as a CSV string embedded in creative_writing.js (plain HTTP fetch,
# no browser automation needed). Primary metric: elo_score (pairwise LLM-judge
# Elo); the alternative rubric score saturates at the top (entire top-15 within
# 16.4-17.1) so Elo is the headline metric — see scripts/analyze_eqbench*.py.
# Non-core benchmark: EXCLUDE_FROM_AVG in build_unified_table.
EQBENCH_CW_JS_URL = "https://eqbench.com/creative_writing.js"
# Anon/cloaked test models (OpenRouter anonymity-protocol entries: temporary,
# unverified identity). Excluded from ingestion. Note: grok-3-beta /
# grok-4.20-beta look similar but are real legacy models and stay.
EQB_ANON_MODELS = {
    "horizon-alpha", "horizon-beta", "pony-alpha", "optimus-alpha",
    "quasar-alpha", "cypher-alpha", "sherlock-dash-alpha",
    "hunter-alpha", "ox-alpha",
}
# Site name -> our display name (same model, different naming convention).
# 'Qwen/Qwen3.8-2.4T-A95B' is the HF repo name of the model we list as
# Qwen3.8-Max (2.4T total / 95B active MoE). User-approved alias.
EQB_NAME_ALIASES = {
    "qwen3.8-2.4t-a95b": "Qwen3.8-Max",
}
# Footnotes rendered as ★ next to the model name (models_meta.alias_note).
EQBENCH_ALIAS_NOTES = {
    "Qwen3.8-Max": "Listed by EQBench as Qwen/Qwen3.8-2.4T-A95B (same model — HF repo name)",
}


def scrape_eqbench_cw():
    """
    Scrape EQBench Creative Writing v3 leaderboard, return [(name, elo), ...].

    Name handling:
    - '*' prefix on the site is NOT a reliable open-weight marker (Gemini rows
      are starred, Kimi-K2-Instruct is not) → stripped; classification is done
      by classify_model() like every other source.
    - HF org prefixes stripped ('zai-org/GLM-5.2' → 'GLM-5.2').
    - Trailing date suffixes stripped ('gpt-5-2025-08-07' → 'gpt-5').
    - Anon/cloaked models skipped (EQB_ANON_MODELS).
    - Aliases applied (EQB_NAME_ALIASES); footnotes recorded via
      EQBENCH_ALIAS_NOTES in main().
    - Same-name rows after cleanup: keep best (highest Elo).
    """
    import urllib.request
    req = urllib.request.Request(
        EQBENCH_CW_JS_URL,
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            js = resp.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"    fetch failed: {e}")
        return []

    m = re.search(r"leaderboardDataCreativeWritingV3\s*=\s*`(.*?)`", js, re.S)
    if not m or not m.group(1).strip():
        print("    [WARN] CSV block not found in creative_writing.js")
        return []
    lines = [l for l in m.group(1).strip().splitlines() if l.strip()]
    header = [h.strip() for h in lines[0].split(",")]
    try:
        i_name = header.index("model_name")
        i_elo = header.index("elo_score")
    except ValueError:
        print(f"    [WARN] unexpected CSV header: {header}")
        return []

    best = {}
    n_anon = 0
    for line in lines[1:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(header):
            continue
        try:
            elo = float(parts[i_elo])
        except (ValueError, TypeError):
            continue
        raw = parts[i_name].lstrip("*").strip()
        base = raw.split("/")[-1].strip()
        bare = re.sub(r"-\d{8}$", "", base).lower()
        if bare in EQB_ANON_MODELS:
            n_anon += 1
            continue
        name = EQB_NAME_ALIASES.get(bare, re.sub(r"-\d{8}$", "", base))
        if name and (name not in best or elo > best[name]):
            best[name] = elo

    models = sorted(best.items(), key=lambda x: -x[1])
    print(f"    Got {len(models)} models (excluded {n_anon} anon/cloaked)")
    return models


# ── LLM Chess (maxim-saplin) ────────────────────────────────────────────────
# maxim-saplin.github.io/llm_chess — multi-game chess simulations: the LLM
# plays Black via a structured dialog (get board → legal moves → UCI move)
# against a Random Player and the Komodo Dragon engine, Elo-anchored by
# Dragon's rated levels (125 × level). 3 illegal moves = loss, so it measures
# planning + protocol adherence. Peer-reviewed (NeurIPS FoRLM 2025).
# Data lives as a CSV string embedded in data.js (plain HTTP fetch).
# Primary metric: elo (~-823..+1550; negative = below the Dragon anchor pool).
# Non-core benchmark: EXCLUDE_FROM_AVG in build_unified_table.
LLM_CHESS_DATA_URL = "https://maxim-saplin.github.io/llm_chess/data.js"

# Org prefixes used by the site (local quant uploads + bedrock-style names).
# ONLY these are stripped — a generic "word." rule would eat names like
# qwen3.8-27b (dot = version separator there, not org separator).
_CHESS_ORG_PREFIXES = r"(?:unsloth|zai|google|amazon|minimax|meta)"


def _chess_clean_name(raw):
    """
    Strip llm_chess naming conventions that do NOT change model identity.
    Order matters: thinking-config suffixes first, then dates, then effort
    levels. Returns the cleaned base name (or None for ablation rows).
    """
    n = raw.strip()
    n = n.split("/")[-1]                                   # unsloth/qwen3.8-27b
    n = re.sub(rf"^{_CHESS_ORG_PREFIXES}[._](?=[A-Za-z0-9])", "", n, flags=re.I)
    n = re.sub(r"@.*$", "", n)                             # @q4_k_m @bf16 @PGN
    n = re.sub(r"\|.*$", "", n)                            # |isol_temp06
    n = re.sub(r"_adaptive.*$", "", n)                     # _adaptive-thinking-high
    n = re.sub(r"_thinking.*$", "", n)                     # _thinking_16000
    n = re.sub(r"-\d{4}-\d{2}-\d{2}.*$", "", n)            # -2026-07-09(-xhigh)
    n = re.sub(r"-\d{8}.*$", "", n)                        # -20251101(_thinking...)
    n = re.sub(r"-\d{4}$", "", n)                          # checkpoint codes -0528/-0324
    n = re.sub(r"-preview-\d{2}-\d{2}$", "", n)            # Google date code -preview-05-06
    n = re.sub(r"-(?:xhigh|high|medium|low|minimal)$", "", n)  # reasoning effort
    n = re.sub(r"-v\d+:\d+$", "", n)                       # HF revision -v1:0 (colon form ONLY:
                                                           # plain -v\d+ would eat real versions
                                                           # like deepseek-v3 → "deepseek")
    n = re.sub(r"-(?:preview|latest|-?001)$", "", n)       # release stage / build batch
    n = n.strip("-_ ")
    if not n or n.startswith("non-"):                      # 'non-*' = pipeline ablations
        return None
    return n


# Same model, different naming convention (keys = post-cleanup lowercase name,
# values = our exact unified display names). CURATED, explicit — no fuzzy
# matching. Generated + reviewed via scripts/curate_chess_aliases.py.
# Note: hyphenated versions on the site (claude-opus-4-7) mean decimals
# (Claude Opus 4.7) — normalize_model_name turns them into "4 7", so the
# decimal-named rows of ours need explicit aliases.
CHESS_NAME_ALIASES = {
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-opus-4-6": "Claude Opus 4.6",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-opus-4-1": "Claude 4.1 Opus",   # word order differs on our side
    "grok-3-mini-beta": "grok 3 mini",
    "grok-4-fast-non-reasoning": "grok 4 fast chat",  # chat mode = non-reasoning variant
    "llama-4-maverick-17b-128e-instruct": "Llama 4 Maverick",
    "llama4-scout-17b-instruct": "Llama 4 Scout",
    "llama-3.3-70b": "llama 3.3 70b instruct",
}

# Footnotes rendered as ★ next to the model name (models_meta.alias_note).
CHESS_ALIAS_NOTES = {
    "grok 4 fast chat": "LLM Chess lists this model as grok-4-fast-non-reasoning (its non-reasoning/chat variant)",
    "Llama 4 Maverick": "LLM Chess lists this model under its HF name llama-4-maverick-17b-128e-instruct",
    "Llama 4 Scout": "LLM Chess lists this model under its HF name llama4-scout-17b-instruct-v1:0",
}

# Deliberately NOT ingested (collision traps found during curation — see
# scripts/curate_chess_aliases.py):
#   - Parameter-size traps: normalize_model_name strips param sizes, so these
#     local-quant entries would land on a DIFFERENT model's row:
#     qwen3.8-27b(+unsloth) → "qwen 3.8" == Qwen3.8-Max (2.4T API model!) key;
#     gpt-oss-20b → "gpt oss" == gpt-oss-120b key; gemma-3-12b/27b-it →
#     "gemma 3 it" == gemma 3 4b it key (queued today, excluded proactively).
#   - Standard-tier gpt-5/5.1/5.2/5.4/5.5 (+ -chat variants): we track only
#     their Pro/Codex/mini/nano variants. build_unified_table's truncated-
#     family merge folds the bare keys into those rows (verified live:
#     gpt-5.5 landed on GPT-5.5 Pro as 99.3) — that would fabricate Pro-tier
#     data from standard-tier games. Excluded.
#   - qwen-max / qwen-plus: versionless keys that could merge into the first
#     "qwen <version>" row (Qwen3.8-Max). Excluded defensively.
# NOT excluded (verified no collision): glm-4.7-flash, deepseek V3.2
# non-reasoning, grok-4-1-fast-*, grok-4-20-* etc. normalize to keys we don't
# track → chess-only entries, visible on the explorer page only.
CHESS_EXCLUDE_MODELS = {
    "qwen3.8-27b", "gpt-oss-20b", "gemma-3-12b-it", "gemma-3-27b-it",
    "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.5",
    "gpt-5-chat", "gpt-5.1-chat", "gpt-5.2-chat",
    "qwen-max", "qwen-plus",
}


def scrape_llmchess():
    """
    Scrape the LLM Chess leaderboard, return [(name, elo), ...].

    Name handling:
    - quant/org/date/effort suffixes stripped via _chess_clean_name().
    - CURATED aliases only (CHESS_NAME_ALIASES); no fuzzy matching.
    - ablation rows ('non-*') and known-collision local quants skipped.
    - rows without an Elo (queued models on the site) skipped.
    - same-name rows after cleanup: keep best (highest Elo).
    """
    import urllib.request
    req = urllib.request.Request(
        LLM_CHESS_DATA_URL,
        headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            js = resp.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"    fetch failed: {e}")
        return []

    m = re.search(r"const data\s*=\s*`(.*?)`", js, re.S)
    if not m or not m.group(1).strip():
        print("    [WARN] CSV block not found in llm_chess data.js")
        return []
    lines = [l for l in m.group(1).strip().splitlines() if l.strip()]
    header = [h.strip() for h in lines[0].split(",")]
    try:
        i_name = header.index("Player")
        i_elo = header.index("elo")
    except ValueError:
        print(f"    [WARN] unexpected CSV header: {header}")
        return []

    best = {}
    n_queued = 0
    n_excluded = 0
    for line in lines[1:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(header):
            continue
        try:
            elo = float(parts[i_elo])
        except (TypeError, ValueError):
            n_queued += 1  # queued models: being tested, no rating yet
            continue
        base = _chess_clean_name(parts[i_name])
        if base is None or base.lower() in CHESS_EXCLUDE_MODELS:
            n_excluded += 1
            continue
        name = CHESS_NAME_ALIASES.get(base.lower(), base)
        if name and (name not in best or elo > best[name]):
            best[name] = elo

    models = sorted(best.items(), key=lambda x: -x[1])
    print(f"    Got {len(models)} models "
          f"(skipped {n_queued} queued/no-elo, {n_excluded} excluded/ablation)")
    return models


# ── Model Name Cleaning ───────────────────────────────────────────────────
# Org names that get appended to model names by some benchmark sites.
# Two lists: with-separator (e.g., "ModelName Anthropic") and without-separator
# (e.g., "GLM-5.2Z.AI", "Kimi K2.6Moonshot").
ORG_SUFFIXES = [
    r'Anthropic$', r'OpenAI$', r'Google$', r'xAI$', r'xai$',
    r'DeepSeek$', r'Z\.?AI$', r'z\.?ai$', r'MiniMax$', r'Minimax$',
    r'Nvidia$', r'nvidia$', r'Alibaba$', r'Meta$',
    r'Self-host$',  # BenchLM appends this to open-weight models
    r'\bModel$',  # CyberGem appends this to model-focused entries
    r'Moonshot\s*AI$',  # Two-word org names
    r'Moonshot$',  # Without AI suffix
    r'Xiaomi$',
]

# Status tags BenchLM appends after org names (e.g., "AnthropicSupported", "OpenAIEstimated")
_STATUS_TAG = r'(?:Supported|Estimated|Self-host)'

# Org names concatenated WITHOUT a separator (e.g., "GLM-5.2Z.AI", "Kimi K2.6Moonshot")
# Order matters: longer/more-specific first to avoid partial matches.
ORG_CONCATENATED = [
    r'Moonshot\s*AI' + _STATUS_TAG + r'$',
    r'Moonshot' + _STATUS_TAG + r'$',
    r'Xiaomi' + _STATUS_TAG + r'$',
    r'MiniMax' + _STATUS_TAG + r'$',
    r'Minimax' + _STATUS_TAG + r'$',
    r'DeepSeek' + _STATUS_TAG + r'$',
    r'Z\.?AI' + _STATUS_TAG + r'$',
    r'z\.?ai' + _STATUS_TAG + r'$',
    r'Anthropic' + _STATUS_TAG + r'$',
    r'OpenAI' + _STATUS_TAG + r'$',
    r'Google' + _STATUS_TAG + r'$',
    r'xAI' + _STATUS_TAG + r'$',
    r'xai' + _STATUS_TAG + r'$',
    r'Alibaba' + _STATUS_TAG + r'$',
    r'Nvidia' + _STATUS_TAG + r'$',
    r'nvidia' + _STATUS_TAG + r'$',
    r'Meta' + _STATUS_TAG + r'$',
    # Fallback: plain org names without status tag
    r'Moonshot\s*AI$',
    r'Moonshot$',
    r'Xiaomi$',
    r'MiniMax$',
    r'Minimax$',
    r'DeepSeek$',
    r'Z\.?AI$',
    r'z\.?ai$',
    r'Anthropic$',
    r'OpenAI$',
    r'Google$',
    r'Alibaba$',
    r'Nvidia$',
    r'nvidia$',
    r'Meta$',
]

def clean_model_name(name):
    """
    Remove org-name artifacts appended by some benchmark parsers.
    Handles both space-separated and concatenated org names,
    including BenchLM's status tags (Supported/Estimated/Self-host).
    """
    cleaned = name
    # 0. Pre-strip trailing status tags that may appear without an org name
    #    (e.g., a model name accidentally ending with "Supported")
    cleaned = re.sub(r'(?:Supported|Estimated)\s*$', '', cleaned)
    # 1. Remove org names with a separator (space/punctuation before them)
    for pattern in ORG_SUFFIXES:
        cleaned = re.sub(pattern, '', cleaned, flags=re.IGNORECASE)
    # 2. Remove org names concatenated directly onto model name (no separator),
    #    including optional status tags (Supported/Estimated/Self-host)
    for pattern in ORG_CONCATENATED:
        cleaned = re.sub(pattern, '', cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


# ── Model Classification ──────────────────────────────────────────────────
# Explicit overrides: checked FIRST before any pattern matching.
# These handle exceptions where a model family is generally open/closed
# but a specific variant is the opposite.
CLOSED_OVERRIDES = [
    r'qwen\s*3[\.]?7\b',              # All Qwen3.7 variants are closed-source
    r'qwen\s*3[\.]?6\s*max',          # Qwen3.6 Max is also a closed API-only tier
]

OPEN_OVERRIDES = [
    # Add any known open-weight models that match closed patterns here
]

# Generic open-weight indicators
OPEN_INDICATORS = [
    'llama', 'mistral', 'mixtral', 'qwen', 'deepseek', 'gemma',
    'phi-', 'falcon', 'yi-', 'zephyr', 'command r', 'dbrx',
    'internlm', 'baichuan', 'vicuna', 'openchat', 'starling',
    'nous', 'wizardlm', 'olmo', 'solar', 'jamba',
    'minimax', 'kimi', 'mimo', 'nemotron', 'glm',
    'open-weight', 'open-source', 'open weight',
]

# Generic closed-source indicators (takes priority over open)
CLOSED_INDICATORS = [
    'gpt-', 'gpt4', 'gpt 4', 'claude', 'gemini', 'grok',
    'chatgpt', 'o1-', 'o3-', 'o4-',
]


def classify_model(name):
    """
    Classify a model as 'closed' or 'open-weight'.

    Priority order:
    1. Explicit override patterns (for known exceptions)
    2. Closed indicators (GPT, Claude, Gemini, Grok, etc.)
    3. Open indicators (Llama, Mistral, Qwen, DeepSeek, etc.)
    4. Default to closed (safer assumption)
    """
    raw = name.lower()
    # Clean org-name artifacts before classification
    cleaned = clean_model_name(name).lower()

    # 1. Check explicit overrides first
    for pattern in CLOSED_OVERRIDES:
        if re.search(pattern, cleaned):
            return 'closed'
    for pattern in OPEN_OVERRIDES:
        if re.search(pattern, cleaned):
            return 'open-weight'

    # 2. Check closed indicators (higher priority — no "but check open too" logic)
    for ci in CLOSED_INDICATORS:
        if ci in cleaned:
            return 'closed'

    # 3. Check open indicators
    for oi in OPEN_INDICATORS:
        if oi in cleaned:
            return 'open-weight'

    # 4. Default to closed
    return 'closed'


# ── Score Normalization ───────────────────────────────────────────────────
def _benchmark_scale(benchmark_name):
    """
    Return (raw_min, raw_max) for benchmarks that don't use 0-100 natively.
    Returns None for benchmarks already on 0-100 scale.

    Arena.ai Text: Elo-like scores (~953-1508 range, rescaled to 0-100).
    SWE-Marathon: resolve% (typically ~0-30 range, rescaled to 0-100).
    """
    if benchmark_name == "Arena.ai Text":
        return (900.0, 1550.0)  # Elo range, rescaled to 0-100
    if benchmark_name == "SWE-Marathon":
        return (0.0, 30.0)   # theoretical ceiling for resolve%
    if benchmark_name == "Artificial Analysis":
        return (0.0, 100.0)  # Intelligence Index ~1-63, rescaled to 0-100
    if benchmark_name == "Design Arena":
        return (800.0, 1400.0)  # Elo range (top ~1396, pool floor ~809), rescaled to 0-100
    if benchmark_name == "EQBench CW":
        return (200.0, 2116.1)  # Judge Elo (floor llama-3.2-1b 200, top claude-opus-5 2116); expands with data
    if benchmark_name == "LLM Chess":
        return (-850.0, 1550.0)  # game Elo vs Random/Dragon anchors (floor deepseek-v3 -823, top gpt-5.6-sol-xhigh 1549.7); expands with data
    return None


def _rescale_score(raw_score, benchmark_name, all_scores_for_bench=None):
    """
    Rescale a score to 0-100 if the benchmark uses a non-standard range.
    Uses theoretical min/max from _benchmark_scale() if available.
    Falls back to min-max of actual scraped data if all_scores_for_bench provided.
    """
    scale = _benchmark_scale(benchmark_name)
    if scale is None:
        return raw_score  # already 0-100

    lo, hi = scale
    # If we have actual data and it exceeds theoretical range, expand
    if all_scores_for_bench:
        actual_lo = min(all_scores_for_bench)
        actual_hi = max(all_scores_for_bench)
        lo = min(lo, actual_lo)
        hi = max(hi, actual_hi)

    if hi == lo:
        return raw_score  # avoid division by zero
    return (raw_score - lo) / (hi - lo) * 100.0


def normalize_score(score, benchmark_name):
    """
    Normalize scores to 0-100 scale.
    Most benchmarks already use 0-100, but some may use different scales.
    NOTE: For benchmarks needing min-max scaling, use _rescale_score()
    with all_scores_for_bench instead — this function is a simple passthrough.
    """
    scale = _benchmark_scale(benchmark_name)
    if scale is None:
        return min(score, 100.0)
    # Can't do min-max without all scores — caller should use _rescale_score
    return score


# ── Model Metadata (OpenRouter) ────────────────────────────────────────────
# Enriches unified models with catalog metadata from OpenRouter's public API:
#   https://openrouter.ai/api/v1/models
# Extracted per model: provider, context/output limits, modalities, parameter
# counts (total + MoE active), pricing (USD / 1M tokens), tokenizer, knowledge
# cutoff, reasoning configuration, supported parameters, HF id, description.
# Future sources (NVIDIA, OpenCode, provider price sheets) can extend the same
# models_meta structure without schema changes.

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OR_CACHE_PATH = os.path.join(TMP_DIR, "openrouter_models.json")
OR_CACHE_TTL = 3600  # seconds — catalog changes are infrequent

HF_API_URL = "https://huggingface.co/api/models/{hf_id}?expand[]=safetensors"
HF_CACHE_PATH = os.path.join(TMP_DIR, "hf_param_counts.json")
HF_CACHE_TTL = 24 * 3600  # seconds — checkpoint totals are stable

# Tokens that may appear in benchmark model names but do not distinguish a
# different OpenRouter catalog entry (effort labels, release-stage noise, dates)
_OR_NOISE_TOKENS = {
    "thinking", "reasoning", "reason", "chat", "beta", "exp",
    "experimental", "preview", "stable", "latest", "with", "fallback",
    # distribution/edition words: a benchmark site may append them to a plain
    # catalog name ("gpt 5.5 instant" = OpenAI: GPT-5.5 served instantly);
    # they never distinguish a different catalog entry
    "instant", "fast", "multimodal",
}
_OR_DATE_TOKENS = [
    re.compile(r"\d{6,}"),                  # "0528", "2512", "20250528"
    re.compile(r"\d{2}[.,]\d{4}"),          # "03.2025", "08,2024"
    re.compile(r"(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])"),  # MMDD "0528"
    re.compile(r"20(?:2[3-9]|3\d)"),        # years 2023-203x
]


def _is_or_noise_token(tok):
    """True when a token is release-stage noise rather than a model variant."""
    if tok in _OR_NOISE_TOKENS:
        return True
    return any(p.fullmatch(tok) for p in _OR_DATE_TOKENS)


# ── Curated meta aliases (unified row name -> exact OpenRouter catalog id) ──
# The name matcher cannot bridge legitimate renames: curated display names in
# a different word order ("Claude 4.1 Opus" vs catalog "Claude Opus 4.1"),
# catalog listings replaced by their dated revision ("qwen3.8-max" became
# "qwen3.8-max-0902"), or HF-style spellings ("gemma 3 4b it"). Every entry
# here is hand-verified against the live catalog — exact ids ONLY, no fuzzy
# matching. A wrong alias would be worse than an honest dash, so anything
# ambiguous (versionless traps, free-only listings, models absent from the
# catalog) is deliberately NOT mapped. Re-verify this table on each use —
# ids can vanish from the catalog, in which case the row falls back to a dash.
#
# VARIANT DISCIPLINE (2026-09-06): a dated revision is a DISTINCT model, not a
# rename — "qwen/qwen3.8-max-0902" is an improved snapshot released 09/02/2026,
# different from the older "qwen/qwen3.8-max" (now delisted; the catalog only
# carries the 0902 listing, whose own description reads "updated snapshot of
# Qwen3.8 Max"). The pin below follows the only surviving listing for the
# endpoint benchmarks score; never merge a dated revision back into its base
# name, and never point one variant's metadata at another variant's repo.
META_NAME_ALIASES = {
    "Claude 4.1 Opus": "anthropic/claude-opus-4.1",   # word-order variant of the curated display name
    "Qwen3.8-Max": "qwen/qwen3.8-max-0902",           # base listing delisted; 0902 snapshot is what benchmarks score
    "gemma 3 4b it": "google/gemma-3-4b-it",          # HF-style spelling; exact catalog id
}

# ── Curated HuggingFace id overrides (unified row name -> HF repo id) ──
# The catalog's own hugging_face_id field is the primary source; these fill
# open-weight rows where the catalog leaves it empty OR the model is absent
# from the catalog entirely (rows that never matched OpenRouter get NO meta
# record at all — apply_hf_overrides creates a minimal record for them).
#
# Same discipline as the aliases: exact ids ONLY, each verified live before
# being pinned. Verification ladder (2026-09-07 sweep, probe scripts under
# /home/z/my-project/scripts/probe_hf_open_models*.py):
#   1. direct GET https://huggingface.co/api/models/<id>  -> HTTP 200 required;
#   2. https://huggingface.co/models-json?search=<term>   -> the listing
#      confirms the id exists under the OFFICIAL org (exact-name confirmation,
#      never close-match picking). A 401 repo that DOES appear in the anonymous
#      search listing is a gated-but-real repo (page visitable); a 401 that is
#      absent from the listing is nonexistent-or-private -> no link.
# Prefix-display pins (same shape as Mistral Large 3 below): the leaderboard
# shows the shortened family name; the official org carries exactly one repo
# bearing the version token —
#   K-EXAONE 2.0 -> LGAI-EXAONE/K-EXAONE-2.0-750B-A37B (only "2.0" repo in the
#     official org; 236B variant carries no version token);
#   Nemotron 3 Nano Omni 30B A3B -> nvidia/...-Reasoning-BF16 (the bare family
#     id returns 401/absent; the official uploads are the Reasoning quant
#     triplet — same weights, BF16 is the full-precision canonical; quant
#     variants are NOT different model identities).
# Verified-ABSENT stays honestly linkless (401 + not in search): MiMo-V2-Omni,
# ERNIE 5.0 Thinking Preview (baidu org only hosts ERNIE-4.5), Command A+,
# Mercury 2 (inceptionai org empty), solar pro4 (upstage org has no pro4 repo),
# grok 4 fast chat, Qwen3.8-Max-0902 (Max line is API-only, no HF repo) and
# every closed family. Dated revisions must never link to their base model's
# repo (see variant note above).
OR_HF_ID_OVERRIDES = {
    "Granite 4.1 8B": "ibm-granite/granite-4.1-8b",
    "Mistral Large 3": "mistralai/Mistral-Large-3-675B-Instruct-2512",
    # 2026-09-07 sweep — open models absent from the OpenRouter catalog
    "MiMo-V2-Flash": "XiaomiMiMo/MiMo-V2-Flash",
    "MiniCPM5-1B": "openbmb/MiniCPM5-1B",
    "LFM2.5-2.6B": "LiquidAI/LFM2.5-2.6B",
    "LFM2.5-8B-A1B": "LiquidAI/LFM2.5-8B-A1B",
    "Olmo 3 7B Think": "allenai/Olmo-3-7B-Think",
    "Olmo 3.1 32B Instruct": "allenai/Olmo-3.1-32B-Instruct",
    "Olmo 3.1 32B Think": "allenai/Olmo-3.1-32B-Think",
    "INTELLECT-3": "PrimeIntellect/INTELLECT-3",
    "Ring-flash-2.0": "inclusionAI/Ring-flash-2.0",
    "Step3 VL 10B": "stepfun-ai/Step3-VL-10B",
    "Qwen3.8-Flash-Next": "Qwen/Qwen3.8-Flash-Next",
    # prefix-display pins (official org, unique version-bearing repo)
    "K-EXAONE 2.0": "LGAI-EXAONE/K-EXAONE-2.0-750B-A37B",
    "Nemotron 3 Nano Omni 30B A3B": "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-BF16",
}


def fetch_openrouter_models(force=False, retries=3):
    """Fetch (and cache) OpenRouter's public model catalog. Returns list of dicts."""
    if not force and os.path.exists(OR_CACHE_PATH):
        try:
            age = time.time() - os.path.getmtime(OR_CACHE_PATH)
            if age < OR_CACHE_TTL:
                with open(OR_CACHE_PATH) as f:
                    cached = json.load(f)
                # accept both bare list and full payload {"data": [...]}
                if isinstance(cached, dict):
                    cached = cached.get("data") or []
                return cached if isinstance(cached, list) else []
        except OSError:
            pass
    import urllib.request
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                OPENROUTER_MODELS_URL,
                headers={"Accept": "application/json",
                         "User-Agent": "benchmark-arena-scraper/1.3"},
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            models = payload.get("data") or []
            if not models:
                raise ValueError("empty catalog returned")
            with open(OR_CACHE_PATH, "w") as f:
                json.dump(models, f, ensure_ascii=False)
            print(f"  [OpenRouter] fetched {len(models)} models from catalog")
            return models
        except Exception as e:
            last_err = e
            print(f"  [OpenRouter] fetch attempt {attempt + 1}/{retries} failed: {e}")
            time.sleep(2 * (attempt + 1))
    print(f"  [OpenRouter] WARNING: catalog fetch failed ({last_err}) — metadata will be empty")
    return []


def _or_org_and_base(entry):
    """'Anthropic: Claude Fable 5.1' -> ('Anthropic', 'Claude Fable 5.1')."""
    name = (entry.get("name") or "").strip()
    m = re.match(r"^([A-Za-z0-9.\- ]+?):\s*(.+)$", name)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return None, name


def _match_key_candidates(entry):
    """Normalized keys under which an OpenRouter entry can be matched."""
    keys = []
    tail = (entry.get("id") or "").split("/")[-1]
    org, base = _or_org_and_base(entry)
    for cand in (base, tail, f"{org} {base}" if org else None):
        if not cand:
            continue
        norm = normalize_model_name(cand)
        if norm and norm not in keys:
            keys.append(norm)
    return keys


def match_models_to_openrouter(unified_names, or_models):
    """Map each unified model name to the best OpenRouter catalog entry.

    Strategy (in order):
      0. Curated alias: META_NAME_ALIASES pins a unified name to an exact
         catalog id (hand-verified renames/word-order variants — no fuzzy
         matching). An alias id missing from the catalog is ignored.
      1. Exact normalized match on display name, catalog id tail, or org+name.
      2. Token-subset fallback: every token of the catalog entry appears in
         our name, and our extra tokens are release-stage noise ("thinking",
         "beta", dates…). Most specific candidate wins.

    Returns {unified_name: (entry, method)}; unmatched names are absent.
    """
    by_key = defaultdict(list)  # normalized key -> [entries]
    by_id = {}
    for e in or_models:
        if e.get("id"):
            by_id[e["id"]] = e
        tail = (e.get("id") or "").split("/")[-1]
        if ":" in tail:  # skip :free/:thinking/:extended catalog variants
            continue
        for k in _match_key_candidates(e):
            by_key[k].append(e)

    def _prefer(entries):
        # shortest raw id tail first (plain model beats dated revision),
        # then newest release timestamp
        return sorted(
            entries,
            key=lambda x: (len((x.get("id") or "").split("/")[-1].split("-")),
                           -(x.get("created") or 0)),
        )[0]

    results = {}
    for name in unified_names:
        alias_id = META_NAME_ALIASES.get(name)
        if alias_id and alias_id in by_id:
            results[name] = (by_id[alias_id], "alias")
            continue
        n = normalize_model_name(name)
        if not n:
            continue
        if n in by_key:
            results[name] = (_prefer(by_key[n]), "exact")
            continue
        # subset fallback
        n_toks = set(n.split())
        best_key, best_entry = None, None
        for k, entries in by_key.items():
            k_toks = set(k.split())
            if not k_toks or not k_toks < n_toks:
                continue
            extras = n_toks - k_toks
            if not all(_is_or_noise_token(t) for t in extras):
                continue
            if best_key is None or len(k_toks) > len(set(best_key.split())):
                best_key, best_entry = k, _prefer(entries)
        if best_entry is not None:
            results[name] = (best_entry, "subset")
    return results


def _extract_param_counts(entry):
    """Parse (total_params_b, active_params_b) from name/id/description.

    Returns values in billions (1T = 1000B), None where unknown.
    Sources tried in order:
      1. MoE sentences in description ("49B active parameters out of 770B total")
      2. A-pattern in name/id ("Qwen3-VL-235B-A22B" -> 235B total, 22B active)
      3. Dense parameter mentions in description ("32.8B parameter model")
      4. Trailing size suffix in name ("Gemma 4 31B" -> 31B total)
    Guards against training-token / context-window numbers ("15T mixed").
    """
    total = active = None
    idname = " ".join(x for x in [entry.get("id") or "", entry.get("name") or ""] if x)
    desc = entry.get("description") or ""

    def _tb(num, unit):
        v = float(num)
        return v * 1000.0 if unit.upper() == "T" else v

    def _clean(text):
        """Strip code blocks/urls where param numbers are often misleading."""
        return re.sub(r"\[.*?\]\(.*?\)|`.*?`", " ", text)

    d, idn = _clean(desc), _clean(idname)

    def _token_guard(match_obj, text):
        """Reject captures followed by token/context words ("15T mixed")."""
        tail = text[match_obj.end():match_obj.end() + 24].lower()
        return not re.match(r"\s*(?:tokens?|context|window|mixed|vocab|corpus|dataset)", tail)

    # 1) MoE description sentences — active params
    for pat in (
        r"(\d+(?:\.\d+)?)\s*([TB])\s*B?\b(?:\s*\)?\s*)?(?:active|activated|activate[sd]?)\b",
        r"\bactivat\w*\s+(?:roughly\s+|approximately\s+|about\s+|~\s*)?(\d+(?:\.\d+)?)\s*([TB])\b",
        r"(\d+(?:\.\d+)?)\s*([TB])\b\s*B?\s*(?:parameters?|params?)\s+per\s+(?:forward\s+)?pass",
    ):
        for m in re.finditer(pat, d, re.IGNORECASE):
            if _token_guard(m, d):
                active = _tb(m.group(1), m.group(2))
                break
        if active is not None:
            break

    # 1b) MoE description sentences — total params
    for pat in (
        r"(\d+(?:\.\d+)?)\s*([TB])\s*B?\b\s*(?:\)?\s*)?(?:total\b|parameters?\s+total)",
        r"\btotal\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*([TB])\b",
        r"(\d+(?:\.\d+)?)\s*([TB])\s*B?\b\s*(?:parameters?|params?)\b",
        r"\bout\s+of\s+(\d+(?:\.\d+)?)\s*([TB])\b",
    ):
        for m in re.finditer(pat, d, re.IGNORECASE):
            if _token_guard(m, d):
                total = _tb(m.group(1), m.group(2))
                break
        if total is not None:
            break

    # 2) A-pattern in name/id: "235B-A22B" -> (235, 22)
    m = re.search(r"(?<![\dxX])(\d+(?:\.\d+)?)\s*B\b.{0,12}?\bA(\d+(?:\.\d+)?)\s*B\b", idn, re.IGNORECASE)
    if m:
        total = total if total is not None else _tb(m.group(1), "B")
        active = active if active is not None else _tb(m.group(2), "B")

    # 3) Dense parameter mention in description
    if total is None:
        for pat in (
            r"(\d+(?:\.\d+)?)\s*([TB])\s*B?\b\s*[- ]?\s*(?:parameters?|params?)\b",
            r"(\d+(?:\.\d+)?)\s*([TB])\s*B?\b\s*dense\b",
            r"\bdense\s+(\d+(?:\.\d+)?)\s*([TB])\b",
        ):
            for m in re.finditer(pat, d, re.IGNORECASE):
                if _token_guard(m, d):
                    total = _tb(m.group(1), m.group(2))
                    break
            if total is not None:
                break

    # 4) Trailing size suffix in display name ("Gemma 4 31B" -> 31)
    if total is None:
        org, base = _or_org_and_base(entry)
        if base:
            m = re.search(r"(?<![\dxX])(\d+(?:\.\d+)?)\s*([TB])\s*$", base.strip())
            if m:
                total = _tb(m.group(1), m.group(2))

    return total, active


def _or_pricing_per_1m(pricing):
    """OpenRouter price strings (USD per token) -> USD per 1M tokens."""
    out = {}
    for src, dst in (("prompt", "input"), ("completion", "output"),
                     ("input_cache_read", "cache_read")):
        if src not in pricing or pricing[src] is None:
            continue
        try:
            v = float(pricing[src])
        except (TypeError, ValueError):
            continue
        out[dst] = round(v * 1_000_000, 4)
    return out


def build_meta_record(entry, method, free_variants=None):
    """Build the models_meta record for a matched OpenRouter entry.

    free_variants: catalog ids of this model's `:free` listings (same base id
    with a `:free` suffix). Persisted for the future per-provider "free at
    which seller" feature — never rendered as pricing.
    """
    org, _base = _or_org_and_base(entry)
    arch = entry.get("architecture") or {}
    prov = entry.get("top_provider") or {}
    created = entry.get("created")
    total, active = _extract_param_counts(entry)
    reasoning = entry.get("reasoning") or None
    return {
        "or_id": entry.get("id"),
        "or_name": entry.get("name"),
        "provider": org,
        "created": time.strftime("%Y-%m-%d", time.gmtime(created)) if created else None,
        "context_length": prov.get("context_length") or entry.get("context_length"),
        "max_output_tokens": prov.get("max_completion_tokens"),
        "modality": arch.get("modality"),
        "input_modalities": arch.get("input_modalities") or [],
        "output_modalities": arch.get("output_modalities") or [],
        "tokenizer": arch.get("tokenizer"),
        "knowledge_cutoff": entry.get("knowledge_cutoff"),
        "total_params_b": total,
        "active_params_b": active,
        "params_source": "openrouter" if total is not None else None,
        "pricing_usd_per_1m": _or_pricing_per_1m(entry.get("pricing") or {}),
        "reasoning": {
            "mandatory": reasoning.get("mandatory") if reasoning else None,
            "supported_efforts": reasoning.get("supported_efforts") if reasoning else None,
            "default_effort": reasoning.get("default_effort") if reasoning else None,
        } if reasoning else None,
        "supported_parameters": entry.get("supported_parameters") or [],
        "hugging_face_id": entry.get("hugging_face_id") or None,
        "or_free_variants": list(free_variants) if free_variants else None,
        "description": (entry.get("description") or "").strip() or None,
        "superseded_by": None,  # filled by annotate_supersession()
        "match": method,  # 'exact' | 'subset' — match confidence
    }


def fetch_hf_param_counts(hf_ids):
    """Fetch total parameter counts from HuggingFace safetensors metadata.

    Fallback for open-weight models whose OpenRouter description does not
    state parameter counts. Returns {hf_id: total_params_billions}.
    """
    if not hf_ids:
        return {}
    # cache (24h TTL)
    cache = {}
    if os.path.exists(HF_CACHE_PATH):
        try:
            if time.time() - os.path.getmtime(HF_CACHE_PATH) < HF_CACHE_TTL:
                with open(HF_CACHE_PATH) as f:
                    cache = json.load(f)
        except (OSError, ValueError):
            cache = {}

    import urllib.request
    from urllib.error import HTTPError
    out = {}
    for hf_id in hf_ids:
        if hf_id in cache:
            if cache[hf_id] is not None:
                out[hf_id] = cache[hf_id]
            continue
        url = HF_API_URL.format(hf_id=urllib.request.quote(hf_id, safe="/"))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "benchmark-arena-scraper/1.3"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            sf = payload.get("safetensors") or {}
            total = sf.get("total")
            out[hf_id] = round(total / 1e9, 1) if total else None
        except HTTPError:
            out[hf_id] = None  # definitive API answer (404/401) — negative-cache dead repos
        except Exception:
            pass  # transient (timeout/5xx) — leave uncached so the next run retries
        time.sleep(0.15)  # be polite to the API

    merged = dict(cache)
    merged.update(out)
    try:
        with open(HF_CACHE_PATH, "w") as f:
            json.dump(merged, f, ensure_ascii=False)
    except OSError:
        pass
    return {k: v for k, v in out.items() if v is not None}


def collect_model_metadata(unified_rows, or_models=None):
    """Enrich unified table rows with OpenRouter catalog metadata.

    Returns {display_name: meta_record}. Rows without a confident catalog
    match are omitted — the frontend treats a missing key as 'no metadata'.
    """
    names = [r["name"] for r in unified_rows]
    if not names:
        return {}
    if or_models is None:
        or_models = fetch_openrouter_models()
    if not or_models:
        return {}
    matches = match_models_to_openrouter(names, or_models)
    # `:free` catalog variants ("<base>:free") — persist on the base model's
    # record for the future per-provider free-model feature (raw data only,
    # never rendered as pricing; free listings carry no benchmark weight).
    free_by_base = {}
    for e in or_models:
        eid = e.get("id") or ""
        if eid.endswith(":free"):
            free_by_base.setdefault(eid[:-5], []).append(eid)
    meta = {}
    n_alias = n_exact = n_subset = 0
    for name in names:
        hit = matches.get(name)
        if not hit:
            continue
        entry, method = hit
        rec = build_meta_record(entry, method,
                                free_variants=free_by_base.get(entry.get("id")))
        meta[name] = rec
        if method == "exact":
            n_exact += 1
        elif method == "alias":
            n_alias += 1
        else:
            n_subset += 1
    unmatched = [n for n in names if n not in meta]
    print(f"  [OpenRouter] metadata matched {len(meta)}/{len(names)} "
          f"(exact {n_exact}, alias {n_alias}, subset {n_subset}, unmatched {len(unmatched)})")
    for u in unmatched:
        print(f"    - no catalog match: {u}")

    # HuggingFace fallback: fill missing total params for open-weight models
    # with a HF repo (safetensors checkpoint totals are authoritative)
    need_hf = {m["hugging_face_id"]: name for name, m in meta.items()
               if m.get("hugging_face_id") and m.get("total_params_b") is None}
    if need_hf:
        hf_counts = fetch_hf_param_counts(sorted(need_hf))
        for hf_id, total_b in hf_counts.items():
            name = need_hf[hf_id]
            meta[name]["total_params_b"] = total_b
            meta[name]["params_source"] = "huggingface"
        if hf_counts:
            print(f"  [HuggingFace] filled total params for {len(hf_counts)} models")

    return meta


# ── Supersession (older model generations) ──────────────────────────────
# Models get versioned re-releases (gpt-5.4-pro → gpt-5.5-pro …). Instead of
# hand-marking models "deprecated", supersession is derived from data:
#   1. parse each matched model's OpenRouter or_id into (family, variant, version)
#   2. siblings in the same family+variant are ordered by `created` date
#      (version number only breaks ties / fills missing dates)
#   3. every model except the newest sibling gets meta["superseded_by"]
# Variant matters: Gemini 3.8 Flash must never supersede Gemini 3.1 Pro —
# Flash and Pro are separate product lines.

_SERIES_NOISE_SUFFIX = re.compile(
    r"-(latest|preview|free|reasoning|thinking|batch|high|exp.*)$")
_SERIES_CANON_DATE = re.compile(r"-\d{8}$")
_SERIES_DOTTED_VER = re.compile(r"(\d+(?:\.\d+)+)")
_SERIES_SINGLE_VER = re.compile(r"(?:^|-)(\d+)(?:-|$)")


def parse_series(or_id):
    """'openai/gpt-5.4-pro' -> ('gpt', 'pro', (5, 4)) — or None when unparseable."""
    if not or_id or "/" not in or_id:
        return None
    base = or_id.split("/", 1)[1].split(":", 1)[0]       # drop :free/:batch
    base = _SERIES_CANON_DATE.sub("", base)              # drop canonical -20260305
    base = _SERIES_NOISE_SUFFIX.sub("", base)
    m = _SERIES_DOTTED_VER.search(base) or _SERIES_SINGLE_VER.search(base)
    if not m:
        return None
    ver = tuple(int(x) for x in m.group(1).split("."))
    fam = base[:m.start()].strip("-") or base[m.end():].strip("-")
    var = base[m.end():].strip("-") if m.start() > 0 else ""
    return (fam, var, ver)


def annotate_supersession(models_meta):
    """Fill meta['superseded_by'] for older versions in the same product line.

    Ordering is by `created` date first (OpenRouter release timestamp), with
    the parsed version tuple as tiebreak. Models without a date sort last, so
    a dated sibling always wins 'newest'. Returns number of flagged models.
    """
    if not models_meta:
        return 0
    groups = defaultdict(list)
    for name, m in models_meta.items():
        s = parse_series(m.get("or_id"))
        if s:
            groups.setdefault((s[0], s[1]), []).append(
                (m.get("created") or "", s[2], name))
    n = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(reverse=True)          # date desc, then version desc
        newest = members[0][2]
        for _, _, name in members[1:]:
            models_meta[name]["superseded_by"] = newest
            n += 1
    return n


# ── Supersession overrides ─────────────────────────────────────────────────
# Same-product-line pairs the automatic pass cannot reach (undated model or
# unparseable or_id). Keys/values are display names as they appear in the
# unified tables; both sides must exist in the current snapshot. Variants
# stay exact: 'gemini 3 pro' -> 'Gemini 3.1 Pro' shares the 'pro' line and
# never touches the Flash line (Pro and Flash are different models — one
# must never hide the other).
SUPERSEDE_OVERRIDES = {
    "gemini 3 pro": "Gemini 3.1 Pro",
    # GPT-5.5 instant is the ChatGPT-instant edition of the GPT-5.5 line;
    # GPT-5.6 (Sol/Terra/Luna) is its successor generation. Target uses a
    # trailing '*' -> resolved to the newest-created GPT-5.6* in the snapshot.
    "gpt 5.5 instant": "GPT-5.6*",
    # grok-4-fast was delisted from OpenRouter (no match, no date); the
    # Grok 4 "fast chat" edition belongs to the Grok 4 line that Grok 4.6
    # succeeded.
    "grok 4 fast chat": "Grok 4.6",
    # 2026-09 data refresh (109-row snapshot): Qwen3.5 Plus re-entered the
    # unified table with no OpenRouter meta, so the date-based auto pass
    # can't order it; same-line successor Qwen3.7 Plus exists (leak detector
    # same-line rule 'qwen/plus' v(3,5) vs v(3,7)).
    "qwen3.5 plus": "Qwen3.7 Plus",
    # Kimi K2.6 is a BARE row while the newer family release Kimi K2.7 Code
    # (2026-06-12) exists in another variant — the (family, variant) auto
    # pass skips cross-variant pairs, but the leak detector's cross-generation
    # rule demands bare rows hide behind newer family releases. Convergent
    # signal: BenchLM also tags Kimi K2.6 'Superseded' (see benchlm_status
    # monitor disagreements).
    "kimi k2.6": "Kimi K2.7 Code",
    # 2026-09 EQBench snapshot (113-row): Granite 4.1 8B re-entered with no
    # OpenRouter meta, so the date-based auto pass can't order it; same-line
    # successor Granite 4.2 8B exists (leak detector same-line rule
    # 'granite/8b' v(4, 1) vs v(4, 2)).
    "granite 4.1 8b": "Granite 4.2 8B",
}

# Models released this many months before the newest release in the snapshot
# are flagged stale (old generation) even when no successor exists in the
# data (e.g. Llama 4, gpt-oss-120b). They are hidden behind the same
# "Older versions" toggle as superseded models.
STALE_AFTER_MONTHS = 9


def _months_before(iso_date, months):
    """'2026-09-02', 9 -> '2025-12-02' (day clamped to the target month)."""
    y, mth, d = (int(x) for x in iso_date[:10].split("-"))
    total = y * 12 + (mth - 1) - months
    y2, m2 = divmod(total, 12)
    m2 += 1
    # clamp day to length of target month
    if m2 == 12:
        last = 31
    else:
        last = (date(y2, m2 + 1, 1) - date(y2, m2, 1)).days
    return f"{y2:04d}-{m2:02d}-{min(d, last):02d}"


def _resolve_override_target(new, row_names, models_meta):
    """Resolve an override target to a concrete row name.

    A trailing '*' means 'newest release in that family': among row names
    starting with the prefix, pick the one with the newest `created` date,
    breaking ties alphabetically for determinism. A plain value resolves to
    itself (checked by the caller).
    """
    if not new.endswith("*"):
        return new
    prefix = new[:-1].lower()
    cands = [r for r in row_names if r.lower().startswith(prefix)]
    if not cands:
        return None
    return max(cands, key=lambda r: ((models_meta.get(r) or {}).get("created") or "", r))


def apply_supersede_overrides(models_meta, row_names):
    """Force superseded_by for known same-line pairs the auto pass misses.

    Override keys are matched CASE-INSENSITIVELY against the unified row
    names (2026-09 lesson: 'gemini 3 pro' was keyed lowercase, but a data
    refresh delivered the row as display-case 'Gemini 3 Pro' and the
    override silently no-op'd — caught by the leak detector). The flag is
    written under the ACTUAL display name so the frontend join resolves.
    The overridden (old) model may have no meta entry at all (never matched
    in OpenRouter) — a minimal entry is created so the frontend join by
    display name still resolves. Targets may end in '*' (family-prefix,
    resolved to the newest created sibling). Targets are resolved
    case-insensitively too. Returns number applied.
    """
    lower_map = {}
    for name in row_names:
        lower_map.setdefault(name.lower(), name)
    n = 0
    for old, spec in SUPERSEDE_OVERRIDES.items():
        actual = lower_map.get(old.lower())
        if not actual:
            continue
        new = _resolve_override_target(spec, row_names, models_meta)
        if not new or new not in row_names or new == actual:
            continue
        entry = models_meta.setdefault(actual, {})
        if not entry.get("superseded_by"):
            entry["superseded_by"] = new
            n += 1
    return n


def annotate_stale_by_age(models_meta, row_names):
    """Flag successor-less old generations: created ≥ STALE_AFTER_MONTHS old.

    Age is measured against the newest release date in the snapshot (not
    wall-clock) so re-running on an old snapshot stays deterministic. Only
    models present in the unified tables get flagged. Returns count.
    """
    dates = [m.get("created") for name, m in models_meta.items()
             if name in row_names and m.get("created")]
    if not dates:
        return 0
    cutoff = _months_before(max(dates), STALE_AFTER_MONTHS)
    n = 0
    for name, m in models_meta.items():
        if name not in row_names or m.get("superseded_by") or m.get("stale"):
            continue
        c = m.get("created")
        if c and c <= cutoff:
            m["stale"] = True
            n += 1
    return n


_VERSIONY_TOKEN = re.compile(r"\d")


def annotate_legacy_bare_names(models_meta, row_names):
    """Flag undated, unversioned rows whose family has versioned siblings.

    A bare name like "Mistral" (no digit, no OpenRouter match, no date) next
    to versioned siblings ("Mistral Small 4", "Mistral Medium 3.5") is the
    vendor's original legacy row carried by old benchmark listings. Family =
    lowercase first token. Dated bare names (e.g. "Inkling", 2026-07) are a
    vendor's actual first release — never flagged. Returns count.
    """
    fams = defaultdict(list)
    for r in row_names:
        if r and r.strip():
            fams[r.strip().split()[0].lower()].append(r)
    n = 0
    for name in row_names:
        m = models_meta.get(name)
        if m and (m.get("created") or m.get("superseded_by") or m.get("stale")):
            continue
        base = name.strip()
        if _VERSIONY_TOKEN.search(base):
            continue
        siblings = [s for s in fams[base.split()[0].lower()]
                    if s != name and _VERSIONY_TOKEN.search(s)]
        if not siblings:
            continue
        entry = models_meta.setdefault(name, {})
        entry["stale"] = True
        n += 1
    return n


def apply_hf_overrides(models_meta, row_names):
    """Curated HuggingFace id overrides — runs AFTER supersession/staleness
    annotation so superseded rows without a catalog match (placeholder
    records) get their verified HF repo too (e.g. "Granite 4.1 8B").

    Rows that never matched the OpenRouter catalog have NO meta record at all
    (collect_model_metadata only creates records for catalog matches) — those
    get a minimal record created here so the row still carries its verified
    HF identity (e.g. "MiMo-V2-Flash", "Olmo 3.1 32B Think").

    Fills hugging_face_id on any record that lacks one, then tops up the
    safetensors parameter count for records that now carry an HF repo.
    Returns (n_ids_filled, n_params_filled).
    """
    filled = []
    for name, hf_id in OR_HF_ID_OVERRIDES.items():
        if name not in row_names:
            continue
        rec = models_meta.get(name)
        if rec is None:
            rec = models_meta.setdefault(name, {})
        if not rec.get("hugging_face_id"):
            rec["hugging_face_id"] = hf_id
            filled.append(hf_id)
    if not filled:
        return 0, 0
    n_params = 0
    need = {m.get("hugging_face_id"): name for name, m in models_meta.items()
            if m.get("hugging_face_id") in filled and m.get("total_params_b") is None}
    if need:
        counts = fetch_hf_param_counts(sorted(need))
        for hf_id, total_b in counts.items():
            if total_b is None:
                continue
            name = need[hf_id]
            models_meta[name]["total_params_b"] = total_b
            models_meta[name]["params_source"] = "huggingface"
            n_params += 1
    return len(filled), n_params


# ── Main Pipeline ──────────────────────────────────────────────────────────
# ── Providers catalog (pricing layer) ────────────────────────────────────
# providers.json powers the /providers page ("who sells which model, at what
# price"). Two keyless sources, fetched independently of the benchmark scrapes:
#   • LiteLLM model_prices_and_context_window.json — community catalog across
#     first-party labs, cloud platforms and serverless hosts (~2.5k chat rows)
#   • OpenRouter /api/v1/models — the aggregator view, already fetched (with
#     cache) for models_meta; reused here as its own provider section
# The main-table Price column does NOT come from here — it keeps using the
# exact-row OpenRouter match in models_meta.pricing_usd_per_1m (no new alias
# surface). This catalog is for the provider comparison page only.
# `--providers-only` refreshes it without touching benchmark data at all.

LITELLM_PRICES_URL = ("https://raw.githubusercontent.com/BerriAI/litellm/main/"
                      "model_prices_and_context_window.json")
LITELLM_CACHE_PATH = os.path.join(TMP_DIR, "litellm_prices.json")
LITELLM_CACHE_TTL = 6 * 3600  # seconds — prices move weekly, not by the minute

PROVIDERS_JSON_PATH = "/home/z/my-project/download/providers.json"
PROVIDERS_PUBLIC_PATH = "/home/z/my-project/benchmark_arena/public/providers.json"

# LiteLLM "<prefix>/" → (display name, kind). Shared display names merge into
# one provider group with per-key dedupe (qwencloud + qwen_ai_platform, …).
# kinds: first-party | cloud | serverless | aggregator
LITELLM_PROVIDERS = {
    # first-party labs (their own API)
    "openai": ("OpenAI", "first-party"),
    "anthropic": ("Anthropic", "first-party"),
    "gemini": ("Google AI Studio", "first-party"),
    "palm": ("Google AI Studio", "first-party"),
    "xai": ("xAI", "first-party"),
    "deepseek": ("DeepSeek", "first-party"),
    "mistral": ("Mistral", "first-party"),
    "codestral": ("Mistral", "first-party"),
    "moonshot": ("Moonshot AI", "first-party"),
    "zai": ("Z.ai", "first-party"),
    "minimax": ("MiniMax", "first-party"),
    "dashscope": ("Alibaba (DashScope)", "first-party"),
    "qwencloud": ("Alibaba (DashScope)", "first-party"),
    "qwen_ai_platform": ("Alibaba (DashScope)", "first-party"),
    "meta": ("Meta", "first-party"),
    "perplexity": ("Perplexity", "first-party"),
    "cognition": ("Cognition", "first-party"),
    "inception": ("Inception", "first-party"),
    "morph": ("Morph", "first-party"),
    "v0": ("Vercel v0", "first-party"),
    # cloud platforms (enterprise hosting of many labs' models)
    "azure": ("Azure OpenAI", "cloud"),
    "azure_ai": ("Azure AI Foundry", "cloud"),
    "bedrock": ("Amazon Bedrock", "cloud"),
    "bedrock_mantle": ("Amazon Bedrock", "cloud"),
    "amazon-nova": ("Amazon Bedrock", "cloud"),
    "vertex_ai": ("Google Vertex AI", "cloud"),
    "oci": ("Oracle OCI", "cloud"),
    "watsonx": ("IBM watsonx", "cloud"),
    "sagemaker": ("AWS SageMaker", "cloud"),
    "databricks": ("Databricks", "cloud"),
    "snowflake": ("Snowflake Cortex", "cloud"),
    "tencent": ("Tencent Cloud", "cloud"),
    # serverless / specialist GPU hosts
    "fireworks_ai": ("Fireworks AI", "serverless"),
    "together_ai": ("Together AI", "serverless"),
    "deepinfra": ("DeepInfra", "serverless"),
    "novita": ("Novita AI", "serverless"),
    "groq": ("Groq", "serverless"),
    "cerebras": ("Cerebras", "serverless"),
    "replicate": ("Replicate", "serverless"),
    "nebius": ("Nebius", "serverless"),
    "lambda_ai": ("Lambda", "serverless"),
    "sambanova": ("SambaNova", "serverless"),
    "hyperbolic": ("Hyperbolic", "serverless"),
    "cloudflare": ("Cloudflare Workers AI", "serverless"),
    "scaleway": ("Scaleway", "serverless"),
    "ovhcloud": ("OVHcloud", "serverless"),
    "nscale": ("Nscale", "serverless"),
    "anyscale": ("Anyscale", "serverless"),
    "baseten": ("Baseten", "serverless"),
    "gradient_ai": ("Gradient", "serverless"),
    "crusoe": ("Crusoe", "serverless"),
    "friendliai": ("FriendliAI", "serverless"),
    "gmi": ("GMI Cloud", "serverless"),
    "ollama": ("Ollama Cloud", "serverless"),
    "lemonade": ("Lemonade", "serverless"),
    "pinstripes": ("Pinstripes", "serverless"),
    "scx-ai": ("SCX AI", "serverless"),
    "darkbloom": ("Darkbloom", "serverless"),
    "tensormesh": ("Tensormesh", "serverless"),
    "publicai": ("PublicAI", "serverless"),
    "libertai": ("LibertAI", "serverless"),
    # aggregators / gateways
    "vercel_ai_gateway": ("Vercel AI Gateway", "aggregator"),
    "wandb": ("W&B Inference Gateway", "aggregator"),
    "llamagate": ("Llamagate", "aggregator"),
    "github_copilot": ("GitHub Copilot", "aggregator"),
}
# LiteLLM also carries openrouter/* rows — the aggregator section comes from
# the OpenRouter API itself, so the LiteLLM copy would only duplicate prices.
LITELLM_SKIP_PREFIXES = {"openrouter"}

# Bare (unprefixed) chat keys — infer the org. Dotted invocation names
# ("anthropic.claude-…", "amazon.nova-…", "zai.glm-…") are Bedrock/LiteLLM
# routing aliases whose content already exists under bedrock/, azure/ or the
# slash prefixes — skipping them keeps per-provider counts honest instead of
# doubling rows with near-duplicate variants.
_BARE_DOT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.[a-z]", re.IGNORECASE)
_BARE_ORG_RULES = [
    (re.compile(r"^(gpt-|o[134](-|\b)|chatgpt|codex|omni-|computer-use|deep-research)"),
     ("OpenAI", "first-party")),
    (re.compile(r"^claude"), ("Anthropic", "first-party")),
    (re.compile(r"^(gemini|gemma|imagen|veo)"), ("Google AI Studio", "first-party")),
    (re.compile(r"^(mistral|ministral|magistral|pixtral|voxtral|devstral|open-mistral|open-mixtral)"),
     ("Mistral", "first-party")),
    (re.compile(r"^(command|rerank-|embed-)"), ("Cohere", "first-party")),
    (re.compile(r"^deepseek"), ("DeepSeek", "first-party")),
    (re.compile(r"^grok"), ("xAI", "first-party")),
    (re.compile(r"^jamba"), ("AI21 Labs", "first-party")),
    (re.compile(r"^ernie"), ("Baidu", "first-party")),
    (re.compile(r"^(moonshot|kimi)"), ("Moonshot AI", "first-party")),
    (re.compile(r"^(glm|chatglm)"), ("Z.ai", "first-party")),
    (re.compile(r"^(qwen|qwq|qvq)"), ("Alibaba (DashScope)", "first-party")),
    (re.compile(r"^llama", re.IGNORECASE), ("Meta", "first-party")),
    (re.compile(r"^sonar"), ("Perplexity", "first-party")),
]

PROVIDER_KIND_ORDER = ["first-party", "cloud", "serverless", "aggregator"]


def _provider_slug(name):
    """Stable id for a provider group ("Alibaba (DashScope)" → alibaba-dashscope)."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def fetch_litellm_prices(force=False, retries=3):
    """Fetch (and cache) LiteLLM's aggregated model pricing catalog."""
    if not force and os.path.exists(LITELLM_CACHE_PATH):
        try:
            if time.time() - os.path.getmtime(LITELLM_CACHE_PATH) < LITELLM_CACHE_TTL:
                with open(LITELLM_CACHE_PATH) as f:
                    return json.load(f)
        except (OSError, ValueError):
            pass
    import urllib.request
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(LITELLM_PRICES_URL,
                                         headers={"User-Agent": "benchmark-arena-scraper/1.4"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            try:
                with open(LITELLM_CACHE_PATH, "w") as f:
                    json.dump(payload, f, ensure_ascii=False)
            except OSError:
                pass
            return payload
        except Exception as e:  # noqa: BLE001 — retry, then surface
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"LiteLLM price catalog fetch failed after {retries} tries: {last_err}")


def _litellm_provider_of(key):
    """Map a LiteLLM key to (provider_name, kind). None = skip the row."""
    if "/" in key:
        prefix = key.split("/", 1)[0]
        if prefix in LITELLM_SKIP_PREFIXES:
            return None
        hit = LITELLM_PROVIDERS.get(prefix)
        return hit
    if _BARE_DOT_RE.match(key):
        return None  # dotted invocation alias — content exists elsewhere
    for rx, org in _BARE_ORG_RULES:
        if rx.match(key):
            return org
    return None


def _per_1m(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f < 0:
        return None  # OpenRouter uses -1 for "unknown"
    return round(f * 1_000_000, 4)


def _litellm_model_row(key, entry):
    """One catalog row: {id, in, out, cache, ctx, free?, base?}. None when unusable."""
    inn = _per_1m(entry.get("input_cost_per_token"))
    if inn is None:
        return None
    out = _per_1m(entry.get("output_cost_per_token"))
    cache = _per_1m(entry.get("cache_read_input_token_cost"))
    ctx = entry.get("max_input_tokens") or entry.get("max_tokens")
    row = {
        "id": key,
        "in": inn,
        "out": out,
        **({"cache": cache} if cache is not None else {}),
        "ctx": int(ctx) if isinstance(ctx, (int, float)) and ctx > 0 else None,
    }
    # Zero-priced LiteLLM rows are free listings of their paid sibling
    # (e.g. together_ai/.../Llama-3.3-70B-Instruct-Turbo-Free). Persist the
    # flag + base id so the pivot matcher and the availability layer key off
    # them the same way as the '-free'/' :free' API rows (stats-14/18
    # discipline: free listings keep their id, they are never folded away).
    if inn == 0 and (out or 0) == 0:
        last = key.rsplit("/", 1)[-1]
        for suf in ("-free", "-Free", "_free", ":free"):
            if last.endswith(suf) and len(last) > len(suf):
                row["free"] = True
                row["base"] = key[: len(key) - len(suf)]
                break
    return row


def _openrouter_model_row(entry):
    pricing = entry.get("pricing") or {}
    inn = _per_1m(pricing.get("prompt"))
    if inn is None:
        return None
    out = _per_1m(pricing.get("completion"))
    cache = _per_1m(pricing.get("input_cache_read"))
    prov = entry.get("top_provider") or {}
    ctx = prov.get("context_length") or entry.get("context_length")
    row = {
        "id": entry.get("id"),
        "name": entry.get("name"),
        "in": inn,
        "out": out,
        **({"cache": cache} if cache is not None else {}),
        "ctx": int(ctx) if isinstance(ctx, (int, float)) and ctx > 0 else None,
    }
    if inn == 0 and (out or 0) == 0:
        row["free"] = True
    return row


# ── Open provider API catalogs (keyless /v1/models endpoints) ──────────────
# Added 2026-09-07 (stats-17) to widen the providers page beyond
# LiteLLM+OpenRouter. All three are open — no API key needed. Shapes vary:
#   NVIDIA NIM   — bare OpenAI list (id/owned_by only; no pricing/context)
#   OpenCode Zen — bare OpenAI list; carries several '-free' twin ids
#   OrcaRouter   — OpenRouter-style schema (pricing per-token AND *_per_million,
#                  context_length, top_provider) incl. '-free' twins
#
# FREE-LISTING DISCIPLINE: an id ending '-free' (or ':free') is a FREE LISTING
# of its base model — stored with free=True + base=<id minus suffix> so the
# future "free at which provider" feature can key off it. Free does NOT mean
# unlimited: none of these APIs expose rate-limit numbers, so the data never
# claims more than "free" and the UI tooltip carries the rate-limit caveat.
# Prices are parsed only where the API exposes them (OrcaRouter); NVIDIA /
# OpenCode rows keep null prices and render an honest dash. A bare trailing
# "/free" segment (orcarouter/free — their free auto-router) is marked free
# with no base id.
#
# FREE-TIER PROVIDERS (stats-18): NVIDIA NIM serves its whole /v1/models
# catalog free of charge, rate-limited (confirmed by Ibrahim 2026-09-07).
# Marked at the PROVIDER level (free_tier=True) — the API exposes no pricing
# so rows keep null prices; the UI shows the free chip + rate-limit caveat.
# LATENCY: none of the four catalogs exposes per-model latency/throughput
# numbers (probed 2026-09-07: bare id/owned_by for NIM+Zen; pricing+context
# only for Orca; OpenRouter /api/v1/models has none and its front stats
# endpoints 404 keyless). Only honest signal available = edge RTT measured
# at build time (measure_edge_rtt) — network round-trip to the API edge from
# the scrape node, NOT model latency; header-tooltip material only.
OPEN_PROVIDER_APIS = [
    {
        "name": "NVIDIA NIM",
        "kind": "serverless",
        "url": "https://integrate.api.nvidia.com/v1/models",
        "cache": os.path.join(TMP_DIR, "openapi_nvidia_nim.json"),
        "free_tier": True,
    },
    {
        "name": "OpenCode Zen",
        "kind": "aggregator",
        "url": "https://opencode.ai/zen/v1/models",
        "cache": os.path.join(TMP_DIR, "openapi_opencode_zen.json"),
    },
    {
        "name": "OrcaRouter",
        "kind": "aggregator",
        "url": "https://api.orcarouter.ai/v1/models",
        "cache": os.path.join(TMP_DIR, "openapi_orcarouter.json"),
    },
]
OPEN_API_CACHE_TTL = 3600  # seconds — mirrors the OpenRouter catalog cache


def measure_edge_rtt(url, tries=3, timeout=10):
    """Median edge RTT (ms) from `tries` fresh GETs to a keyless catalog.

    Network round-trip to the API edge from the scrape node — explicitly NOT
    model latency. Stored as edge_rtt_ms on the provider object; the UI only
    surfaces it in column-header tooltips. Non-fatal: any failure returns None.
    """
    import urllib.request
    times = []
    for _ in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "benchmark-arena-scraper/1.4"})
            t0 = time.monotonic()
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read(65536)  # headers + first chunk, not the full payload
            times.append((time.monotonic() - t0) * 1000)
        except Exception:  # noqa: BLE001 — one failed probe is not an error
            continue
    if not times:
        return None
    times.sort()
    return round(times[len(times) // 2])


def _free_listing_of(rid):
    """Classify a catalog id as a free listing.

    Returns (is_free, base_id_or_None):
      'deepseek/deepseek-v4-flash-free' -> (True, 'deepseek/deepseek-v4-flash')
      'org/model:free'                  -> (True, 'org/model')
      'orcarouter/free'                 -> (True, None)   # free router, no base
      'deepseek/deepseek-v4-flash'      -> (False, None)
    """
    if not rid:
        return False, None
    last = rid.rsplit("/", 1)[-1]
    low = last.lower()
    if low == "free":
        return True, None
    for suf in ("-free", ":free"):
        if low.endswith(suf) and len(last) > len(suf):
            return True, rid[: len(rid) - len(suf)]
    return False, None


def fetch_open_provider_models(url, cache_path, label, retries=3):
    """Fetch (and cache) a keyless OpenAI-compatible /v1/models catalog."""
    if os.path.exists(cache_path):
        try:
            if time.time() - os.path.getmtime(cache_path) < OPEN_API_CACHE_TTL:
                with open(cache_path) as f:
                    cached = json.load(f)
                if isinstance(cached, dict):
                    cached = cached.get("data") or []
                if isinstance(cached, list) and cached:
                    return cached
        except (OSError, ValueError):
            pass
    import urllib.request
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"Accept": "application/json",
                         "User-Agent": "benchmark-arena-scraper/1.4"},
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            models = payload.get("data") if isinstance(payload, dict) else payload
            models = models or []
            if not isinstance(models, list) or not models:
                raise ValueError("empty model list returned")
            try:
                with open(cache_path, "w") as f:
                    json.dump(models, f, ensure_ascii=False)
            except OSError:
                pass
            print(f"  [{label}] fetched {len(models)} models")
            return models
        except Exception as e:  # noqa: BLE001 — retry, then degrade
            last_err = e
            print(f"  [{label}] fetch attempt {attempt + 1}/{retries} failed: {e}")
            time.sleep(2 * (attempt + 1))
    print(f"  [{label}] WARNING: catalog fetch failed ({last_err}) — "
          f"provider section will be missing this run")
    return []


def _api_provider_row(entry):
    """Parse one entry from a keyless provider API into a providers.json row.

    Prices only when the API exposes them (OrcaRouter: per-token strings and
    per-million doubles); never fabricated from the free flag — free rows keep
    whatever pricing the API stated (usually nothing) plus free/base markers.
    """
    rid = entry.get("id")
    if not rid:
        return None
    pricing = entry.get("pricing") or {}
    inn = _per_1m(pricing.get("prompt"))
    out = _per_1m(pricing.get("completion"))
    for field, target in (("prompt_per_million", "in"), ("completion_per_million", "out")):
        val = pricing.get(field)
        if val is not None:
            try:
                num = float(val)
                if target == "in" and inn is None:
                    inn = num
                elif target == "out" and out is None:
                    out = num
            except (TypeError, ValueError):
                pass
    prov = entry.get("top_provider") or {}
    ctx = prov.get("context_length") or entry.get("context_length")
    is_free, base = _free_listing_of(rid)
    row = {
        "id": rid,
        "name": entry.get("name") or rid,
        "in": inn,
        "out": out,
        "ctx": int(ctx) if isinstance(ctx, (int, float)) and ctx > 0 else None,
    }
    if is_free:
        row["free"] = True
        if base:
            row["base"] = base
    if (inn is not None and inn == 0 and (out or 0) == 0) and not is_free:
        # zero-priced listing without a free suffix (OpenRouter-style) —
        # still a free listing, just with no base derivable from the id
        row["free"] = True
    return row


_PROV_KEY_RE = re.compile(r"[^a-z0-9]")


def _prov_norm_key(raw):
    """Python twin of src/lib/pivot.js normKey(): lowercase -> drop the org
    prefix (last '/' segment) -> strip every non-alphanumeric char. Joins
    display names across seller catalogs under the SAME conservative
    discipline the Compare pivot matcher follows (no fuzzy matching)."""
    if not raw:
        return None
    s = str(raw).lower().strip()
    slash = s.rfind("/")
    if slash != -1:
        s = s[slash + 1:]
    s = _PROV_KEY_RE.sub("", s)
    return s or None


def _bake_provider_display_names(groups):
    """stats-19: bake a full display name onto every catalog row via exact
    normKey join against rows that carry a real name (OpenRouter/OrcaRouter
    style "Vendor: Model" preferred). The listings then present ONE name
    format — the full model name — while the raw API id stays on the row
    for the UI hover tooltip (Ibrahim: one format, id on hover + card).

    Discipline: exact normalized key match only; a key mapping to two
    different names stays unnamed (honest id-only fallback in the UI);
    free twins join on their base id, never the suffixed listing id;
    _api_provider_row's `name = id` fallback does NOT count as a name.
    Returns the number of rows that gained a name."""
    def _row_join_key(m):
        return _prov_norm_key(m.get("base") if m.get("free") and m.get("base")
                              else m.get("id"))

    name_pool = defaultdict(set)
    for (_n, _k), g in groups.items():
        for m in g["models"]:
            nm = m.get("name")
            if not nm or nm == m.get("id"):
                continue  # id fallback is not a name
            key = _row_join_key(m)
            if key:
                name_pool[key].add(nm)
    name_by_key = {}
    for key, names in name_pool.items():
        vendored = {n for n in names if ": " in n}
        pool = vendored or names
        if len(pool) == 1:
            name_by_key[key] = next(iter(pool))
    n_named = 0
    for (_n, _k), g in groups.items():
        for m in g["models"]:
            if m.get("name") and m["name"] != m.get("id"):
                continue
            nm = name_by_key.get(_row_join_key(m))
            if nm:
                m["name"] = nm
                n_named += 1
    return n_named


def build_providers_json(or_models=None, litellm=None):
    """Build providers.json: per-provider model price catalogs."""
    if or_models is None:
        or_models = fetch_openrouter_models()
    if litellm is None:
        litellm = fetch_litellm_prices()

    groups = {}  # (name, kind) → {"seen": set, "models": list}
    unmapped = defaultdict(int)

    def add_model(name, kind, row):
        g = groups.setdefault((name, kind), {"seen": set(), "models": []})
        if row["id"] in g["seen"]:
            return
        g["seen"].add(row["id"])
        g["models"].append(row)

    for key, entry in litellm.items():
        if not isinstance(entry, dict) or entry.get("mode") != "chat":
            continue
        org = _litellm_provider_of(key)
        if org is None:
            if "/" not in key and not _BARE_DOT_RE.match(key):
                unmapped[key] += 1
            continue
        row = _litellm_model_row(key, entry)
        if row is not None:
            add_model(org[0], org[1], row)

    or_rows = []
    for entry in or_models:
        row = _openrouter_model_row(entry)
        if row is not None:
            or_rows.append(row)
    if or_rows:
        groups.setdefault(("OpenRouter", "aggregator"),
                          {"seen": set(), "models": []})
        g = groups[("OpenRouter", "aggregator")]
        for row in or_rows:
            if row["id"] not in g["seen"]:
                g["seen"].add(row["id"])
                g["models"].append(row)

    # keyless provider APIs (NVIDIA NIM, OpenCode Zen, OrcaRouter) — non-fatal:
    # a failed fetch only omits that provider section for this run
    api_meta = {src["name"]: src for src in OPEN_PROVIDER_APIS}
    edge_rtt = {}
    for src in OPEN_PROVIDER_APIS:
        entries = fetch_open_provider_models(src["url"], src["cache"], src["name"])
        if not entries:
            continue
        rtt = measure_edge_rtt(src["url"])
        if rtt is not None:
            edge_rtt[src["name"]] = rtt
        g = groups.setdefault((src["name"], src["kind"]),
                              {"seen": set(), "models": []})
        for entry in entries:
            row = _api_provider_row(entry)
            if row is not None and row["id"] not in g["seen"]:
                g["seen"].add(row["id"])
                g["models"].append(row)

    def _prov_sort_key(m):
        # unpriced rows (NVIDIA/OpenCode API rows expose no pricing) sink to
        # the end of their card instead of crashing on None arithmetic
        inn = m.get("in")
        total = (inn + (m.get("out") or 0)) if inn is not None else None
        return (total is None, total if total is not None else 0, m["id"])

    # stats-19: one display-name format across the whole listing — bake the
    # full model name onto id-only rows before the payload is written
    n_named = _bake_provider_display_names(groups)
    if n_named:
        print(f"  [providers] baked full display names on {n_named} id-only rows "
              f"(exact normKey join; ambiguous keys left unnamed)")

    providers = []
    for (name, kind), g in groups.items():
        models = sorted(g["models"], key=_prov_sort_key)
        prov = {
            "id": _provider_slug(name),
            "name": name,
            "kind": kind,
            "models": models,
        }
        src = api_meta.get(name)
        if src:
            # stats-18: provider-level free tier (NVIDIA NIM) + measured edge RTT
            if src.get("free_tier"):
                prov["free_tier"] = True
            if name in edge_rtt:
                prov["edge_rtt_ms"] = edge_rtt[name]
        providers.append(prov)
    providers.sort(key=lambda p: (PROVIDER_KIND_ORDER.index(p["kind"]),
                                  -len(p["models"]), p["name"]))

    payload = {
        "as_of": time.strftime("%Y-%m-%d"),
        "kinds": PROVIDER_KIND_ORDER,
        "sources": {
            "catalog": "LiteLLM model_prices_and_context_window.json (community catalog)",
            "aggregator": "OpenRouter /api/v1/models (router list price)",
            "apis": "keyless /v1/models catalogs: NVIDIA NIM · OpenCode Zen · OrcaRouter",
        },
        "providers": providers,
    }
    for path in (PROVIDERS_JSON_PATH, PROVIDERS_PUBLIC_PATH):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
    total = sum(len(p["models"]) for p in providers)
    print(f"\n  providers.json: {len(providers)} providers, {total} model rows "
          f"-> {PROVIDERS_PUBLIC_PATH}")
    for p in providers[:8]:
        print(f"    {p['name']} ({p['kind']}): {len(p['models'])} models")
    if unmapped:
        top_unmapped = sorted(unmapped.items(), key=lambda kv: -kv[1])[:10]
        print(f"  [providers] unmapped bare keys skipped: {top_unmapped}")
    return payload


def _run_providers_only():
    """--providers-only: refresh providers.json without touching benchmarks."""
    print("=" * 60)
    print("  PROVIDERS CATALOG (pricing layer) — providers only")
    print("=" * 60)
    build_providers_json()


def scrape_all():
    """Scrape all benchmarks and return unified results."""
    all_results = {}

    print("=" * 60)
    print("  LLM BENCHMARK AGGREGATOR - Scraping all leaderboards")
    print("=" * 60)

    # 1. Artificial Analysis — JS eval (virtual table)
    print("\n[1/5] Artificial Analysis")
    aa_models = scrape_artificial_analysis()
    aa_closed = [(n, s) for n, s in aa_models if classify_model(n) == 'closed']
    aa_open = [(n, s) for n, s in aa_models if classify_model(n) == 'open-weight']
    all_results["Artificial Analysis"] = {"closed": aa_closed, "open": aa_open}
    print(f"  Found: {len(aa_closed)} closed, {len(aa_open)} open models")

    # 2. BenchLM.ai — JS eval (virtual table)
    print("\n[2/5] BenchLM.ai")
    bl_models = scrape_benchlm()
    bl_closed = [(n, s) for n, s in bl_models if classify_model(n) == 'closed']
    bl_open = [(n, s) for n, s in bl_models if classify_model(n) == 'open-weight']
    all_results["BenchLM.ai"] = {"closed": bl_closed, "open": bl_open}
    print(f"  Found: {len(bl_closed)} closed, {len(bl_open)} open models")

    # 3. Arena.ai Text — JS eval (Elo-based, 394 models)
    print("\n[3/5] Arena.ai Text")
    ar_models = scrape_arena_text()
    ar_closed = [(n, s) for n, s in ar_models if classify_model(n) == 'closed']
    ar_open = [(n, s) for n, s in ar_models if classify_model(n) == 'open-weight']
    all_results["Arena.ai Text"] = {"closed": ar_closed, "open": ar_open}
    print(f"  Found: {len(ar_closed)} closed, {len(ar_open)} open models")

    # 4. SimpleBench.com — snapshot with cell parser
    print("\n[4/5] SimpleBench.com")
    sb = BENCHMARKS["SimpleBench.com"]
    snap = load_and_snapshot(sb["url"], sb["wait_after_load"], sb["snapshot_depth"])
    sb_models = parse_simplebench(snap)
    sb_closed = [(n, s) for n, s in sb_models if classify_model(n) == 'closed']
    sb_open = [(n, s) for n, s in sb_models if classify_model(n) == 'open-weight']
    all_results["SimpleBench.com"] = {"closed": sb_closed, "open": sb_open}
    print(f"  Found: {len(sb_closed)} closed, {len(sb_open)} open models")

    # 5. ARC-AGI-2 — snapshot with cell parser
    print("\n[5/5] ARC-AGI-2")
    ap = BENCHMARKS["ARC-AGI-2"]
    snap = load_and_snapshot(ap["url"], ap["wait_after_load"], ap["snapshot_depth"])
    ap_models = parse_arcprize(snap)
    ap_closed = [(n, s) for n, s in ap_models if classify_model(n) == 'closed']
    ap_open = [(n, s) for n, s in ap_models if classify_model(n) == 'open-weight']
    all_results["ARC-AGI-2"] = {"closed": ap_closed, "open": ap_open}
    print(f"  Found: {len(ap_closed)} closed, {len(ap_open)} open models")

    return all_results


# ── Synthesis & Formatting ────────────────────────────────────────────────

# Patterns to strip from display names (config modes, effort levels, API modes)
_DISPLAY_STRIP = re.compile(
    r'\s*(?:\(with fallback\)|\(thinking\)|\(no thinking\)|\(refine\.?\)|\(reasoning\)'
    r'|\((?:high|xhigh|x-high|medium|low|minimal|adaptive|max|auto|\d+[kK]?)\)'
    r'|\((?:high|xhigh|x-high|medium|low|minimal|adaptive|max|auto)\s+with\s+fallback\)'
    r'|\((?:thinking|reasoning|refine\.?|no\s*thinking)\s*,?\s*\d+[kK]?\))'
    r'|\s+max\b'
    r'\s*',
    re.IGNORECASE
)


def clean_display_name(name):
    """Return a human-friendly display name: org suffixes + config parentheticals removed."""
    n = clean_model_name(name).strip()
    n = _DISPLAY_STRIP.sub(' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    return n


def normalize_model_name(name):
    """
    Normalize model names for cross-benchmark matching.
    Strips: org artifacts, API-mode parentheticals, config-level parentheticals.
    Normalizes: hyphens↔spaces, case of variant suffixes, version prefixes,
                spacing between letters/digits, parenthetical style variants.
    Keeps meaningful model-name suffixes (Pro, Ultra, Flash, Code, etc.)
    since they often denote distinct model variants.
    """
    n = clean_model_name(name).strip()

    # ── Remove API-mode / non-variant parentheticals entirely ──
    n = re.sub(r'\s*\(with fallback\)', '', n, flags=re.IGNORECASE)
    n = re.sub(r'\s*\(thinking\)', '', n, flags=re.IGNORECASE)
    n = re.sub(r'\s*\(refine\.?\)', '', n, flags=re.IGNORECASE)
    n = re.sub(r'\s*\(reasoning\)', '', n, flags=re.IGNORECASE)
    n = re.sub(r'\s*\(no thinking\)', '', n, flags=re.IGNORECASE)
    n = re.sub(r'\s*\(latest\)', '', n, flags=re.IGNORECASE)
    n = re.sub(r'\s*\(new\)', '', n, flags=re.IGNORECASE)

    # ── Remove config-level parentheticals (e.g., (High), (xHigh), (Medium), etc.) ──
    n = re.sub(r'\s*\((?:high|xhigh|x-high|medium|low|minimal|adaptive|max|none|\d+[kK]?|auto)\s*(?:with\s+fallback)?\)\s*', ' ', n, flags=re.IGNORECASE)
    # Also handle combined parentheticals like "(Thinking 16K)" from ARC
    n = re.sub(r'\s*\((?:thinking|reasoning|refine\.?|no\s*thinking)\s*,?\s*\d+[kK]?\)', '', n, flags=re.IGNORECASE)
    # Handle hyphen-separated effort levels: "Model - High" → "Model" (VendingBench format)
    # 'none' included for parity with the parenthetical rule above ("Fable 5 - None").
    n = re.sub(r'\s+-\s+(?:high|xhigh|x-high|medium|low|minimal|adaptive|max|none)\s*$', '', n, flags=re.IGNORECASE)

    # ── Normalize variant-name parentheticals → strip parens, keep word ──
    # Handles: "(Pro)" ↔ " Pro", "(Ultra)" ↔ " Ultra", etc.
    # This ensures "Model (pro)" and "Model Pro" produce the same key.
    # Note: "max" is NOT here — it's handled above as config-level (removed entirely).
    n = re.sub(
        r'\s*\((pro|ultra|flash|lite|plus|premium|turbo|nano|heavy|code|instruct|chat|base|preview)\)\s*',
        r' \1 ', n, flags=re.IGNORECASE
    )

    # ── Strip non-distinguishing trailing words ──
    # "Preview" is a release-stage marker (pre-release), not a distinct model.
    # "Gemini 3.1 Pro Preview" ↔ "Gemini 3.1 Pro"
    n = re.sub(r'\s+preview\s*$', '', n, flags=re.IGNORECASE)
    # NOTE: "Deep Think" is NOT stripped — it denotes a distinct model variant
    # (e.g., "Gemini 3 Pro Deep Think" is a different model from "Gemini 3 Pro").

    # ── Strip "v" prefix before version numbers ──
    # "v5.2" ↔ "5.2", "V3" ↔ "3"
    n = re.sub(r'\bv(\d)', r'\1', n, flags=re.IGNORECASE)

    # ── Strip release-date suffixes (e.g., "0731", "20260731", "0813") ──
    # These appear after model names like "DeepSeek V4 Flash 0731 (Max)"
    # Must run BEFORE version detection to avoid parsing "0731" as version 731.0
    n = re.sub(r'\s+(?:20)?\d{4}\b', '', n)

    # ── Strip parameter-size suffixes (open-weight technical designations) ──
    # "Qwen 3.8 2.4T" → "Qwen 3.8", "Model 397B" → "Model"
    n = re.sub(r'\s+\d+(?:\.\d+)?[TtBb]\b', '', n)
    # "Model A95B" → "Model" (letter-prefix param sizes)
    n = re.sub(r'\s+[A-Za-z]\d+[Bb]\b', '', n)

    # ── Strip trailing "max" as config/effort variant ──
    # "Qwen3.8 Max" ↔ "Qwen3.8" — safe because \b can't match mid-word (MiniMax)
    n = re.sub(r'\s+max\b', '', n, flags=re.IGNORECASE)

    # ── Normalize hyphen ↔ space in model names ──
    # "GLM-5.2" ↔ "GLM 5.2", "GPT-5.5" ↔ "GPT 5.5", "MiniMax-M3" ↔ "MiniMax M3"
    # Step 1: letter-hyphen-digit (e.g., "GLM-5.2" → "GLM 5.2")
    n = re.sub(r'(?<=[A-Za-z])-(?=\d)', ' ', n)
    # Step 2: digit-hyphen-digit (e.g., "Qwen3-235b" → "Qwen3 235b")
    n = re.sub(r'(?<=\d)-(\d)', r' \1', n)
    # Step 3: any remaining hyphens → space
    # Handles "MiniMax-M3" ↔ "MiniMax M3", "Nex-N2-Pro" ↔ "Nex N2 Pro", etc.
    # Safe because org suffixes are already stripped; all hyphens are within the model name.
    n = re.sub(r'-', ' ', n)

    # ── Add space between letter and digit when directly adjacent (no separator) ──
    # "GPT4o" → "GPT 4o", "Claude4" → "Claude 4", "Qwen3.7 Max" → "Qwen 3.7 Max"
    # Handles both integer (4) and decimal (3.7) version numbers glued to letters.
    n = re.sub(r'(?<=[A-Za-z])(\d+\.\d+)', r' \1', n)
    n = re.sub(r'(?<=[A-Za-z])(?<!\.)((?:\d+\.\d+|\d+)(?=[A-Za-z]))', r' \1', n)
    # Also: digit(s) at end after letters with no space
    n = re.sub(r'(?<=[A-Za-z])(\d+)(?=\s|$|\()', r' \1', n)

    # ── Normalize specific org names ──
    n = re.sub(r'\bZ\.?AI\b', '', n, flags=re.IGNORECASE)

    # ── Normalize case: lowercase the whole thing for matching ──
    n = n.lower().strip()

    # ── Normalize whitespace ──
    n = re.sub(r'\s+', ' ', n).strip()
    return n


def get_model_family_and_version(normalized_name):
    """
    Extract (family, version) from a normalized model name for version deduplication.
    Returns (None, None) if no version pattern is detected.

    Strategy: match the version number (with optional generation letter),
    then include any trailing sub-variant words (sol, terra, pro, flash …)
    as part of the family.  This ensures distinct variants get distinct
    families and are never cross-deduped.

    Examples:
      "glm 5.2"           -> ("glm", 5.2)
      "glm 5"             -> ("glm", 5.0)
      "kimi k2.7 code"    -> ("kimi k code", 2.7)
      "deepseek 4 pro"    -> ("deepseek pro", 4.0)
      "deepseek 4 flash"  -> ("deepseek flash", 4.0)
      "nemotron 3 ultra"  -> ("nemotron ultra", 3.0)
      "gemma 4 31b"       -> (None, None)
      "minimax m 3"       -> ("minimax m", 3.0)
      "gpt 5.6 sol"       -> ("gpt sol", 5.6)
      "gpt 5.6 terra"     -> ("gpt terra", 5.6)
      "gpt 5.5"           -> ("gpt", 5.5)
      "claude opus 4.8"   -> ("claude opus", 4.8)
      "claude fable 5"    -> ("claude fable", 5.0)
      "mimo 2.5 pro"      -> ("mimo pro", 2.5)
      "glm 5v turbo"      -> (None, None)   [vision variant, not a version]
      "gemini 3 pro deep think" -> ("gemini pro deep think", 3.0)
      "gemini 3 deep think"   -> ("gemini deep think", 3.0)
    """
    n = normalized_name.strip().lower()

    # Match: (family)(space)(optional gen-letter)(version)(optional trailing sub-variant) end
    # The trailing sub-variant (group 4) is included in the family to keep
    # distinct model variants (Sol vs Terra, Pro vs Flash, Deep Think) separate.
    # Supports 1-3 trailing variant words to handle multi-word suffixes like
    # "deep think" and "pro deep think".
    m = re.search(
        r'^(.+?)\s+([a-z])?(\d+(?:\.\d+)?)(?:\s+([a-z]\w*(?:\s+[a-z]\w+){0,2}))?\s*$',
        n
    )
    if not m:
        return (None, None)

    family = m.group(1).strip()
    gen_letter = m.group(2)
    version = float(m.group(3))
    trailing = m.group(4)

    # Append generation letter to family (e.g., "kimi k" for Kimi K2.7)
    if gen_letter:
        family = f"{family} {gen_letter}"
    # Append trailing sub-variant to family (e.g., "gpt sol" for GPT-5.6 Sol)
    if trailing:
        family = f"{family} {trailing}"

    family = re.sub(r'\s+', ' ', family.strip())

    if not family or len(family) < 2:
        return (None, None)

    return (family, version)


def dedup_older_versions(rows, normalize_fn):
    """
    Remove inferior same-version variants within the same model family.

    When multiple models share the exact same (family, version) but differ
    only in trailing variant words (e.g. plain "GPT-5.5" vs "GPT-5.5 Pro"),
    only the entry with the most benchmark coverage (highest CL) is kept.

    Different versions (e.g. GPT-5.5 vs GPT-5.6) are ALWAYS preserved —
    they represent distinct product releases, not duplicates.
    Different families (e.g. "gpt sol" vs "gpt terra") are also preserved.
    """
    from collections import defaultdict

    # Build (family, version) -> list of row indices
    group_entries = defaultdict(list)
    for i, row in enumerate(rows):
        key = normalize_fn(row['name'])
        family, version = get_model_family_and_version(key)
        if family is None or version is None:
            continue
        group_entries[(family, version)].append(i)

    to_remove = set()
    for (family, version), indices in group_entries.items():
        if len(indices) < 2:
            continue
        # Keep entry with: most benchmarks, then has Artific.A score, then CL
        best = max(indices, key=lambda i: (
            rows[i]['num_benchmarks'],
            rows[i].get('Artificial Analysis') is not None,
            rows[i]['cl'],
        ))
        for idx in indices:
            if idx != best:
                to_remove.add(idx)

    if not to_remove:
        return rows, []

    removed_names = [rows[i]['name'] for i in sorted(to_remove)]
    rows = [r for i, r in enumerate(rows) if i not in to_remove]
    return rows, removed_names


def build_unified_table(all_results):
    """
    Build a unified table with each model's scores across benchmarks.
    DeepSWE, VendingBench, and CyberGem are excluded from the average calculation
    (shown in per-benchmark results only, not blended into global score).
    Returns: (closed_table, open_table, all_benchmarks, avg_benchmarks)
    """
    all_benchmarks = list(all_results.keys())
    # Benchmarks excluded from the global average
    EXCLUDE_FROM_AVG = {"DeepSWE", "VendingBench", "CyberGem", "EQBench CW", "LLM Chess"}
    avg_benchmarks = [b for b in all_benchmarks if b not in EXCLUDE_FROM_AVG]

    # Collect all models with their per-benchmark scores
    model_scores = defaultdict(lambda: {"classification": "closed", "scores": {}})

    # ── First pass: collect raw scores per benchmark for rescaling ──
    raw_scores_per_bench = defaultdict(list)
    for bname, bdata in all_results.items():
        for category in ["closed", "open"]:
            for model_name, score in bdata[category]:
                raw_scores_per_bench[bname].append(score)

    # ── Second pass: store rescaled scores ──
    for bname, bdata in all_results.items():
        all_s = raw_scores_per_bench[bname]
        for category in ["closed", "open"]:
            for model_name, raw_score in bdata[category]:
                score = _rescale_score(raw_score, bname, all_s)
                cls = classify_model(model_name)
                key = normalize_model_name(model_name)
                model_scores[key]["classification"] = cls
                if bname not in model_scores[key]["scores"] or score > model_scores[key]["scores"][bname]:
                    model_scores[key]["scores"][bname] = score
                display = clean_display_name(model_name)
                if "display_name" not in model_scores[key] or len(display) < len(model_scores[key].get("display_name", "z" * 999)):
                    model_scores[key]["display_name"] = display

    # ── Merge versionless entries into versioned counterparts ──
    # E.g. SimpleBench's "Claude Fable" (no version) should merge into
    # "Claude Fable 5" from other benchmarks.
    versionless_keys = [
        k for k, d in model_scores.items()
        if get_model_family_and_version(k)[0] is None
    ]
    for vk in list(versionless_keys):
        # Find a versioned key that starts with the same text + space + digit
        for ok in list(model_scores.keys()):
            if ok == vk or not ok.startswith(vk + ' '):
                continue
            rest = ok[len(vk) + 1:]
            if rest and rest[0].isdigit():
                # Merge scores from versionless into versioned
                for bench, score in model_scores[vk]["scores"].items():
                    existing = model_scores[ok]["scores"].get(bench)
                    if existing is None or score > existing:
                        model_scores[ok]["scores"][bench] = score
                del model_scores[vk]
                break

    # ── Merge truncated-family entries into their full-family counterparts ──
    # E.g. ARC-AGI-2's "Claude 4.7" (missing "Opus") should merge into
    # "Claude Opus 4.7" from other benchmarks.
    # Strategy: if key X has version V and a single-word family, and key Y
    # shares the same version V with a multi-word family that STARTS WITH
    # X's family, merge X into Y.
    #
    # IMPORTANT: Do NOT merge when Y's extra words are smaller-variant
    # indicators (Flash, Lite, Mini, Nano).  E.g. "glm 5.3" must NOT be
    # merged into "glm 5.3 flash" — the base model's scores would
    # incorrectly inflate the smaller variant.
    _VARIANT_SMALLER = {'flash', 'lite', 'mini', 'nano', 'small', 'tiny'}

    _merged_truncated = set()
    for xk in list(model_scores.keys()):
        if xk in _merged_truncated:
            continue
        xfam, xver = get_model_family_and_version(xk)
        if xfam is None or xver is None:
            continue
        # Only consider single-word families (likely truncated)
        if ' ' in xfam:
            continue
        # Find the best match (most benchmarks) among candidates
        best_yk = None
        best_nbench = 0
        for yk in list(model_scores.keys()):
            if yk == xk or yk in _merged_truncated:
                continue
            yfam, yver = get_model_family_and_version(yk)
            if yfam is None or yver is None or yver != xver:
                continue
            if ' ' not in yfam:
                continue
            # Check if x's family is a prefix of y's family (word-level)
            if yfam.startswith(xfam + ' '):
                # Block merge if y's extra words include smaller-variant suffixes.
                # Use any() — if ANY extra word is a smaller-variant tag (Flash, Lite, …),
                # the longer name is a smaller/cheaper variant and must NOT absorb the
                # base model's scores.  E.g. "Qwen3.8" must NOT merge into
                # "Qwen3.8-Flash-Next" even though "Next" isn't a size tag.
                extra_words = yfam[len(xfam) + 1:].split()
                if extra_words and any(w in _VARIANT_SMALLER for w in extra_words):
                    continue
                n_bench = len(model_scores[yk]["scores"])
                if n_bench > best_nbench:
                    best_nbench = n_bench
                    best_yk = yk
        if best_yk:
            for bench, score in model_scores[xk]["scores"].items():
                existing = model_scores[best_yk]["scores"].get(bench)
                if existing is None or score > existing:
                    model_scores[best_yk]["scores"][bench] = score
            del model_scores[xk]
            _merged_truncated.add(xk)

    # Build tables
    n_core = len(avg_benchmarks)  # total core benchmarks for CL calculation
    def build_table(classification):
        rows = []
        for key, data in model_scores.items():
            if data["classification"] != classification:
                continue
            scores = data["scores"]
            # Only include models meeting minimum CL threshold
            avg_scores = {b: s for b, s in scores.items() if b not in EXCLUDE_FROM_AVG}
            cl_pct = len(avg_scores) / n_core * 100
            if len(avg_scores) < 2:  # ≥2 core benchmarks (configurable via MIN_CL_PERCENT)
                continue

            # Confidence Level: fraction of core benchmarks covered
            cl = cl_pct
            row = {
                "name": data.get("display_name", key),
                "num_benchmarks": len(avg_scores),
                "cl": round(cl, 1),
            }
            for b in all_benchmarks:
                s = scores.get(b, None)
                row[b] = round(s, 1) if s is not None else None
            rows.append(row)

        # Sort by: (1) has Artific.A score, (2) Artific.A desc, (3) CL desc, (4) name
        rows.sort(key=lambda x: (
            0 if x.get("Artificial Analysis") is not None else 1,
            -(x.get("Artificial Analysis") or 0),
            -x["cl"],
            x["name"],
        ))

        # Remove same-version duplicates (e.g. two "gpt sol 5.6" entries)
        rows, removed = dedup_older_versions(rows, normalize_model_name)
        if removed:
            print(f"  [dedup] Removed duplicates from {classification}: {removed}")

        # Re-sort after dedup (order may have shifted)
        rows.sort(key=lambda x: (
            0 if x.get("Artificial Analysis") is not None else 1,
            -(x.get("Artificial Analysis") or 0),
            -x["cl"],
            x["name"],
        ))

        return rows

    closed_table = build_table("closed")
    open_table = build_table("open-weight")

    # ── Post-build validation: warn if smaller variant has more coverage ──
    _VARIANT_TAGS = {'flash', 'lite', 'mini', 'nano', 'small', 'tiny'}
    for label, table in [("closed", closed_table), ("open", open_table)]:
        for row in table:
            norm = normalize_model_name(row['name'])
            fam, ver = get_model_family_and_version(norm)
            if not fam:
                continue
            words = fam.split()
            if len(words) >= 2 and words[-1] in _VARIANT_TAGS:
                base_fam = ' '.join(words[:-1])
                base_norm = f"{base_fam} {ver}"
                base_rows = [r for r in table if normalize_model_name(r['name']) == base_norm]
                if not base_rows:
                    continue
                base_row = base_rows[0]
                if row['num_benchmarks'] > base_row['num_benchmarks']:
                    print(f"  [WARN] {label}: variant \"{row['name']}\" ({row['num_benchmarks']} benches) "
                          f"has more coverage than base \"{base_row['name']}\" ({base_row['num_benchmarks']} benches)")

    return closed_table, open_table, all_benchmarks, avg_benchmarks


def _pearson_r(x, y):
    """Compute Pearson correlation between two equal-length lists of floats."""
    n = len(x)
    if n < 3:
        return None
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    num = sum((a - mean_x) * (b - mean_y) for a, b in zip(x, y))
    den_x = sum((a - mean_x) ** 2 for a in x) ** 0.5
    den_y = sum((b - mean_y) ** 2 for b in y) ** 0.5
    if den_x == 0 or den_y == 0:
        return None
    return num / (den_x * den_y)


def check_benchmark_overlap(all_results, closed_table, open_table, avg_benchmarks):
    """
    Check known overlap pairs for correlation inflation and return a
    human-readable note for the report.

    Two checks:
      1. Static note — always printed, shows known overlaps and estimated
         impact on the unified average.
      2. Dynamic flag — computes Pearson r between the two sites' scores
         for shared models; warns if r exceeds OVERLAP_CORRELATION_THRESHOLD.
    """
    lines = []
    lines.append("-" * 80)
    lines.append("  METRIC OVERLAP AWARENESS")
    lines.append("-" * 80)

    n_avg = len(avg_benchmarks)

    for pair in OVERLAP_PAIRS:
        site_a, site_b = pair["sites"]
        shared = pair["shared"]
        wa = pair["weight_a"]
        wb = pair["weight_b"]

        # Estimated double-counting impact on the unified average:
        # P(overlap) ≈ (wa/n_avg) + (wb/n_avg) — the fraction of the
        # unified avg that could be inflated by shared signal.
        impact_pct = ((wa + wb) / n_avg) * 100

        lines.append(f"  {site_a} <-> {site_b}")
        lines.append(f"    Shared sub-benchmarks: {', '.join(shared)}")
        lines.append(f"    Est. contribution to each aggregate: "
                      f"{site_a} ~{wa:.0%}, {site_b} ~{wb:.0%}")
        lines.append(f"    Est. double-counting in unified avg: ~{impact_pct:.1f}% "
                      f"(of {n_avg}-benchmark average)")

        # Dynamic correlation check
        if site_a in all_results and site_b in all_results:
            r_values = []
            for category in ("closed", "open"):
                # Build model -> score maps from each site
                scores_a = {normalize_model_name(n): s
                            for n, s in all_results[site_a][category]}
                scores_b = {normalize_model_name(n): s
                            for n, s in all_results[site_b][category]}
                common = sorted(set(scores_a) & set(scores_b))
                if len(common) >= 3:
                    xa = [scores_a[k] for k in common]
                    xb = [scores_b[k] for k in common]
                    r = _pearson_r(xa, xb)
                    if r is not None:
                        r_values.append((category, r, len(common)))

            if r_values:
                for cat, r, n_models in r_values:
                    flag = ""
                    if r >= OVERLAP_CORRELATION_THRESHOLD and n_models >= OVERLAP_MIN_SAMPLES_FOR_FLAG:
                        flag = "  ⚠️ HIGH — overlap may be distorting rankings"
                    lines.append(f"    Correlation ({cat}): r={r:.2f} "
                                  f"({n_models} shared models){flag}")
            else:
                lines.append("    Correlation: insufficient shared models to compute")

        lines.append("")

    lines.append("  No sites are excluded from the average due to overlap.")
    lines.append("  This section monitors for growing correlation between overlapping sites.")

    return "\n".join(lines)


def format_results(all_results, closed_table, open_table, all_benchmarks, avg_benchmarks):
    """Format the final output as a readable report."""

    output = []
    output.append("=" * 80)
    output.append("  LLM BENCHMARK AGGREGATE - Unified Summary")
    output.append("=" * 80)
    output.append(f"  Benchmarks: {', '.join(all_benchmarks)}")
    output.append(f"  Avg computed over: {', '.join(avg_benchmarks)}")
    output.append(f"  Date: {time.strftime('%Y-%m-%d %H:%M')}")
    output.append("")

    # ── Per-benchmark individual results ──
    output.append("-" * 80)
    output.append("  PER-BENCHMARK RESULTS")
    output.append("-" * 80)

    for bname, bdata in all_results.items():
        output.append(f"\n  {bname}:")
        if bdata["closed"]:
            output.append("    Closed-Source Top 5:")
            for i, (name, score) in enumerate(bdata["closed"][:TOP_N], 1):
                output.append(f"      {i}. {name} — {score:.1f}")
        else:
            output.append("    Closed-Source: No models found")
        if bdata["open"]:
            output.append("    Open-Weight Top 5:")
            for i, (name, score) in enumerate(bdata["open"][:TOP_N], 1):
                output.append(f"      {i}. {name} — {score:.1f}")
        else:
            output.append("    Open-Weight: No models found")

    # ── Pivot tables (raw scores, no unified average) ──
    short_names = {
        "Artificial Analysis": "Artific.A",
        "BenchLM.ai": "BenchLM",
        "Arena.ai Text": "Arena.ai",
        "SimpleBench.com": "SimpleB",
        "ARC-AGI-2": "ARC-AGI2",
        "Design Arena": "Design",
        "SWE-Marathon": "SWE-Mara",
        "FrontierSWE": "Frontier",
        "DeepSWE": "DeepSWE",
        "VendingBench": "Vending",
        "CyberGem": "CyberG",
    }
    headers = [short_names.get(b, b[:10]) for b in all_benchmarks]
    col_w = 8

    for label, table in [("Closed-Source", closed_table), ("Open-Weight", open_table)]:
        output.append("")
        output.append("=" * 80)
        n_show = min(TOP_N, len(table))
        output.append(f"  {label} Models — Pivot ({n_show}/{len(table)} qualified, sorted by Artificial Analysis)")
        output.append("=" * 80)
        if not table:
            output.append("  No models found")
            continue

        # Rank + CL columns
        rank_w = 4
        header_line = f"  {'#':>{rank_w}}  {'Model':<28}  " + "  ".join(f"{h:>{col_w}}" for h in headers) + f"  {'CL':>4}"
        sep_line = "  " + "-" * (rank_w + 2 + 28 + 2 + (col_w + 2) * len(all_benchmarks) + 2 + 4)
        output.append(header_line)
        output.append(sep_line)

        for idx, row in enumerate(table[:TOP_N], 1):
            cells = []
            for b in all_benchmarks:
                v = row.get(b)
                if v is not None:
                    cells.append(f"{v:>{col_w}.1f}")
                else:
                    cells.append(" " * col_w)
            bench_str = "  ".join(cells)
            output.append(f"  {idx:>{rank_w}}  {row['name'][:28]:<28}  {bench_str}  {row['cl']:>3.0f}%")

    # ── Summary stats ──
    output.append("")
    output.append("=" * 80)
    output.append("  SUMMARY")
    output.append("=" * 80)
    n_qualified = len(closed_table) + len(open_table)
    output.append(f"  Qualified models (>=2 core benchmarks): {n_qualified} "
                  f"({len(closed_table)} closed, {len(open_table)} open-weight)")
    output.append(f"  Core benchmarks ({len(avg_benchmarks)}): {', '.join(avg_benchmarks)}")
    output.append(f"  Non-core (shown but not counted in CL): {', '.join(b for b in all_benchmarks if b not in avg_benchmarks)}")
    output.append(f"  CL = core benchmarks covered / total core benchmarks")
    output.append(f"  Sorted by Artificial Analysis score (descending). No unified average.")
    output.append("")

    # ── Overlap awareness note ──
    overlap_note = check_benchmark_overlap(all_results, closed_table, open_table, avg_benchmarks)
    if overlap_note:
        output.append(overlap_note)

    return "\n".join(output)



def save_results_json(all_results, closed_table, open_table, all_benchmarks, avg_benchmarks, models_meta=None):
    """Save raw results to JSON for debugging."""
    data = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M"),
        "benchmarks": all_benchmarks,
        "avg_benchmarks": avg_benchmarks,
        "per_benchmark": {},
        "unified_closed": closed_table,
        "unified_open": open_table,
    }
    if models_meta:
        data["models_meta"] = models_meta
    for bname, bdata in all_results.items():
        data["per_benchmark"][bname] = {
            "closed": [(n, s) for n, s in bdata["closed"][:TOP_N]],
            "open": [(n, s) for n, s in bdata["open"][:TOP_N]],
        }

    path = "/home/z/my-project/download/benchmark_results.json"
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"\n  Raw results saved to: {path}")
    return path


# ── BenchLM status monitoring signal ──────────────────────────────────────
# Per the 2026-09 dry run (scripts/dryrun_benchlm_supersede.py): BenchLM's
# 'Superseded' tag is NOT auto-wired into our supersession system — our
# OpenRouter-date rules already cover 12/15 of its tags and are strictly more
# principled (dated, variant-safe, red-lined), while blind wiring hides
# flagships (GPT-5.6 Sol). Instead the tag is kept as an early-warning
# signal: saved per scrape, diffed between runs, and cross-checked against
# our current-gen flags so a human can trigger an in-depth check and curate
# SUPERSEDE_OVERRIDES only when justified.

BENCHLM_STATUS_PATH = "/home/z/my-project/download/benchlm_status.json"


def _save_benchlm_status(census, by_name):
    """Save the BenchLM status census as a sidecar JSON (monitoring only).

    Rotates the previous file to .prev so the post-scrape monitor can diff
    status demotions (Current/Established → Superseded) between runs.
    Non-fatal on any I/O error — scraping must never fail because of it.
    """
    try:
        if os.path.exists(BENCHLM_STATUS_PATH):
            shutil.copyfile(BENCHLM_STATUS_PATH, BENCHLM_STATUS_PATH + ".prev")
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "census": census,
            "by_name": by_name,
        }
        with open(BENCHLM_STATUS_PATH, "w") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        print(f"    Status sidecar saved: {BENCHLM_STATUS_PATH} "
              f"({len(by_name)} models, prev rotated)")
    except Exception as e:
        print(f"    [WARN] could not save BenchLM status sidecar: {e}")


def _monitor_benchlm_status(closed_table, open_table, models_meta):
    """Post-scrape monitor: cross-check BenchLM status tags vs our flags.

    Reports (never mutates data):
      1. Demotions since the previous scrape (Current/Established → Superseded).
      2. Disagreements: models WE treat as current-gen (no superseded_by/stale)
         that BenchLM tags 'Superseded' → in-depth-check candidates for a
         curated SUPERSEDE_OVERRIDES pair.
      3. Convergence: how many of its Superseded tags our system already flags.
    """
    try:
        with open(BENCHLM_STATUS_PATH) as f:
            sidecar = json.load(f)
    except Exception:
        print("  [BenchLM-monitor] no status sidecar (BenchLM scrape failed?) — skipped")
        return
    by_name = sidecar.get("by_name") or {}
    if not by_name:
        print("  [BenchLM-monitor] empty status sidecar — skipped")
        return
    prev = {}
    try:
        with open(BENCHLM_STATUS_PATH + ".prev") as f:
            prev = json.load(f).get("by_name") or {}
    except Exception:
        pass

    def key_for(name):
        try:
            return normalize_model_name(name)
        except Exception:
            return name.lower()

    demotions, disagreements, converged = [], [], 0
    for row in closed_table + open_table:
        name = row.get("name")
        if not name:
            continue
        status = by_name.get(key_for(name))
        if not status:
            continue
        meta = models_meta.get(name) or {}
        older = bool(meta.get("superseded_by") or meta.get("stale"))
        if status == "Superseded":
            if older:
                converged += 1
            else:
                disagreements.append(name)
        p = prev.get(key_for(name))
        if p and p != "Superseded" and status == "Superseded":
            demotions.append(f"{name}: {p} -> Superseded")

    print(f"  [BenchLM-monitor] census: {sidecar.get('census', {})} | "
          f"unified rows matched: {converged + len(disagreements)}")
    if demotions:
        print(f"  [BenchLM-monitor] STATUS DEMOTIONS since last scrape "
              f"({len(demotions)}) — in-depth check recommended:")
        for d in demotions:
            print(f"    - {d}")
    else:
        print("  [BenchLM-monitor] no status demotions since last scrape")
    if disagreements:
        print(f"  [BenchLM-monitor] DISAGREEMENTS — BenchLM 'Superseded' but WE "
              f"treat as current-gen ({len(disagreements)}): {disagreements}")
        print("      (per-row lifecycle tag, usually NOT a model-line death; "
              "run an in-depth check before curating SUPERSEDE_OVERRIDES)")
    else:
        print("  [BenchLM-monitor] zero disagreements with our current-gen flags")
    print(f"  [BenchLM-monitor] convergence: {converged} of its 'Superseded' tags "
          f"already flagged by our own supersession rules")


def _scrape_site(site_name):
    """Scrape a single site and save to a temp file."""
    if site_name == "Artificial Analysis":
        models = scrape_artificial_analysis()
    elif site_name == "BenchLM.ai":
        models = scrape_benchlm()
    elif site_name == "Arena.ai Text":
        models = scrape_arena_text()
    elif site_name == "SimpleBench.com":
        models = scrape_simplebench()
    elif site_name == "ARC-AGI-2":
        models = scrape_arcprize()
    elif site_name == "Design Arena":
        models = scrape_design_arena()
    elif site_name == "DeepSWE":
        models = scrape_deepswe()
    elif site_name == "VendingBench":
        models = scrape_vending_bench()
    elif site_name == "SWE-Marathon":
        models = scrape_swe_marathon()
    elif site_name == "FrontierSWE":
        models = scrape_frontierswe()
    elif site_name == "CyberGem":
        models = scrape_cybergem()
    elif site_name == "EQBench CW":
        models = scrape_eqbench_cw()
    elif site_name == "LLM Chess":
        models = scrape_llmchess()
    else:
        return

    closed = [(n, s) for n, s in models if classify_model(n) == 'closed']
    open_w = [(n, s) for n, s in models if classify_model(n) == 'open-weight']
    path = f"{TMP_DIR}/bench_{site_name.replace(' ', '_').replace('.', '')}.json"
    if not closed and not open_w:
        # Don't cache empty results — remove stale file so we retry next time
        if os.path.exists(path):
            os.remove(path)
        raise ValueError(f"No models found for {site_name}")
    with open(path, 'w') as f:
        json.dump({'closed': closed, 'open': open_w}, f, ensure_ascii=False)
    print(f"  [{site_name}] {len(closed)}c {len(open_w)}o")


def _run_meta_only():
    """--meta-only: refresh OpenRouter metadata on the last saved results."""
    path = "/home/z/my-project/download/benchmark_results.json"
    if not os.path.exists(path):
        print(f"  [meta-only] no saved results at {path}")
        return
    with open(path) as f:
        data = json.load(f)
    rows = data.get("unified_closed", []) + data.get("unified_open", [])
    meta = collect_model_metadata(rows)
    # stats-19: available_at is a curated cross-seller layer (hand-baked with
    # exact-match + pins, commit db3ea19) that this flow cannot rebuild — the
    # providers catalogs don't expose it in this path. Preserve it from the
    # saved snapshot so a meta refresh can never regress the live feature.
    saved_meta = data.get("models_meta") or {}
    n_preserved = 0
    for name, rec in meta.items():
        prev = saved_meta.get(name) or {}
        if prev.get("available_at") and not rec.get("available_at"):
            rec["available_at"] = prev["available_at"]
            n_preserved += 1
    if n_preserved:
        print(f"  [available-at] preserved curated seller map for {n_preserved} record(s)")
    row_names = {r["name"] for r in rows if r.get("name")}
    n_sup = annotate_supersession(meta)
    n_ov = apply_supersede_overrides(meta, row_names)
    n_stale = annotate_stale_by_age(meta, row_names)
    n_bare = annotate_legacy_bare_names(meta, row_names)
    n_hf, n_hfp = apply_hf_overrides(meta, row_names)
    n_aa, _aa_moves = apply_aa_pricing(meta)
    if n_sup:
        print(f"  [Supersession] flagged {n_sup} older model version(s)")
    if n_ov:
        print(f"  [Supersession] applied {n_ov} override pair(s)")
    if n_stale:
        print(f"  [Staleness] flagged {n_stale} model(s) older than {STALE_AFTER_MONTHS} months")
    if n_bare:
        print(f"  [Staleness] flagged {n_bare} legacy bare-name model(s)")
    if n_hf:
        print(f"  [HuggingFace] applied {n_hf} curated id override(s) (+{n_hfp} param fills)")
    data["models_meta"] = meta
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  models_meta saved to {path} ({len(meta)} entries)")


def main():
    """Main entry point. Scrapes each site sequentially, combines results."""
    if "--meta-only" in sys.argv:
        _run_meta_only()
        return
    if "--providers-only" in sys.argv:
        _run_providers_only()
        return
    # Ensure no stale browser from a previous crashed run
    try:
        run_browser("close", timeout=5)
    except Exception:
        pass
    start_time = time.time()
    all_results = {}
    site_files = {
        "Artificial Analysis": f"{TMP_DIR}/bench_Artificial_Analysis.json",
        "BenchLM.ai": f"{TMP_DIR}/bench_BenchLMai.json",
        "Arena.ai Text": f"{TMP_DIR}/bench_Arenaai_Text.json",
        "SimpleBench.com": f"{TMP_DIR}/bench_SimpleBenchcom.json",
        "ARC-AGI-2": f"{TMP_DIR}/bench_ARC-AGI-2.json",
        "Design Arena": f"{TMP_DIR}/bench_Design_Arena.json",
        "DeepSWE": f"{TMP_DIR}/bench_DeepSWE.json",
        "VendingBench": f"{TMP_DIR}/bench_VendingBench.json",
        "SWE-Marathon": f"{TMP_DIR}/bench_SWE-Marathon.json",
        "FrontierSWE": f"{TMP_DIR}/bench_FrontierSWE.json",
        "CyberGem": f"{TMP_DIR}/bench_CyberGem.json",
        "EQBench CW": f"{TMP_DIR}/bench_EQBench_CW.json",
        "LLM Chess": f"{TMP_DIR}/bench_LLM_Chess.json",
    }

    print("=" * 60)
    print("  LLM BENCHMARK AGGREGATOR")
    print("=" * 60)

    # Scrape each site (skip if temp file exists and is fresh)
    for site_name in site_files:
        print(f"\n[{list(site_files.keys()).index(site_name)+1}/{len(site_files)}] {site_name}")
        path = site_files[site_name]
        if os.path.exists(path):
            try:
                age = time.time() - os.path.getmtime(path)
                # Default 5 min; raise via BENCH_CACHE_TTL when orchestrating
                # per-site runs (results then reused by the final combine run)
                if age < int(os.environ.get("BENCH_CACHE_TTL", "300")):
                    print(f"  Using cached results ({age:.0f}s old)")
                    continue
            except OSError:
                pass
        try:
            _scrape_site(site_name)
        except Exception as e:
            print(f"  [ERROR] {site_name} failed: {e}")
            # Ensure browser is closed after failure
            try:
                run_browser("close", timeout=5)
            except Exception:
                pass

    # Load all results
    for site_name, path in site_files.items():
        if os.path.exists(path):
            with open(path) as f:
                data = json.load(f)
            all_results[site_name] = {
                'closed': [tuple(x) for x in data['closed']],
                'open': [tuple(x) for x in data['open']],
            }

    # Build unified table (handles rescaling internally via _rescale_score)
    closed_table, open_table, all_benchmarks, avg_benchmarks = build_unified_table(all_results)

    # Enrich models with OpenRouter catalog metadata (params, modalities,
    # pricing, context, reasoning…). Non-fatal: leaderboard works without it.
    try:
        models_meta = collect_model_metadata(closed_table + open_table)
        row_names = {r["name"] for r in closed_table + open_table if r.get("name")}
        n_sup = annotate_supersession(models_meta)
        n_ov = apply_supersede_overrides(models_meta, row_names)
        n_stale = annotate_stale_by_age(models_meta, row_names)
        n_bare = annotate_legacy_bare_names(models_meta, row_names)
        n_hf, n_hfp = apply_hf_overrides(models_meta, row_names)
        n_aa, n_aa_moves = apply_aa_pricing(models_meta)
        if n_sup:
            print(f"  [Supersession] flagged {n_sup} older model version(s)")
        if n_ov:
            print(f"  [Supersession] applied {n_ov} override pair(s)")
        if n_stale:
            print(f"  [Staleness] flagged {n_stale} model(s) older than {STALE_AFTER_MONTHS} months")
        if n_bare:
            print(f"  [Staleness] flagged {n_bare} legacy bare-name model(s)")
        if n_hf:
            print(f"  [HuggingFace] applied {n_hf} curated id override(s) (+{n_hfp} param fills)")
        if n_aa:
            print(f"  [Pricing] AA list prices on {n_aa} rows ({n_aa_moves} differ from OpenRouter)")
    except Exception as e:
        print(f"  [OpenRouter] metadata collection failed (non-fatal): {e}")
        models_meta = {}

    # EQBench alias footnotes (data-driven; renders as ★ next to the model
    # name in the UI). e.g. EQBench lists Qwen3.8-Max under its HF repo name.
    if models_meta:
        for _name, _note in EQBENCH_ALIAS_NOTES.items():
            if _name in models_meta and not models_meta[_name].get("alias_note"):
                models_meta[_name]["alias_note"] = _note
        # LLM Chess footnotes (e.g. HF-style names, variant mapping)
        for _name, _note in CHESS_ALIAS_NOTES.items():
            if _name in models_meta and not models_meta[_name].get("alias_note"):
                models_meta[_name]["alias_note"] = _note

    # BenchLM 'Superseded' tags: monitoring signal only (never auto-wired —
    # see the dry run in scripts/dryrun_benchlm_supersede.py).
    try:
        _monitor_benchlm_status(closed_table, open_table, models_meta)
    except Exception as e:
        print(f"  [BenchLM-monitor] failed (non-fatal): {e}")

    # Rescale non-0-100 benchmarks in all_results for per-benchmark display only
    # (pivot table already has correct scores from build_unified_table)
    for bname, bdata in list(all_results.items()):
        scale = _benchmark_scale(bname)
        if scale is None:
            continue
        all_s = [s for _, s in bdata["closed"] + bdata["open"]]
        if not all_s:
            continue
        all_results[bname] = {
            'closed': [(n, _rescale_score(s, bname, all_s)) for n, s in bdata["closed"]],
            'open': [(n, _rescale_score(s, bname, all_s)) for n, s in bdata["open"]],
        }

    # Format and display
    report = format_results(all_results, closed_table, open_table, all_benchmarks, avg_benchmarks)
    print("\n" + report)

    # Save JSON
    save_results_json(all_results, closed_table, open_table, all_benchmarks, avg_benchmarks,
                      models_meta=models_meta)

    # Providers catalog (pricing layer) — non-fatal, independent of benchmarks
    try:
        build_providers_json()
    except Exception as e:
        print(f"  [providers] catalog build failed (non-fatal): {e}")

    elapsed = time.time() - start_time
    print(f"  Total time: {elapsed:.1f}s")
    print()

    return report


if __name__ == "__main__":
    main()