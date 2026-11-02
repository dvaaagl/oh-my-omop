#!/usr/bin/env python3
"""Email OSINT sweeper — stdlib only.

Usage:  python email_osint.py user@example.com
"""
import sys, re, json, hashlib
import urllib.request, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http(url, timeout=8, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(300000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read(300000).decode("utf-8", "replace") if e.fp else "")
    except Exception as e:
        return 0, str(e)


def strip_html(s):
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s)


def main():
    if len(sys.argv) < 2:
        print("usage: python email_osint.py <email>"); return
    email = sys.argv[1].strip().lower()
    local = email.split("@")[0]
    domain = email.split("@")[-1]
    print("=" * 60)
    print("EMAIL OSINT:", email)
    print("=" * 60)

    # --- Gravatar ---
    h = hashlib.md5(email.encode()).hexdigest()
    st, body = http("https://gravatar.com/%s.json" % h)
    try:
        d = json.loads(body)
        e = (d.get("entry") or [{}])[0]
        print("\n[Gravatar  ] HTTP %s" % st)
        print("  displayName:", e.get("displayName"))
        print("  profileUrl :", e.get("profileUrl"))
        print("  aboutMe    :", (e.get("aboutMe") or "")[:120])
        for u in (e.get("urls") or []):
            print("  url        :", u.get("value"))
        for a in (e.get("accounts") or []):
            print("  account    : %s/%s" % (a.get("shortname"), a.get("username")))
        print("  avatar     : https://gravatar.com/avatar/%s?s=500" % h)
    except Exception:
        print("\n[Gravatar  ] no profile (HTTP %s)" % st)

    # --- Breach ---
    st, body = http("https://api.xposedornot.com/v1/breach-analytics?email=" + urllib.parse.quote(email))
    try:
        d = json.loads(body)
        br = d.get("ExposedBreaches") or {}
        sites = br.get("breaches_details") or []
        print("\n[Breaches  ] %d breach(es)" % len(sites))
        for s in sites[:20]:
            print("  -", s.get("breach"), s.get("xposed_data", ""))
        ps = d.get("ExposedPastes") or {}
        pastes = ps.get("pastes_details") or []
        if pastes:
            print("[Pastes    ] %d paste(s)" % len(pastes))
            for p in pastes[:10]:
                print("  -", p.get("domain"), p.get("date"))
    except Exception:
        print("\n[Breaches  ] unparsed (HTTP %s)" % st)

    # --- search ---
    print("\n[Search DDG]")
    for q in ('"%s"' % email, '"%s"' % local + " osint"):
        st, body = http("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(q), timeout=6)
        hits = re.findall(r'result__a[^>]*>([^<]+)<', body or "")
        print("  %-32s -> %d %s" % (q[:32], len(hits), hits[:3]))

    # --- github by local-part ---
    st, body = http("https://api.github.com/users/" + urllib.parse.quote(local))
    try:
        d = json.loads(body)
        if d.get("login"):
            print("\n[GitHub    ] %s (%s) repos=%s" %
                  (d.get("login"), d.get("name"), d.get("public_repos")))
    except Exception:
        pass

    print("\n[Suggested pivots]")
    print("  handle   -> python handle_osint.py %s" % local)
    print("  domain   -> python domain_osint.py %s" % domain)
    print("=" * 60)


if __name__ == "__main__":
    main()
