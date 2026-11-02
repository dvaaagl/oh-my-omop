---
name: ikona-osint-arsenal
description: "Use when OSINT-ing any target. Phone, email, username recon."
version: 1.0.0
triggers:
  - osint
  - sampah osint
  - reverse phone
  - phone osint
  - username osint
  - email osint
  - people search
  - osint phone
  - osint email
  - osint username
  - osint domain
  - osint github
  - osint instagram
  - osint facebook
  - osint telegram
  - osint tiktok
  - breach check
  - leak check
  - recon
  - full osint
  - digital footprint
  - cari orang
  - find person
  - hunt username
---

# IKONA OSINT ARSENAL v1.0

**Source repos:** sherlock, maigret, phoneinfoga, GHunt, holehe, theHarvester, Amass, SpiderFoot, Osintgram, Photon, hakrawler, Arjun, Recon-ng, OSINT-Framework, GitHub-Dorks, Nuclei

---

## Installed Tools
```bash
sherlock, maigret, holehe, phoneinfoga, GHunt, nuclei, theHarvester, arjun, socialscan, shodan, censys, spiderfoot, dnspython, python-whois
```

---

## 1. PHONE NUMBER OSINT

### Format Enumeration
```
E.164:      +628****7890
National:   0812-345-67890
Bare:       6281234567890
WhatsApp:   6281234567890
```

### Carrier Prefix (Indonesia)
```python
prefixes = {
    "811":"Telkomsel","812":"Telkomsel","813":"Telkomsel","821":"Telkomsel","822":"Telkomsel",
    "851":"Telkomsel","852":"Telkomsel","853":"Telkomsel",
    "814":"Indosat IM3","815":"Indosat IM3","816":"Indosat IM3","855":"Indosat IM3",
    "856":"Indosat IM3","857":"Indosat IM3","858":"Indosat IM3",
    "817":"XL Axiata","818":"XL Axiata","819":"XL Axiata","859":"XL Axiata",
    "877":"XL Axiata","878":"XL Axiata",
    "831":"AXIS","832":"AXIS","833":"AXIS",
    "881":"Smartfren","882":"Smartfren","883":"Smartfren","884":"Smartfren",
    "885":"Smartfren","886":"Smartfren","887":"Smartfren","888":"Smartfren","889":"Smartfren",
    "895":"Tri","896":"Tri","897":"Tri","898":"Tri","899":"Tri",
}
num = "81234567890"
for L in (4,3):
    if num[:L] in prefixes: print(f"{num[:L]} -> {prefixes[num[:L]]}"); break
```

### WhatsApp Registration
```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124"
curl -sL "https://wa.me/6281234567890" -A "$UA" -o /tmp/wa.html -w "status: %{http_code} final: %{url_effective}\n"
grep -ci "invalid" /tmp/wa.html
# 302->api.whatsapp.com + 200 + 0 invalid = REGISTERED
```

### Telegram Phone Probe
```bash
curl -sL "https://t.me/+628XXXXXXXXXX" -A "$UA" -o /tmp/tg.html
# og:title display name = registered w/ username
# og:title "Telegram: Contact" = registered, no public username
# og:title "Join group chat" = registered (generic probe)
# 404 = not registered
```

### Facebook Recovery (CRITICAL VECTOR)
```javascript
// Fill (standard fill_input FAILS on FB React)
(() => {
    const input = document.querySelector("input[type='text']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "+62XXXXXXXXXX");
    input.dispatchEvent(new Event("input", {bubbles:true}));
    input.dispatchEvent(new Event("change", {bubbles:true}));
    return input.value;
})()

// Click Continue (div[role='button'], NOT button)
(() => {
    for (const b of document.querySelectorAll("div[role='button']"))
        if (b.textContent.trim()==="Continue") { b.click(); return "clicked"; }
})()
```

**Results:**
- `"Meta Accounts"` = IG+FB unified (initials = IG account)
- `"Facebook"` = FB-only account
- PFPs = almost always default silhouette
- Click "Not you?" between numbers (session carries)
- Anti-bot 0-dimension -> fresh tab

### Instagram Reset
```
URL: https://www.instagram.com/accounts/password/reset/
Enter phone -> masked username(s)
Headless: empty page = anti-bot (not rate limit)
Rate limit: "Something went wrong" = 10-15min lockout
Max 2 attempts/session
```

### PhoneInfoga
```bash
phoneinfoga scan -n +628****7890
```

### Spam DBs
```bash
curl -sL "https://www.tellows.com/num/+62XXXXXXXXXX" -A "$UA" | grep -oE '<title>[^<]*'
curl -sL "https://spamcalls.net/en/number/62XXXXXXXXXX" -A "$UA" | grep -oE '<title>[^<]*'
curl -sL "https://sync.me/search/?number=%2B62XXXXXXXXXX" -A "$UA" | grep -oE '<title>[^<]*'
```

---

## 2. USERNAME OSINT

### Sherlock
```bash
sherlock USER --timeout 15 --json results.json --print-found
sherlock USER --site instagram,tiktok,twitter
```

### Maigret (3000+ sites)
```bash
maigret USER --json --top-sites
maigret USER --site instagram,tiktok,twitter --no-nsfw
```

