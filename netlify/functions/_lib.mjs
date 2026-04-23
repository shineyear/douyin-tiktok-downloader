// Shared core used by parse.js (HTTP handler), video.mjs (streaming proxy),
// and download.mjs (one-shot Shortcut endpoint). Keep platform-specific
// knowledge here so the three entry points stay thin.

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export const ALLOWED_CDN_HOSTS = [
  /\.douyinvod\.com$/,
  /\.zjcdn\.com$/,
  /^aweme\.snssdk\.com$/,
  /\.tiktokcdn\.com$/,
  /\.tiktokcdn-us\.com$/,
  /\.tiktokcdn-eu\.com$/,
  /\.tiktokv\.com$/,
  /\.ttcdnapi\.com$/,
  /\.muscdn\.com$/,
  /\.tiktok\.com$/,
];

export function isAllowedHost(host) {
  return ALLOWED_CDN_HOSTS.some((re) => re.test(host));
}

export function extractUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s，,）)】\]]+/);
  return m ? m[0] : null;
}

export function detectPlatform(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (host.endsWith('douyin.com') || host.endsWith('iesdouyin.com')) return 'douyin';
  return 'unknown';
}

// -------- Douyin parser --------

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
  if (!routerMatch) throw new Error('抖音页面结构异常，链接可能失效或被风控');

  const routerData = JSON.parse(routerMatch[1]);
  const item = walkForItem(routerData) || {};
  const videoObj = walkForVideo(routerData);
  if (!videoObj) throw new Error('未找到视频播放地址，可能是图集或已删除');

  const rawPlayUrl = (videoObj.play_addr.url_list[0] || '')
    .replace('playwm', 'play')
    .replace(/^http:/, 'https:');
  if (!rawPlayUrl) throw new Error('视频地址为空');

  const vidMatch =
    rawPlayUrl.match(/[?&]video_id=([a-zA-Z0-9_]+)/) ||
    (videoObj.play_addr.uri && videoObj.play_addr.uri.match(/^[a-zA-Z0-9_]+$/)
      ? [null, videoObj.play_addr.uri] : null);
  const vid = vidMatch ? vidMatch[1] : '';
  if (!vid) throw new Error('无法提取 video_id');

  const cover =
    (videoObj.cover?.url_list?.[0]) ||
    (videoObj.origin_cover?.url_list?.[0]) || '';

  return {
    platform: 'douyin',
    title: (item.desc || 'Douyin video').slice(0, 200),
    cover: cover.replace(/^http:/, 'https:'),
    item_id: itemId || item.aweme_id || item.awemeId || '',
    video_id: vid,
    vid,
    cdnUrl: null,
    cookie: null,
  };
}

// -------- TikTok parser --------

async function parseTikTok(url) {
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

  const idMatch = finalUrl.match(/\/video\/(\d+)/) || finalUrl.match(/\/photo\/(\d+)/);
  const itemId = idMatch ? idMatch[1] : '';

  // Capture session cookies — TikTok CDN rejects the playAddr URL without
  // the matching `tt_chain_token` cookie from this same session.
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

  const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('TikTok 页面结构异常，链接可能失效或被风控');

  const data = JSON.parse(m[1]);
  const scope = data?.__DEFAULT_SCOPE__ || {};
  const detail = scope['webapp.video-detail'] || scope['webapp.photo-detail'];
  const itemStruct = detail?.itemInfo?.itemStruct;
  if (!itemStruct) throw new Error('未找到 TikTok 视频信息');

  const video = itemStruct.video || {};
  let playUrl = video.playAddr || video.downloadAddr || '';
  if (Array.isArray(playUrl)) playUrl = playUrl[0];
  playUrl = (playUrl || '').replace(/^http:/, 'https:');
  if (!playUrl) throw new Error('未找到 TikTok 播放地址');

  const cover = (video.cover || video.dynamicCover || video.originCover || '').replace(/^http:/, 'https:');

  return {
    platform: 'tiktok',
    title: (itemStruct.desc || 'TikTok video').slice(0, 200),
    cover,
    item_id: itemId || itemStruct.id || '',
    video_id: itemStruct.id || '',
    vid: null,
    cdnUrl: playUrl,
    cookie,
  };
}

// -------- Entry points --------

export async function parseShareLink(rawText) {
  const url = extractUrl(rawText);
  if (!url) throw new Error('未识别到有效链接');

  let platform = detectPlatform(url);
  if (platform === 'unknown') {
    // Short URL may need redirect resolution before we know the host.
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      platform = detectPlatform(r.url);
    } catch { /* ignore */ }
  }
  if (platform === 'unknown') throw new Error('不支持的链接（仅支持抖音 / TikTok）');

  return platform === 'tiktok' ? parseTikTok(url) : parseDouyin(url);
}

export function buildVideoProxyUrl(parsed) {
  if (parsed.platform === 'douyin') {
    return `/.netlify/functions/video?p=douyin&vid=${encodeURIComponent(parsed.vid)}`;
  }
  const ck = parsed.cookie ? `&ck=${encodeURIComponent(parsed.cookie)}` : '';
  return `/.netlify/functions/video?p=tiktok&src=${encodeURIComponent(parsed.cdnUrl)}${ck}`;
}

// Build and execute the upstream CDN request. Used by video.mjs (via query
// params) and download.mjs (with a freshly-parsed object).
export async function fetchVideoStream({ platform, vid, cdnUrl, cookie }, { range } = {}) {
  let upstreamUrl;
  if (platform === 'tiktok') {
    if (!cdnUrl) throw new Error('missing cdnUrl for tiktok');
    const u = new URL(cdnUrl);
    if (!isAllowedHost(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
    upstreamUrl = u.toString();
  } else {
    if (!vid || !/^[a-zA-Z0-9_]+$/.test(vid)) throw new Error('missing or invalid vid');
    upstreamUrl = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(vid)}&ratio=720p&line=0`;
  }

  const headers = {
    'User-Agent': platform === 'tiktok' ? DESKTOP_UA : MOBILE_UA,
    'Referer': platform === 'tiktok' ? 'https://www.tiktok.com/' : 'https://www.douyin.com/',
    'Accept': '*/*',
  };
  if (range) headers.Range = range;
  if (cookie) headers.Cookie = cookie;

  return fetch(upstreamUrl, { headers, redirect: 'follow' });
}
