#!/usr/bin/env python3
# stats-91: bake "creator-reported" benchmark scores onto the card_models
# census rows (vendor lane). Sources, in the priority order Ibrahim approved:
#   1. HF's structured eval system — README `model-index` metadata and
#      `.eval_results/*.yaml` files (only 4 census models carry any today)
#   2. The model card README's own benchmark tables (markdown pipes + HTML)
#   3. Nothing — gated cards (401) and table-less cards ship no scores, an
#      honest gap.
# RED LINES: scores land ONLY on card_models rows (the census namespace);
# ranked rows (unified_open/unified_closed) are never touched, so nothing
# can reach the Score/rank/avg-set math. The leak detector asserts that.
#
# CURATED contract: every extracted number is printed for review before the
# doc is committed; the script never guesses a benchmark name (it keeps the
# card's own wording, trimmed) and drops anything it cannot parse cleanly.
# Re-runnable: card READMEs are cached in scripts/.vendor_cache (gitignored).
#
# stats-96 (phase-2, the daily-refresh hook the stats-91 header promised):
# every card is sha-diffed against the HF repo's latest commit sha
# (api/models/{hf}.sha, fetched fresh daily — the plain fetch() cache never
# expires and would pin the sha forever). sha unchanged -> the cached card
# is reused and the row keeps its original vendor_extracted_at (content
# untouched = extraction date untouched). sha changed or first sight -> the
# card's cache files are busted, everything re-fetched/re-extracted, and
# the row is stamped today. .eval_results YAMLs ride the same repo sha, so
# one diff covers both sources.
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOC = os.path.join(REPO, "public", "benchmark_results.json")
CACHE = os.path.join(REPO, "scripts", ".vendor_cache")
UA = {"User-Agent": "Mozilla/5.0 (vendor-scores-bake)"}

