# Douyin, TikTok & X Video Downloader

[![Deploy Status](https://img.shields.io/badge/status-live-success)](https://digitaldialogue.com.au/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A mobile-first web tool that parses a **Douyin (抖音), TikTok, or X (Twitter)** share link and saves the **watermark-free MP4** straight into your iPhone **Camera Roll** via the native iOS Share Sheet — no app to install, no sign-up, no ads.

**Zero-bandwidth design**: the web page and every API consumer pull the MP4 **directly from each platform's CDN**. Our server only does the small HTML/JSON parse (~1 KB per video) — **no video bytes transit the server**.

Live at **[digitaldialogue.com.au](https://digitaldialogue.com.au/)**.

<p align="center">
  <img src="screenshots/hero-zh.png" width="300" alt="中文">
  <img src="screenshots/hero-en.png" width="300" alt="English">
</p>
<p align="center">
  <img src="screenshots/hero-ja.png" width="300" alt="日本語">
  <img src="screenshots/hero-es.png" width="300" alt="Español">
</p>

---

## Features

- **Douyin, TikTok & X (Twitter)** — watermark-free MP4 via per-platform parsing
- **Zero hosting bandwidth** — video bytes flow browser ↔ platform CDN, not through us (see architecture below)
- **Save to Photos on iPhone** — tap once, native Share Sheet opens with "Save Video"
- **Progress prefetch** — the MP4 streams into memory during render so the save click can call `navigator.share()` synchronously (avoids Safari's NotAllowedError from expired user activation)
- **i18n** — 中文 / English / 日本語 / Español, picked by `?lang=` query param or browser locale
- **SEO** — per-language title/description, OG tags, hreflang, canonical, JSON-LD, sitemap, robots.txt
- **Two public APIs** for iOS Shortcuts, both zero-bandwidth, both auto-detect the platform

## How the zero-bandwidth trick works

Each platform has a public endpoint that hands us the CDN URL without authentication. The exact mechanism differs:

| Platform | Page host | Resolution path | Final CDN host | CORS | URL lifetime |
|----------|-----------|-----------------|----------------|------|--------------|
| Douyin   | `www.douyin.com` | server-side `aweme.snssdk.com/aweme/v1/play/` 302 follow | `*.zjcdn.com` / `*.douyinvod.com` | `*` | ~5 min signed |
| TikTok   | `www.tiktok.com` | server-side `www.tiktok.com/aweme/v1/play/` 302 follow (cookieless variant) | `*.tiktokcdn-us.com` | `*` | ~5 min signed |
| X (Twitter) | `cdn.syndication.twimg.com/tweet-result` (oEmbed-style API, no auth) | direct MP4 URL in the JSON response — no 302 | `video.twimg.com` (Cloudflare) | `*` | **1 week** (`max-age=604800`) |

**Douyin**: `aweme.snssdk.com` has no CORS headers so browsers can't follow its 302 from JS. The redirect target does have ACAO `*` and accepts requests with no Referer (CDN rejects cross-origin Referer as anti-hotlink). We do the follow once server-side.

**TikTok**: same play-redirect endpoint serves *two different Locations* based on whether the request carries `tt_chain_token` cookie. With cookie → `v16-webapp-prime.us.tiktok.com` (cookie-gated, 403 cold). Without cookie → `v16m-default.tiktokcdn-us.com` (signed URL, no header requirements, ACAO `*`). Node fetch has no cookie jar, so the cookieless variant comes back automatically.

**X (Twitter)**: easiest by far. The same `cdn.syndication.twimg.com/tweet-result?id=…` endpoint that powers `publish.twitter.com` returns a JSON with `video.variants[]` listing direct MP4 URLs at multiple resolutions (480p / 720p / 1080p). No 302, no signature, no cookie — just public Cloudflare-cached assets that browsers can `fetch()` directly. We pick the highest resolution.

```
Browser                  Netlify Function              Platform
───────                  ────────────────              ──────────
  │                            │                          │
  ├─ POST /parse ────────────> │                          │
  │                            ├─ extract video URL       │  Douyin/TikTok: page+302
  │                            │  (per-platform path) ──> │  Twitter: syndication API
  │<── { direct_cdn_url, … } ──│                          │
  │                                                       │
  ├─ GET direct_cdn_url (no Referer, no cookies) ──────> │
  │<── MP4 bytes ←─ 2-15 MB straight from platform CDN ──│
  │   (<video> plays + File for navigator.share)          │
```

## API for iOS Shortcuts

### `/api/download` — simplest, zero-bandwidth

```
GET https://digitaldialogue.com.au/api/download?url=<share_link>
→ 302 Location: https://v5-dy-o-abtest.zjcdn.com/.../video.mp4
```

The server 302-redirects to the CDN; the Shortcut's HTTP client follows the redirect and pulls bytes straight from Douyin. **Zero bytes transit our server.**

<p align="center">
  <img src="screenshots/ios-shortcut.jpg" width="320" alt="iOS Shortcut configuration">
</p>

#### One-tap install (recommended)

Open this link on your iPhone in **Safari** (not Chrome):

→ **[icloud.com/shortcuts/677ab543c5894e50ad3c7acc0b9640ce](https://www.icloud.com/shortcuts/677ab543c5894e50ad3c7acc0b9640ce)**

Tap **Add Shortcut** → done. The Shortcut is named *Save to Photos* and is pre-wired with the regex below + every setting in place.

> ⚠️ **iOS Photos sorts the Library by capture date, not save date.** A video posted a week ago will land where last week's photos are, not at the top. To see what you just saved, look in **Photos → Albums → Recents** (sorted by add date) or scroll Library.

#### Use it

Open Douyin / TikTok / X → tap any video's **Share** button → swipe the Shortcuts row and pick yours → a few seconds later the video is in Photos. If you just have a share link on the clipboard, run the Shortcut from the home screen / widget instead.

> ⚠️ **Don't tap the ▶ Play button in the Shortcuts editor to test.** It runs without Share Sheet input, so step 1 silently falls through to Clipboard — if that doesn't contain a supported link you'll get a confusing error. Always test via the real share menu.

#### Building it manually (if you can't import the iCloud link)

Open the **Shortcuts** app → tap **+** to create a new Shortcut.

**First: enable Share Sheet in settings (NOT in actions).** Tap the **ⓘ info icon** at the bottom of the editor → toggle **Show in Share Sheet** on → for **Share Sheet Types** keep **only Text** checked and uncheck everything else (including URLs). Name it e.g. *Save to Photos*.

> ⚠️ "Receive Input" is a Shortcut **setting**, not an action you can search for. If you skip the toggle above, the Shortcut won't appear in any app's share menu.
>
> ⚠️ **Accept Text, not URLs.** Douyin's share blob looks like `8.97 复制打开抖音… https://v.douyin.com/XXXX/ S@Y.MW YMW:/ 12/07`. If you accept URLs, iOS auto-extracts `S@Y.MW` as `mailto:S@Y.MW` and you'll hit *"URL is missing a hostname"*.

Then add these 4 actions:

1. **Receive Text from Share Sheet** — type Text; if no input → **Get Clipboard**.
2. **Match Text** — pattern `https?:\/\/(?:v\.douyin\.com|(?:www\.|vm\.)?tiktok\.com|(?:www\.|mobile\.)?(?:twitter|x)\.com|t\.co)\/[^\s]+` against **Shortcut Input**.
3. **Get Contents of URL** — `https://digitaldialogue.com.au/api/download?url=` + **Matches** variable. Method: **GET**.
4. **Save to Photo Album** — input **Contents of URL** → album **Recents**.

### `/api/info` — same zero bandwidth, but returns JSON if you want finer control

```
GET https://digitaldialogue.com.au/api/info?url=<share_link>
→ 200 application/json
{
  "platform": "twitter",                              // or "douyin", "tiktok"
  "filename": "twitter_2031895801064985021.mp4",
  "title": "STRIKE. 💥🦅 ...",
  "direct": {
    "url": "https://video.twimg.com/amplify_video/.../1920x1080/...mp4",
    "headers": { "User-Agent": "..." },
    "note": "Standard GET — video.twimg.com is a public Cloudflare CDN with cache-control: max-age=604800."
  },
  "download_url": "https://digitaldialogue.com.au/api/download?url=..."
}
```

Use this if you want to inspect metadata (title, cover, video_id) inside your Shortcut before fetching, or if you want to set a custom User-Agent.

## Layout

```
douyin_downloader/
├── index.html                  # mobile-first UI with i18n
├── netlify/functions/
│   ├── _lib.mjs                # shared parser + 302 resolver
│   ├── parse.js                # POST  → JSON with direct_cdn_url (used by the web UI)
│   ├── download.mjs            # GET   → 302 redirect to CDN (simple Shortcut)
│   └── info.mjs                # GET   → JSON with direct.url + headers (advanced Shortcut)
├── netlify.toml                # Netlify config + /api/* redirects
├── sitemap.xml
├── robots.txt
├── screenshots/                # README assets
└── dev-server.js               # local-only dev server (http + https via self-signed cert)
```

## Local development

```bash
# Generate a self-signed cert for HTTPS (needed for navigator.share on mobile)
mkdir -p .certs
openssl req -x509 -newkey rsa:2048 -keyout .certs/key.pem -out .certs/cert.pem \
  -sha256 -days 365 -nodes \
  -subj "/CN=$(ipconfig getifaddr en0)" \
  -addext "subjectAltName=IP:$(ipconfig getifaddr en0),IP:127.0.0.1,DNS:localhost"

# Run the dev server (HTTP on :8888, HTTPS on :8443)
node dev-server.js
```

Open `https://<lan-ip>:8443/` on your iPhone, accept the self-signed cert warning, and the `navigator.share({ files })` flow will work.

## Deploy

Drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop) — Netlify picks up `netlify.toml` automatically. Node 18 runtime supports v2 streaming functions out of the box.

## Why the funny workarounds?

- **Prefetch the full MP4 on parse, not on save click.** `navigator.share()` requires transient user activation (~5s from click). Awaiting a multi-MB download inside the click handler blows past that window and Safari throws `NotAllowedError`. Prefetching means the save click calls `share()` synchronously.
- **`referrerPolicy: 'no-referrer'` everywhere (for Douyin / TikTok).** Both platforms' CDN anti-hotlink filters accept a request with no Referer but 403 any cross-origin one. We set the policy on the prefetch `fetch()` and use a 302 for the Shortcut endpoint (HTTP clients don't add Referer when following 302s). Twitter's `video.twimg.com` doesn't care about Referer, but the policy is harmless.
- **Server-resolve the play-redirect 302.** The redirect endpoints (Douyin: `aweme.snssdk.com`; TikTok: `www.tiktok.com/aweme/v1/play/`) either lack CORS headers or serve different Locations based on cookies, so the browser can't reliably follow them. We do the follow once server-side and hand the resulting cookieless CDN URL to the client. Twitter skips this step — `cdn.syndication.twimg.com/tweet-result` returns the final CDN URL directly in JSON.
- **Per-platform User-Agent.** TikTok and Twitter syndication 403 mobile UAs and need desktop Chrome. Douyin is the opposite — its mobile-share endpoint expects an iPhone Safari UA.

## License

MIT

## Credits

Built by [@shineyear](https://github.com/shineyear).
