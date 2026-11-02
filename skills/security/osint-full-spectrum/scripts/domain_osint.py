#!/usr/bin/env python3
"""Domain / IP OSINT — stdlib only.

DNS (via Google DoH), RDAP, crt.sh, robots/well-known, JS bundle email grep.

Usage:  python domain_osint.py example.com
"""
import sys, re, json
import urllib.request, urllib.parse

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def http(url, timeout=25, headers=None):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(500000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, (e.read(500000).decode("utf-8", "replace") if e.fp else "")
    except Exception as e:
        return 0, str(e)


def dns(name, rtype):
    try:
        st, body = http("https://dns.google/resolve?name=%s&type=%s" % (name, rtype))
        d = json.loads(body)
        return [a.get("data") for a in d.get("Answer", [])]
    except Exception:
        return []


def main():
    if len(sys.argv) < 2:
        print("usage: python domain_osint.py <domain|ip>"); return
    dom = sys.argv[1].strip().lower().replace("https://", "").replace("http://", "").split("/")[0]
    tld = dom.split(".")[-1]
    print("=" * 60)
    print("DOMAIN OSINT:", dom)
    print("=" * 60)

    # --- DNS ---
    print("\n[DNS]")
    for rt in ("A", "AAAA", "NS", "MX", "TXT", "CNAME"):
        recs = dns(dom, rt)
        if recs:
            print("  %-5s %s" % (rt, "; ".join(str(r)[:120] for r in recs[:5])))

    # --- RDAP ---
    print("\n[RDAP]")
    rdap_urls = []
    if tld == "id":
        rdap_urls = ["https://rdap.pandi.id/domain/" + dom]
    rdap_urls.append("https://rdap.org/domain/" + dom)
    for u in rdap_urls:
        st, body = http(u)
        if st == 200:
            try:
                d = json.loads(body)
                print("  source:", u)
                for ev in d.get("events", []):
                    print("  %-14s %s" % (ev.get("eventAction"), ev.get("eventDate")))
                for ent in d.get("entities", []):
                    roles = ",".join(ent.get("roles", []))
                    vcard = ent.get("vcardArray", [None, []])[1] if ent.get("vcardArray") else []
                    vals = [v[3] for v in vcard if len(v) > 3]
                    print("  entity %-12s %s" % (roles, " | ".join(str(x)[:80] for x in vals[:4])))
                print("  status:", d.get("status"))
                break
            except Exception:
                pass

    # --- crt.sh subdomains ---
    print("\n[crt.sh subdomains]")
    st, body = http("https://crt.sh/?q=" + urllib.parse.quote("%." + dom) + "&output=json", timeout=45)
    try:
        d = json.loads(body)
        names = set()
        for row in d:
            for n in (row.get("name_value") or "").split("\n"):
                n = n.strip().lower()
                if n and "*" not in n:
                    names.add(n)
        for n in sorted(names)[:40]:
            print("  ", n)
        print("  total:", len(names))
    except Exception:
        print("  crt.sh unavailable")

    # --- paths + email grep ---
    print("\n[Path / email grep]")
    emails = set()
    for path in ("", "robots.txt", "sitemap.xml", ".well-known/security.txt",
                 "contact", "about", "privacy", "terms", "docs"):
        st, body = http("https://%s/%s" % (dom, path), timeout=15)
        if not body:
            continue
        found = re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", body)
        for f in found:
            if not f.lower().endswith((".png", ".jpg", ".svg", ".gif", ".webp")):
                emails.add(f)
    for e in sorted(emails):
        print("  ", e)
    if not emails:
        print("   (none)")

    # --- JS bundles ---
    st, home = http("https://" + dom, timeout=15)
    if home:
        bundles = set(re.findall(r'src=["\']([^"\']+\.js[^"\']*)["\']', home)) | \
                  set(re.findall(r'href=["\']([^"\']+\.js[^"\']*)["\']', home))
        print("\n[JS bundles] %d found" % len(bundles))
        for b in list(bundles)[:8]:
            u = b if b.startswith("http") else "https://%s/%s" % (dom, b.lstrip("/"))
            st, js = http(u, timeout=15)
            found = re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", js or "")
            for f in set(found):
                if not f.lower().endswith((".png", ".js", ".css")):
                    print("   JS email:", f)

    print("\n[NEXT] run: python oauth_email_hunt.py %s   (owner email via consent screen)" % dom)
    print("[NEXT] run: python cf_origin_finder.py %s   (origin IP behind Cloudflare)" % dom)
    print("=" * 60)


if __name__ == "__main__":
    main()
