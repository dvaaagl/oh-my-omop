---
name: osint-full-spectrum
description: "Use when running OSINT on a phone, email, domain, IP, or username. Multi-vector sweeper: caller-ID DBs, breach mirrors, social, search engines, OAuth/Gravatar pivots, Cloudflare origin uncloaking. Stdlib-only Python."
version: 1.3.0
author: Omop
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [osint, recon, phone-lookup, email-lookup, cloudflare-bypass, footprint, investigation]
    related_skills: [osint-methodology, offensive-osint, recon-and-methodology, web2-recon]
prerequisites:
  commands: [python, curl]
---

# OSINT Full Spectrum

Deep multi-vector OSINT sweeper for phone / email / domain / IP / username targets.
Encodes the technique chain that actually lands hits — not surface scraping.

## When to Use

- Reverse-lookup a phone number (owner, country, carrier, spam status, WA/Telegram presence)
- Email footprint → Gravatar → breaches → social accounts
- Domain → DNS → origin IP behind Cloudflare → registrar/RDAP → OAuth support email
- Username/handle → cross-platform presence
- Any "find everything on this target" job

## SCOPE GATE — decide the objective BEFORE sweeping

Two requests look identical at the prompt but are different jobs:

- **Operation attribution** — which accounts, channel, bot and referral ID belong
  to one operator, and what that operation does. Do this: public, account-level
  linkage only.
- **Person-identity compilation** — "who really owns this", "proof of ownership",
  "find all their data". Refuse this. Real name, personal email, phone, address,
  face, employer = private identifying information about a real individual. That
  is doxxing: decline the identity part plainly, hand over the account-level
  facts you already hold, and redirect to a legitimate path — abuse report
  (Telegram abuse form / police), defensive hardening, or the user's own
  admin-tool verification.

"Trace X until you find proof of ownership" is the second kind. Do not extend a
prior session's personal dossier.

**Check for a campaign in progress first.** Before sweeping a person/handle, grep
this agent's own session store — a prior session may already hold a dossier on
the same target, which makes this a continuation, not a fresh lookup:

```
grep -ail '<handle>' ~/.hermes/state.db      # is it already in our history?
# then read the messages / sessions tables (SQLite, read-only) for the prior turns
```

Prior session titles and user turns reveal the intent (e.g. an existing personal
dossier). If one exists, say so and stop — do not extend it.

## Core Rule: pivot, do not just search

A raw web_search on an identifier returns nothing ~80% of the time (engines don't
index phone numbers / emails). **Real hits come from pivoting through services that
hold first-party data:** caller-ID DBs, consent screens, Gravatar, breach mirrors,
RDAP, certificate transparency, and Cloudflare origin leaks.

Memorize the pivot chains below. That is the whole skill.

---

## PIVOT CHAINS

### PHONE
```
number
 ├─ normalize: strip 0 → 62 / +62 / 08 / spaced / dashed / wa.me/<n>
 ├─ caller-ID DBs: tellows, whocalld, spamcalls.net, sync.me, who-called.me
 ├─ WhatsApp presence: curl -o /dev/null -w %{http_code} https://wa.me/<62n>
 │                    200 = registered & active
 ├─ Telegram: https://t.me/+<62n>  → <title> "Telegram: Contact" = exists
 ├─ social: FB / IG / X dork "09..." + "628..."
 ├─ search: DDG html / Bing rss / Google — for exact, spaced, wa.me forms
 ├─ breach mirrors: xposedornot (free), breachdirectory (CF-walled)
 └─ verdict: hits? → name/handle. zero across all → digital ghost.
```

### EMAIL
```
email
 ├─ Gravatar: md5(email) → https://gravatar.com/<hash>.json → display name + photos
 ├─ breach: xposedornot.com/v1/breach-analytics?email=<e>
 ├─ HIBP-style mirrors, paste sites (dork "email" site:pastebin.com)
 ├─ provider OAuth: if account on Google, consent screen may leak supportEmail
 ├─ reverse: search exact email in DDG/Bing/Google
 └─ pivot to username from email local-part → run HANDLE chain
```