# Cells that mean "no comparable score" in vendor tables.
DASH_RE = re.compile(r"^[\s\-–——*†‡.]*$")
# Benchmark-name labels that are table furniture, not benchmarks. Extended
# during the stats-91 review: spec rows (params/tokens/latency/price),
# behavior metrics (rate/ratio) and summary rows (average) all leaked as
# "scores" on first extraction.
FURNITURE_RE = re.compile(
    r"^(benchmark|metric|model(s)?|avg|average|overall|category|source|"
    r"license|context|window|notes?|rank|date|organization|org|vendor|"
    r"creator|release|links?|ref(erence)?s?)$",
    re.I,
)
FURNITURE_SUB_RE = re.compile(
    r"(params?|parameters?|tokens?|latency|ttft|seconds?|\(s\)|speed|"
    r"price|cost|billion|rate\b|ratio\b)",
    re.I,
)
# Param-size labels ("Hy 1.8B translation model") are spec rows, not evals.
PARAM_SIZE_RE = re.compile(r"\d+(?:\.\d+)?\s*[bB]\b")
# Trailing footnote references glued to labels ("BrowseComp 6",
# "WebTest 8 , 9") — never a 4-digit year ("AIME 2024") and never a
# version tail ("LiveCodeBench v6").
FOOTNOTE_RE = re.compile(r"(?<![vVwW])\s+\d{1,2}\s*(?:,\s*\d{1,2}\s*)*$")
# Strip markdown/HTML decoration from a cell down to its text.
TAG_RE = re.compile(r"<[^>]+>")
LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def clean_text(s):
    s = LINK_RE.sub(r"\1", s or "")
    s = TAG_RE.sub("", s)
    s = s.replace("&amp;", "&").replace("&#39;", "'")
    # stats-91 review fixes: markdown emphasis, arrow glyphs, footnote glue
    s = re.sub(r"[\u2197\u2192\u2190\u2193]", " ", s)  # ↗ → ← ↓ pointers
    s = s.replace("**", " ").replace("__", " ")
    s = re.sub(r"[\*`_]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def fetch(url, binary=False, fresh=False, retries=2, timeout=25):
    """Fetch with the workspace cache; returns None on any failure.
    fresh=True bypasses the cache READ (still writes it) — used for the
    daily sha probe, whose whole point is to notice upstream changes.
    stats-96: 429/5xx get a short backoff-retry (first seen 2026-11-22 when
    a 63-card probe burst tripped HF's unauthenticated budget and one missed
    .eval_results YAML cost Motif 3 its whole structured lane). Successes
    are cached, so a retry only ever re-costs the failed request.
    retries=0 for the sha probes — a failed probe is SAFE by design (cached
    fallback + TTL), and under throttle the backoff chain is what pushed
    whole bake windows past the 10-min cap.
    Negative responses are cached too, tiered: a 404 (no .eval_results dir —
    the steady state for most cards) is stable for 7 days, a 429/5xx only
    15 min; both markers die with the card's cache on a sha change. Without
    this every run re-fetched ~40 live 404s and the whole run stalled."""
    os.makedirs(CACHE, exist_ok=True)
    key = re.sub(r"[^a-zA-Z0-9._-]", "_", url.split("huggingface.co/", 1)[-1])
    path = os.path.join(CACHE, key)
    if not fresh and os.path.exists(path) and os.path.getsize(path) > 0:
        return open(path, "rb").read() if binary else open(path, encoding="utf-8", errors="ignore").read()
    marker = path + ".err"
    if not fresh and os.path.exists(marker):
        try:
            code, at = json.load(open(marker))
        except Exception:  # noqa: BLE001
            code, at = 0, 0
        ttl = 7 * 86400 if code == 404 else 900
        if time.time() - at < ttl:
            return None
    try:
        req = urllib.request.Request(url, headers=UA)
        data = None
        for attempt in range(retries + 1):
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                    time.sleep((5, 12)[min(attempt, 1)])
                    continue
                raise
        if data is None:
            return None
        open(path, "wb").write(data)
        if os.path.exists(marker):
            os.unlink(marker)
        return data if binary else data.decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        try:
            json.dump([e.code, time.time()], open(marker, "w"))
        except OSError:
            pass
        print(f"    fetch-fail {url.split('huggingface.co/')[-1]}: {e}")
        return None
    except Exception as e:
        try:
            json.dump([0, time.time()], open(marker, "w"))
        except OSError:
            pass
        print(f"    fetch-fail {url.split('huggingface.co/')[-1]}: {e}")
        return None


def api_json(url, fresh=False, retries=2, timeout=25):
    raw = fetch(url, fresh=fresh, retries=retries, timeout=timeout)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


# ── stats-96: sha-diff state ─────────────────────────────────────────

SHA_MAP = os.path.join(CACHE, "_sha_map.json")
# stats-96: live HF probes allowed per bake run — bounds a cold start (cache
# wiped by a recycle, or a brand-new card set) to ~20 x 10s of network worst
# case so the refresh window can never stall on throttled connections.
PROBE_BUDGET = 20


def _load_sha_map():
    try:
        return json.load(open(SHA_MAP, encoding="utf-8"))
    except Exception:  # noqa: BLE001 — missing/corrupt map = first sight
        return {}


def _save_sha_map(m):
    try:
        os.makedirs(CACHE, exist_ok=True)
        json.dump(m, open(SHA_MAP, "w", encoding="utf-8"), indent=1)
    except Exception as e:  # noqa: BLE001
        print(f"    [sha-map] write failed (non-fatal): {e}")


def bust_card_cache(hf):
    """Drop every cache file belonging to one HF repo (README raw, meta,
    .eval_results tree + YAMLs all key off the repo path prefix)."""
    prefix = re.sub(r"[^a-zA-Z0-9._-]", "_", hf)
    n = 0
    try:
        for f in os.listdir(CACHE):
            if f.startswith(prefix):
                os.unlink(os.path.join(CACHE, f))
                n += 1
    except OSError:
        pass
    return n


# ── source 1: HF structured eval system ────────────────────────────────

def hf_eval_scores(hf, meta=None):
    """model-index entries + .eval_results YAML files. Returns {bench: rec}.
    YAML docs are lists of {dataset:{id,task_id}, value, date, source{url,name}}
    (Motif-3 shape) — a top-level list parses to ONE list doc, so both a dict
    doc and items of a list doc are harvested. Per-score provenance (date,
    source url) is carried through — the structured lane's whole point.
    stats-96: `meta` may be pre-fetched by the caller (the sha probe already
    made the api/models call — never spend a second one)."""
    out = {}
    if meta is None:
        meta = api_json(f"https://huggingface.co/api/models/{hf}")
    if not meta:
        return out
    for e in meta.get("model-index") or []:
        for r in e.get("results") or []:
            task = (r.get("task") or {})
            tname = clean_text(str(task.get("name") or task.get("type") or ""))
            metric = (r.get("metric") or {})
            mname = clean_text(str(metric.get("name") or metric.get("type") or ""))
            bench = tname or mname
            v = r.get("value")
            if bench and isinstance(v, (int, float)):
                out.setdefault(bench, {"score": round(float(v), 2), "qualifier": "reported", "source": "hf-eval"})
    tree = api_json(f"https://huggingface.co/api/models/{hf}/tree/main/.eval_results")
    for f in tree or []:
        p = f.get("path") or ""
        if not p.endswith((".yaml", ".yml")):
            continue
        raw = fetch(f"https://huggingface.co/{hf}/raw/main/{p}")
        if not raw:
            continue
        try:
            import yaml
            docs = list(yaml.safe_load_all(raw))
        except Exception:
            docs = []
        flat = []
        for d in docs:
            if isinstance(d, list):
                flat.extend(x for x in d if isinstance(x, dict))
            elif isinstance(d, dict):
                flat.append(d)
        for d in flat:
            ds = d.get("dataset") if isinstance(d.get("dataset"), dict) else {}
            ds_id = str(ds.get("id") or d.get("dataset_id") or "")
            task = str(d.get("task_name") or d.get("task_id") or "")
            val = d.get("value")
            if not ds_id or not isinstance(val, (int, float)):
                continue
            tail = ds_id.split("/")[-1].replace("_", " ").strip()
            # dataset-id tails arrive lowercase ("gpqa", "hle", "aime 2026")
            # — short all-lower lead tokens read as acronyms: uppercase them
            m = re.match(r"^([a-z]{2,5})(\b.*)$", tail)
            if m:
                tail = m.group(1).upper() + m.group(2)
            bench = tail
            # short alphabetic task hints (gpqa + "diamond") sharpen the name
            if task and len(task) <= 12 and re.fullmatch(r"[a-z0-9_.%-]+", task.lower()) \
                    and task.lower() not in tail.lower() and "_" not in task:
                bench = f"{tail} ({task})"
            rec = {"score": round(float(val), 2), "qualifier": "reported", "source": "hf-eval"}
            if d.get("date"):
                rec["reported_date"] = str(d["date"])
            src = d.get("source") if isinstance(d.get("source"), dict) else {}
            if src.get("url"):
                rec["reported_url"] = str(src["url"])
            out.setdefault(bench, rec)
    return out


# ── source 2: the card README's own benchmark tables ───────────────────

NAME_CLEAN_RE = re.compile(r"[^a-z0-9]+")


def name_key(s):
    return NAME_CLEAN_RE.sub("", (s or "").lower())


def alias_keys(model_name):
    """All acceptable spellings of the model's own column/row header."""
    keys = {name_key(model_name)}
    # LongCat 2.0 card column says "LongCat-2.0"; Nex-N2.6 says "Nex-N2.6".
    # The punctuation-stripped key already folds those; also accept the
    # versioned tail variants ("LongCat2", "NexN2") the vendors use.
    base = re.sub(r"[\s]*v?\d+(\.\d+)*$", "", model_name).strip()
    if base:
        keys.add(name_key(base))
    return {k for k in keys if len(k) >= 4}


def parse_score(cell):
    """'88.9', '88.9*' (footnote cite), '**83.0**' (bold = emphasis, not cite).
    Citation detection reads the RAW cell: clean_text strips markdown
    emphasis, which would also erase genuine footnote markers. Bold pairs
    are removed first, then a remaining trailing single */† means cited."""
    raw = (cell or "")
    t = clean_text(cell)
    if DASH_RE.match(t) or not t:
        return None
    cited = bool(re.search(r"[*\u2020]\s*$", raw.replace("**", "")))
    m = re.search(r"-?\d+(?:\.\d+)?", t.replace(",", ""))
    if not m:
        return None
    v = float(m.group(0))
    if v < 0 or v > 100:
        return None
    return (round(v, 2), cited)


def bench_label(cell):
    t = clean_text(cell)
    t = FOOTNOTE_RE.sub("", t)
    t = t.strip(" :#*-↗")
    if not t or len(t) < 3 or len(t) > 60:
        return None
    if DASH_RE.match(t) or FURNITURE_RE.match(t.strip()):
        return None
    if FURNITURE_SUB_RE.search(t) or PARAM_SIZE_RE.search(t):
        return None
    if re.fullmatch(r"[\d.,%\s*†‡-]+", t):
        return None
    return t.strip(" :#*-")


def md_tables(text):
    """Group consecutive markdown pipe lines into tables (list of row-lists)."""
    tables, cur = [], []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("|") and s.endswith("|") and s.count("|") >= 2:
            cells = [c for c in s.strip("|").split("|")]
            if re.fullmatch(r"[\s:\-|]+", s):  # separator row
                continue
            cur.append(cells)
        else:
            if cur:
                tables.append(cur)
                cur = []
    if cur:
        tables.append(cur)
    return tables


def html_tables(text):
    tables = []
    for tb in re.findall(r"<table[^>]*>(.*?)</table>", text, re.S | re.I):
        rows = []
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tb, re.S | re.I):
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S | re.I)
            rows.append([TAG_RE.sub(" ", c) for c in cells])
        if rows:
            tables.append(rows)
    return tables


