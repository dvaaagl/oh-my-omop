#!/usr/bin/env python3
"""
osint_full.py — unified OSINT sweeper. stdlib only (urllib/socket/ssl).

Auto-detects the target kind and runs every vector for it:
  phone | email | domain | url | ip | handle

  python3 osint_full.py 6285187434760
  python3 osint_full.py user@example.com
  python3 osint_full.py example.com --json out.json
  python3 osint_full.py 1.2.3.4 --ports
  python3 osint_full.py somehandle

Rule of the game: PIVOT, don't search. Engines don't index phones/emails;
caller-ID DBs, Gravatar, OAuth consent, RDAP, cert transparency hold first-party data.
Empty across every source = "digital ghost" — report that, do not invent.
"""
import argparse
import concurrent.futures as cf
import gzip
import hashlib
import html as htmlmod
import ipaddress
import json
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
TIMEOUT = 12
MAXB = 1_500_000
LOCK = threading.Lock()

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
KEY_RE = re.compile(
    r"(sk-[A-Za-z0-9_\-]{16,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_\-]{30,}"
    r"|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9\-]{10,}"
    r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,})")


# ------------------------------------------------------------------ http
def req(url, timeout=TIMEOUT, headers=None, method="GET", data=None, maxb=MAXB):
    """-> (status, body_bytes, headers_dict). status 0 = transport error."""
    h = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(r, timeout=timeout, context=ctx) as resp:
            body = resp.read(maxb)
            if resp.headers.get("Content-Encoding") == "gzip":
                try:
                    body = gzip.decompress(body)
                except Exception:
                    pass
            return resp.status, body, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read(maxb)
        except Exception:
            pass
        return e.code, body, {k.lower(): v for k, v in (e.headers or {}).items()}
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}".encode(), {}


def txt(b):
    return b.decode("utf-8", "replace") if isinstance(b, (bytes, bytearray)) else str(b)


def jget(url, timeout=TIMEOUT):
    st, b, h = req(url, timeout=timeout, headers={"Accept": "application/json"})
    if st != 200:
        return None
    try:
        return json.loads(txt(b))
    except Exception:
        return None


def jina(url, timeout=25):
    """JS-walled page -> markdown via r.jina.ai (prefix baris Title/URL/Content dibuang)."""
    st, b, _ = req("https://r.jina.ai/" + url, timeout=timeout)
    if st != 200:
        return ""
    md = txt(b)
    md = re.sub(r"(?m)^(Title|URL Source|Image Source|Markdown Content|Warning):.*$", "", md)
    md = re.sub(r"(?m)^(!\[.*?\]\(.*?\))\s*$", "", md)
    return md.strip()


def strip_tags(s):
    s = re.sub(r"<script.*?</script>", " ", s, flags=re.S | re.I)
    s = re.sub(r"<style.*?</style>", " ", s, flags=re.S | re.I)
    return re.sub(r"\s+", " ", htmlmod.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def og(s, prop):
    m = re.search(r'<meta[^>]+property=["\']%s["\'][^>]+content=["\']([^"\']*)' % re.escape(prop),
                  s, re.I | re.S)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']%s["\']' % re.escape(prop),
                      s, re.I | re.S)
    return htmlmod.unescape(m.group(1)).strip() if m else ""


# ------------------------------------------------------------------ report
class Report:
    def __init__(self, target, kind):
        self.target, self.kind = target, kind
        self.rows = []          # (section, key, value)
        self.sources = set()
        self.t0 = time.time()

    def add(self, section, key, value):
        if value in (None, "", [], {}):
            return
        v = re.sub(r"\s+", " ", str(value)).strip()
        if not v or v in ("0 ", "None"):
            return
        with LOCK:
            self.rows.append((section, str(key), v))
            self.sources.add(section)

    def dump(self):
        out, cur = [], None
        for sec, k, v in self.rows:
            if sec != cur:
                out.append(f"\n### {sec}")
                cur = sec
            out.append(f"  {k:<26} {v}")
        return "\n".join(out)

    def json(self):
        d = {}
        for sec, k, v in self.rows:
            d.setdefault(sec, {})[k] = v
        return {"target": self.target, "kind": self.kind,
                "sources_hit": sorted(self.sources), "data": d}


# ------------------------------------------------------------------ detect
PHONE_CHARS = re.compile(r"^[\+\d][\d\s\-\(\)\.]{6,}$")


