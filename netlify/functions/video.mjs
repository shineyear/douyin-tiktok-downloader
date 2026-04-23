// Streaming video proxy. Two modes:
//   ?p=douyin&vid=<video_id>           -> hit aweme.snssdk.com play endpoint
//   ?p=tiktok&src=<url-encoded mp4>&ck=<cookie> -> stream a TikTok CDN URL
// We inject a platform-correct Referer + UA + cookies that the browser can't,
// and hide short-lived / Referer-gated URLs behind our own origin so iOS
// Safari's <video> + navigator.share keep working.

import { fetchVideoStream } from './_lib.mjs';

export default async (req) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get('p') || 'douyin';
  const vid = url.searchParams.get('vid');
  const src = url.searchParams.get('src');
  const cookie = url.searchParams.get('ck');

  let upstream;
  try {
    upstream = await fetchVideoStream(
      { platform, vid, cdnUrl: src, cookie },
      { range: req.headers.get('range') },
    );
  } catch (err) {
    return new Response(err.message, { status: 400 });
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`upstream ${upstream.status}`, { status: upstream.status });
  }

  const respHeaders = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `inline; filename="${platform}_${vid || 'video'}.mp4"`,
  });
  for (const key of ['content-length', 'content-range', 'last-modified', 'etag']) {
    const v = upstream.headers.get(key);
    if (v) respHeaders.set(key, v);
  }

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
};
