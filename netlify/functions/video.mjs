// Streaming video proxy. Two modes:
//   ?p=douyin&vid=<video_id>        -> hit aweme.snssdk.com play endpoint
//   ?p=tiktok&src=<url-encoded mp4> -> stream a TikTok CDN URL directly
// In both cases we inject a platform-correct Referer+UA the browser can't,
// and hide short-lived / Referer-gated URLs behind our own origin so
// iOS Safari's <video> + navigator.share work.

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const ALLOWED_HOSTS = [
  /\.douyinvod\.com$/,
  /\.zjcdn\.com$/,
  /^aweme\.snssdk\.com$/,
  /\.tiktokcdn\.com$/,
  /\.tiktokcdn-us\.com$/,
  /\.tiktokcdn-eu\.com$/,
  /\.tiktokv\.com$/,
  /\.ttcdnapi\.com$/,
  /\.muscdn\.com$/,
  // TikTok webapp delivers video from v{16,19}-webapp-prime.*.tiktok.com
  /\.tiktok\.com$/,
];

function isAllowedHost(host) {
  return ALLOWED_HOSTS.some((re) => re.test(host));
}

export default async (req) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get('p') || 'douyin';
  const vid = url.searchParams.get('vid');
  const src = url.searchParams.get('src');

  let upstreamUrl;
  if (platform === 'tiktok' && src) {
    try {
      const u = new URL(src);
      if (!isAllowedHost(u.hostname)) {
        return new Response(`host not allowed: ${u.hostname}`, { status: 403 });
      }
      upstreamUrl = u.toString();
    } catch {
      return new Response('invalid src', { status: 400 });
    }
  } else if (vid && /^[a-zA-Z0-9_]+$/.test(vid)) {
    const ratio = url.searchParams.get('ratio') || '720p';
    upstreamUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(vid)}&ratio=${encodeURIComponent(ratio)}&line=0`;
  } else {
    return new Response('missing vid or src', { status: 400 });
  }

  const referer = platform === 'tiktok' ? 'https://www.tiktok.com/' : 'https://www.douyin.com/';

  // TikTok CDN rejects mobile UA for the web-app playAddr URLs. Douyin's
  // aweme play endpoint is happy with mobile UA.
  const upstreamHeaders = {
    'User-Agent': platform === 'tiktok' ? DESKTOP_UA : MOBILE_UA,
    'Referer': referer,
    'Accept': '*/*',
  };
  const range = req.headers.get('range');
  if (range) upstreamHeaders['Range'] = range;

  // TikTok CDN gates play URLs on a session cookie captured during parse.
  const cookie = url.searchParams.get('ck');
  if (cookie) upstreamHeaders['Cookie'] = cookie;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { headers: upstreamHeaders, redirect: 'follow' });
  } catch (err) {
    return new Response(`upstream fetch failed: ${err.message}`, { status: 502 });
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
