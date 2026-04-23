// Netlify Function (classic Lambda signature) — parses a Douyin / TikTok
// share link and returns JSON with a proxy URL the browser can stream from.
// Heavy lifting lives in ./_lib.mjs so download.mjs and video.mjs can reuse it.

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const raw = (body.url || '').toString().trim();
  if (!raw) return json(400, { error: '链接为空' });

  const { parseShareLink } = await import('./_lib.mjs');

  let parsed;
  try {
    parsed = await parseShareLink(raw);
  } catch (err) {
    return json(502, { error: err.message });
  }

  // Zero-bandwidth design: we pre-resolve aweme.snssdk.com/play's 302
  // server-side (it has no CORS headers so the browser can't follow it
  // directly), and hand the final CDN URL to the browser. The browser
  // fetches it with referrerPolicy:'no-referrer' (Douyin CDN's
  // anti-hotlink filter rejects cross-origin Referers). Netlify egress
  // for the actual video bytes: 0.
  return json(200, {
    platform: parsed.platform,
    direct_cdn_url: parsed.resolvedCdnUrl || null,
    video_id: parsed.video_id,
    cover: parsed.cover,
    title: parsed.title,
    item_id: parsed.item_id,
  });
};
