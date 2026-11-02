#!/usr/bin/env python3
"""Handle / username OSINT — stdlib only.

Usage:  python handle_osint.py someuser
"""
import sys, re, json
import urllib.request, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http(url, timeout=18, headers=None):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(400000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read(400000).decode("utf-8", "replace") if e.fp else "")
    except Exception as e:
        return 0, str(e)


def main():
    if len(sys.argv) < 2:
        print("usage: python handle_osint.py <username>"); return
    h = sys.argv[1].strip().lstrip("@")
    print("=" * 60)
    print("HANDLE OSINT:", h)
    print("=" * 60)

    # --- platform probes ---
    checks = [
        ("Telegram", "https://t.me/%s" % h),
        ("GitHub", "https://api.github.com/users/%s" % h),
        ("Gravatar", "https://gravatar.com/%s.json" % h),
        ("Reddit", "https://www.reddit.com/user/%s/about.json" % h),
        ("Pastebin", "https://pastebin.com/u/%s" % h),
        ("TikTok", "https://www.tiktok.com/@%s" % h),
        ("Instagram", "https://www.instagram.com/%s/" % h),
        ("X", "https://x.com/%s" % h),
        ("Keybase", "https://keybase.io/_/api/1.0/user/lookup.json?username=%s" % h),
        ("Steam", "https://steamcommunity.com/id/%s" % h),
    ]
    print("\n[Platforms]")
    soft = {
        "Instagram": ["isn't available", "page not found", "sorry, this page"],
        "TikTok": ["couldn't find this account", "page not available", "captcha"],
        "Steam": ["the specified profile could not be found"],
        "Pastebin": ["not found", "does not exist"],
        "Keybase": ['"status":{"code":205'],
    }
    for name, url in checks:
        st, body = http(url)
        note = ""
        low = (body or "").lower()
        if name in soft and any(s in low for s in soft[name]):
            note = "NOT FOUND (soft-200)"
        elif name == "GitHub":
            try:
                d = json.loads(body)
                note = "%s repos=%s" % (d.get("name"), d.get("public_repos"))
            except Exception:
                note = "not found"
        elif name == "Gravatar":
            try:
                d = json.loads(body)
                note = (d.get("entry") or [{}])[0].get("displayName") or "profile"
            except Exception:
                note = "none"
        elif name == "Reddit" and st == 200:
            note = "exists"
        elif name == "Telegram":
            m = re.search(r"<title>([^<]*)</title>", body or "")
            note = m.group(1) if m else ""
        print("  %-10s HTTP %-4s %s" % (name, st, note))

    # --- search ---
    print("\n[Search DDG]")
    for q in ('"%s"' % h, '"%s" -site:telegram.org' % h):
        st, body = http("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q), timeout=6)
        hits = re.findall(r'result__a[^>]*>([^<]+)<', body or "")
        print("  %-24s -> %d %s" % (q[:24], len(hits), hits[:3]))
    print("=" * 60)


if __name__ == "__main__":
    main()
