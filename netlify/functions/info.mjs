// Zero-bandwidth endpoint for iOS Shortcuts. Returns JSON describing how
// to fetch the video directly from the platform's CDN, so a Shortcut never
// pulls the MP4 bytes through our server.
//   GET /api/info?url=<share_link>
// Supports Douyin, TikTok, and Twitter / X.

import { parseShareLink, MOBILE_UA, DESKTOP_UA } from './_lib.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const share = url.searchParams.get('url') || url.searchParams.get('u');
  if (!share) return json(400, { error: 'missing url param, e.g. ?url=https://v.douyin.com/xxxxx/ or https://x.com/.../status/...' });

  let parsed;
  try {
    parsed = await parseShareLink(share);
  } catch (err) {
    return json(502, { error: err.message });
  }

  const filename = `${parsed.platform}_${parsed.item_id || parsed.video_id || 'video'}.mp4`;
  // Douyin still has a fallback URL via aweme.snssdk.com if the server-side
  // resolve missed (very rare). TikTok / Twitter have no usable fallback —
  // for TikTok the cookieless 302 trick is mandatory, for Twitter the
  // syndication call is the only way to get the variant URLs at all.
  const fallback = parsed.platform === 'douyin' && parsed.vid
    ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(parsed.vid)}&ratio=720p&line=0`
    : null;

  // Per-platform UA hint — TikTok page-fetch requires desktop Chrome,
  // Douyin requires mobile, Twitter video.twimg.com accepts anything.
  const ua = parsed.platform === 'tiktok' ? DESKTOP_UA
           : parsed.platform === 'twitter' ? DESKTOP_UA
           : MOBILE_UA;

  // Per-platform note. Twitter URLs are open Cloudflare-cached assets so
  // the "no Referer / no cookies" advice doesn't apply (it doesn't hurt
  // either, but it's misleading to imply it's required).
  const note = parsed.platform === 'twitter'
    ? 'Standard GET — video.twimg.com is a public Cloudflare CDN with cache-control: max-age=604800.'
    : 'Send this request WITHOUT a Referer and WITHOUT cookies — the CDN serves a permissive variant only when neither is present.';

  return json(200, {
    platform: parsed.platform,
    video_id: parsed.video_id,
    item_id: parsed.item_id,
    title: parsed.title,
    cover: parsed.cover,
    filename,
    direct: {
      url: parsed.resolvedCdnUrl || fallback,
      headers: { 'User-Agent': ua },
      note,
    },
    download_url: `${url.origin}/api/download?url=${encodeURIComponent(share)}`,
  });
};

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
