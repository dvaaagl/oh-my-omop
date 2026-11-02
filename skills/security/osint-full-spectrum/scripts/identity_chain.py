#!/usr/bin/env python3
"""Identity confirmation chain — stdlib only.

Links a handle/domain across developer-marketplace / profile platforms that
expose schema.org `sameAs`, so ONE person can be confirmed across many sites.

This is the chain that turns "a username" into "a real named person".

Seed it with a handle OR a domain. It probes the profile-URL patterns used by
common ID dev marketplaces, then harvests schema.org sameAs / Person blocks.

Usage:
  python identity_chain.py bambangnurdiann
  python identity_chain.py --domain tokenportal.id --handle bambangnurdiann
"""
import sys, re, json
import urllib.request, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# profile URL patterns: (label, template with {h})
PROFILE_PATTERNS = [
    ("appverse",      "https://appverse.id/developers/{h}"),
    ("github",        "https://github.com/{h}"),
    ("linkedin",      "https://www.linkedin.com/in/{h}"),
    ("projects.co.id","https://www.projects.co.id/user/{h}"),
    ("p-store",       "https://p-store.net/{h}"),
    ("gitlab",        "https://gitlab.com/{h}"),
    ("medium",        "https://medium.com/@{h}"),
    ("about.me",      "https://about.me/{h}"),
    ("gravatar",      "https://gravatar.com/{h}.json"),
    ("keybase",       "https://keybase.io/{h}"),
]


def http(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(400000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read(400000).decode("utf-8", "replace") if e.fp else ""
        except Exception:
            body = ""
        return e.code, body
    except Exception as e:
        return 0, str(e)


def extract_jsonld(html):
    blocks = []
    for m in re.finditer(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                         html or "", re.S | re.I):
        try:
            blocks.append(json.loads(m.group(1).strip()))
        except Exception:
            pass
    return blocks


def _aslist(v):
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    if isinstance(v, (list, tuple)):
        return [x for x in v if isinstance(x, str)]
    return []


def harvest(html, base):
    """Return (names, sameAs, emails, socials) found in HTML + JSON-LD."""
    names, same_as, emails, socials = set(), set(), set(), set()
    for b in extract_jsonld(html):
        items = b if isinstance(b, list) else [b]
        for it in items:
            if not isinstance(it, dict):
                continue
            for k in ("name", "alternateName"):
                if it.get(k):
                    names.add(str(it[k]))
            for s in _aslist(it.get("sameAs")):
                same_as.add(s)
                socials.add(s)
            if it.get("@type") in ("Person", "Organization"):
                for u in _aslist(it.get("url")):
                    same_as.add(u)
    # clean escapes + filter junk single chars
    def clean(s):
        return s.replace("\\", "").strip()
    same_as = {clean(s) for s in same_as if len(clean(s)) > 3}
    socials = {clean(s) for s in socials if len(clean(s)) > 3}
    # plain-text emails
    for e in re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", html or ""):
        el = e.lower()
        if el.endswith((".png", ".jpg", ".svg", ".gif", ".webp", ".js", ".css")):
            continue
        if any(j in el for j in ("sentry", "youremail@", "example.", "w3.org",
                                 "schema.org", "noreply", "@mail.com")):
            continue
        emails.add(e)
    # social links
    for m in re.finditer(r'https?://(?:www\.)?(linkedin\.com/in/[^"\'\\>\s]+|github\.com/[^"\'\\>\s]+|'
                         r'instagram\.com/[^"\'\\>\s]+|x\.com/[^"\'\\>\s]+|twitter\.com/[^"\'\\>\s]+|'
                         r't\.me/[^"\'\\>\s]+)', html or ""):
        socials.add(m.group(1))
    socials = {clean(s) for s in socials if len(clean(s)) > 3}
    return names, same_as, emails, socials


def main():
    handle = None
    domain = None
    a = sys.argv[1:]
    i = 0
    while i < len(a):
        if a[i] == "--handle" and i + 1 < len(a):
            handle = a[i + 1]; i += 2; continue
        if a[i] == "--domain" and i + 1 < len(a):
            domain = a[i + 1]; i += 2; continue
        if not handle and not domain and not a[i].startswith("-"):
            handle = a[i]
        i += 1

    print("=" * 60)
    print("IDENTITY CONFIRMATION CHAIN")
    print("  handle:", handle or "-", "| domain:", domain or "-")
    print("=" * 60)

    all_names, all_same, all_emails, all_socials = set(), set(), set(), set()
    found_platforms = []

    if handle:
        print("\n[Profile probes: %s]" % handle)
        for label, tmpl in PROFILE_PATTERNS:
            url = tmpl.format(h=handle)
            st, body = http(url)
            if st != 200:
                print("  %-14s HTTP %s" % (label, st))
                continue
            low = (body or "").lower()
            if any(x in low for x in ("isn't available", "page not found",
                                      "couldn't find", "not found", "404 not found")):
                print("  %-14s HTTP 200  (soft-404)" % label)
                continue
            n, s, e, soc = harvest(body, url)
            nm = ",".join(sorted(n))[:70]
            print("  %-14s HTTP 200  name=%s sameAs=%d email=%d" %
                  (label, nm or "-", len(s), len(e)))
            # only count as CONFIRMED if the page actually yielded identity data —
            # HTTP 200 with empty harvest = soft-404 / generic shell (learned: a
            # non-existent projects.co.id user returns 200 + empty body)
            if n or s or e or soc:
                found_platforms.append(label)
            all_names |= n; all_same |= s; all_emails |= e; all_socials |= soc

    if domain:
        print("\n[Domain probes: %s]" % domain)
        paths = ["", "about", "team", "contact"]
        if handle:
            paths.append("developers/" + handle)
        for path in paths:
            url = "https://%s/%s" % (domain, path)
            st, body = http(url)
            if st != 200:
                continue
            n, s, e, soc = harvest(body, url)
            if n or s or e:
                print("  /%-18s name=%s sameAs=%d email=%d" %
                      (path, ",".join(n) or "-", len(s), len(e)))
            all_names |= n; all_same |= s; all_emails |= e; all_socials |= soc

    print("\n" + "=" * 60)
    print("CONSOLIDATED IDENTITY")
    print("  names    :", ", ".join(sorted(all_names)) or "(none)")
    print("  emails   :", ", ".join(sorted(all_emails)) or "(none)")
    print("  sameAs   :")
    for s in sorted(all_same):
        print("     -", s)
    print("  socials  :")
    for s in sorted(all_socials):
        print("     -", s)
    print("  platforms confirmed:", ", ".join(found_platforms) or "(none)")
    print("=" * 60)


if __name__ == "__main__":
    main()
