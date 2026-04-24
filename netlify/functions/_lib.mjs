// Shared core for parse.js, download.mjs, info.mjs.
// Both Douyin and TikTok use the same trick: their share-link host has a
// 302 endpoint (Douyin: aweme.snssdk.com/play, TikTok: www.tiktok.com/aweme/v1/play)
// that — when called WITHOUT cookies — redirects to a cookieless CDN URL with
// Access-Control-Allow-Origin:* and no anti-hotlink Referer check. We resolve
// that 302 server-side and hand the final URL to the client, which fetches the
// MP4 bytes directly from the CDN. Netlify egress per video: ~1 KB JSON.

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

// TikTok's anti-bot 403s mobile UAs on the page-fetch step. Desktop Chrome
// passes consistently across every account/year we tested.
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function extractUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s，,）)】\]]+/);
  return m ? m[0] : null;
}

export function detectPlatform(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (host.endsWith('douyin.com') || host.endsWith('iesdouyin.com')) return 'douyin';
  if (host.endsWith('tiktok.com')) return 'tiktok';
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

  // aweme.snssdk.com/play has NO CORS headers on its 302, so a browser can't
  // follow it from JS. The redirect target advertises ACAO:* and accepts
  // requests with no Referer. We do the follow once server-side.
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
  } catch (_) { /* parse still succeeds; client just won't have direct URL */ }

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

// -------- TikTok parser --------

async function parseTikTok(url) {
  // Step 1: fetch the page with desktop Chrome UA. Mobile UAs get 403'd.
  // No cookies sent (Node fetch has no cookie jar), which is what we want
  // — we'll also call the play endpoint cookieless below to get the
  // permissive-CDN redirect target instead of the chain-token one.
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip',
    },
  });
  if (!resp.ok) throw new Error(`TikTok page fetch failed: HTTP ${resp.status}`);
  const finalUrl = resp.url;
  const html = await resp.text();

  // Step 2: extract __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON.
  const dataMatch = html.match(
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]+?)<\/script>/,
  );
  if (!dataMatch) throw new Error('TikTok page structure changed — no UNIVERSAL_DATA tag');

  let parsed;
  try { parsed = JSON.parse(dataMatch[1]); }
  catch (e) { throw new Error(`TikTok JSON parse failed: ${e.message}`); }

  const itemStruct =
    parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  if (!itemStruct) throw new Error('TikTok video data not in page (private/deleted/region-locked?)');

  const video = itemStruct.video || {};
  const itemId =
    itemStruct.id ||
    finalUrl.match(/\/video\/(\d+)/)?.[1] ||
    '';

  // Step 3: find the aweme/v1/play URL. It's always present in bitrateInfo
  // alongside the cookie-gated v16/v19 hosts. Same shape across every video
  // we tested (2021–2026, US/intl creators, ad/non-ad, verified/non-verified).
  let playApiUrl = null;
  for (const br of video.bitrateInfo || []) {
    for (const u of br?.PlayAddr?.UrlList || []) {
      if (typeof u === 'string' && u.includes('/aweme/v1/play')) {
        playApiUrl = u; break;
      }
    }
    if (playApiUrl) break;
  }
  if (!playApiUrl) throw new Error('TikTok play API URL not found in bitrateInfo');

  // Step 4: follow the play API redirect WITHOUT cookies. TikTok serves a
  // different 302 Location based on whether tt_chain_token cookie is present:
  //   with cookie    → v16-webapp-prime.us.tiktok.com (cookie-gated, 403 cold)
  //   without cookie → v16m-default.tiktokcdn-us.com (signed URL, ACAO:*, cold-fetchable)
  // Node fetch defaults to no cookies, so we just don't include any.
  let resolvedCdnUrl = null;
  try {
    const head = await fetch(playApiUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': DESKTOP_UA },
    });
    if (head.status >= 300 && head.status < 400) {
      const loc = head.headers.get('location');
      if (loc) resolvedCdnUrl = loc.replace(/^http:/, 'https:');
    }
  } catch (_) { /* parse still succeeds; client just won't have direct URL */ }

  // Sanity: if we got a chain-token URL by mistake, the cookieless trick
  // misfired (e.g. TikTok changed behavior). Refuse rather than hand the
  // client a URL it can't fetch.
  if (resolvedCdnUrl && resolvedCdnUrl.includes('tt_chain_token')) {
    resolvedCdnUrl = null;
  }

  return {
    platform: 'tiktok',
    title: (itemStruct.desc || 'TikTok video').slice(0, 200),
    cover: (video.cover || video.originCover || '').replace(/^http:/, 'https:'),
    item_id: itemId,
    video_id: video.id || video.videoID || itemId,
    vid: video.id || video.videoID || '',
    resolvedCdnUrl,
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

  if (platform === 'douyin') return parseDouyin(url);
  if (platform === 'tiktok') return parseTikTok(url);
  throw new Error('不支持的链接 / Unsupported link (Douyin / TikTok only)');
}
