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

  const { parseShareLink, buildVideoProxyUrl } = await import('./_lib.mjs');

  let parsed;
  try {
    parsed = await parseShareLink(raw);
  } catch (err) {
    return json(502, { error: err.message });
  }

  // direct_url: if Safari following this link will work without our proxy.
  // Douyin's play endpoint accepts the browser's native mobile UA (no IP
  // binding, no cookies). TikTok's signed URLs need cookies the browser
  // can't set, so force the proxy path there.
  const directUrl = parsed.platform === 'douyin'
    ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(parsed.vid)}&ratio=720p&line=0`
    : null;

  return json(200, {
    platform: parsed.platform,
    video_url: buildVideoProxyUrl(parsed),
    direct_url: directUrl,
    video_id: parsed.video_id,
    cover: parsed.cover,
    title: parsed.title,
    item_id: parsed.item_id,
  });
};