def detect(target):
    t = target.strip()
    if re.match(r"^https?://", t):
        return "url"
    if "@" in t and EMAIL_RE.fullmatch(t.split("?")[0]) and " " not in t:
        return "email"
    try:
        ipaddress.ip_address(t)
        return "ip"
    except ValueError:
        pass
    if PHONE_CHARS.match(t) and len(re.sub(r"\D", "", t)) >= 8:
        return "phone"
    if re.fullmatch(r"(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}", t):
        return "domain"
    return "handle"


# ------------------------------------------------------------------ shared bits
def dns_query(name, rtype):
    d = jget(f"https://dns.google/resolve?name={urllib.parse.quote(name)}&type={rtype}")
    if not d:
        return []
    return [a.get("data", "").rstrip(".") for a in d.get("Answer", [])]


def dns_chain(rep, domain):
    for rt in ("A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "CAA", "SRV"):
        vals = dns_query(domain, rt)
        if vals:
            rep.add("dns", rt, " | ".join(vals[:6]))
    for rt in ("_dmarc." + domain, "default._domainkey." + domain, "google._domainkey." + domain):
        vals = dns_query(rt, "TXT")
        for v in vals:
            if "v=DMARC" in v or "v=DKIM" in v or "k=" in v:
                rep.add("dns-verify", rt, v[:220])
    spf = [v for v in dns_query(domain, "TXT") if "v=spf1" in v]
    for s in spf:
        rep.add("dns-verify", "SPF", s[:220])
    # reverse dns on resolved A records
    for a in dns_query(domain, "A")[:3]:
        try:
            rep.add("dns", "PTR " + a, socket.gethostbyaddr(a)[0])
        except Exception:
            pass


def whois_raw(query, server):
    try:
        with socket.create_connection((server, 43), timeout=10) as s:
            s.sendall((query + "\r\n").encode())
            data = b""
            while len(data) < 400_000:
                ch = s.recv(8192)
                if not ch:
                    break
                data += ch
        return txt(data)
    except Exception as e:
        return f"(whois {server} gagal: {e})"


WH_KEYS = {
    "Registrar:": "registrar", "Registrar Name:": "registrar", "Sponsoring Registrar:": "registrar",
    "Creation Date:": "created", "Created On:": "created", "Domain Registration Date:": "created",
    "Registry Expiry Date:": "expires", "Expiration Date:": "expires", "Registry Expiry Date": "expires",
    "Updated Date:": "updated", "Registrant Name:": "registrant",
    "Registrant Organization:": "registrant-org", "Registrant Email:": "registrant-email",
    "Registrant Country:": "registrant-country", "Registrant State/Province:": "registrant-state",
    "Registrant City:": "registrant-city", "Registrant Street:": "registrant-street",
    "Registrant Phone:": "registrant-phone", "Admin Email:": "admin-email", "Tech Email:": "tech-email",
    "Name Server:": "ns", "Status:": "status", "Domain Status:": "status",
}


def _parse_whois(rep, raw):
    for line in raw.splitlines():
        line = line.strip()
        if ":" not in line or line.startswith("%") or line.startswith("#"):
            continue
        k, v = line.split(":", 1)
        k, v = (k.strip() + ":"), v.strip()
        if k in WH_KEYS and v and v.lower() not in ("redacted for privacy", "not disclosed"):
            rep.add("whois", WH_KEYS[k], v)


def whois_domain(rep, domain):
    tld = domain.rsplit(".", 1)[-1]
    ref = whois_raw(tld, "whois.iana.org")            # IANA: query = TLD saja
    m = re.search(r"(?im)^whois:\s*(\S+)", ref)
    srv = m.group(1) if m else ""
    if srv:
        rep.add("whois", "registry server", srv)
        raw = whois_raw(domain, srv)
        _parse_whois(rep, raw)
        # thin registry -> lanjut ke registrar whois buat data registrant
        m2 = re.search(r"(?im)^\s*Registrar WHOIS Server:\s*(\S+)", raw)
        if m2:
            r2 = m2.group(1).strip()
            if r2 and r2.lower() != srv.lower() and "iana.org" not in r2:
                rep.add("whois", "registrar server", r2)
                _parse_whois(rep, whois_raw(domain, r2))
    if "whois" not in rep.sources:
        rep.add("whois", "hasil", "registry tidak balikin field yang bisa diparse")


def rdap_domain(rep, domain):
    d = jget(f"https://rdap.org/domain/{domain}")
    if not d:
        return
    rep.add("rdap", "handle", d.get("handle"))
    for ev in d.get("events", []) or []:
        rep.add("rdap", ev.get("eventAction", "event"), ev.get("eventDate", ""))
    for e in d.get("entities", []) or []:
        roles = ",".join(e.get("roles", []) or [])
        v = e.get("vcardArray", [None, []])
        fields = {}
        for item in (v[1] if len(v) > 1 and v[1] else []):
            if isinstance(item, list) and len(item) >= 4:
                fields[item[0]] = item[3]
        name = fields.get("fn") or fields.get("org")
        if name:
            rep.add("rdap", f"entity ({roles})", str(name))
        if fields.get("email"):
            rep.add("rdap", f"email ({roles})", fields["email"])
    for ns in d.get("nameservers", []) or []:
        rep.add("rdap", "ns", ns.get("ldhName"))
    for s in d.get("status", []) or []:
        rep.add("rdap", "status", s)


HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?)+$")


