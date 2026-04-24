// One-shot download endpoint for iOS Shortcuts & other API consumers.
//   GET /api/download?url=<share_link>
// Supports Douyin, TikTok, and Twitter / X. We parse the share link and
// 302-redirect to the resolved CDN URL. The HTTP client (Shortcut, curl,
// etc.) follows the redirect and pulls the MP4 directly from the CDN —
// zero Netlify egress for the bytes.
//
// Douyin / TikTok CDNs reject cross-origin Referer headers as anti-hotlink,
// but HTTP clients don't add Referer when following a server 302, so the
// follow succeeds. Twitter's video.twimg.com is a public Cloudflare CDN
// with no such restriction.

import { parseShareLink } from './_lib.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const share = url.searchParams.get('url') || url.searchParams.get('u');
  if (!share) return plain(400, 'missing url param, e.g. ?url=https://v.douyin.com/xxxxx/ or https://x.com/.../status/...');

  let parsed;
  try {
    parsed = await parseShareLink(share);
  } catch (err) {
    return plain(502, `parse failed: ${err.message}`);
  }

  if (!parsed.resolvedCdnUrl) {
    return plain(502, `could not resolve ${parsed.platform} CDN URL`);
  }

  // Netlify edge appends the original request query string to the Location
  // header when the redirect target has NO query string of its own (seen
  // in production: our Twitter MP4 URL is a clean path, Netlify rewrites
  // the Location to `cdn.../video.mp4?url=https%3A%2F%2Fx.com%2F...`).
  // Twitter CDN tolerates the junk param but iOS Shortcut's HTTP client
  // mis-handles it and saves the response as a JPEG. Pre-empt by adding a
  // benign cache-buster so the URL already has a query and merge skips.
  // Douyin / TikTok URLs already carry signed query strings, so this is
  // a no-op for them.
  let cdnUrl = parsed.resolvedCdnUrl;
  if (!cdnUrl.includes('?')) cdnUrl += `?_=${Date.now()}`;

  // 302 — client follows to the CDN. Bytes never touch this function.
  // Referrer-Policy: no-referrer as a belt-and-braces hint for browsers.
  return new Response(null, {
    status: 302,
    headers: {
      'Location': cdnUrl,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Video-Id': parsed.video_id || '',
      'X-Video-Title': encodeURIComponent(parsed.title || ''),
    },
  });
};

function plain(status, msg) {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
