// Zero-bandwidth endpoint for iOS Shortcuts. Returns JSON describing how
// to fetch the video directly from Douyin's CDN, so a Shortcut never
// pulls the MP4 bytes through our server.
//   GET /api/info?url=<share_link>
// iOS Shortcut flow: Get Contents of URL (this) -> Get Dictionary Value
// direct.url -> Get Contents of URL (that) -> Save to Photo Album.

import { parseShareLink, MOBILE_UA } from './_lib.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const share = url.searchParams.get('url') || url.searchParams.get('u');
  if (!share) return json(400, { error: 'missing url param, e.g. ?url=https://v.douyin.com/xxxxx/' });

  let parsed;
  try {
    parsed = await parseShareLink(share);
  } catch (err) {
    return json(502, { error: err.message });
  }

  const filename = `douyin_${parsed.item_id || parsed.video_id || 'video'}.mp4`;

  return json(200, {
    platform: 'douyin',
    video_id: parsed.video_id,
    item_id: parsed.item_id,
    title: parsed.title,
    cover: parsed.cover,
    filename,
    direct: {
      // parsed.resolvedCdnUrl is the final CDN URL after following the
      // aweme.snssdk.com/play 302 server-side. Browsers / Shortcuts can
      // hit it with just a User-Agent — no cookies, no IP binding.
      url: parsed.resolvedCdnUrl
        || `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(parsed.vid)}&ratio=720p&line=0`,
      headers: {
        'User-Agent': MOBILE_UA,
      },
      note: 'Send this request WITHOUT a Referer header — the CDN rejects cross-origin Referer.',
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