def crt_subdomains(rep, domain):
    d = jget(f"https://crt.sh/?q=%25.{urllib.parse.quote(domain)}&output=json", timeout=35)
    if not d:
        rep.add("crt.sh", "hasil", "query gagal / timeout (rate-limit)")
        return
    subs, issuers = set(), set()
    for e in d:
        for n in (e.get("name_value") or "").split("\n"):
            n = n.strip().lower().lstrip("*.")
            if n.endswith(domain) and HOST_RE.match(n) and " " not in n:
                subs.add(n)
        if e.get("issuer_name"):
            m = re.search(r"O=([^,]+)", e["issuer_name"])
            issuers.add(m.group(1) if m else e["issuer_name"][:40])
    rep.add("crt.sh", "subdomains", f"{len(subs)} unik")
    for s in sorted(subs)[:60]:
        rep.add("crt.sh", "sub", s)
    rep.add("crt.sh", "issuers", " | ".join(sorted(issuers)[:6]))


def http_fingerprint(rep, url):
    st, b, h = req(url)
    body = txt(b)
    rep.add("http", "status", st)
    for k in ("server", "x-powered-by", "cf-ray", "via", "x-vercel-id",
              "x-amz-cf-id", "x-generator", "x-drupal-cache", "set-cookie"):
        if h.get(k):
            rep.add("http", k, h[k][:180])
    m = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
    if m:
        rep.add("http", "title", strip_tags(m.group(1))[:160])
    if "cloudflare" in (h.get("server", "") + h.get("cf-ray", "")).lower():
        rep.add("http", "cdn", "Cloudflare (origin kemungkinan ke-cloak)")
    return body


COMMON_PATHS = ["robots.txt", "sitemap.xml", ".well-known/security.txt", "humans.txt",
                "openapi.json", "swagger.json", "graphql", "api", "docs", "swagger-ui",
                ".git/config", ".env", "login", "admin", "static/js", "assets"]


def path_probe(rep, base):
    base = base.rstrip("/")
    hits = 0

    def one(p):
        st, b, _ = req(f"{base}/{p}", timeout=8, maxb=60_000)
        return p, st, len(b)

    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for p, st, n in ex.map(one, COMMON_PATHS):
            if st == 200:
                rep.add("paths", p, f"200 ({n}B)")
                hits += 1
            elif st in (301, 302, 401, 403):
                rep.add("paths", p, str(st))
                hits += 1
    if not hits:
        rep.add("paths", "hasil", "tidak ada path sensitif terbuka (semua 404)")


OAUTH_ROUTES = ["/auth/google", "/auth/github", "/oauth/google", "/oauth/authorize",
                "/login/google", "/users/auth/google_oauth2", "/auth/oauth", "/api/auth/google"]


