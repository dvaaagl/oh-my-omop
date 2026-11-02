---
name: person-osint
description: "Use when OSINT-ing a person by phone, email, or username."
version: 1.3.0
triggers:
  - osint nomor
  - osint phone number
  - reverse phone
  - osint akun
  - osint telegram
  - osint username
  - osint instagram
  - osint email
  - cross-platform username
  - wa.me check
  - telegram profile osint
  - osint facebook
  - osint nama
  - osint name
  - osint person
  - sampah osint
  - cari orang
  - find person
  - osint crypto
  - osint nft
  - osint web3
---

# Person/Subject OSINT — Passive, No-Auth Pipeline

Scope: identifying a person/subject behind a phone number, handle, or account without auth and without touching the target. Deliverable: a dossier with confidence labels — never overclaim an identity match.

Confidence labels (mandatory on every identity claim):
- **FIRM** — directly observed on the platform (bio text, member counts, live page render).
- **TENTATIVE** — single source or same-brand coincidence.

## Procedure — Phone Number OSINT (order matters)

**Browser-independent by default.** The core vectors (WA, TG, spam DBs, web search) all run via curl. Browser is needed only for FB recovery and IG reset — treat those as escalation, not blocking.

1. **Enumerate target formats.** E.164 (`+62…`), national (`08…`), bare (`62…`). All later steps run per format.

2. **Carrier prefix lookup** (offline, no pip). Use the prefix map in `references/platform-recipes.md` §5. Mobile prefixes are NOT geographically tied.

3. **Platform-native checks BEFORE search engines** (order: WA → Telegram → spam DBs → web search):
   - **WhatsApp registration**: `wa.me/<E164>` — 302 → `api.whatsapp.com/send/?phone=…` + 200 + zero "invalid" in page = **registered & active**.
   - **Telegram phone-number probe**: `t.me/+62XXXXXXXXXX` — og:title shows display name if registered with username. "Telegram: Contact" = registered, no username.
   - **Caller-ID / spam DBs**: tellows, sync.me, nocall.io, spamcalls.net — extract community report count.
   - **Web search**: quoted-exact only (`"082130642257"`). Unquoted = fuzzy noise. If zero results across all formats, **stop searching**.

4. **Facebook Account Recovery** — THE critical identity vector for phone numbers.
   - URL: `https://www.facebook.com/login/identify/?ctx=recover&ars=facebook_login`
   - **React input filling** (standard `fill_input` fails on FB React):
     ```js
     js(`(() => {
         const input = document.querySelector("input[type='text']");
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
         setter.call(input, "+62XXXXXXXXXX");
         input.dispatchEvent(new Event("input", {bubbles:true}));
         input.dispatchEvent(new Event("change", {bubbles:true}));
         return input.value;
     })()`);
     js(`(() => {
         const btns = document.querySelectorAll("div[role='button']");
         for (const b of btns) {
             if (b.textContent.trim() === "Continue") { b.click(); return "clicked"; }
         }
     })()`);
     ```
   - Results show **masked initials** of every FB/Meta account bound to the number.
   - "Meta Accounts" = IG+FB unified. "Facebook" = FB-only.
   - Click "Not you?" between different numbers (session carries).
   - Anti-bot 0-dimension -> fresh tab + text walker extraction.

5. **Instagram password reset probe** (secondary, often blocked).
   - URL: `https://www.instagram.com/accounts/password/reset/`
   - Headless: empty page = anti-bot. Rate limit: 10-15min lockout.

6. **Cross-platform username sweep** (if handle was target).
   - Verify status codes AND page content. See `references/platform-recipes.md` §6.

7. **Email pivots** (if suspected).
   - Gravatar hash check, Wayback Machine, Indonetwork company profile.

8. **Deliver the dossier.** Structure:
   - Identity fields, carrier/region, social graph, business evidence, spam/safety, cross-platform matrix with FIRM/TENTATIVE, next escalation vectors.

## Procedure — Email-Based OSINT

1. **Email prefix analysis** — split local part for linguistic patterns.
2. **Gravatar profile check** — `md5(email)` → gravatar avatar.
3. **Username derivation from email prefix** — direct, underscore, stems.
4. **Cross-platform sweep** using derived username(s).
5. **Web search** for exact email AND username variants.
6. **Platform-native deep-dive** on confirmed platforms.
7. **Cross-platform profile pivot** — OAuth-linked profiles expose FB/Google user IDs.
8. **Breach/leak database pivot** — DeHashed, LeakCheck, IntelX.
9. **Deliver dossier** with email-specific fields.

## Procedure — Name-Based Person OSINT

1. **Parallel username stem generation** from display name.
2. **Direct platform probing FIRST** — skip search engines (CAPTCHA from server IPs).
3. **Facebook public name search** — `facebook.com/public/<Firstname>-<Lastname>`.
4. **Bio-link pivot** — lynk.id, linktree, beacon links in bios.
5. **Follower-count triage** — highest count = primary identity platform.
6. **Cross-reference username consistency** across 3+ platforms = FIRM match.
7. **GitHub repo enumeration** — richest signal for tech targets.

## Procedure — Username-Based OSINT

1. **Telegram first** — extract identity anchors from og:title/description/image.
2. **Cross-platform sweep** — parallel curl, status codes + content verification.
3. **Profile pic analysis** — download + vision analyze (brand/logo = business, real photo = identity, anime = interests).
4. **Web3/crypto pivot** — OpenSea, Web3.bio, Etherscan, Farcaster.
5. **Deep-dive confirmed platforms** — GitHub, X, Instagram, TikTok.
6. **Username variant probing** — case variations, shortened stems.
7. **Web search fallback** — only after platform-native checks.

## Procedure — Telegram Username OSINT

1. Platform-native first: `t.me/<username>` → og:title, og:description, og:image.
2. Pivot bio links → check group member counts.
3. Group post preview: `t.me/s/<group>` → payment info, business activity.
4. Profile pic download + vision analysis.
5. Cross-platform sweep.
6. Business pivot via Indonetwork/Google Maps.

## Pitfalls

- Search engines CAPTCHA headless browsers from server IPs. Platform-native first.
- TikTok requires 5s wait for JS render.
- Bio-link platforms (lynk.id, linktree) are often Cloudflare-protected.
- Pinterest confirms existence via og:title alone.
- X/Twitter returns 403 from headless. Note but don't retry.
- Multiple accounts same display name = TENTATIVE until username stem matches 3+ platforms.
- FB recovery anti-bot: session degradation after 2-3 lookups -> fresh tab.
- FB text walker for 0-dimension elements.
- IG headless detection returns empty page.
- Telegram default og:image = no custom PFP.
- Crypto-affiliated targets need Web3 platform checks.
- Zero web footprint across exhaustive formats = FIRM finding.
- Browser `js()` backtick nesting -> use triple-quoted strings in browser_exec.
- Never echo live phone number in full in output.