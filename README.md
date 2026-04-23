# Douyin & TikTok Video Downloader

[![Deploy Status](https://img.shields.io/badge/status-live-success)](https://digitaldialogue.com.au/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A mobile-first web tool that parses a Douyin (抖音) or TikTok share link and saves the **watermark‑free MP4** straight into your iPhone **Camera Roll** via the native iOS Share Sheet — no app to install, no sign‑up, no ads.

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

## API for iOS Shortcuts

Two endpoints, two trade-offs:

### `/api/download` — one-shot, bytes through our server

```
GET https://digitaldialogue.com.au/api/download?url=<share_link>
→ 200 video/mp4
```

Single HTTP call, response streams the watermark-free MP4 straight into **Save to Photo Album**. Simplest Shortcut (3 actions):

1. **Receive** — Text / URLs from Share Sheet
2. **Get Contents of URL** — `https://digitaldialogue.com.au/api/download?url=` + Shortcut Input, method GET
3. **Save to Photo Album**

Trade-off: every byte goes through our server, counts against Netlify bandwidth.

### `/api/info` — zero bandwidth, direct CDN fetch

```
GET https://digitaldialogue.com.au/api/info?url=<share_link>
→ 200 application/json
{
  "platform": "douyin",
  "filename": "douyin_7631...mp4",
  "direct": {
    "url": "https://aweme.snssdk.com/aweme/v1/play/?video_id=...",
    "headers": { "User-Agent": "...", "Referer": "https://www.douyin.com/" }
  },
  "proxy_url": "https://digitaldialogue.com.au/api/download?url=..."
}
```

Returns only metadata (~1 KB). The Shortcut fetches the MP4 directly from the CDN with the headers we provided — **our server stays out of the video bytes**. Works reliably for Douyin; TikTok's signed URLs can be IP-bound so use `proxy_url` as a fallback.

Shortcut (5 actions for Douyin):

1. Receive Text / URLs from Share Sheet
2. Get Contents of URL — `https://digitaldialogue.com.au/api/info?url=` + Shortcut Input
3. Get Dictionary Value → `direct.url`
4. Get Contents of URL — the URL from step 3, with Headers: `User-Agent` = `direct.headers.User-Agent`, `Referer` = `direct.headers.Referer`
5. Save to Photo Album

### Download response headers (for either path)

| Header                | Example                                   |
| --------------------- | ----------------------------------------- |
| `Content-Disposition` | `attachment; filename="douyin_7631...mp4"`|
| `X-Video-Platform`    | `douyin` or `tiktok`                      |
| `X-Video-Id`          | `v0d00fg10000d7jk097og65m1m8dl080`        |
| `X-Video-Title`       | percent-encoded UTF-8 caption             |

## Features

- **Douyin + TikTok** — auto-detects the platform from the URL
- **Watermark-free** — pulls the clean `play_addr` / `playAddr` MP4
- **Save to Photos on iPhone** — tap once, native Share Sheet opens with "Save Video"
- **Progress prefetch** — the MP4 downloads in the background while the page renders, so the save button click can call `navigator.share()` synchronously (avoids Safari's NotAllowedError from expired user activation)
- **i18n** — 中文 / English / 日本語 / Español, picked by `?lang=` query param or browser locale
- **SEO** — per-language title/description, OG tags, hreflang, canonical, JSON-LD, sitemap, robots.txt
- **No servers to run** — deploys as a static page + two Netlify Functions

## How it works

```
Browser           Netlify Function             Douyin / TikTok
───────           ────────────────             ───────────────
  │                    │                             │
  ├─ POST /parse ─────>│                             │
  │                    ├── GET share URL ──────────>│
  │                    │<── HTML + Set-Cookie ──────│
  │                    │   (extract play addr +     │
  │                    │    session cookies)        │
  │<── { video_url,    │                             │
  │      cover, title }│                             │
  │                    │                             │
  ├─ GET /video?... ──>│                             │
  │                    ├── GET CDN URL w/ UA+Ref ─>│
  │                    │<── MP4 stream ────────────│
  │<── MP4 stream ─────│                             │
  │   (iOS Safari plays inline + long-press works)  │
```

- **`/parse`** (classic Lambda): resolves the short URL, parses `_ROUTER_DATA` (Douyin) or `__UNIVERSAL_DATA_FOR_REHYDRATION__` (TikTok), returns a proxy URL pointing to `/video`.
- **`/video`** (v2 streaming function): re-fetches the CDN MP4 server-side with the right `User-Agent` + `Referer` + session cookies, streams it back to the browser with a clean `Content-Type: video/mp4` so iOS treats it as a first-class media resource.

The proxy exists because TikTok's CDN requires session cookies captured during the HTML fetch (otherwise 403), and Douyin's play URLs are one-shot / short-lived.

## Layout

```
douyin_downloader/
├── index.html                  # mobile-first UI with i18n
├── netlify/functions/
│   ├── _lib.mjs                # shared: parse + fetchVideoStream
│   ├── parse.js                # POST  → JSON with proxy URL (used by the web UI)
│   ├── video.mjs               # GET   → streaming CDN proxy (uses allowlist)
│   ├── download.mjs            # GET   → one-shot MP4 stream (simple Shortcut)
│   └── info.mjs                # GET   → JSON with direct CDN URL + headers (zero-bandwidth Shortcut)
├── netlify.toml                # Netlify config + /api/download redirect
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

Drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop) — Netlify picks up `netlify.toml` automatically. The default Node 18 runtime supports v2 streaming functions out of the box.

## Why the funny workarounds?

A few decisions worth calling out because they took real debugging to land on:

- **Prefetch the full MP4 on parse, not on save click.** `navigator.share()` requires transient user activation (~5s from click). Awaiting a multi-MB download inside the click handler blows past that window and Safari throws `NotAllowedError`. Prefetching means the save click can call `share()` synchronously.
- **Desktop UA for TikTok, mobile UA for Douyin.** TikTok's web CDN rejects mobile UA; Douyin's `aweme.snssdk.com/play` endpoint prefers mobile.
- **Forward TikTok session cookies.** TikTok's play URLs have `tk=tt_chain_token` that is validated against a matching `Cookie: tt_chain_token=…`. Parse captures the cookie from the HTML response, we pass it through the proxy URL.
- **Allowlist CDN hosts in the proxy.** Prevents the `/video` endpoint being used as an open proxy. Currently allows Douyin / TikTok / ByteDance CDN domains only.

## License

MIT

## Credits

Built by [@shineyear](https://github.com/shineyear) — originally a one-off personal tool, made public after friends kept asking how to save Douyin videos to their iPhones without installing sketchy apps.
