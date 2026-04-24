// Zero-bandwidth endpoint for iOS Shortcuts. Returns JSON describing how
// to fetch the video directly from the platform's CDN, so a Shortcut never
// pulls the MP4 bytes through our server.
//   GET /api/info?url=<share_link>
// Supports Douyin and TikTok.

import { parseShareLink, MOBILE_UA, DESKTOP_UA } from './_lib.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const share = url.searchParams.get('url') || url.searchParams.get('u');
  if (!share) return json(400, { error: 'missing url param, e.g. ?url=https://v.douyin.com/xxxxx/ or https://www.tiktok.com/t/xxxxx/' });

  let parsed;
  try {
    parsed = await parseShareLink(share);
  } catch (err) {
    return json(502, { error: err.message });
  }

  const filename = `${parsed.platform}_${parsed.item_id || parsed.video_id || 'video'}.mp4`;
  // Douyin still has a fallback URL via aweme.snssdk.com if the server-side
  // resolve missed (very rare). TikTok has no usable fallback — without the
  // cookieless 302 trick there's no URL the client can fetch.
  const fallback = parsed.platform === 'douyin' && parsed.vid
    ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(parsed.vid)}&ratio=720p&line=0`
    : null;

  return json(200, {
    platform: parsed.platform,
    video_id: parsed.video_id,
    item_id: parsed.item_id,
    title: parsed.title,
    cover: parsed.cover,
    filename,
    direct: {
      url: parsed.resolvedCdnUrl || fallback,
      headers: {
        'User-Agent': parsed.platform === 'tiktok' ? DESKTOP_UA : MOBILE_UA,
      },
      note: 'Send this request WITHOUT a Referer and WITHOUT cookies — the CDN serves a permissive variant only when neither is present.',
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
