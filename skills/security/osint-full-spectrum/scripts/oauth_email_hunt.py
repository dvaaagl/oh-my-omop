#!/usr/bin/env python3
"""OAuth owner-email hunter — stdlib only.

Finds the OWNER email of a domain/product by probing OAuth consent screens.
The Google OAuth consent page exposes the project's supportEmail, which is very
often the founder's personal Gmail. This is the single highest-value OSINT pivot
for a product domain.

Usage:  python oauth_email_hunt.py example.com
"""
import sys, re
import urllib.request, urllib.parse, ssl

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PATHS = ["auth/google", "auth/google/callback", "oauth/google", "auth/google/login",
         "login/google", "api/auth/google", "auth/github", "auth/microsoft",
         "oauth/authorize", "auth/signin", "api/auth/signin/google"]

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
CLIENT_RE = re.compile(r"client_id=([0-9a-zA-Z_.-]+)")


def http(url, timeout=20, follow=True):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect if not follow else urllib.request.HTTPRedirectHandler,
                                         urllib.request.HTTPSHandler(context=ctx))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        r = opener.open(req, timeout=timeout)
        return r.status, dict(r.headers), r.read(400000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), (e.read(400000).decode("utf-8", "replace") if e.fp else "")
    except Exception as e:
        return 0, {}, str(e)


def main():
    if len(sys.argv) < 2:
        print("usage: python oauth_email_hunt.py <domain>"); return
    dom = sys.argv[1].strip().lower().replace("https://", "").replace("http://", "").split("/")[0]
    print("=" * 60)
    print("OAUTH OWNER-EMAIL HUNT:", dom)
    print("=" * 60)

    client_ids = set()
    redirects = set()

    for p in PATHS:
        url = "https://%s/%s" % (dom, p)
        st, hdr, body = http(url, follow=False)
        loc = hdr.get("Location", "") or hdr.get("location", "")
        if st in (301, 302, 303, 307, 308) and loc:
            print("\n[%s] -> %s %s" % (p, st, loc[:160]))
            redirects.add(loc)
            m = CLIENT_RE.search(loc)
            if m:
                client_ids.add(m.group(1))
        elif st == 200 and body:
            m = CLIENT_RE.search(body)
            if m:
                client_ids.add(m.group(1))
                print("\n[%s] 200 client_id=%s" % (p, m.group(1)))
            if "accounts.google.com" in body or "oauth" in body.lower():
                print("[%s] 200 oauth reference in page" % p)
        else:
            print("[%s] HTTP %s" % (p, st))

    # --- follow Google OAuth authorize URLs and harvest emails ---
    print("\n[Google consent]")
    gurls = [r for r in redirects if "accounts.google.com" in r or "oauth" in r]
    for u in gurls:
        st, hdr, body = http(u, follow=True)
        print("  %s -> HTTP %s" % (u[:90], st))
        emails = set(EMAIL_RE.findall(body or ""))
        for e in emails:
            if not any(x in e.lower() for x in ("example.", "sentry", "w3.org", "schema.org")):
                print("    EMAIL:", e)
        # app name + support email often in consent HTML
        for m in re.finditer(r'(support|contact)[^<]{0,40}?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', body or "", re.I):
            print("    SUPPORT-EMAIL:", m.group(2))

    # --- directly build the authorize URL from a discovered client_id ---
    for cid in client_ids:
        auth = ("https://accounts.google.com/o/oauth2/v2/auth?client_id=%s"
                "&redirect_uri=https://%s/auth/google/callback"
                "&response_type=code&scope=openid%%20email%%20profile&prompt=select_account" % (cid, dom))
        st, hdr, body = http(auth, follow=True)
        print("\n[auth-url] client_id=%s -> HTTP %s" % (cid, st))
        for e in set(EMAIL_RE.findall(body or "")):
            if not any(x in e.lower() for x in ("example.", "sentry", "w3.org", "schema.org", "google.com")):
                print("    EMAIL:", e)

    if not client_ids:
        print("\n  no client_id discovered — try /auth/google manually in a browser")
    print("\n[HOW TO FINISH]")
    print("  1. open the discovered accounts.google.com URL in a browser (not logged in)")
    print("  2. on the consent screen, the 'App name' + support email is shown")
    print("  3. that support email = owner/founder → pivot: Gravatar md5 → LinkedIn/GitHub")
    print("=" * 60)


if __name__ == "__main__":
    main()
