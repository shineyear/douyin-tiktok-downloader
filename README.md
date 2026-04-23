# Douyin Video Downloader

[![Deploy Status](https://img.shields.io/badge/status-live-success)](https://digitaldialogue.com.au/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A mobile-first web tool that parses a Douyin (抖音) share link and saves the **watermark-free MP4** straight into your iPhone **Camera Roll** via the native iOS Share Sheet — no app to install, no sign-up, no ads.

**Zero-bandwidth design**: the web page and every API consumer pull the MP4 **directly from Douyin's CDN**. Our server only does the small HTML/JSON parse (~1 KB) — **no video bytes transit the server**.

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

- **Douyin only** — watermark-free MP4 via `_ROUTER_DATA` parsing
- **Zero hosting bandwidth** — video bytes flow browser ↔ Douyin CDN, not through us (see architecture below)
- **Save to Photos on iPhone** — tap once, native Share Sheet opens with "Save Video"
- **Progress prefetch** — the MP4 streams into memory during render so the save click can call `navigator.share()` synchronously (avoids Safari's NotAllowedError from expired user activation)
- **i18n** — 中文 / English / 日本語 / Español, picked by `?lang=` query param or browser locale
- **SEO** — per-language title/description, OG tags, hreflang, canonical, JSON-LD, sitemap, robots.txt
- **Two public APIs** for iOS Shortcuts, both zero-bandwidth

## How the zero-bandwidth trick works

Douyin's `aweme.snssdk.com/play` endpoint returns a 302 redirect to the actual CDN URL (`v5-dy-o-abtest.zjcdn.com/...`). Two asymmetries make the magic:

1. `aweme.snssdk.com` has **no CORS headers** → a browser can't follow its 302 from JavaScript.
2. The redirect target `*.zjcdn.com` has `Access-Control-Allow-Origin: *` → a browser **can** CORS-fetch it.
3. The CDN rejects any cross-origin `Referer` as anti-hotlinking → the browser must use `referrerPolicy: 'no-referrer'`.

So our `/parse` endpoint performs the 302-follow server-side, hands the resolved CDN URL to the browser, and the browser fetches it directly with no-referrer. Netlify egress: ~1 KB of JSON per video.

```
Browser                  Netlify Function              Douyin
───────                  ────────────────              ──────
  │                            │                         │
  ├─ POST /parse ────────────> │                         │
  │                            ├── GET share URL ──────> │
  │                            │<── HTML  ───────────────│
  │                            │   (extract video_id)    │
  │                            ├── HEAD aweme/play ────> │
  │                            │<── 302 Location: CDN ───│
  │<── { direct_cdn_url, … } ──│                         │
  │                                                      │
  ├─ GET direct_cdn_url (no Referer) ──────────────────> │
  │<── MP4 bytes ←─ 15 MB straight from Douyin CDN ────  │
  │   (<video> plays + File for navigator.share)         │
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

Build a 4-action Shortcut exactly as shown above. On iPhone: open the **Shortcuts** app → tap **+** to create a new Shortcut.

#### First: enable it in the Share Sheet (this is NOT an action)

Tap the **ⓘ info icon** at the bottom of the editor → toggle **Show in Share Sheet** on → for **Share Sheet Types** keep **only Text** checked and uncheck everything else (including URLs). Name it e.g. *Save to Photos*.

> ⚠️ This is a gotcha — "Receive Input" is a Shortcut **setting**, not an action you can search for. If you skip it, the Shortcut won't appear in Douyin's share menu.
>
> ⚠️ **Accept Text, not URLs.** Douyin's share blob looks like `8.97 复制打开抖音… https://v.douyin.com/XXXX/ S@Y.MW YMW:/ 12/07`. If you accept URLs, iOS auto-extracts `S@Y.MW` as `mailto:S@Y.MW` and you'll hit the error *"URL is missing a hostname"* before your actions even run.

#### Then: add these 4 actions in order

**1. Receive Text from Share Sheet**
- Action: *Receive input from Share Sheet*
- Type: **Text**
- If there's no input: **Get Clipboard** (so it also works when you copy a share link instead of tapping Share)

**2. Match Text** (this is where the URL gets extracted)
- Action: *Match Text*
- Pattern: `https:\/\/v\.douyin\.com\/[A-Za-z0-9\/?=_-]+`
- Input: **Shortcut Input**

This regex pulls the `v.douyin.com/XXXX` short link out of the mixed text blob above. Without it the whole blob gets URL-encoded and the API can't parse anything.

**3. Get Contents of URL**
- URL: `https://digitaldialogue.com.au/api/download?url=` followed by the **Matches** variable from step 2
- Method: **GET** (default; Shortcuts URL-encodes the appended variable automatically)

**4. Save to Photo Album**
- Action: *Save to Photo Album*
- Input: **Contents of URL** from step 3
- Album: **Recents** (or any album you prefer)

#### Use it

Open Douyin → tap any video's **Share** button → swipe the Shortcuts row and pick yours → a few seconds later the video is in Photos. If you just have a share link on the clipboard, run the Shortcut from the home screen / widget instead.

> ⚠️ **Don't tap the ▶ Play button in the editor to test.** It runs without Share Sheet input, so step 1 silently falls through to Clipboard — if that doesn't contain a Douyin link you'll get a confusing error. Always test via the real Douyin share menu.

### `/api/info` — same zero bandwidth, but returns JSON if you want finer control

```
GET https://digitaldialogue.com.au/api/info?url=<share_link>
→ 200 application/json
{
  "platform": "douyin",
  "filename": "douyin_7631...mp4",
  "direct": {
    "url": "https://v5-dy-o-abtest.zjcdn.com/.../video.mp4",
    "headers": { "User-Agent": "..." },
    "note": "Send this request WITHOUT a Referer header."
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
- **`referrerPolicy: 'no-referrer'` everywhere.** Douyin's CDN anti-hotlink filter accepts a request with no Referer but 403s on any cross-origin one. We set the policy on the prefetch `fetch()` and use a 302 for the Shortcut endpoint (HTTP clients don't add Referer when following 302s).
- **Server-resolve the `aweme.snssdk.com/play` 302.** That origin has no CORS headers so browsers can't follow its 302 in JS. The redirect target does, so we do the follow once server-side and hand the target URL to the client.
- **TikTok was dropped.** Its signed URLs require session cookies the browser can't replay, which forces all bytes through a proxy. That defeats the zero-bandwidth design, so we removed TikTok rather than make it the one path that costs bandwidth.

## License

MIT

## Credits

Built by [@shineyear](https://github.com/shineyear).