def oauth_hunt(rep, base):
    base = base.rstrip("/")
    found = False
    for r in OAUTH_ROUTES:
        st, b, h = req(base + r, timeout=9, maxb=200_000)
        loc = h.get("location", "")
        body = txt(b)
        cid = re.search(r"client_id=([A-Za-z0-9._\-]{15,})", loc + body)
        if cid:
            found = True
            rep.add("oauth", r, f"client_id={cid.group(1)}")
            cs = jget("https://accounts.google.com/.well-known/openid-configuration")
            if cs:
                pass
            # consent screen may carry the app name + support email
            sc = f"https://accounts.google.com/o/oauth2/auth?client_id={cid.group(1)}&redirect_uri=https://localhost&response_type=code&scope=email"
            st2, b2, _ = req(sc, timeout=10, maxb=400_000)
            t = txt(b2)
            for e in set(EMAIL_RE.findall(t)) - {"noreply@google.com"}:
                rep.add("oauth", "consent-email", e)
            m = re.search(r'<title[^>]*>(.*?)</title>', t, re.S)
            if m:
                rep.add("oauth", "app-name", strip_tags(m.group(1))[:120])
        elif st in (301, 302, 303) and ("google" in loc or "github" in loc or "facebook" in loc):
            found = True
            rep.add("oauth", r, f"redirect -> {loc[:120]}")
    if not found:
        rep.add("oauth", "route", "tidak ada endpoint OAuth terdeteksi")


def js_assets(rep, base, body):
    base = base.rstrip("/")
    srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)', body, re.I)[:12]
    emails, keys = set(), set()
    for s in srcs:
        u = urllib.parse.urljoin(base + "/", s.split("?")[0])
        if not u.startswith("http"):
            continue
        st, b, _ = req(u, timeout=12, maxb=MAXB)
        if st != 200:
            continue
        t = txt(b)
        emails |= set(EMAIL_RE.findall(t))
        keys |= set(KEY_RE.findall(t))
        rep.add("js", "bundle", f"{u.split('/')[-1][:60]} ({len(b)}B)")
    for e in list(emails)[:20]:
        if not e.endswith((".png", ".jpg", ".webp")):
            rep.add("js", "email", e)
    for k in list(keys)[:10]:
        rep.add("js", "KEY-CANDIDATE", k[:60])


def dork_links(rep, term):
    q = urllib.parse.quote(f'"{term}"')
    rep.add("dorks", "ddg", f"https://duckduckgo.com/html/?q={q}")
    rep.add("dorks", "bing", f"https://www.bing.com/search?q={q}")
    rep.add("dorks", "google", f"https://www.google.com/search?q={q}")
    rep.add("dorks", "github", f"https://github.com/search?q={q}&type=code")
    rep.add("dorks", "pastebin", f"https://www.google.com/search?q=site%3Apastebin.com+{q}")


# ------------------------------------------------------------------ phone
ID_PREFIX = {
    "0811": "Telkomsel", "0812": "Telkomsel", "0813": "Telkomsel", "0821": "Telkomsel",
    "0822": "Telkomsel", "0823": "Telkomsel", "0851": "Telkomsel", "0852": "Telkomsel",
    "0853": "Telkomsel", "0814": "Indosat", "0815": "Indosat", "0816": "Indosat",
    "0855": "Indosat", "0856": "Indosat", "0857": "Indosat", "0858": "Indosat",
    "0817": "XL", "0818": "XL", "0819": "XL", "0859": "XL", "0877": "XL", "0878": "XL",
    "0831": "Axis", "0832": "Axis", "0833": "Axis", "0838": "Axis",
    "0895": "Tri", "0896": "Tri", "0897": "Tri", "0898": "Tri", "0899": "Tri",
    "0881": "Smartfren", "0882": "Smartfren", "0883": "Smartfren", "0884": "Smartfren",
    "0885": "Smartfren", "0886": "Smartfren", "0887": "Smartfren", "0888": "Smartfren",
    "0889": "Smartfren",
}
CALLER_DBS = [
    ("tellows", "https://www.tellows.com/num/{q}"),
    ("whocalld", "https://whocalld.com/{q}"),
    ("spamcalls", "https://spamcalls.net/en/search?q={q}"),
    ("sync.me", "https://sync.me/search/?number={q_digits}"),
    ("who-called", "https://who-called.co.uk/Number/{q_digits}"),
]


def normalize_phone(raw):
    d = re.sub(r"\D", "", raw)
    if d.startswith("0"):
        return "+62" + d[1:], "62" + d[1:]
    if d.startswith("62"):
        return "+" + d, d
    if d.startswith("8") and len(d) in (9, 10, 11, 12):
        return "+62" + d, "62" + d
    return "+" + d, d


