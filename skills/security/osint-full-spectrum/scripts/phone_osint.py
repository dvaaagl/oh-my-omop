#!/usr/bin/env python3
"""Phone OSINT sweeper — stdlib only.

Usage:  python phone_osint.py 6285187434760
        python phone_osint.py 0851-8743-4760
"""
import sys, re, json, hashlib
import urllib.request, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def normalize(raw):
    d = re.sub(r"\D", "", raw)
    if d.startswith("0"):
        d = "62" + d[1:]
    elif d.startswith("8"):
        d = "62" + d
    elif d.startswith("62"):
        pass
    return d


def variants(nat):
    local = "0" + nat[2:]
    spaced = "0%s-%s-%s" % (nat[2:5], nat[5:9], nat[9:]) if len(nat) >= 12 else local
    return {"nat": nat, "local": local, "spaced": spaced,
            "plus": "+" + nat, "wa": "wa.me/" + nat}


def http(url, timeout=8, method="GET", data=None, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(200000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(200000).decode("utf-8", "replace") if e.fp else ""
    except Exception as e:
        return 0, str(e)


def status_only(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


def strip_html(s):
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s)


def main():
    if len(sys.argv) < 2:
        print("usage: python phone_osint.py <number>"); return
    nat = normalize(sys.argv[1])
    v = variants(nat)
    print("=" * 60)
    print("PHONE OSINT:", v["nat"], "(local", v["local"], ")")
    print("=" * 60)

    # --- WhatsApp presence ---
    wa = status_only("https://wa.me/" + nat)
    print("\n[WhatsApp ] wa.me/%s -> HTTP %s  %s" %
          (nat, wa, "ACTIVE" if wa == 200 else "unknown/absent"))

    # --- Telegram ---
    st, body = http("https://t.me/+" + nat)
    title = re.search(r"<title>([^<]*)</title>", body or "")
    print("[Telegram ] t.me/+%s -> %s" % (nat, title.group(1) if title else "no title"))

    # --- Caller-ID / spam DBs ---
    checks = [
        ("tellows", "https://www.tellows.com/num/%s" % nat),
        ("whocalld", "https://whocalld.com/phone/%s" % nat),
        ("spamcalls", "https://spamcalls.net/en/search?q=%s" % nat),
        ("who-called", "https://who-called.me/%s" % v["local"]),
        ("telpon.info", "https://www.telpon.info/%s" % v["local"]),
        ("sync.me", "https://sync.me/search/?number=%s" % urllib.parse.quote("+" + nat)),
        ("callapp", "https://callapp.com/api/v1/search?phone=%s" % urllib.parse.quote("+" + nat)),
        ("getcontact", "https://getcontact.com/en/profile/%s" % nat),
    ]
    print("\n[Caller-ID DBs]")
    for name, url in checks:
        code, body = http(url)
        txt = strip_html(body).lower() if body else ""
        flags = []
        for kw in ("no user report", "no reports", "unknown", "not found", "404",
                   "telkomsel", "indonesia", "spam risk", "rating"):
            if kw in txt:
                flags.append(kw)
        print("  %-12s HTTP %-3s %s" % (name, code, ",".join(flags[:4]) if flags else "-"))

    # --- breach / leak (free) ---
    st, body = http("https://api.xposedornot.com/v1/breach-analytics?email=%s@telkomsel.co.id" % nat)
    try:
        d = json.loads(body)
        b = (d.get("BreachesSummary") or {}).get("site", "")
        p = (d.get("PastesSummary") or {}).get("cnt", 0)
        print("\n[Breach    ] xposedornot -> breaches='%s' pastes=%s" % (b, p))
    except Exception:
        print("\n[Breach    ] xposedornot -> unparsed (HTTP %s)" % st)

    # --- Gravatar by phone (md5) ---
    for lbl, val in (("nat", nat), ("local", v["local"])):
        h = hashlib.md5(val.encode()).hexdigest()
        st, body = http("https://gravatar.com/%s.json" % h)
        try:
            d = json.loads(body)
            name = (d.get("entry") or [{}])[0].get("displayName")
            if name:
                print("[Gravatar  ] %s -> %s" % (lbl, name))
        except Exception:
            pass

    # --- search (DDG html; empty = no footprint) ---
    print("\n[Search DDG]")
    for q in ('"%s"' % v["local"], '"%s"' % nat, '"%s"' % v["spaced"], '"wa.me/%s"' % nat):
        try:
            st, body = http("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q), timeout=6)
        except Exception:
            st, body = 0, ""
        hits = re.findall(r'result__a[^>]*>([^<]+)<', body or "")
        print("  %-28s -> %d result(s) %s" % (q, len(hits), hits[:2] if hits else ""))

    print("\n" + "=" * 60)
    print("VERDICT: cross-check hits above. All-empty => digital ghost.")
    print("=" * 60)


if __name__ == "__main__":
    main()
