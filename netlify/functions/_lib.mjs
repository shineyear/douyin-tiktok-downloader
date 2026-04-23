// Shared core used by parse.js (HTTP handler), video.mjs (streaming proxy),
// download.mjs (one-shot Shortcut endpoint), and info.mjs (metadata).
// Douyin-only: TikTok's CDN requires session cookies the browser can't
// replay, which forces all bytes through our proxy and defeats the
// zero-bandwidth design. We dropped TikTok.

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

export function extractUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s，,）)】\]]+/);
  return m ? m[0] : null;
}

export function detectPlatform(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (host.endsWith('douyin.com') || host.endsWith('iesdouyin.com')) return 'douyin';
  if (host.endsWith('tiktok.com')) return 'tiktok-unsupported';
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

  // Follow the aweme.snssdk.com/play 302 here so the browser doesn't have
  // to. aweme.snssdk.com has NO CORS headers on its 302, so a browser
  // fetch of it fails with "Failed to fetch". The redirect target
  // (v5-dy-o-abtest.zjcdn.com etc.) advertises Access-Control-Allow-Origin:*
  // so the browser can fetch it directly — but only if the request carries
  // no Referer (the CDN rejects cross-origin Referer as anti-hotlinking).
  let resolvedCdnUrl = null;
  try {
    const head = await fetch(
      `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(vid)}&ratio=720p&line=0`,
      { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': MOBILE_UA } },
    );
    if (head.status >= 300 && head.status < 400) {
      const loc = head.headers.get('location');
      if (loc) resolvedCdnUrl = loc.replace(/^http:/, 'https:');
    }
  } catch (_) { /* best effort; proxy path still works as fallback */ }

  return {
    platform: 'douyin',
    title: (item.desc || 'Douyin video').slice(0, 200),
    cover: cover.replace(/^http:/, 'https:'),
    item_id: itemId || item.aweme_id || item.awemeId || '',
    video_id: vid,
    vid,
    resolvedCdnUrl,
  };
}

// -------- Entry points --------

export async function parseShareLink(rawText) {
  const url = extractUrl(rawText);
  if (!url) throw new Error('未识别到有效链接');

  let platform = detectPlatform(url);
  if (platform === 'unknown' || platform === 'tiktok-unsupported') {
    // Short URL may need redirect resolution before we know the host.
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      platform = detectPlatform(r.url);
    } catch { /* ignore */ }
  }

  if (platform === 'tiktok-unsupported') {
    throw new Error('仅支持抖音链接 / Only Douyin links are supported');
  }
  if (platform !== 'douyin') {
    throw new Error('不支持的链接 / Unsupported link');
  }

  return parseDouyin(url);
}