def phone_sweep(rep, raw):
    e164, digits = normalize_phone(raw)
    rep.add("phone", "e164", e164)
    k = "0" + digits[2:] if digits.startswith("62") else digits
    carrier = ID_PREFIX.get(k[:4], "")
    rep.add("phone", "carrier (heuristic)", carrier or "tidak dikenal / non-ID")
    for pfx in range(4, 6):
        if ID_PREFIX.get(k[:pfx]):
            rep.add("phone", "prefix", k[:pfx])
            break

    # WhatsApp — validasi nomor jalan di client-side, jadi dari server cuma bisa
    # kasih link + status HTTP. Jangan klaim "terdaftar" tanpa bukti.
    st, b, _ = req(f"https://wa.me/{digits}", timeout=10, maxb=80_000)
    rep.add("whatsapp", "wa.me", f"http {st} — https://wa.me/{digits}")
    rep.add("whatsapp", "catatan", "nomor terdaftar/tidak hanya bisa dipastikan via app (validasi client-side)")

    # Telegram
    st2, b2, _ = req(f"https://t.me/+{digits}", timeout=10, maxb=120_000)
    t2 = txt(b2)
    m = re.search(r"<title>(.*?)</title>", t2, re.S)
    if m:
        rep.add("telegram", "title", strip_tags(m.group(1))[:120])
        rep.add("telegram", "verdict", "akun ada" if "Contact" in m.group(1) else "tidak ditemukan")

    # caller-ID databases
    for name, tpl in CALLER_DBS:
        url = tpl.format(q=e164, q_digits=digits)
        st, b, _ = req(url, timeout=12, maxb=300_000)
        if st != 200:
            rep.add("caller-id", name, f"http {st}")
            continue
        body = txt(b)
        title = re.search(r"<title[^>]*>(.*?)</title>", body, re.S)
        snippet = strip_tags(body)
        # pull name-ish / comment-ish hits near the number
        hits = re.findall(r"(?i)(?:name|caller|reported as|identified as)[^<]{0,60}", snippet)[:3]
        rep.add("caller-id", name, strip_tags(title.group(1))[:140] if title else "200, tanpa title")
        for h in hits:
            rep.add("caller-id", f"{name} hit", h.strip()[:120])

    # breach mirror
    d = jget(f"https://api.xposedornot.com/v1/breach-analytics?email={urllib.parse.quote(digits)}")
    if d and d.get("BreachMetrics"):
        rep.add("breach", "xposedornot", json.dumps(d)[:300])
    dork_links(rep, digits)
    dork_links(rep, e164)


# ------------------------------------------------------------------ email
FREE_MAIL = {"gmail.com": "Google", "yahoo.com": "Yahoo", "outlook.com": "Microsoft",
             "hotmail.com": "Microsoft", "live.com": "Microsoft", "protonmail.com": "Proton",
             "proton.me": "Proton", "icloud.com": "Apple", "aol.com": "AOL",
             "yandex.com": "Yandex", "mail.ru": "Mail.ru", "gmx.com": "GMX", "zoho.com": "Zoho"}


def email_sweep(rep, email):
    email = email.strip().lower()
    local, _, domain = email.partition("@")
    rep.add("email", "local-part", local)
    rep.add("email", "domain", domain)
    provider = FREE_MAIL.get(domain, "custom / korporat")
    rep.add("email", "provider", provider)

    for rt in ("MX", "TXT", "A"):
        vals = dns_query(domain, rt)
        if vals:
            rep.add("email", f"domain {rt}", " | ".join(vals[:5]))
    for v in dns_query(domain, "TXT"):
        if v.startswith("v=spf1") or "DMARC" in v:
            rep.add("email", "policy", v[:200])

    # Gravatar pivot
    h = hashlib.md5(email.encode()).hexdigest()
    rep.add("gravatar", "md5", h)
    d = jget(f"https://gravatar.com/{h}.json")
    if d and d.get("entry"):
        for e in d["entry"]:
            rep.add("gravatar", "displayName", e.get("displayName"))
            rep.add("gravatar", "aboutMe", (e.get("aboutMe") or "")[:160])
            for u in (e.get("urls") or [])[:6]:
                rep.add("gravatar", "url", f"{u.get('title')}: {u.get('value')}")
            for a in (e.get("accounts") or [])[:8]:
                rep.add("gravatar", "account", f"{a.get('shortname')}: {a.get('username')}")
            for p in (e.get("photos") or [])[:2]:
                rep.add("gravatar", "photo", p.get("value"))
    else:
        rep.add("gravatar", "hash", "tidak ada profil gravatar")

    # breach mirror
    d = jget(f"https://api.xposedornot.com/v1/breach-analytics?email={urllib.parse.quote(email)}")
    if d:
        if d.get("BreachMetrics"):
            rep.add("breach", "status", "TERDAMPAK breach")
            for b in (d.get("BreachesSummary") or {}).get("site", "").split(";"):
                if b:
                    rep.add("breach", "site", b)
        else:
            rep.add("breach", "status", str(d.get("Error") or "bersih / tidak terindeks"))

    # username pivot
    if provider != "custom / korporat":
        local_alt = local.split("+")[0].replace(".", "")
        rep.add("pivot", "handle kandidat", f"{local} | {local_alt}")
    else:
        rep.add("pivot", "handle kandidat", local)

    # github user search by email
    d = jget(f"https://api.github.com/search/users?q={urllib.parse.quote(email)}")
    if d and d.get("total_count"):
        for it in d.get("items", [])[:5]:
            rep.add("github", "match", f"{it.get('login')} {it.get('html_url')}")
        rep.add("github", "total_count", d.get("total_count"))

    dork_links(rep, email)


