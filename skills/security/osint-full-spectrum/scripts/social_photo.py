#!/usr/bin/env python3
"""Social profile + photo finder v2 — stdlib only.

For a handle, harvests profile data and profile pictures across platforms.
Now with:
- Gravatar by handle (returns displayName + photo hash)
- AppVerse developer page (tokenportal.id owner-confirmation pivot)
- GitLab API avatar (via Gravatar hash)
- Google Avatar size-bump to 2048px
- Facebook signed og:image (extract full signed URL + referer)
- Telegram profile photo check (tgme_page_photo element)
- Projects.co.id soft-404 detection
- AI-generated face warning (visual analysis hint printed)

Usage:
  python social_photo.py someuser
  python social_photo.py --url https://example.com/somepage
  python social_photo.py --handle someuser --reverse-face https://pbs.twimg.com/...jpg
"""
import sys, re, json, os, urllib.parse, hashlib, struct
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

PLATFORMS = [
    ("GitHub",     "https://github.com/{h}"),
    ("Telegram",   "https://t.me/{h}"),
    ("Facebook",   "https://www.facebook.com/{h}"),
    ("Instagram",  "https://www.instagram.com/{h}/"),
    ("TikTok",     "https://www.tiktok.com/@{h}"),
    ("X",          "https://x.com/{h}"),
    ("Pinterest",  "https://www.pinterest.com/{h}/"),
    ("YouTube",    "https://www.youtube.com/@{h}"),
    ("GitLab",     "https://gitlab.com/api/v4/users?username={h}"),
    ("Gravatar",   "https://gravatar.com/{h}.json"),
    ("AppVerse",   "https://appverse.id/developers/{h}"),
    ("ProjectsID", "https://projects.co.id/public/user/view/1/{h}"),
]


def fetch(url, timeout=15, referer=None):
    headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(800000).decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        body = (e.read(400000).decode("utf-8", "replace") if e.fp else "")
        return e.code, body, dict(e.headers) if hasattr(e, "headers") else {}
    except Exception as e:
        return 0, str(e), {}


def og(html):
    out = {}
    for prop in ("og:title", "og:description", "og:image", "og:url", "profile:username"):
        m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']+)' % prop,
                      html or "", re.I)
        if not m:
            m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']%s' % prop,
                          html or "", re.I)
        if m:
            out[prop] = m.group(1)
    return out


def download_img(url, dest, referer=None):
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        if len(data) < 500:
            return 0
        # verify JPEG magic
        if not (data[:2] == b'\xff\xd8' or data[:4] == b'\x89PNG' or data[:4] == b'RIFF'):
            return 0
        with open(dest, "wb") as f:
            f.write(data)
        # get dimensions
        if data[:2] == b'\xff\xd8':
            # JPEG: scan SOF markers
            i = 2
            while i < len(data) - 9:
                if data[i] != 0xFF: break
                marker = data[i+1]
                seglen = struct.unpack(">H", data[i+2:i+4])[0]
                if marker in (0xC0, 0xC2):
                    h, w = struct.unpack(">HH", data[i+5:i+9])
                    return f"{len(data)} bytes {w}x{h}"
                i += 2 + seglen
        return f"{len(data)} bytes"
    except Exception as e:
        return f"0 ({str(e)[:50]})"


def harvest_gravatar(handle):
    """Fetch Gravatar by handle, return (name, photo_url_512)."""
    st, body, _ = fetch(f"https://gravatar.com/{handle}.json")
    if st != 200:
        return None, None
    try:
        d = json.loads(body)
        entry = d.get("entry", [{}])[0]
        name = entry.get("displayName") or entry.get("preferredUsername") or ""
        hash_ = entry.get("hash") or entry.get("requestHash", "")
        photo = entry.get("thumbnailUrl") or f"https://2.gravatar.com/avatar/{hash_}"
        # request 512px
        if "?" in photo:
            photo = re.sub(r's=\d+', 's=512', photo)
        else:
            photo += "?s=512"
        return name, photo
    except Exception:
        return None, None