### DOMAIN / IP
```
domain
 ├─ DNS: A / NS / MX / TXT (dig, or curl dns.google/resolve)
 ├─ RDAP: registry RDAP (for .id → pandi.id) → registrar, dates, status, registrant
 ├─ crt.sh — certificate transparency → subdomains
 ├─ CLOUDFLARE ORIGIN UNCLOAK:
 │    cert SAN on origin certs + curl --resolve + -H "Host: <domain>" to candidate IPs
 │    → match served content / cert CN → origin found
 ├─ OAuth consent hunt: probe /auth/google /auth/github /oauth/... redirects
 │    → client_id → Google Cloud project page → **support email = owner**  ★big win
 ├─ JS bundles: grep for emails / keys / endpoints
 └─ robots.txt, sitemap, /.well-known/, /docs /about /contact /privacy pages
```

### HANDLE / USERNAME
```
handle
 ├─ Telegram: t.me/<h> — read og:title (display name) + og:image (a real
 │    cdn*.telesco.pe photo) + tgme_page_title/extra. <title> gives the KIND:
 │    "Telegram: Contact @h" = user, "Telegram: Launch @h" = bot/mini-app.
 │    "Contact" is NOT an unclaimed signal — live users render it (pitfall 16).
 │    Numeric user ID: a public `?start=ref_<digits>` / `ref_<digits>` param is
 │    the owner's Telegram user ID — groups their accounts/channel (not a name).
 │    Details: references/telegram-account-attribution.md
 ├─ GitHub: api.github.com/users/<h>  (public, no auth)
 ├─ X/Twitter: x.com/<h> — real name sits in <title> ("Name (@handle) / X")
 │    even when the body is a JS wall; og:description carries follower/join
 │    data. No-login renderer fallback: curl https://r.jina.ai/https://x.com/<h>
 │    → name, join date, follower/following, profile pic URL, post count.
 │    Nitter instances are largely dead or CF-challenged — don't loop on them.
 ├─ LinkedIn / IG / TikTok / FB / Reddit / Pastebin / Keybase
 ├─ Gravatar by username: gravatar.com/<h>.json
 └─ search exact handle across engines
```

---

## SCRIPTS

All scripts are stdlib-only (urllib) — no pip needed. Run with `python`.

| Script | Target | Usage |
|---|---|---|
| `scripts/phone_osint.py` | phone | `python phone_osint.py 6285187434760` |
| `scripts/email_osint.py` | email | `python email_osint.py user@x.com` |
| `scripts/domain_osint.py` | domain/ip | `python domain_osint.py example.com` |
| `scripts/handle_osint.py` | username | `python handle_osint.py someuser` |
| `scripts/identity_chain.py` | handle+domain | `python identity_chain.py bambangnurdiann` |
| `scripts/social_photo.py` | username | `python social_photo.py someuser` |
| `scripts/breach_multi.py` | email/phone | `python breach_multi.py user@x.com` |
| `scripts/cf_origin_finder.py` | domain (CF) | `python cf_origin_finder.py example.com --ip 1.2.3.4` |
| `scripts/oauth_email_hunt.py` | domain | `python oauth_email_hunt.py example.com` |

Each prints a clean report and a verdict line.

### identity_chain.py — the person-confirmation engine

This is the script that turns a username into a **real named person**. It probes
developer-marketplace / profile URL patterns, harvests schema.org `sameAs` +
`Person`/`Organization` blocks + OG data, and consolidates everything.

Worked example (`bambangnurdiann`):
```
appverse    -> name="Bambang Nurdiansyah", sameAs links
sameAs      -> https://github.com/bambangnurdiann
               https://tokenportal.id
               https://appverse.id/developers/bambangnurdiann
platforms confirmed: appverse
```
Domain → named human + face (AppVerse Google avatar, 1365x1375) in one run.
"platforms confirmed" now requires actual harvested data (name/sameAs/email) —
HTTP 200 alone no longer counts (see pitfall 12).

### breach_multi.py — key-optional mirrors

xposedornot works with no key. Set env vars to light up the rest:
`HIBP`, `LEAKCHECK`, `INTELX`. Without keys it still reports xposedornot.

### social_photo.py v2 — multi-source photo harvester

Now pulls from 12 sources. Biggest wins this iteration:

- **AppVerse developer page** → person name + **Google avatar at 2048px**
  (harvests `lh3.googleusercontent.com/a/ACg8ocJ...`, size-bumps `=s96-c` → `=s2048`).
  This is the pivot that turns a domain into a human face.
- **Gravatar by handle** → displayName + photo URL. Works even when GitHub/LinkedIn
  are soft-404. `gravatar.com/<handle>.json` returns `photos[0].value` (the hash-based
  avatar URL, request `?s=512` for full).
- **GitLab API** → `gitlab.com/api/v4/users?username=<h>` → real name + avatar (often
  a Gravatar URL = cross-references the same person).
