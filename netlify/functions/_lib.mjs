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
  if (host === 'twitter.com' || host.endsWith('.twitter.com') ||
      host === 'x.com' || host.endsWith('.x.com') || host === 't.co') return 'twitter';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
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

// -------- Twitter / X parser --------

async function parseTwitter(url) {
  // Resolve t.co → final tweet URL (HEAD with follow). Twitter / X canonical
  // URL is .../status/<tweet_id>, optionally /photo/N or /video/N suffix.
  let finalUrl = url;
  if (/^https?:\/\/t\.co\//i.test(url)) {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      finalUrl = r.url;
    } catch { /* fall through, the original URL may still parse */ }
  }
  const idMatch = finalUrl.match(/\/status(?:es)?\/(\d+)/);
  if (!idMatch) throw new Error('无法从链接提取 tweet ID');
  const tweetId = idMatch[1];

  // syndication API is the public oEmbed/embed backend used by publish.twitter.com
  // and every "tweet preview" service. No auth, no token strictly required —
  // but a recent change requires a numeric `token` query param (any value works
  // as long as it's there). We use the timestamp.
  const token = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const synd = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`,
    { headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'application/json' } },
  );
  if (!synd.ok) throw new Error(`Twitter syndication HTTP ${synd.status} (tweet may be private/deleted)`);
  const data = await synd.json();

  const v = data.video;
  if (!v || !Array.isArray(v.variants) || !v.variants.length) {
    throw new Error('该 tweet 不含视频（可能是图片或纯文本）');
  }
  // variants[] holds 1 HLS .m3u8 + several MP4 resolutions. Pick the highest
  // MP4 by extracting the WxH from the URL path (bitrate field is null in
  // current API responses, so URL parsing is the reliable signal).
  const mp4s = v.variants.filter((x) => x.type === 'video/mp4' && typeof x.src === 'string');
  if (!mp4s.length) throw new Error('Tweet 视频没有 MP4 变体（可能是 live broadcast）');
  const scored = mp4s.map((x) => {
    const m = x.src.match(/\/(\d+)x(\d+)\//);
    return { src: x.src, area: m ? Number(m[1]) * Number(m[2]) : 0 };
  }).sort((a, b) => b.area - a.area);
  const bestUrl = scored[0].src;

  // syndication API returns video.videoId as an object {type, id}, not a
  // string — extract the id field for our string-typed response shape.
  const innerVideoId = (v.videoId && typeof v.videoId === 'object')
    ? v.videoId.id
    : v.videoId;

  return {
    platform: 'twitter',
    title: (data.text || data.user?.name || 'Twitter video').slice(0, 200),
    cover: v.poster || '',
    item_id: tweetId,
    video_id: innerVideoId || tweetId,
    vid: innerVideoId || tweetId,
    // No 302 dance needed — video.twimg.com URLs are stable signed-by-path
    // assets with `cache-control: max-age=604800` and `access-control-allow-origin`
    // echoes the request Origin. Browser can fetch directly.
    resolvedCdnUrl: bestUrl,
  };
}

// -------- Instagram parser --------

async function parseInstagram(url) {
  // Accept formats: instagram.com/p/<code>/, /reel/<code>/, /reels/<code>/,
  // and the username-prefixed variants like /username/p/<code>/.
  const codeMatch = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!codeMatch) throw new Error('未识别到 Instagram shortcode（仅支持 /p/、/reel/、/reels/ 链接）');
  const shortcode = codeMatch[1];

  // Step 1: warm csrftoken cookie. Instagram's graphql endpoint requires
  // a csrftoken cookie + matching X-CSRFToken header even for unauth calls.
  // A cold GET to instagram.com sets the cookie for free.
  const warm = await fetch('https://www.instagram.com/', {
    headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const setCookie = warm.headers.get('set-cookie') || '';
  const csrf = (setCookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
  if (!csrf) throw new Error('Instagram csrftoken cookie 拿不到（可能 IP 被风控）');

  // Step 2: graphql call. doc_id is a stable identifier maintained by yt-dlp;
  // Instagram rotates these every few months — if this 4xx-es with a doc_id
  // error, find the current value at:
  //   github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/instagram.py
  // (search for `doc_id`)
  const variables = JSON.stringify({
    shortcode,
    child_comment_count: 3,
    fetch_comment_count: 40,
    parent_comment_count: 24,
    has_threaded_comments: true,
  });
  const body = new URLSearchParams({
    doc_id: '8845758582119845',
    variables,
  });
  const resp = await fetch('https://www.instagram.com/graphql/query/', {
    method: 'POST',
    headers: {
      'User-Agent': DESKTOP_UA,
      'X-IG-App-ID': '936619743392459',
      'X-ASBD-ID': '198387',
      'X-IG-WWW-Claim': '0',
      'X-CSRFToken': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://www.instagram.com',
      'Referer': `https://www.instagram.com/p/${shortcode}/`,
      'Cookie': `csrftoken=${csrf}`,
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (resp.status === 429) {
    throw new Error('Instagram 限流中，请稍后再试 (rate limited)');
  }
  if (!resp.ok) throw new Error(`Instagram graphql HTTP ${resp.status}`);
  const data = await resp.json();
  const media = data?.data?.xdt_shortcode_media;
  if (!media) throw new Error('Instagram 未返回视频元数据（可能私密 / 删除 / 区域锁）');

  // Single-video post or reel: video_url is at top level.
  // Carousel post: edge_sidecar_to_children.edges[i].node.video_url. For now
  // pick the first video in the carousel; warn user to specify if they want
  // a different one (rare case).
  let videoUrl = media.video_url;
  let cover = media.thumbnail_src || media.display_url || '';
  let usedCarouselIndex = null;
  if (!videoUrl) {
    const sidecar = media.edge_sidecar_to_children?.edges || [];
    const videoChild = sidecar.find((e) => e.node?.is_video && e.node?.video_url);
    if (videoChild) {
      videoUrl = videoChild.node.video_url;
      cover = videoChild.node.thumbnail_src || videoChild.node.display_url || cover;
      usedCarouselIndex = sidecar.indexOf(videoChild);
    }
  }
  if (!videoUrl) {
    throw new Error('该帖子不含视频（仅图片）');
  }

  const captionEdges = media.edge_media_to_caption?.edges || [];
  const caption = captionEdges[0]?.node?.text || '';
  const owner = media.owner?.username || '';
  const title = (caption || (owner ? `@${owner} on Instagram` : 'Instagram video')).slice(0, 200);

  return {
    platform: 'instagram',
    title: usedCarouselIndex !== null ? `[carousel #${usedCarouselIndex + 1}] ${title}` : title,
    cover: cover.replace(/^http:/, 'https:'),
    item_id: media.id || shortcode,
    video_id: shortcode,
    vid: shortcode,
    // *.cdninstagram.com URLs serve `Access-Control-Allow-Origin: *` and accept
    // requests with no Referer / no cookie / any UA. Browser fetches direct.
    resolvedCdnUrl: videoUrl,
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
  if (platform === 'twitter') return parseTwitter(url);
  if (platform === 'instagram') return parseInstagram(url);
  throw new Error('不支持的链接 / Unsupported link (Douyin / TikTok / Twitter / Instagram only)');
}
