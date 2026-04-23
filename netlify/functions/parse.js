// Netlify Function: parse Douyin or TikTok share link
// Returns { platform, video_url (proxy), video_id | play_src, cover, title, item_id }

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s，,）)】\]]+/);
  return m ? m[0] : null;
}

function detectPlatform(url) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  if (host.endsWith('tiktok.com') || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return 'tiktok';
  if (host.endsWith('douyin.com') || host === 'v.douyin.com' || host.endsWith('iesdouyin.com')) return 'douyin';
  return 'unknown';
}

// ---------------- Douyin ----------------

function walkForVideo(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (obj.play_addr && Array.isArray(obj.play_addr.url_list) && obj.play_addr.url_list.length) return obj;
  if (obj.playAddr && Array.isArray(obj.playAddr.url_list) && obj.playAddr.url_list.length) {
    return { ...obj, play_addr: obj.playAddr };
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const hit = walkForVideo(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function walkForItem(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (obj.video && (typeof obj.desc === 'string' || obj.aweme_id || obj.awemeId)) return obj;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const hit = walkForItem(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function parseDouyin(url) {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': MOBILE_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });

  const finalUrl = resp.url;
  const html = await resp.text();

  const idMatch =
    finalUrl.match(/\/(?:video|note|share\/video|share\/note)\/(\d+)/) ||
    finalUrl.match(/[?&]modal_id=(\d+)/) ||
    finalUrl.match(/\/(\d{15,})/);
  const itemId = idMatch ? idMatch[1] : '';

  let routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
  if (!routerMatch) routerMatch = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]+?\});\s*window/);
  if (!routerMatch) {
    return { error: '抖音页面结构异常，链接可能失效或被风控', debug: { finalUrl, htmlHead: html.slice(0, 200) } };
  }

  let routerData;
  try { routerData = JSON.parse(routerMatch[1]); } catch { return { error: '_ROUTER_DATA JSON 解析失败' }; }

  const item = walkForItem(routerData) || {};
  const videoObj = walkForVideo(routerData);
  if (!videoObj) return { error: '未找到视频播放地址，可能是图集或已删除' };

  const rawUrl = (videoObj.play_addr.url_list[0] || '').replace('playwm', 'play').replace(/^http:/, 'https:');
  if (!rawUrl) return { error: '视频地址为空' };

  const vidMatch =
    rawUrl.match(/[?&]video_id=([a-zA-Z0-9_]+)/) ||
    (videoObj.play_addr.uri && videoObj.play_addr.uri.match(/^[a-zA-Z0-9_]+$/)
      ? [null, videoObj.play_addr.uri] : null);
  const vid = vidMatch ? vidMatch[1] : '';
  if (!vid) return { error: '无法提取 video_id' };

  const cover =
    (videoObj.cover?.url_list?.[0]) ||
    (videoObj.origin_cover?.url_list?.[0]) || '';

  return {
    platform: 'douyin',
    video_url: `/.netlify/functions/video?p=douyin&vid=${encodeURIComponent(vid)}`,
    video_id: vid,
    cover: cover.replace(/^http:/, 'https:'),
    title: (item.desc || 'Douyin video').slice(0, 200),
    item_id: itemId || item.aweme_id || item.awemeId || '',
  };
}

// ---------------- TikTok ----------------

async function parseTikTok(url) {
  // Desktop UA is required; mobile UA returns a "download the app" wall.
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const finalUrl = resp.url;
  const html = await resp.text();

  // TikTok's CDN play URLs are session-gated: they 403 unless the request
  // sends the full cookie bundle captured from this initial HTML fetch.
  // Scrape each cookie name we've seen matter (tt_chain_token is critical,
  // ttwid + tt_csrf_token help).
  const setCookieLines = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : [resp.headers.get('set-cookie') || ''];
  const want = ['tt_chain_token', 'ttwid', 'tt_csrf_token'];
  const parts = [];
  for (const name of want) {
    for (const line of setCookieLines) {
      const m = line.match(new RegExp(`(?:^|[;\\s])${name}=([^;,\\s]+)`));
      if (m) { parts.push(`${name}=${m[1]}`); break; }
    }
  }
  const cookie = parts.join('; ');

  const idMatch = finalUrl.match(/\/video\/(\d+)/) || finalUrl.match(/\/photo\/(\d+)/);
  const itemId = idMatch ? idMatch[1] : '';

  // __UNIVERSAL_DATA_FOR_REHYDRATION__ carries all item info.
  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { error: 'TikTok 页面结构异常，链接可能失效或被风控', debug: { finalUrl, htmlHead: html.slice(0, 200) } };

  let data;
  try { data = JSON.parse(m[1]); } catch { return { error: 'TikTok JSON 解析失败' }; }

  const scope = data?.__DEFAULT_SCOPE__ || {};
  const detail = scope['webapp.video-detail'] || scope['webapp.photo-detail'];
  const itemStruct = detail?.itemInfo?.itemStruct;
  if (!itemStruct) return { error: '未找到视频信息' };

  const video = itemStruct.video || {};
  // Prefer no-watermark: playAddr; fallback downloadAddr.
  let playUrl = video.playAddr || video.downloadAddr || '';
  if (Array.isArray(playUrl)) playUrl = playUrl[0];
  playUrl = (playUrl || '').replace(/^http:/, 'https:');
  if (!playUrl) return { error: '未找到 TikTok 播放地址' };

  const cover = (video.cover || video.dynamicCover || video.originCover || '').replace(/^http:/, 'https:');

  const ckParam = cookie ? `&ck=${encodeURIComponent(cookie)}` : '';
  return {
    platform: 'tiktok',
    video_url: `/.netlify/functions/video?p=tiktok&src=${encodeURIComponent(playUrl)}${ckParam}`,
    video_id: itemStruct.id || '',
    cover,
    title: (itemStruct.desc || 'TikTok video').slice(0, 200),
    item_id: itemId || itemStruct.id || '',
  };
}

// ---------------- Dispatcher ----------------

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }

  const raw = (body.url || '').toString().trim();
  if (!raw) return json(400, { error: '链接为空' });

  const url = extractUrl(raw);
  if (!url) return json(400, { error: '未识别到有效链接' });

  // Follow the short-URL redirect ONCE to figure out the real platform,
  // then hand off to the platform-specific parser with the resolved URL.
  let platform = detectPlatform(url);
  let resolved = url;

  if (platform === 'unknown') {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      resolved = r.url;
      platform = detectPlatform(resolved);
    } catch (_) { /* ignore */ }
  }

  if (platform === 'unknown') {
    return json(400, { error: '不支持的链接（仅支持抖音 / TikTok）' });
  }

  try {
    const result = platform === 'tiktok' ? await parseTikTok(url) : await parseDouyin(url);
    if (result.error) return json(502, result);
    return json(200, result);
  } catch (err) {
    return json(500, { error: `抓取失败：${err.message}` });
  }
};
