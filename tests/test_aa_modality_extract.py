#!/usr/bin/env python3
"""stats-76 self-test for the AA modality probe type contract in
scripts/bench_scraper.py. Plain-assert, no framework — run:

    python3 tests/test_aa_modality_extract.py

Exits non-zero on any failure.

Background: load_and_eval JSON-parses the agent-browser eval result. The
modality probe JS used to return a joined string, which the eval plumbing
delivered as a fully-parsed FAQPage DICT whenever the page carried a single
ld+json script — and aa_page_modalities demanded a str, so EVERY probe
returned (None, None) and the negative cache tombstoned the whole AA
modality ladder (2026-11-11: 63 fresh probes, 0 positives; guard floors
blocked the ship). The fix returns JSON.stringify(parts) from the JS and
normalizes all three observed shapes in _faqpage_probe_text before the
classic regexes run.

Real-page fixture captured live from artificialanalysis.ai on 2026-11-11
(Claude Opus 4.5 (Non-reasoning): text+image input, text output).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
from bench_scraper import (  # noqa: E402
    _AA_LDJSON_ANSWER_RES,
    _faqpage_probe_text,
    parse_aa_modality_answer,
)


FAQ_NAME_IN = "What input modalities does Claude Opus 4.5 (Non-reasoning) support?"
FAQ_ANS_IN = "Claude Opus 4.5 (Non-reasoning) supports text and image input."
FAQ_NAME_OUT = "What output modalities does Claude Opus 4.5 (Non-reasoning) support?"
FAQ_ANS_OUT = "Claude Opus 4.5 (Non-reasoning) supports text output."
FAQ_OTHER = ("When was Claude Opus 4.5 (Non-reasoning) released?",
             "Claude Opus 4.5 (Non-reasoning) was released on November 24, 2025.")


def run_regexes(text):
    """The exact post-normalize extraction aa_page_modalities performs."""
    inp = out = None
    m = _AA_LDJSON_ANSWER_RES["input"].search(text)
    if m:
        inp = parse_aa_modality_answer(m.group(1).replace('\\"', '"'), "input")
    m = _AA_LDJSON_ANSWER_RES["output"].search(text)
    if m:
        out = parse_aa_modality_answer(m.group(1).replace('\\"', '"'), "output")
    return (inp or None, out or None)


def raw_script(name_in=FAQ_NAME_IN, ans_in=FAQ_ANS_IN,
               name_out=FAQ_NAME_OUT, ans_out=FAQ_ANS_OUT):
    """One raw ld+json FAQPage script text, quotes JSON-escaped like a
    browser textContent smuggled through eval."""
    page = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": FAQ_OTHER[0],
             "acceptedAnswer": {"@type": "Answer", "text": FAQ_OTHER[1]}},
            {"@type": "Question", "name": name_in,
             "acceptedAnswer": {"@type": "Answer", "text": ans_in}},
            {"@type": "Question", "name": name_out,
             "acceptedAnswer": {"@type": "Answer", "text": ans_out}},
        ],
    }
    # compact separators: real ld+json textContent is compact, and the
    # extraction regexes are built against exactly that shape
    return json.dumps(page, separators=(",", ":"))


def test_dict_shape_single_faqpage():
    """THE BUG: load_and_eval fully parses a single FAQPage into a dict.
    _faqpage_probe_text must re-serialize mainEntity into regex-ready text."""
    data = json.loads(raw_script())
    text = _faqpage_probe_text(data)
    assert '"name":"What input modalities' in text.replace(": ", ":", 1) or \
        '"name": "What input modalities' not in text, "sanity: questions re-serialized"
    got = run_regexes(text)
    assert got == (["text", "image"], ["text"]), f"dict shape -> {got}"


def test_list_shape_stringified_parts():
    """stats-76 JS returns JSON.stringify(parts); load_and_eval unwraps to a
    list of script texts (possibly several ld+json blocks per page)."""
    data = [raw_script(), raw_script(name_in="x", ans_in="y")]
    text = _faqpage_probe_text(data)
    got = run_regexes(text)
    assert got == (["text", "image"], ["text"]), f"list shape -> {got}"


def test_str_shape_legacy():
    """Legacy contract: a raw joined script string goes straight to regex."""
    text = _faqpage_probe_text(raw_script())
    got = run_regexes(text)
    assert got == (["text", "image"], ["text"]), f"str shape -> {got}"


def test_str_shape_escaped_quotes_in_answer():
    """Answer text containing quotes survives the eval round-trip escaped;
    both the str replace path and the dict json.dumps path must agree."""
    ans = 'Model X supports text and image input ("multimodal" per vendor).'
    got_str = run_regexes(_faqpage_probe_text(
        '{"name":"What input modalities does Model X support?",'
        '"acceptedAnswer":{"@type":"Answer","text":"'
        + ans.replace('"', '\\"') + '"}}'))
    got_dict = run_regexes(_faqpage_probe_text({
        "mainEntity": [{"name": "What input modalities does Model X support?",
                        "acceptedAnswer": {"@type": "Answer", "text": ans}}]}))
    assert got_str == got_dict == (["text", "image"], None), \
        f"escape divergence: str={got_str} dict={got_dict}"


def test_dict_without_modality_questions():
    """FAQPage carrying only unrelated questions -> honest negative."""
    data = {"@type": "FAQPage", "mainEntity": [
        {"name": FAQ_OTHER[0], "acceptedAnswer": {"text": FAQ_OTHER[1]}}]}
    got = run_regexes(_faqpage_probe_text(data))
    assert got == (None, None), f"unrelated FAQ -> {got}"


def test_no_usable_data_never_crashes():
    """None (page 404), empty, wrong types -> (None, None), no exceptions."""
    for bad in (None, "", [], {}, 42, {"mainEntity": None},
                {"mainEntity": "not-a-list"}, [None, 7, ""]):
        got = run_regexes(_faqpage_probe_text(bad))
        assert got == (None, None), f"{bad!r} -> {got}"


def test_audio_token_canonical_order():
    """Multi-token answers scan in SECONDARY_TOKENS canonical order."""
    got = run_regexes(_faqpage_probe_text({
        "mainEntity": [
            {"name": "What input modalities does M support?",
             "acceptedAnswer": {"text": "M supports text, audio and image input."}},
            {"name": "What output modalities does M support?",
             "acceptedAnswer": {"text": "M supports text and audio output."}},
        ]}))
    assert got == (["text", "image", "audio"], ["text", "audio"]), f"order -> {got}"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok: {fn.__name__}")
    print(f"ALL PASS ({len(fns)} cases)")