def harvest_appverse(handle):
    """AppVerse dev page → person name + Google avatar URL."""
    st, body, _ = fetch(f"https://appverse.id/developers/{handle}")
    if st != 200 or "not found" in body.lower():
        return None, None
    # extract name from <title>
    ti = re.findall(r'<title>([^<]+)', body)
    name = ti[0].split(" - ")[0].strip() if ti else ""
    # extract sameAs links
    sameas = re.findall(r'sameAs"\s*:\s*\[([^\]]+)\]', body)
    socials = []
    for blk in sameas[:2]:
        socials += re.findall(r'"(https?://[^"]+)"', blk)
    # google avatar: lh3.googleusercontent.com
    ga = re.findall(r'(https://lh3\.googleusercontent\.com/a/[A-Za-z0-9_-]+)', body)
    if ga:
        gurl = ga[0]
        # try size bump to 2048
        gurl_2048 = gurl + ("&" if "?" in gurl else "?") + "s=2048"
        # actually lh3 uses =s2048 suffix
        if "=s" in gurl:
            gurl_2048 = re.sub(r'=\s*s\d+[-c]*', '=s2048', gurl)
        else:
            gurl_2048 = gurl + "=s2048"
        return name, gurl_2048, socials
    return name, None, socials


def harvest_gitlab(handle):
    """GitLab API user → name + avatar."""
    st, body, _ = fetch(f"https://gitlab.com/api/v4/users?username={handle}")
    if st != 200:
        return None, None
    try:
        users = json.loads(body)
        if not users:
            return None, None
        u = users[0]
        return u.get("name"), u.get("avatar_url")
    except Exception:
        return None, None


def harvest_facebook_signed_og(handle):
    """Facebook: fetch page, extract full signed og:image URL, download with referer."""
    url = f"https://www.facebook.com/{handle}"
    st, body, _ = fetch(url)
    if st != 200:
        return None, None
    m = re.search(r'og:image["\'] content=["\']([^"\']+)', body)
    if not m:
        return None, None
    og_img = m.group(1).replace("&amp;", "&")
    return og_img, url


def check_telegram_photo(handle):
    """Return True if t.me page has tgme_page_photo (profile pic present)."""
    st, body, _ = fetch(f"https://t.me/{handle}")
    return st == 200 and "tgme_page_photo" in (body or "")


def detect_soft404_projects(body):
    """Projects.co.id returns 200 with 'Not Found' in body."""
    return body and ("Not Found" in body or "tidak ditemukan" in body.lower())


def print_photo_report(label, url, meta, st, body):
    """Print platform result, extract and download photos."""
    low = (body or "").lower()
    notfound = any(x in low for x in ("not found", "couldn't find", "isn't available",
                                      "page not found", "doesn't exist", "user profile not found"))
    wall = any(x in low for x in ("log in", "sign up", "log into"))

    if st != 200:
        print(f"\n[{label}] HTTP {st}")
        return

    if label == "ProjectsID" and detect_soft404_projects(body):
        print(f"\n[{label}] HTTP 200 (soft-404: user not found)")
        return

    print(f"\n[{label}] HTTP {st}")
    print(f"   url : {url}")
    if meta:
        for k, v in meta.items():
            print(f"   {k:16s} {v[:130]}")