def extract_from_tables(tables, model_name):
    """Walk tables; find the model's own column (or row) and harvest scores."""
    found = {}
    keys = alias_keys(model_name)
    for rows in tables:
        if not rows:
            continue
        header = rows[0]
        # orientation A: models as columns, benchmarks as rows
        self_idx = next((i for i, h in enumerate(header) if name_key(clean_text(h)) in keys), None)
        if self_idx is not None and self_idx > 0:
            for r in rows[1:]:
                if len(r) <= self_idx:
                    continue
                b = bench_label(r[0])
                if not b:
                    continue
                sp = parse_score(r[self_idx])
                if sp:
                    found.setdefault(b, {"score": sp[0], "qualifier": "cited" if sp[1] else "in-house", "source": "card"})
            continue
        # orientation B: benchmarks as columns, models as rows. Accepted
        # only when it yields a real benchmark table (≥3 columns) — spec
        # sheets ("Model | params | langs") match this shape too and
        # poisoned the tencent cards on the first extraction pass.
        row_hit = next((r for r in rows if any(name_key(clean_text(c)) in keys for c in r[1:2] + r[:1])), None)
        if row_hit:
            cand = {}
            for i, c in enumerate(header[1:], start=1):
                b = bench_label(c)
                if not b or i >= len(row_hit):
                    continue
                sp = parse_score(row_hit[i])
                if sp:
                    cand.setdefault(b, {"score": sp[0], "qualifier": "cited" if sp[1] else "in-house", "source": "card"})
            if len(cand) >= 3:
                found.update(cand)
    return found


