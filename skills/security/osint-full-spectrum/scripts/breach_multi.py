#!/usr/bin/env python3
"""Multi-mirror breach / leak cross-checker — stdlib only.

Queries several free / partially-free breach & leak sources for one identifier
(email or phone) and consolidates the results. Where a source needs an API key,
pass it via env var and it is used automatically.

Usage:
  python breach_multi.py user@example.com
  python breach_multi.py 6285187434760

Env (optional):
  XPOSEDORNOT  (no key needed)
  LEAKCHECK    leakcheck.io API key
  INTELX       intelx.io API key
  HIBP         haveibeenpwned.com API key
"""
import sys, os, json, re
import urllib.request, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http(url, timeout=20, headers=None, data=None, method="GET"):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(500000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read(200000).decode("utf-8", "replace") if e.fp else "")
    except Exception as e:
        return 0, str(e)


def xposedornot(q):
    st, body = http("https://api.xposedornot.com/v1/breach-analytics?email=" + urllib.parse.quote(q))
    try:
        d = json.loads(body)
        br = (d.get("ExposedBreaches") or {}).get("breaches_details") or []
        pa = (d.get("ExposedPastes") or {}).get("pastes_details") or []
        return "breaches=%d pastes=%d" % (len(br), len(pa)), [b.get("breach") for b in br]
    except Exception:
        return "unparsed (HTTP %s)" % st, []


def hibp(q):
    key = os.environ.get("HIBP")
    if not key:
        return "no HIBP key (set env HIBP)", []
    st, body = http("https://haveibeenpwned.com/api/v3/breachedaccount/" + urllib.parse.quote(q),
                    headers={"hibp-api-key": key})
    if st == 404:
        return "clean (no breach)", []
    if st == 200:
        try:
            d = json.loads(body)
            return "%d breach(es)" % len(d), [b.get("Name") for b in d]
        except Exception:
            return "200 unparsed", []
    return "HTTP %s" % st, []


def leakcheck(q):
    key = os.environ.get("LEAKCHECK")
    if not key:
        return "no LEAKCHECK key", []
    st, body = http("https://leakcheck.io/api/v2/query/" + urllib.parse.quote(q),
                    headers={"X-API-Key": key})
    try:
        d = json.loads(body)
        found = d.get("found", 0)
        srcs = [s.get("name") for s in (d.get("sources") or [])]
        return "found=%s" % found, srcs
    except Exception:
        return "HTTP %s" % st, []


def intelx(q):
    key = os.environ.get("INTELX")
    if not key:
        return "no INTELX key", []
    st, body = http("https://2.intelx.io/phonebook/search?k=" + key, method="POST",
                    data=json.dumps({"term": q, "maxresults": 20,
                                     "media": 0, "target": 0}).encode(),
                    headers={"Content-Type": "application/json"})
    try:
        d = json.loads(body)
        return "id=%s" % d.get("id"), []
    except Exception:
        return "HTTP %s" % st, []


def main():
    if len(sys.argv) < 2:
        print("usage: python breach_multi.py <email|phone>"); return
    q = sys.argv[1].strip()
    print("=" * 60)
    print("MULTI-MIRROR BREACH CHECK:", q)
    print("=" * 60)

    sources = [
        ("xposedornot", xposedornot),
        ("haveibeenpwned", hibp),
        ("leakcheck", leakcheck),
        ("intelx", intelx),
    ]
    any_hit = False
    for name, fn in sources:
        try:
            summary, detail = fn(q)
        except Exception as e:
            summary, detail = "error: %s" % e, []
        if detail:
            any_hit = True
        print("\n[%s] %s" % (name, summary))
        for d in detail[:25]:
            print("   -", d)

    print("\n" + "=" * 60)
    print("VERDICT:", "BREACH DATA FOUND" if any_hit else
          "no free-source breach hit (consider paid DeHashed/IntelX/Snusbase)")
    print("=" * 60)


if __name__ == "__main__":
    main()