- **Facebook signed og:image** → extracts the full signed URL (with `?oh=` & `oe=`
  tokens), then downloads with `-e` referer. Unsigned URL → 403.
- **Telegram** → checks for `tgme_page_photo` element. Its absence = account has no
  profile pic (only `tgme_page_icon` = platform logo).
- **Projects.co.id** → soft-404 detection ("Not Found" in body despite HTTP 200).

Placeholder trap (carried forward): GitHub 404, X 404, and Telegram no-photo all
serve a generic `og:image`. **Verify every file before delivery** — `file <path>` +
byte size. Telegram serves `telegram.org/img/t_logo_2x.png` for non-existent users.

### AI-generated face detection — new OSINT layer

When harvesting faces, check for AI tells before treating as real-person evidence:

- **Malformed anatomy**: fingers blending into objects, ears merging with glasses
- **Garbled text**: brand logos, chest prints, signs in background = diffusion artifacts
- **Lighting inconsistency**: sun angle vs shadow direction off by >15°
- **Over-smoothed skin**: plastic texture, no pores, no blemishes even on young adults
- **Distorted background figures**: limbs too long/short, no facial detail

**Verdict**: An AI-generated face on a public profile = **deliberate identity
obfuscation**. Not a "digital ghost" — a deliberate fake persona. Report as such.
Real person on Gravatar (even if pixelated) + fake AI face on AppVerse = mismatched
identities, likely the operator used a stock/generated image on one platform and
their actual face on another. Pivot: reverse-image search the real-looking one,
ignore the AI.

### Photo reverse search — Yandex only works via curl

Google Lens (`lens.google.com/uploadbyurl`) and TinEye both 303/403 from curl.
**Yandex is the only one that returns 200 + parseable HTML**:
```
https://yandex.com/images/search?rpt=imageview&url=<urlencoded_image_url>
```
Parse response for `"title":"...","linkUrl":"...img_url=<origin_url>"`. Results
are CBIR-similar, not exact matches — read as noise unless the same face appears
on multiple unrelated platforms.

### Wayback machine — rate-limited from datacenter IPs

CDX API returns `429 Too Many Requests` after 2–3 quick calls. Backoff: wait
60s between queries or use a residential proxy. Don't loop.

### Instagram anonymous viewers — all dead

imginn, picuki, dumpor, greatfon, instanavigation — all Cloudflare-challenged
(`Just a moment...`). Jina reader on instagram.com returns login wall. IG needs
a session cookie or it's a dead end. Don't waste calls.

### TikTok — no reliable unauthenticated existence check

Tested with positive controls (`@tiktok`, `@zendaya` = real accounts):
- `m.tiktok.com/@<h>` → **404 for EVERY account, including the official @tiktok**.
  The m. subdomain is dead — 404 there means NOTHING about existence.
- `www.tiktok.com/@<h>` → 200 always; body text is unreliable BOTH ways: the real
  @tiktok page contains a "couldn't find" string (JS bundle), and a non-existent
  handle returned a 1462-byte shell with no title. Don't read existence off it.
- Working signals: `www.tiktok.com/oembed?url=...` (returns account data when
  exists, but rate-limits hard) or `https://r.jina.ai/https://www.tiktok.com/@<h>`
  → "Couldn't find this" = non-existent. Jina is the cheap default.

### Photo delivery (standing operator preference)

Hand back the actual images, not a prose description: download, verify, then
send inline with `MEDIA:/abs/path` in the reply. Rules:

- Verify every file before sending — `file <path>` + byte size. Telegram serves
  `telegram.org/img/t_logo_2x.png` and GitHub serves its own logo as `og:image`
  for NON-EXISTENT users; a saved "photo" can be a platform placeholder. Strip
  placeholders, never deliver them as the target's picture.
- Largest X profile pic: `https://pbs.twimg.com/profile_images/<id>/<hash>.jpg`
  BARE (no size suffix). `_400x400.jpg` is a downscaled duplicate; the
  `?format=jpg&name=orig` query 404s on profile images (it only works for tweet
  media). Fallback avatar source: `https://unavatar.io/x/<handle>`.
- Zero-post X account = the profile pic is the only media; don't chase /media
  or /photo pages.
- For the record, describe what the photo shows (gender, age band, ethnicity,
  hair, clothing, background, AI/retouch tells) — the image plus the read.

---

## PITFALLS (learned the hard way)

1. **browser_exec on these sites times out / duplicates output.** Use curl or the
   stdlib scripts. One request per service, small responses.