# ── main ───────────────────────────────────────────────────────────────

def main():
    apply = "--apply" in sys.argv
    doc = json.load(open(DOC, encoding="utf-8"))
    cards = doc.get("card_models") or []
    meta = doc.get("models_meta") or {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"card_models: {len(cards)}")
    sha_map = _load_sha_map()
    updated = 0
    n_changed = n_unchanged = 0
    n_probed = 0
    for row in cards:
        name = row.get("name") or ""
        hf = (meta.get(name) or {}).get("hugging_face_id")
        if not hf:
            print(f"  {name}: no HF id — skipped")
            continue
        # stats-96 sha probe: fresh daily, cache-read bypassed. A FAILED
        # probe (HF rate limit / network) must read as "unchanged" — never
        # re-stamp, never bust, and fall back to the last-good cached meta
        # so the structured lane survives a rate-limited window (first seen
        # minutes after a 63-card probe burst: 429s wiped hf-eval lanes).
        # Probe budget: one live probe per card per ~20h — retries, dry-runs
        # and same-day re-runs reuse the last-good sha with zero network
        # (first seen: backoff-retries under throttle pushed the whole bake
        # past the refresh's 10-min window).
        prev = sha_map.get(hf) or {}
        probed_now = False
        if (time.time() - (prev.get("probed_at") or 0)) < 20 * 3600 \
                and prev.get("sha"):
            sha = prev["sha"]
            card_meta = api_json(f"https://huggingface.co/api/models/{hf}")
            changed = False
        elif n_probed < PROBE_BUDGET:
            # stats-96: bounded live-probe budget per run — a cold start (new
            # card set, or the cache wiped by a sandbox recycle) must finish
            # inside the refresh's 10-min window. Cards past the budget ship
            # an honest gap this run; incremental map saves bank every
            # success, so the next window/daily run closes the rest.
            n_probed += 1
            card_meta = api_json(f"https://huggingface.co/api/models/{hf}",
                                 fresh=True, retries=0, timeout=10)
            sha = (card_meta or {}).get("sha") or ""
            probed_now = bool(sha)
            if not sha and prev.get("sha"):
                # last-good cached meta only — never a live stall here
                meta_cache = os.path.join(
                    CACHE, re.sub(r"[^a-zA-Z0-9._-]", "_",
                                  f"api/models/{hf}"))
                card_meta = json.load(open(meta_cache, encoding="utf-8")) \
                    if os.path.exists(meta_cache) else None
            sha = (card_meta or {}).get("sha") or ""
            changed = bool(sha) and prev.get("sha") != sha
        else:
            sha = prev.get("sha") or ""
            card_meta = api_json(f"https://huggingface.co/api/models/{hf}") \
                if prev.get("sha") else None
            changed = False
            if not prev.get("sha"):
                print(f"    probe budget spent — {hf} ships a gap this run")
        if changed and prev.get("sha"):
            n_busted = bust_card_cache(hf)
            print(f"    sha-diff: {hf} moved {prev['sha'][:7]} -> {sha[:7]} "
                  f"(cache busted: {n_busted} file(s))")
        elif not prev.get("sha"):
            print(f"    sha-diff: {hf} first sight (sha {sha[:7] or 'unavailable'})")
        scores = hf_eval_scores(hf, meta=card_meta)
        n_hf = len(scores)
        readme = fetch(f"https://huggingface.co/{hf}/raw/main/README.md")
        n_card = 0
        if readme:
            card = extract_from_tables(md_tables(readme) + html_tables(readme), name)
            # scale guard: card scores below 1.0 mean the vendor used a 0-1
            # (or mixed 0-1/0-10) scale (Ministral 3) — unnormalizable with
            # confidence, so the model's card lane ships nothing.
            if any(rec["score"] <= 1.0 for rec in card.values()):
                print(f"    scale-guard: dropping {len(card)} card scores (sub-1.0 value = mixed scale)")
                card = {}
            for b, rec in card.items():
                # structured HF eval data wins on name collisions (priority 1)
                scores.setdefault(b, rec)
            n_card = len(card)
        # sort for a stable, reviewable order
        row["vendor_scores"] = [
            {"benchmark": b, **scores[b]} for b in sorted(scores, key=str.lower)
        ]
        row["vendor_source_url"] = f"https://huggingface.co/{hf}"
        # stats-96: the stamp tracks card CONTENT — unchanged sha keeps the
        # original extraction date, a changed sha re-stamps today.
        extracted_at = today if changed else (prev.get("extracted_at") or today)
        row["vendor_extracted_at"] = extracted_at
        if sha:
            entry = {**prev, "sha": sha, "extracted_at": extracted_at}
            # probed_at tracks the last LIVE probe: refreshed when this run
            # actually probed, kept when the 20h TTL path reused the sha,
            # stamped now for a first success after earlier failures.
            entry["probed_at"] = (time.time() if (probed_now or not prev.get("probed_at"))
                                  else prev["probed_at"])
            sha_map[hf] = entry
            # stats-96: persist EVERY new probe (stats-65 lesson) — a killed
            # 10-min window used to lose the whole loop's probes because the
            # map only saved after it; incremental saves make repeated
            # windows converge on the full card set under HF throttling.
            if probed_now:
                _save_sha_map(sha_map)
        n_changed += 1 if changed else 0
        n_unchanged += 0 if changed else 1
        status = f"{len(row['vendor_scores'])} scores (hf-eval {n_hf}, card {n_card})"
        print(f"  {name}: {status}")
        updated += 1
        # stats-96: gentle inter-card gap — the fresh sha probes + README
        # fetches burst ~63 calls per run; spacing keeps the unauthenticated
        # HF budget from throttling mid-run (failures are safe now, but a
        # clean run beats a degraded one).
        time.sleep(0.3)
    _save_sha_map(sha_map)
    print(f"sha-diff census: {n_changed} changed/new, {n_unchanged} unchanged "
          f"(cached cards reused)")

    print(f"\nupdated {updated}/{len(cards)} card rows")
    print("\n── REVIEW: every extracted number ──")
    for row in cards:
        vs = row.get("vendor_scores") or []
        if not vs:
            continue
        print(f"\n{row['name']}  [{row['vendor_source_url']}]")
        for s in vs:
            print(f"    {s['benchmark']:34} {s['score']:>7}  {s['qualifier']}  ({s['source']})")

    if apply:
        json.dump(doc, open(DOC, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        open(DOC, "a", encoding="utf-8").write("\n")
        print("\ndoc APPLIED (vendor_scores baked onto card rows)")
    else:
        n = sum(len(r.get("vendor_scores") or []) for r in cards)
        print(f"\ndry-run only ({n} scores would be baked) — rerun with --apply")


if __name__ == "__main__":
    main()
