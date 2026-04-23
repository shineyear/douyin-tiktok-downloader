// One-shot endpoint for iOS Shortcuts & other external callers.
//   GET /api/download?url=<share_link>   (mapped in netlify.toml)
//   GET /.netlify/functions/download?url=<share_link>
// Parses the share link and streams back MP4 bytes in the same response, so
// a Shortcut can do "Get Contents of URL" -> "Save to Photo Album".

import { parseShareLink, fetchVideoStream } from './_lib.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const share = url.searchParams.get('url') || url.searchParams.get('u');
  if (!share) return plain(400, 'missing url param, e.g. ?url=https://v.douyin.com/xxxxx/');

  let parsed;
  try {
    parsed = await parseShareLink(share);
  } catch (err) {
    return plain(502, `parse failed: ${err.message}`);
  }

  let upstream;
  try {
    upstream = await fetchVideoStream(parsed, { range: req.headers.get('range') });
  } catch (err) {
    return plain(502, `upstream build failed: ${err.message}`);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return plain(upstream.status, `upstream ${upstream.status}`);
  }

  const filename = `${parsed.platform}_${parsed.item_id || parsed.video_id || 'video'}.mp4`;
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    // attachment disposition encourages Shortcuts' "Get Contents" to treat
    // the response as a file rather than trying to preview it.
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Video-Platform': parsed.platform,
    'X-Video-Id': parsed.video_id || '',
    'X-Video-Title': encodeURIComponent(parsed.title || ''),
  });
  for (const k of ['content-length', 'content-range', 'etag']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
};

function plain(status, msg) {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