def main():
    handle, url = None, None
    reverse_face_url = None
    a = sys.argv[1:]
    i = 0
    while i < len(a):
        if a[i] == "--url" and i + 1 < len(a):
            url = a[i + 1]; i += 2; continue
        if a[i] == "--reverse-face" and i + 1 < len(a):
            reverse_face_url = a[i + 1]; i += 2; continue
        if a[i] in ("--handle", "-h") and i + 1 < len(a):
            handle = a[i + 1].lstrip("@"); i += 2; continue
        if not handle and not a[i].startswith("-"):
            handle = a[i].lstrip("@")
        i += 1

    outdir = os.path.join(os.path.expanduser("~"), "osint_photos")
    os.makedirs(outdir, exist_ok=True)

    print("=" * 65)
    print("SOCIAL PROFILE + PHOTO FINDER v2")
    print("=" * 65)

    # ============ GRAVATAR ============
    if handle:
        print("\n" + "-" * 65)
        print("[GRAVATAR by handle]")
        name, photo = harvest_gravatar(handle)
        if name:
            print(f"   displayName: {name}")
            print(f"   photo 512 : {photo}")
            dest = os.path.join(outdir, f"gravatar_{handle}.jpg")
            n = download_img(photo, dest)
            print(f"   saved     : {dest} ({n})")
        else:
            print("   not found")

    # ============ APPVERSE (person-confirmation pivot) ============
    if handle:
        print("\n" + "-" * 65)
        print("[APPVERSE developer page — person-confirmation pivot]")
        try:
            av = harvest_appverse(handle)
            if av and len(av) >= 2:
                name, gurl, socials = av
                print(f"   name      : {name}")
                if gurl:
                    print(f"   avatar    : {gurl}")
                    dest = os.path.join(outdir, f"appverse_{handle}.jpg")
                    n = download_img(gurl, dest)
                    print(f"   saved     : {dest} ({n})")
                    if socials:
                        print(f"   sameAs    : {len(socials)} links")
                        for s in socials[:10]:
                            print(f"     - {s[:120]}")
        except Exception as e:
            print(f"   error: {e}")

    # ============ GITLAB ============
    if handle:
        print("\n" + "-" * 65)
        print("[GITLAB API]")
        gl_name, gl_avatar = harvest_gitlab(handle)
        if gl_name:
            print(f"   name      : {gl_name}")
            print(f"   avatar    : {gl_avatar}")
            if gl_avatar:
                dest = os.path.join(outdir, f"gitlab_{handle}.jpg")
                n = download_img(gl_avatar, dest)
                print(f"   saved     : {dest} ({n})")
        else:
            print("   not found")

    # ============ FACEBOOK (signed og:image) ============
    if handle:
        print("\n" + "-" * 65)
        print("[FACEBOOK — signed og:image]")
        fb_og, fb_url = harvest_facebook_signed_og(handle)
        if fb_og:
            print(f"   og:image  : {fb_og[:130]}...")
            dest = os.path.join(outdir, f"facebook_{handle}.jpg")
            n = download_img(fb_og, dest, referer=fb_url)
            print(f"   saved     : {dest} ({n})")
        else:
            print("   not found")

    # ============ TELEGRAM profile photo ============
    if handle:
        has_photo = check_telegram_photo(handle)
        if has_photo:
            print(f"\n[Telegram] {handle}: HAS profile photo (tgme_page_photo present)")
        else:
            print(f"\n[Telegram] {handle}: no profile photo (only tgme_page_icon)")

    # ============ OG scrape per-platform ============
    if handle:
        print("\n" + "=" * 65)
        print("[OG:image per-platform]")
        tg_has_photo = check_telegram_photo(handle)
        for label, tmpl in PLATFORMS:
            tgt = tmpl.format(h=handle)
            st, body, headers = fetch(tgt)
            meta = og(body)
            print_photo_report(label, tgt, meta, st, body)
            # download og:image on clean 200
            if meta.get("og:image") and st == 200:
                low = (body or "").lower()
                if any(x in low for x in ("not found", "login", "sign up")):
                    pass
                elif label == "Telegram" and not tg_has_photo:
                    # placeholder: t.me always serves telegram logo og:image
                    print(f"   (skipped: Telegram placeholder logo, no profile photo)")
                elif "telegram.org" in meta["og:image"]:
                    print(f"   (skipped: Telegram platform logo, not a user photo)")
                else:
                    dest = os.path.join(outdir, f"{label.lower()}_{handle}.jpg")
                    n = download_img(meta["og:image"], dest)
                    if n and not n.startswith("0"):
                        print(f"   saved     : {dest} ({n})")

    if url:
        print("\n" + "=" * 65)
        print(f"[Custom URL] {url}")
        st, body, _ = fetch(url)
        meta = og(body)
        for k, v in meta.items():
            print(f"   {k:16s} {v[:130]}")
        if meta.get("og:image") and st == 200:
            dest = os.path.join(outdir, "custom_og.jpg")
            n = download_img(meta["og:image"], dest)
            print(f"   saved     : {dest} ({n})")

    # ============ Reverse face hint ============
    if reverse_face_url:
        print("\n" + "=" * 65)
        print(f"[Reverse face search hint]")
        print(f"  URL: {reverse_face_url}")
        print(f"  Yandex: https://yandex.com/images/search?rpt=imageview&url={urllib.parse.quote(reverse_face_url, safe='')}")
        print(f"  Google: https://lens.google.com/uploadbyurl?url={urllib.parse.quote(reverse_face_url, safe='')}")
        print(f"  TinEye: https://tineye.com/search?url={urllib.parse.quote(reverse_face_url, safe='')}")

    print("\n" + "=" * 65)
    print(f"Photos saved under: {outdir}")
    print("=" * 65)


if __name__ == "__main__":
    main()