# ------------------------------------------------------------------ handle
def handle_sweep(rep, h):
    rep.add("handle", "input", h)

    d = jget(f"https://api.github.com/users/{h}")
    if d and d.get("login"):
        rep.add("github", "nama", d.get("name"))
        rep.add("github", "bio", (d.get("bio") or "")[:140])
        rep.add("github", "repos", d.get("public_repos"))
        rep.add("github", "followers", d.get("followers"))
        rep.add("github", "blog", d.get("blog"))
        rep.add("github", "email", d.get("email"))
        rep.add("github", "twitter", d.get("twitter_username"))
        rep.add("github", "company", d.get("company"))
        rep.add("github", "lokasi", d.get("location"))
        rep.add("github", "dibuat", d.get("created_at"))
        rep.add("github", "avatar", d.get("avatar_url"))

    d = jget(f"https://gitlab.com/api/v4/users?username={urllib.parse.quote(h)}")
    if isinstance(d, list) and d:
        u = d[0]
        rep.add("gitlab", "nama", u.get("name"))
        rep.add("gitlab", "state", u.get("state"))
        rep.add("gitlab", "avatar", u.get("avatar_url"))
        rep.add("gitlab", "profile", u.get("web_url"))

    d = jget(f"https://dev.to/api/users/by_username?url={urllib.parse.quote(h)}")
    if d and d.get("username"):
        rep.add("dev.to", "nama", d.get("name"))
        rep.add("dev.to", "lokasi", d.get("location"))
        rep.add("dev.to", "github", (d.get("github_username") or ""))
        rep.add("dev.to", "twitter", (d.get("twitter_username") or ""))

    d = jget(f"https://hn.algolia.com/api/v1/search?query={urllib.parse.quote(h)}&tags=author_%3A{h}")
    if d and d.get("nbHits"):
        rep.add("hackernews", "posts", f"{d.get('nbHits')} hit (author match)")

    d = jget(f"https://api.keybase.io/1.0/user/lookup.json?username={urllib.parse.quote(h)}")
    if d and d.get("them"):
        rep.add("keybase", "match", json.dumps(d["them"][0])[:200])

    st, b, _ = req(f"https://www.reddit.com/user/{h}/about.json", timeout=12,
                   headers={"User-Agent": "osint_full/1.0"})
    if st == 200:
        try:
            dd = json.loads(txt(b)).get("data", {})
            if dd.get("name"):
                rep.add("reddit", "nama", dd.get("name"))
                rep.add("reddit", "karma", f"{dd.get('link_karma')} link / {dd.get('comment_karma')} comment")
                rep.add("reddit", "dibuat", str(dd.get("created_utc")))
        except Exception:
            pass

    st, b, _ = req(f"https://steamcommunity.com/id/{h}/?xml=1", timeout=12)
    t = txt(b)
    m = re.search(r"<steamID><!\[CDATA\[(.*?)\]\]>", t)
    if m:
        rep.add("steam", "steamID", m.group(1))
        m2 = re.search(r"<steamID64>(\d+)", t)
        if m2:
            rep.add("steam", "steamID64", m2.group(1))

    st, b, _ = req(f"https://t.me/{h}", timeout=12, maxb=200_000)
    t = txt(b)
    title = og(t, "og:title")
    desc = og(t, "og:description")
    img = og(t, "og:image")
    if title:
        kind = "bot / mini-app" if "Launch" in (re.search(r"<title>(.*?)</title>", t, re.S).group(1) if re.search(r"<title>(.*?)</title>", t, re.S) else "") else "user"
        rep.add("telegram", "og:title", title)
        rep.add("telegram", "jenis", kind)
        if desc:
            rep.add("telegram", "og:desc", desc[:160])
        if img and "telesco.pe" in img:
            rep.add("telegram", "foto", img)
        elif img:
            rep.add("telegram", "foto", "tidak ada foto profil (placeholder platform)")
        m = re.search(r'data-content="user-id:(\d+)"', t) or re.search(r"ref_(\d{6,})", t)
        if m:
            rep.add("telegram", "user-id (publik)", m.group(1))

    xmd = jina(f"https://x.com/{h}", timeout=25)
    if xmd and "something went wrong" not in xmd.lower():
        m = re.search(r"^(.{2,60}?)\s*\(@", xmd, re.M)
        if m:
            rep.add("x/twitter", "nama", m.group(1).strip())
        f = re.search(r"([\d,\.]+)\s*Followers", xmd)
        if f:
            rep.add("x/twitter", "followers", f.group(1))
        j = re.search(r"Joined\s+([A-Z][a-z]+ \d{4})", xmd)
        if j:
            rep.add("x/twitter", "joined", j.group(1))

    tkmd = jina(f"https://www.tiktok.com/@{h}", timeout=25)
    if "Couldn't find this" in tkmd:
        rep.add("tiktok", "verdict", "tidak ada")
    elif tkmd:
        m = re.search(r"^(.{2,60}?)\(@", tkmd, re.M)
        rep.add("tiktok", "verdict", "ada" + (f" — {m.group(1).strip()}" if m else ""))

    d = jget(f"https://gravatar.com/{urllib.parse.quote(h)}.json")
    if d and d.get("entry"):
        e = d["entry"][0]
        rep.add("gravatar", "displayName", e.get("displayName"))
        for p in (e.get("photos") or [])[:1]:
            rep.add("gravatar", "photo", p.get("value"))
        for a in (e.get("accounts") or [])[:6]:
            rep.add("gravatar", "account", f"{a.get('shortname')}: {a.get('username')}")

    dork_links(rep, h)