### Cross-Platform Sweep
```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124"
for p in "https://www.instagram.com/USER/" "https://www.tiktok.com/@USER" \
         "https://x.com/USER" "https://github.com/USER" \
         "https://youtube.com/@USER" "https://www.pinterest.com/USER/" \
         "https://www.threads.net/@USER" "https://t.me/USER" \
         "https://steamcommunity.com/id/USER" "https://www.twitch.tv/USER" \
         "https://www.reddit.com/user/USER" "https://linkedin.com/in/USER"; do
  code=$(curl -sL -o /dev/null -w "%{http_code}" -A "$UA" "$p" --max-time 8)
  echo "$code  $p"
done
```

**Soft-404:**
| Platform | Nonexistent |
|---|---|
| x.com | honest 404 |
| github | honest 404 |
| instagram | 200+generic, grep handle |
| tiktok | 200+generic |
| youtube | 200+title mismatch |
| pinterest | 200+check og:title |
| steam | 200+error page |
| reddit | 403 |
| t.me | 200+og:title |
| linkedin | 999 |

**Status code alone is never evidence on SPAs.**

### Telegram Deep
```bash
curl -sL "https://t.me/USER" -A "$UA" | grep -oE '<meta property="og:(title|description|image)" content="[^"]*"'
curl -sL "https://t.me/GROUP" -A "$UA" | grep -B1 -A3 'tgme_page_extra' | head -10
```

---

## 3. EMAIL OSINT

### Holehe (120+ sites)
```bash
holehe email@example.com --json
```

### GHunt (Google)
```bash
ghunt login
ghunt email email@example.com
ghunt gaia GOOGLE_ID
```

### Email Verification
```bash
# Gravatar
MD5=$(echo -n "email@example.com" | md5sum | cut -d' ' -f1)
curl -sL "https://gravatar.com/avatar/$MD5?d=404" -w "%{http_code}"
```

### theHarvester
```bash
theHarvester -d example.com -b crtsh,certspotter,commoncrawl
```

---

## 4. DOMAIN / IP

```bash
nuclei -u https://example.com -severity critical,high
arjun -u https://example.com/api
echo "https://example.com" | hakrawler -d 3
nmap -sV -sC -T4 example.com
```

---

## 5. SOCIAL MEDIA

### GitHub Profile
```bash
curl -sL "https://github.com/USER" | python3 -c "
import re,sys
html=sys.stdin.read()
for p,l in [(r'p-name[^>]*>([^<]+)','Name'),(r'p-nickname[^>]*>([^<]+)','User'),
            (r'mailto:([^"]+)','Email'),(r'homeLocation[^>]*title=\\\"([^\\\"]*)\\\"','Loc')]:
    m=re.search(p,html)
    if m: print(f'{l}: {m.group(1).strip()}')
"
curl -sL "https://github.com/USER?tab=repositories" | grep -oE 'itemprop="name codeRepository"[^>]*>\s*([^<\s]+)' | head -20
```

### GitHub Dorks
```
site:github.com "user" password
site:github.com "email" secret
site:github.com filename:.env filename:id_rsa
```

---

## 6. DORKS

```
"exact phrase"  site:domain.com  filetype:pdf  intitle:word  inurl:word

Phone: site:facebook.com "081234567890" site:tokopedia.com "081234567890"
Email: site:pastebin.com "email@example.com" "email@example.com" breach OR leak
User:  site:instagram.com "username" site:twitter.com "username"
```

---

## 7. BREACH

```
https://dehashed.com   https://intelx.io   https://leakcheck.io
site:pastebin.com "target@email.com"
site:ghostbin.com "target"
```

---

## 8. GEO / IMAGE

```bash
exiftool image.jpg | grep -iE '(GPS|location)'
curl -s "http://ip-api.com/json/IP"
# Reverse: images.google.com, tineye.com, yandex.com/images
```

---

## 9. KILL CHAIN

```
1. IDENTIFY: Phone->1, Username->2, Email->3, Domain->4
2. PLATFORM-NATIVE (before search engines)
3. SEARCH ENGINE DORKS (exact match all variants)
4. DEEP DIVE (PFP analysis, bio pivot, follower triage)
5. DOSSIER (FIRM/TENTATIVE matrix, social graph, identity)
```

---

## CONFIDENCE
- **FIRM** = directly observed (bio, member count, live render)
- **TENTATIVE** = single source, needs corroboration

---

## PITFALLS

- Search engines CAPTCHA server IPs -> platform-native first
- IG/TikTok/YT 200 soft-404 -> verify page content
- FB session carries -> "Not you?" between numbers
- FB anti-bot 0-dimension -> fresh tab
- TikTok 5s wait for JS render
- IG max 2 attempts before lockout
- TG "Join group chat" = phone probe, NOT group
- LinkedIn 999, Reddit 403 -> note don't retry
- YT title mismatch = soft 404
- Pinterest og:title confirms even empty body
- GitHub empty name+"Block or report" = spam
- Carrier != geographic location
- Zero footprint all formats = stop
- IG empty page = anti-bot not rate limit
- Wayback = only source for expired Indo sites