2. **Bing RSS returns junk for phone/email queries.** DDG html endpoint returns
   *truly empty* when no index — that emptiness is itself the signal (no footprint).
3. **GetContact / Truecaller / Sync.me need the mobile app + OTP.** Web = 404/login
   wall. Only call them out as "requires app" — do not burn calls trying.
4. **breachdirectory.org is Cloudflare-challenged** → returns "Just a moment...".
   Use xposedornot (free, no key) instead.
5. **Google/Bing block automated scraping** sometimes — treat junk results as noise,
   not as evidence of presence.
6. **Google OAuth consent screen is the single best owner-email source** for a
   product/domain. Probe every `/auth/*` route. supportEmail is often the founder's
   personal Gmail.
7. **RDAP registrant for .id domains is REDACTED** (Niagahoster privacy) and .ai via
   Cloudflare Registrar is REDACTED too — don't expect registrant data. Pivot to
   the OAuth/cert/JS route instead.
8. **Zero results across ALL free sources = "digital ghost".** Report it as such,
   don't keep grinding the same dead ends. Offer paid DB / app-based / direct-
   interaction paths as the remaining options.
9. **Facebook og:image needs the FULL SIGNED params, not a referer.** Isolated
   test on one fbcdn URL: full `?...&oh=...&oe=...` with NO referer → 200;
   trimmed params WITH referer → 403; bare URL → 403. Copy the signed URL whole
   from page HTML, unescape `&amp;`. The `-e` referer is harmless but irrelevant.
10. **Google avatar (lh3.googleusercontent.com) size-bumps work**: `/a/<id>=s96-c`
    → replace the suffix `=s2048` for full resolution (real pixels, not upscale —
    e.g. s2048 returned 1365x1375). Probe s96 → s512 → s1024 → s2048 in order.
11. **AppVerse.id developer pages punched above expectations for Indonesian
    targets** (schema.org `sameAs` linking dev handle → live product domain, plus
    an embedded Google avatar) — but evidence is n=1 (bambangnurdiann). Try it
    early, don't call it "the best surface" until a second target confirms.
12. **HTTP 200 ≠ user exists.** projects.co.id, p-store.net, and similar marketplaces
    return 200 + empty shell for non-existent users. Only trust a platform as
    "confirmed" when the harvest actually yielded name/sameAs/email — patched into
    identity_chain.py after a false "platforms confirmed: projects.co.id, p-store".
13. **Yandex reverse-image works from curl; Google Lens and TinEye do not**
    (303 to login / 403). Yandex CBIR returns *similar* faces, not exact matches.
    COROLLARY FOR HONESTY: with Lens/Tineye unreachable you only hold ONE engine —
    "no exact match in Yandex" ≠ "image is unique to its source". Report what you
    actually ran ("no match found in Yandex index"), never a uniqueness verdict.
14. **Wayback CDX rate-limits datacenter IPs hard** (429 after 2–3 queries).
    Sleep 60s between calls or use residential egress. Don't loop.
15. **IG anonymous-viewer mirrors are all dead** (imginn/picuki/dumpor/greatfon/
    instanavigation → Cloudflare challenge). Instagram without a session cookie is
    a closed door — say so, move on.
16. **t.me existence is NOT read off the `<title>`.** Live user accounts render
    `<title>Telegram: Contact @h</title>`; judge existence by og:title + a real
    og:image on `cdn*.telesco.pe`, never by the title string. `Telegram: Launch @h`
    = a bot with a mini-app button. See references/telegram-account-attribution.md.
17. **Same photo ≠ same person without a hash test.** t.me photos are 320x320
    JPEGs; `md5sum` first, then dHash/aHash in PIL — bit-distance > ~100/256 is a
    DIFFERENT image. Never link two accounts to one person off a visual
    impression.
18. **Multi-column SQLite probes: build the WHERE and the param list in the SAME
    loop.** `WHERE a LIKE ? OR b LIKE ?` fed `len(cols)*values` params raises
    'incorrect number of bindings', and a bare `except: continue` turns that into
    a false "no hits". `grep -a <term> <file>` first to confirm the term is
    actually present before trusting an empty query.

---

## VERDICT TEMPLATE

End every run with:

```
TARGET:      <identifier>
HITS:        <n>
IDENTITY:    <name/handle or "none">
FOOTPRINT:   <sources that returned data>
VERDICT:     <real identity found | digital ghost | partial>
NEXT:        <paid DB / app OTP / direct interaction / none>
```