# ------------------------------------------------------------------ ip
TOP_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 587, 993, 995, 1433, 1521, 2049,
             2375, 3000, 3306, 3389, 5432, 5900, 6379, 8000, 8080, 8443, 8888, 9000, 9200, 27017]


def scan_ports(ip, ports):
    open_p = []

    def one(p):
        try:
            with socket.create_connection((ip, p), timeout=2.2):
                return p
        except Exception:
            return None

    with cf.ThreadPoolExecutor(max_workers=60) as ex:
        for r in ex.map(one, ports):
            if r:
                open_p.append(r)
    return sorted(open_p)


def ip_sweep(rep, ip, do_ports=False):
    d = jget(f"http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,zip,lat,lon,"
             f"timezone,isp,org,as,asname,reverse,proxy,hosting,query")
    if d and d.get("status") == "success":
        for k in ("country", "regionName", "city", "zip", "timezone", "isp", "org", "as",
                  "reverse", "proxy", "hosting"):
            rep.add("ip-geo", k, d.get(k))
        rep.add("ip-geo", "koordinat", f"{d.get('lat')},{d.get('lon')}")
        rep.add("ip-geo", "peta", f"https://www.google.com/maps?q={d.get('lat')},{d.get('lon')}")
    else:
        rep.add("ip-geo", "status", (d or {}).get("message", "gagal query ip-api"))

    try:
        rep.add("ip", "PTR", socket.gethostbyaddr(ip)[0])
    except Exception:
        pass

    t = txt(req(f"https://api.hackertarget.com/reverseiplookup/?q={ip}", timeout=20)[1])
    if t and "error" not in t.lower() and "API count exceeded" not in t:
        doms = [d for d in t.split() if len(d) < 60 and not re.search(r"\d{8,}", d)]
        base = {}
        for d in doms:
            key = ".".join(d.split(".")[-3:])
            base.setdefault(key, d)
        rep.add("ip", "reverse-ip domains", f"{len(base)} domain unik (dari {len(doms)} baris)")
        for x in list(base.values())[:20]:
            rep.add("ip", "domain", x)

    st, b, h = req(f"https://{ip}/", timeout=8, maxb=40_000)
    if st:
        cert = None
        try:
            ctx = ssl._create_unverified_context()
            with socket.create_connection((ip, 443), timeout=6) as s:
                with ctx.wrap_socket(s, server_hostname=ip) as ss:
                    cert = ss.getpeercert()
        except Exception:
            pass
        if cert:
            san = [v for k, v in cert.get("subjectAltName", []) if k == "DNS"]
            rep.add("tls", "SAN", " | ".join(san[:15]))
            for rdn in cert.get("subject", ()):
                for k, v in rdn:
                    rep.add("tls", k, v)
        rep.add("http", "status", st)
        for k in ("server", "title"):
            pass
        m = re.search(r"<title[^>]*>(.*?)</title>", txt(b), re.S | re.I)
        if m:
            rep.add("http", "title", strip_tags(m.group(1))[:140])

    if do_ports:
        op = scan_ports(ip, TOP_PORTS)
        rep.add("ports", "terbuka", ", ".join(map(str, op)) or "none")
    else:
        rep.add("ports", "info", "pakai --ports buat scan top-30 TCP")


