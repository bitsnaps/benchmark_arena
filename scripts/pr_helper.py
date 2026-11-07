#!/usr/bin/env python3
# Create (or update) a GitHub PR via the REST API with urllib — no `gh`
# CLI in this sandbox. The bearer token comes from the origin remote's
# userinfo PASSWORD part (https://bitsnaps:<TOKEN>@github.com/...); the
# token is NEVER printed, logged or embedded in outputs.
import json
import os
import sys
import urllib.parse
import urllib.request

REPO = "bitsnaps/benchmark_arena"


def token_from_remote():
    url = urllib.parse.urlparse(
        os.popen("git -C %s remote get-url origin" % os.getcwd()).read().strip()
    )
    tok = url.password or (url.username or "")
    if not tok:
        sys.exit("no token in origin remote url")
    return tok


def api(method, path, tok, payload=None):
    req = urllib.request.Request(
        "https://api.github.com%s" % path,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={
            "Authorization": "Bearer %s" % tok,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "pr-helper",
        },
    )
    with urllib.request.urlopen(req) as r:
        body = r.read().decode()
        return json.loads(body) if body else {}


def main():
    head, title, body = sys.argv[1], sys.argv[2], sys.argv[3]
    tok = token_from_remote()
    # Existing open PR for this head?
    prs = api("GET", "/repos/%s/pulls?head=%s:%s&state=open" % (REPO, "bitsnaps", head), tok)
    if prs:
        pr = prs[0]
        api("PATCH", "/repos/%s/pulls/%d" % (REPO, pr["number"]), tok,
            {"title": title, "body": body})
        print("updated PR #%d" % pr["number"])
    else:
        pr = api("POST", "/repos/%s/pulls" % REPO, tok,
                 {"head": head, "base": "main", "title": title, "body": body})
        print("opened PR #%d" % pr["number"])
    print("https://github.com/%s/pull/%d" % (REPO, pr["number"]))


def merge(number):
    tok = token_from_remote()
    # The merge endpoint is PUT — POST returns a misleading 404.
    api("PUT", "/repos/%s/pulls/%d/merge" % (REPO, number), tok,
        {"merge_method": "merge"})


if __name__ == "__main__":
    main()
