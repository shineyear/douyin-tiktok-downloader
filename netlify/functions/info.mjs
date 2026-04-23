// Zero-bandwidth endpoint for iOS Shortcuts & other API consumers.
//   GET /api/info?url=<share_link>
// Returns JSON describing how to fetch the video directly from the CDN,
// so the caller can bypass our server for the MP4 bytes. Saves Netlify
// egress entirely when the direct path works.
//
// Douyin: direct fetch works reliably — aweme.snssdk.com/play only wants
//         an iPhone UA, no session binding.
// TikTok: signed URLs may be IP-bound to the server that parsed the HTML.
//         We include the direct URL + cookies in case it works, but the
//         caller should fall back to proxy_url on 403.

import { parseShareLink, MOBILE_UA, DESKTOP_UA } from './_lib.mjs';

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

  const filename = `${parsed.platform}_${parsed.item_id || parsed.video_id || 'video'}.mp4`;

  const direct = parsed.platform === 'douyin'
    ? {
        url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(parsed.vid)}&ratio=720p&line=0`,
        headers: {
          'User-Agent': MOBILE_UA,
          'Referer': 'https://www.douyin.com/',
        },
        note: 'Reliable — no IP binding. Preferred path.',
      }
    : {
        url: parsed.cdnUrl,
        headers: {
          'User-Agent': DESKTOP_UA,
          'Referer': 'https://www.tiktok.com/',
          ...(parsed.cookie ? { Cookie: parsed.cookie } : {}),
        },
        note: 'TikTok signed URLs may be IP-bound; if the direct fetch 403s, use proxy_url instead.',
      };

  return json(200, {
    platform: parsed.platform,
    video_id: parsed.video_id,
    item_id: parsed.item_id,
    title: parsed.title,
    cover: parsed.cover,
    filename,
    direct,
    proxy_url: `${url.origin}/api/download?url=${encodeURIComponent(share)}`,
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