# ------------------------------------------------------------------ domain
def domain_sweep(rep, domain, do_ports=False):
    dns_chain(rep, domain)
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futs = [
            ex.submit(whois_domain, rep, domain),
            ex.submit(rdap_domain, rep, domain),
            ex.submit(crt_subdomains, rep, domain),
            ex.submit(oauth_hunt, rep, f"https://{domain}"),
            ex.submit(path_probe, rep, f"https://{domain}"),
        ]
        for f in futs:
            try:
                f.result(timeout=60)
            except Exception as e:
                rep.add("err", "modul", str(e)[:80])
    body = http_fingerprint(rep, f"https://{domain}")
    js_assets(rep, f"https://{domain}", body)
    a = dns_query(domain, "A")
    if a:
        rep.add("pivot", "IP kandidat", " | ".join(a[:4]))
        dork_links(rep, domain)


# ------------------------------------------------------------------ main
def run(target, args):
    kind = detect(target)
    rep = Report(target, kind)
    print(f"[*] target  : {target}")
    print(f"[*] jenis   : {kind}")
    print(f"[*] mulai   : {time.strftime('%Y-%m-%d %H:%M:%S')}")
    try:
        if kind == "phone":
            phone_sweep(rep, target)
        elif kind == "email":
            email_sweep(rep, target)
        elif kind == "handle":
            handle_sweep(rep, target)
        elif kind == "ip":
            ip_sweep(rep, target, args.ports)
        else:
            dom = urllib.parse.urlparse(target).netloc or target
            dom = dom.split("@")[-1].split(":")[0]
            if kind == "url":
                http_fingerprint(rep, target)
                js_assets(rep, target, txt(req(target)[1]))
                oauth_hunt(rep, target)
            domain_sweep(rep, dom, args.ports)
    except KeyboardInterrupt:
        print("\n[!] dibatalkan")
    print(rep.dump())
    print("\n" + "=" * 62)
    print(f"HITS      : {len(rep.rows)} baris, {len(rep.sources)} modul balik data")
    print(f"MODUL     : {', '.join(sorted(rep.sources)) or 'none'}")
    print(f"VERDICT   : {'data ditemukan' if rep.rows else 'digital ghost — nol jejak publik'}")
    print(f"NEXT      : {'verifikasi manual dork di atas' if rep.rows else 'paid DB / OTP app / interaksi langsung'}")
    print("=" * 62)
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(rep.json(), fh, indent=2, ensure_ascii=False)
        print(f"[*] json    : {args.json}")


def main():
    ap = argparse.ArgumentParser(description="unified OSINT sweeper (stdlib only)")
    ap.add_argument("target", help="phone | email | domain | url | ip | handle")
    ap.add_argument("--ports", action="store_true", help="scan top-30 TCP port (ip/domain)")
    ap.add_argument("--json", metavar="FILE", help="simpan hasil sebagai JSON")
    args = ap.parse_args()
    run(args.target, args)


if __name__ == "__main__":
    sys.exit(main())
