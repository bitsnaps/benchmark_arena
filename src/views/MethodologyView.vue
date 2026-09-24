<script setup>
// Methodology (stats-45) — the plain-language contract: how this site is
// built and how to read every number it shows. Static content only — no
// store access — so the page renders even while the snapshot is swapping
// and can never drift with a data refresh. Every claim below mirrors the
// actual pipeline: scripts/bench_scraper.py (daily collect),
// scripts/merge_full_scrape_into_public.py (merge + retirement oracle),
// scripts/prepush.sh (gates), lib/benchScale.js + stores/data.js (Score),
// lib/format.js (price blend), lib/pivot.js (provider join).

// In-page jumps: the router uses hash history (#/...), so plain anchor
// hrefs would hijack the route. Scroll manually instead.
function jump(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>

<template>
  <section>
    <div class="page-head">
      <div class="kicker">How this works</div>
      <h1 class="section-title">Methodology</h1>
      <p class="section-sub">
        Where every number comes from, what it means, and what it deliberately doesn't claim.
        No black boxes — the same rules run on every page of this site.
      </p>
    </div>

    <div class="chips" style="margin-bottom:1.2rem">
      <span class="chip on"><i class="fas fa-diagram-project"></i>&nbsp; Pipeline</span>
      <span class="chip" role="button" tabindex="0" @click="jump('score')" @keydown.enter="jump('score')"><i class="fas fa-star-half-stroke"></i>&nbsp; Our Score</span>
      <span class="chip" role="button" tabindex="0" @click="jump('money')" @keydown.enter="jump('money')"><i class="fas fa-coins"></i>&nbsp; Price &amp; value</span>
      <span class="chip" role="button" tabindex="0" @click="jump('providers')" @keydown.enter="jump('providers')"><i class="fas fa-store"></i>&nbsp; Providers</span>
      <span class="chip" role="button" tabindex="0" @click="jump('honesty')" @keydown.enter="jump('honesty')"><i class="fas fa-scale-balanced"></i>&nbsp; Honesty rules</span>
    </div>

    <!-- ── 1. The pipeline ─────────────────────────────────────────── -->
    <h2 class="mh2">From public leaderboards to one snapshot</h2>
    <p class="mlead">
      Benchmark Arena is an aggregator, not an evaluator. We never run models ourselves — we read
      the public leaderboards that do, every day, and reconcile them into one snapshot you can
      actually compare across. Four steps, all automated, all gated:
    </p>
    <div class="grid-4">
      <div class="panel-lab mstep">
        <div class="mstep-n">1</div>
        <h3>Collect</h3>
        <p>A daily scraper reads 13 public leaderboards plus provider price catalogs —
          no logins, no paywalls. Every cell keeps its source; nothing is inferred
          between sources.</p>
      </div>
      <div class="panel-lab mstep">
        <div class="mstep-n">2</div>
        <h3>Merge</h3>
        <p>Everything is joined into one snapshot: one row per model, one column per
          benchmark, plus a provider availability catalog. Models match by exact
          normalized identifiers — never fuzzy guesses.</p>
      </div>
      <div class="panel-lab mstep">
        <div class="mstep-n">3</div>
        <h3>Gate</h3>
        <p>Before anything ships: unit tests, a data-leak guard (a retired model may not
          resurface), a production build, and browser end-to-end tests. A refresh that
          fails a gate is held back, not published.</p>
      </div>
      <div class="panel-lab mstep">
        <div class="mstep-n">4</div>
        <h3>Publish</h3>
        <p>The verified snapshot goes live as static JSON. After each deploy the live
          site is polled and re-verified against the same data. The timestamp in the
          footer is the snapshot's data date.</p>
      </div>
    </div>

    <!-- ── 2. Reading the leaderboard ──────────────────────────────── -->
    <h2 class="mh2" id="score">Reading the leaderboard</h2>
    <div class="grid-2">
      <div class="panel-lab mpanel">
        <h3><i class="fas fa-star-half-stroke"></i> Our Score — the ranking metric</h3>
        <p>
          Raw benchmark numbers live on incomparable scales (one leaderboard's median sits near
          83, another's near 26), so a plain average rewards <em>which</em> benchmarks a model
          took, not how strong it is. Our Score fixes both halves:
        </p>
        <ol>
          <li><strong>Harmonize each column.</strong> Every cell is z-normalized across all
            shipped models: 50 = the median model on that benchmark, +15 = one standard
            deviation better, clipped to 0–100. Now every column shares one scale.</li>
          <li><strong>Blend toward neutral for gaps.</strong> The Score averages the harmonized
            cells over the selected benchmarks and pulls uncovered ones to the neutral 50,
            weighted by how much the model actually reports:
            <div class="mformula mono">
              Score = w × mean(harmonized covered) + (1 − w) × 50,&nbsp; w = CL / 100
            </div></li>
        </ol>
        <p>
          The plain average of covered cells is still shown for reference ("Raw avg" tooltip) —
          it is just never the ranking number. Change the benchmark set and the Score, the ranks
          and the whole page follow.
        </p>
      </div>

      <div class="panel-lab mpanel">
        <h3><i class="fas fa-chart-simple"></i> Coverage Level (CL)</h3>
        <p>
          CL is the share of the selected benchmarks a model actually reports, from 0 to 100%.
          It is not a quality measure — it tells you how much evidence sits behind a row.
        </p>
        <ul>
          <li>Rows visually fade as CL drops, so thin data is obvious without hiding anything
            (full ≥ 87.5% · mid ≥ 62.5% · low ≥ 37.5% · minimal below).</li>
          <li>A dash means "no public score on any source we read". Absence of evidence is
            never rendered as a zero — a zero would be a fabrication.</li>
          <li>The CL column header counts the default 8-core set; pick a custom Avg set and CL
            is recomputed against your selection.</li>
        </ul>
      </div>

      <div class="panel-lab mpanel">
        <h3><i class="fas fa-layer-group"></i> Core vs context benchmarks</h3>
        <p>
          Eight benchmarks count toward the Score by default: Artificial Analysis, BenchLM.ai,
          Arena.ai Text, SimpleBench.com, ARC-AGI-2, Design Arena, SWE-Marathon and FrontierSWE —
          chosen to span reasoning, knowledge, human preference, agentic tool use and software
          engineering.
        </p>
        <p>
          The rest (DeepSWE, VendingBench, CyberGem, EQBench CW, LLM Chess) are
          <strong>context only</strong>: niche or thin-coverage evals you can browse per-benchmark
          on the Benchmarks page, or fold into the Score with the <em>Avg set</em> dropdown.
          Custom sets persist in your browser and are shareable via <span class="mono">?avg=</span>
          links — column headers are tagged "core" or "not counted" on hover.
        </p>
      </div>

      <div class="panel-lab mpanel">
        <h3><i class="fas fa-clock-rotate-left"></i> Tiers, ranks &amp; older versions</h3>
        <p>
          Closed-source and open-weight models rank independently — pick a tier tab and the rank
          numbers are honest for that tier. Ranks are computed among <strong>current-generation
          models only</strong>:
        </p>
        <ul>
          <li>A model is <em>superseded</em> when a newer version of the same product line exists
            in the catalog, and <em>stale</em> when it released ≥ 9 months before the newest
            snapshot release.</li>
          <li>Older models hide behind the <em>Older versions</em> toggle — never deleted. Shown,
            they rank at the bottom with no rank number and a dimmed bar.</li>
          <li>The <em>NEW</em> badge marks models released within a recency window you can widen
            or shrink; release dates come from the provider catalog.</li>
        </ul>
      </div>
    </div>

    <!-- ── 3. Price, value, latency ────────────────────────────────── -->
    <h2 class="mh2" id="money">Reading the money columns</h2>
    <div class="grid-3">
      <div class="panel-lab mpanel">
        <h3><i class="fas fa-coins"></i> Price</h3>
        <p>
          List API price per 1M tokens — what a seller publishes, not a negotiated rate. Source
          preference: the lab's own list price first (it excludes routing margin), otherwise the
          largest aggregator's catalog snapshot. Whichever fed the row is recorded so tooltips
          stay honest.
        </p>
        <p>
          The sortable headline is the conventional <strong>3:1 blend</strong>:
          <span class="mono">(3 × input + output) / 4</span> — most real traffic is input-heavy.
          Free listings count as $0; unpriced rows show a dash and are never assigned a price.
        </p>
      </div>

      <div class="panel-lab mpanel">
        <h3><i class="fas fa-balance-scale"></i> Value</h3>
        <p>
          Value = Score ÷ blended $/1M — benchmark points per dollar of API spend, higher is
          better. It is unbounded by design: a cheap capable model <em>should</em> dominate this
          lens, and frontier prices should sink.
        </p>
        <p>
          Two deliberate rules: free tiers resolve to a dash, not infinity (rate limits mean
          "free" ≠ unlimited free value), and the Value column follows your current Score —
          change the Avg set and value rankings move with it.
        </p>
      </div>

      <div class="panel-lab mpanel">
        <h3><i class="fas fa-gauge-high"></i> Latency (TTFT)</h3>
        <p>
          Median time-to-first-token as measured by Artificial Analysis, colored as a ladder:
          <span class="lat-fast">green</span> under 1.5 s ·
          <span class="lat-ok">amber</span> under 3.5 s ·
          <span class="lat-slow">red</span> at or above 3.5 s. It is a per-model property, so the
          same value rides along on every seller cell of that model. Unmeasured models stay
          uncolored — no invented latencies.
        </p>
      </div>
    </div>

    <!-- ── 4. Beyond the table ─────────────────────────────────────── -->
    <h2 class="mh2" id="providers">Beyond the table</h2>
    <div class="grid-2">
      <div class="panel-lab mpanel">
        <h3><i class="fas fa-store"></i> The Providers page</h3>
        <p>
          Providers is the <strong>availability layer</strong>: who sells which model, at what
          list price — completely independent of benchmark scores. Sourcing one model is often
          cheaper than owning one subscription; this is where you shop.
        </p>
        <ul>
          <li><strong>Compare tab</strong> — one row per canonical model, sellers side by side,
            cheapest cell highlighted. The join is exact: org prefixes stripped, separators
            ignored, and that is all. No fuzzy matching; a near-miss name stays its own honest
            row and the coverage line tells you so.</li>
          <li><strong>Free twins</strong> — a <span class="mono">:free</span> listing attaches to
            its paid listing as a free tier, it is not a separate model. Batch endpoints are
            discounted asynchronous offerings: separate rows, hidden behind a toggle.</li>
          <li><strong>By-provider tab</strong> — every seller's catalog exactly as published.
            <strong>My providers</strong> — your own quotes, stored only in your browser, never
            uploaded.</li>
        </ul>
      </div>

      <div class="panel-lab mpanel">
        <h3><i class="fas fa-compass"></i> Advisor &amp; Compare</h3>
        <p>
          The <strong>Advisor</strong> turns "what should I use for X?" into a ranked
          shortlist: pick a use case and priorities, get models scored for that job. It uses the
          exact same harmonized scoring core as the leaderboard — the two are parity-tested, so
          a recommendation can never quietly disagree with the table. Shareable views via URL
          parameters, like everything else here.
        </p>
        <p>
          <strong>Compare</strong> (the counter in the navbar) puts the models you tick
          side by side — scores, per-benchmark cells, prices, latency — for a direct
          head-to-head read.
        </p>
      </div>
    </div>

    <!-- ── 5. Honesty rules ────────────────────────────────────────── -->
    <h2 class="mh2" id="honesty">Honesty rules</h2>
    <div class="panel-lab mpanel">
      <div class="grid-2" style="gap:.2rem 2rem">
        <div class="kv"><span class="k">Dashes over guesses</span><span>No data is shown as "—", never as a zero, an imputed value or a copy of another column.</span></div>
        <div class="kv"><span class="k">Exact match over fuzzy</span><span>A near-miss model name is not a match. Joining is by normalized identifier only.</span></div>
        <div class="kv"><span class="k">Sources are read, never invented</span><span>No benchmark cell originates from a price catalog or another benchmark; OpenRouter-style catalogs enrich metadata only.</span></div>
        <div class="kv"><span class="k">Free ≠ unlimited</span><span>A free listing counts as $0 with its rate limits intact — we never promote it to "infinite value".</span></div>
        <div class="kv"><span class="k">Archived, not deleted</span><span>Superseded models stay reachable behind the Older-versions toggle, forever unranked.</span></div>
        <div class="kv"><span class="k">Retirement needs two proofs</span><span>A model is removed only when its scores vanish from every source <em>and</em> no seller still lists it at a price — sell-through churn alone doesn't erase a model.</span></div>
      </div>
      <div class="notice mt" style="margin-top:1rem">
        <strong>This is not an official ranking.</strong> It is an aggregate of public
        leaderboards, each with its own methodology, errors and blind spots. Use it to shortlist
        — then read the underlying evals before you commit real money or real code.
      </div>
    </div>

    <!-- ── 6. Freshness ────────────────────────────────────────────── -->
    <h2 class="mh2">Freshness &amp; verification</h2>
    <div class="panel-lab mpanel">
      <p>
        The site is a static snapshot refreshed daily through the gated pipeline above. The
        footer timestamp is the date of the data, not the deploy — an unchanged timestamp means
        the refresh was held back by a gate, and no update ships until it passes. After every
        deploy, the production site is re-verified against the same checks that gated the push.
      </p>
      <p>
        Nothing here is hidden in a database: the full snapshot is plain JSON served with the
        app — <span class="mono">benchmark_results.json</span> (scores, metadata, prices) and
        <span class="mono">providers.json</span> (the availability catalog). View-source
        friendly, diffable, and identical to what your browser renders.
      </p>
    </div>
  </section>
</template>

<style scoped>
.mh2 {
  margin: 1.8rem 0 .7rem;
  font-size: 1.12rem;
  font-weight: 700;
  /* fixed-top navbar would otherwise cover jumped-to headings */
  scroll-margin-top: 4.5rem;
}
.mlead {
  color: var(--muted);
  max-width: 56rem;
  margin-bottom: .9rem;
}
.mstep { padding: 1.05rem 1.1rem; }
.mstep h3 { margin: .2rem 0 .45rem; font-size: 1rem; }
.mstep p { color: var(--muted); font-size: .86rem; line-height: 1.5; margin: 0; }
.mstep-n {
  width: 26px; height: 26px; border-radius: 8px;
  display: grid; place-items: center;
  background: var(--teal-dim); color: var(--teal);
  font-weight: 800; font-size: .85rem;
}
.mpanel { padding: 1.2rem; }
.mpanel h3 { margin: 0 0 .6rem; font-size: 1rem; display: flex; align-items: center; gap: .5rem; }
.mpanel h3 i { color: var(--teal); font-size: .9rem; }
.mpanel p { color: var(--muted); font-size: .88rem; line-height: 1.55; }
.mpanel ul, .mpanel ol { color: var(--muted); font-size: .88rem; line-height: 1.55; padding-left: 1.2rem; margin: .5rem 0; }
.mpanel li { margin-bottom: .4rem; }
.mpanel li::marker { color: var(--teal); font-weight: 700; }
.mformula {
  margin: .55rem 0 .2rem; padding: .55rem .8rem;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--surface-2); color: var(--teal);
  font-size: .82rem; overflow-x: auto; white-space: nowrap;
}
.mono { font-family: 'IBM Plex Mono', monospace; font-size: .92em; }
.lat-fast { color: var(--teal); font-weight: 700; }
.lat-ok { color: var(--gold); font-weight: 700; }
.lat-slow { color: var(--rose); font-weight: 700; }
.chip { text-decoration: none; }
.mt { margin-top: 1rem; }
@media (max-width: 900px) {
  .mformula { white-space: normal; }
}
</style>
