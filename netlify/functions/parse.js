// Netlify Function (classic Lambda signature) — parses a Douyin / TikTok /
// Twitter / Instagram share link and returns JSON with a direct CDN URL
// the browser can fetch without going through our server.
//
// Accepts GET (?url=) and POST ({url}). GET responses set Cache-Control
// with a per-platform TTL so Netlify edge cache absorbs repeat hits on
// the same share URL across all users — critical for Instagram where
// the graphql endpoint rate-limits our IP pool aggressively.

function json(status, body, cacheTtlSec = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (status === 200 && cacheTtlSec > 0) {
    // public = any cache may store (including shared caches like Netlify edge)
    // s-maxage overrides max-age for CDN/edge specifically
    headers['Cache-Control'] = `public, max-age=${cacheTtlSec}, s-maxage=${cacheTtlSec}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return {
    statusCode: status,
    headers,
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  let raw;
  if (event.httpMethod === 'GET') {
    raw = (event.queryStringParameters?.url || '').toString().trim();
  } else if (event.httpMethod === 'POST') {
    try {
      raw = (JSON.parse(event.body || '{}').url || '').toString().trim();
    } catch { return json(400, { error: 'Invalid JSON body' }); }
  } else {
    return json(405, { error: 'Method not allowed' });
  }
  if (!raw) return json(400, { error: '链接为空' });

  const { parseShareLink, cacheTtlForPlatform } = await import('./_lib.mjs');

  let parsed;
  try {
    parsed = await parseShareLink(raw);
  } catch (err) {
    // Errors are never cached — a transient rate-limit shouldn't become
    // permanent from the user's perspective.
    return json(502, { error: err.message });
  }

  // Only GET can be edge-cached; POST responses are never cached per HTTP spec.
  const edgeTtl = event.httpMethod === 'GET' ? cacheTtlForPlatform(parsed.platform) : 0;

  return json(200, {
    platform: parsed.platform,
    direct_cdn_url: parsed.resolvedCdnUrl || null,
    video_id: parsed.video_id,
    cover: parsed.cover,
    title: parsed.title,
    item_id: parsed.item_id,
  }, edgeTtl);
};
