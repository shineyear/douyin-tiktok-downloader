// Shared core for parse.js, download.mjs, info.mjs.
//
// The invariant every platform here must satisfy: we resolve, server-side, a
// CDN URL that the BROWSER can then fetch directly — meaning it answers cold
// range requests with Access-Control-Allow-Origin:* and no anti-hotlink Referer
// check. Video bytes go Browser <-> platform CDN and never transit Netlify;
// egress per video is ~1 KB of JSON. A URL that only curl can fetch is not good
// enough, because a browser cannot set Referer (it is a forbidden header).
//
// How each platform gets there differs, and drifts as platforms change:
//   Douyin  -> web API (/aweme/v1/web/aweme/detail/) + self-minted ttwid/UIFID
//   TikTok  -> page scrape, then its aweme/v1/play 302 followed WITHOUT cookies
//   Twitter -> cdn.syndication.twimg.com, no auth and no redirect
//   Instagram -> logged-out reel page HTML, scraped for inlined video_versions

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

// Pick the best CDN URL out of a Douyin image's url_list. Each url_list has
// several webp variants on different mirror hosts plus one JPEG variant at the
// end. We prefer JPEG: iOS "Save to Photos" via Shortcuts accepts both but JPEG
// has the widest 3rd-party-app compatibility, and the file is only ~2x larger.
function pickImageUrl(urlList) {
  if (!Array.isArray(urlList) || !urlList.length) return null;
  const jpeg = urlList.find((u) => typeof u === 'string' && /\.jpe?g(\?|$)/i.test(u));
  const pick = jpeg || urlList[0];
  return typeof pick === 'string' ? pick.replace(/^http:/, 'https:') : null;
}

// Resolve any Douyin share link to its numeric aweme_id. Short links
// (v.douyin.com/XXXX) 302 to a long URL carrying the id; long URLs already
// have it. Uses a manual redirect so we never download the page body.
async function resolveDouyinItemId(url) {
  const fromUrl = (u) =>
    (u.match(/\/(?:video|note|share\/video|share\/note)\/(\d+)/) ||
     u.match(/[?&]modal_id=(\d+)/) ||
     u.match(/\/(\d{15,})/) || [])[1] || '';

  const direct = fromUrl(url);
  if (direct) return direct;

  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const loc = resp.headers.get('location');
    if (!loc) break;
    current = new URL(loc, current).toString();
    const id = fromUrl(current);
    if (id) return id;
  }
  throw new Error('无法从链接解析出抖音视频 ID');
}

// Douyin's web API is gated by ByteDance's "Argus" plugin, which as of
// Sep 2026 rejects requests with 403 `Uifid Not Found` unless a UIFID cookie
// is present alongside ttwid.
//
// A HEAD (not GET) to any video page hands out ttwid + UIFID_TEMP in one shot;
// a GET to the same URL returns only __ac_nonce, which is what made this look
// like TLS-fingerprint discrimination when it is really just the method.
//
// A real browser also holds a genuine UIFID, distinct from UIFID_TEMP, minted
// by ByteDance's obfuscated security SDK — no plain endpoint mints one, so we
// cannot. Sending the UIFID_TEMP value under BOTH names passes the plugin, but
// only on the fraction of backends that do not validate UIFID contents: about
// half of requests still 403. Measured ~50-55% success, and it is per-REQUEST
// random, not per-cookie-jar — replaying a jar that just worked fails at the
// same rate, so caching a "good" jar buys nothing and only retrying does.
// A real browser is deterministic (8/8), so this is a mitigation, not a cure:
// if Douyin tightens validation everywhere, this stops working and the SDK
// handshake becomes the only path.
const DOUYIN_DETAIL_ATTEMPTS = 6;

let cachedDouyinCookie = null;

async function mintDouyinCookie() {
  const resp = await fetch('https://www.douyin.com/video/7631138806736964870', {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': DESKTOP_UA },
  });
  const jar = {};
  const setCookie = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const c of setCookie) {
    const m = /^([^=]+)=([^;]*)/.exec(c.trim());
    if (m) jar[m[1]] = m[2];
  }
  if (!jar.ttwid || !jar.UIFID_TEMP) return null;
  return `ttwid=${jar.ttwid}; UIFID=${jar.UIFID_TEMP}; UIFID_TEMP=${jar.UIFID_TEMP}`;
}

async function fetchDouyinDetail(itemId, cookie) {
  const qs = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    aweme_id: itemId,
    version_code: '190500',
    version_name: '19.5.0',
  }).toString();

  const resp = await fetch(`https://www.douyin.com/aweme/v1/web/aweme/detail/?${qs}`, {
    headers: {
      'User-Agent': DESKTOP_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': `https://www.douyin.com/video/${itemId}`,
      'Cookie': cookie,
    },
  });
  return { status: resp.status, text: await resp.text() };
}

// Douyin serves the same video from several CDN families and the mix varies
// between requests for the same video. Most of them (*.zjcdn.com,
// www.douyin.com) answer cold range requests with Access-Control-Allow-Origin:
// *, but *.douyinvod.com enforces an anti-hotlink check and 403s unless the
// request carries `Referer: douyin.com`. A browser cannot forge Referer — it is
// a forbidden header — so a douyinvod URL is useless to us even though curl can
// fetch it. Handing one out produced intermittent 403s for users and in the
// health check. Order the permissive families first, then spend one 1-byte
// range request confirming the browser can really fetch what we return.
const DOUYIN_REFERER_GATED = /(^|\.)douyinvod\.com$/i;

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

async function pickDouyinPlayUrl(urlList) {
  const candidates = urlList.filter((u) => typeof u === 'string' && u.startsWith('https://'));
  if (!candidates.length) return null;
  const ordered = [
    ...candidates.filter((u) => !DOUYIN_REFERER_GATED.test(hostOf(u))),
    ...candidates.filter((u) => DOUYIN_REFERER_GATED.test(hostOf(u))),
  ];
  for (const candidate of ordered) {
    try {
      const probe = await fetch(candidate, {
        headers: {
          'Range': 'bytes=0-0',
          'User-Agent': DESKTOP_UA,
          'Origin': 'https://digitaldialogue.com.au',
        },
      });
      if ((probe.status === 200 || probe.status === 206) &&
          probe.headers.get('access-control-allow-origin') === '*') {
        return candidate;
      }
    } catch { /* mirror unreachable — try the next one */ }
  }
  // Every probe failed: transient CDN trouble, or a family we have not seen.
  // Returning the best-ordered candidate beats failing the whole parse.
  return ordered[0];
}

async function parseDouyin(url) {
  // Douyin stopped server-rendering video data into the share page in Aug 2026
  // — _ROUTER_DATA now arrives empty for every video — so the web API is the
  // only remaining source. It needs ttwid + UIFID cookies, but no request
  // signature: the a_bogus parameter every scraping guide adds is not checked.
  const itemId = await resolveDouyinItemId(url);

  // Argus accepts our cookie set on only ~half of requests, and rejection is
  // per-request rather than per-jar, so the retry replays the SAME cookies
  // instead of re-minting every round. One re-mint partway through covers the
  // separate case where the jar really has gone stale.
  let text = '';
  for (let attempt = 0; attempt < DOUYIN_DETAIL_ATTEMPTS; attempt++) {
    if (!cachedDouyinCookie || attempt === Math.floor(DOUYIN_DETAIL_ATTEMPTS / 2)) {
      cachedDouyinCookie = await mintDouyinCookie();
    }
    if (!cachedDouyinCookie) continue;
    const { status, text: body } = await fetchDouyinDetail(itemId, cachedDouyinCookie);
    // 403 is an Argus rejection; 200-with-empty-body is a stale ttwid. Both are
    // retryable, and both look identical to the caller, so just try again.
    if (status === 200 && body.trim()) { text = body; break; }
  }
  if (!text) {
    throw new Error('抖音接口未返回数据，可能被风控，请稍后再试');
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('抖音接口返回异常内容，可能被风控，请稍后再试');
  }

  const detail = payload?.aweme_detail;
  if (!detail) {
    // filter_detail carries Douyin's own human-readable reason (deleted,
    // private, author-only, region-locked). Prefer it over a generic guess.
    const reason = payload?.filter_detail?.detail_msg || payload?.filter_detail?.notice;
    throw new Error(reason ? `抖音：${reason}` : '抖音未返回视频信息（可能私密 / 删除 / 区域锁）');
  }

  const title = (detail.desc || '').slice(0, 200);

  // Image carousel (图文/图集) posts carry a populated `images` array. They also
  // carry a `video` object holding background music, so `images` must be
  // checked first or we would hand back the music track as the "video".
  const images = (detail.images || [])
    .map((img) => {
      const imgUrl = pickImageUrl(img?.url_list);
      return imgUrl ? { url: imgUrl, width: img.width || 0, height: img.height || 0 } : null;
    })
    .filter(Boolean);

  if (images.length) {
    return {
      platform: 'douyin',
      media_type: 'images',
      title: title || 'Douyin images',
      cover: images[0].url,
      item_id: itemId,
      video_id: '',
      vid: '',
      // No single CDN URL for image posts — caller reads `images` instead.
      resolvedCdnUrl: null,
      images,
    };
  }

  const video = detail.video || {};
  const playUrl = await pickDouyinPlayUrl(video.play_addr?.url_list || []);
  if (!playUrl) throw new Error('未找到视频播放地址，可能是图集或已删除');

  return {
    platform: 'douyin',
    media_type: 'video',
    title: title || 'Douyin video',
    cover: (video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || '')
      .replace(/^http:/, 'https:'),
    item_id: itemId,
    video_id: video.play_addr?.uri || '',
    vid: video.play_addr?.uri || '',
    resolvedCdnUrl: playUrl,
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

  const videoDetail = parsed?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
  const itemStruct = videoDetail?.itemInfo?.itemStruct;
  if (!itemStruct) {
    // TikTok reports the specific access reason via statusCode/statusMsg on
    // the video-detail scope. Surface the common ones so callers (and the
    // health check) can tell "genuinely inaccessible" from "parser broke".
    // 10204 = status_friend_see, 10216 = age-gated, 10222 = geo-blocked.
    // Anything else falls back to the generic message.
    const sc = videoDetail?.statusCode;
    if (sc === 10204) throw new Error('TikTok 视频仅好友可见 (friends-only)');
    if (sc === 10216) throw new Error('TikTok 视频年龄限制 (age-gated)');
    if (sc === 10222) throw new Error('TikTok 视频区域限制 (region-locked)');
    if (sc) throw new Error(`TikTok video not accessible (statusCode=${sc}, ${videoDetail?.statusMsg || 'no msg'})`);
    throw new Error('TikTok video data not in page (private/deleted/region-locked?)');
  }

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
    media_type: 'video',
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
    media_type: 'video',
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

  // Scrape the logged-out reel page HTML directly and pull the video URL
  // out of the inlined `video_versions` JSON. The previous doc_id-based
  // graphql path is retired: the old /graphql/query/ endpoint now returns
  // {"errors":[{"message":"execution error","severity":"CRITICAL"}],"data":null}
  // for every shortcode, and yt-dlp's newer /api/graphql path only works with
  // TLS-fingerprint impersonation (curl-cffi) — plain Node fetch gets served
  // the login-gate HTML page. IG still server-renders `video_versions` into
  // the logged-out reel page, so scraping that stays viable.
  const resp = await fetch(`https://www.instagram.com/reel/${shortcode}/`, {
    headers: {
      'User-Agent': DESKTOP_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  if (resp.status === 429) {
    throw new Error('Instagram 风控中，请 10-30 分钟后再试 (IG rate-limited our IP pool; this is a known IG restriction for any shared-IP service, not a bug)');
  }
  if (!resp.ok) throw new Error(`Instagram page HTTP ${resp.status}`);
  const html = await resp.text();

  const ogTitle = (html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/) || [])[1] || '';
  const ogImage = (html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/) || [])[1] || '';
  const ogDesc  = (html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/) || [])[1] || '';

  // `video_versions` is an inlined JSON array; grab the first `"url":"..."` inside it.
  let videoUrl = '';
  const vvStart = html.indexOf('"video_versions":[');
  if (vvStart !== -1) {
    const slice = html.slice(vvStart, vvStart + 8000);
    const m = slice.match(/"url":"([^"]+)"/);
    if (m) videoUrl = m[1].replace(/\\\//g, '/');
  }

  if (!videoUrl) {
    // No inlined video. Distinguish IP rate-limit / login-gate / not-a-video.
    if (!ogTitle && !ogImage) {
      throw new Error('Instagram 风控中，请 10-30 分钟后再试 (IG rate-limited our IP pool; this is a known IG restriction for any shared-IP service, not a bug)');
    }
    if (ogImage && !html.includes('"video_versions"')) {
      throw new Error('该帖子不含视频（仅图片）');
    }
    throw new Error('Instagram 未返回视频元数据（可能私密 / 删除 / 区域锁）');
  }

  const decodeEntities = (s) =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));

  const decodedImage = decodeEntities(ogImage);
  const decodedTitle = decodeEntities(ogTitle);
  const decodedDesc  = decodeEntities(ogDesc);

  // og:description shape: "N,NNN likes, M comments - username on DATE: ..."
  const ownerMatch = decodedDesc.match(/-\s+([A-Za-z0-9._]+)\s+on\s+/);
  const owner = ownerMatch ? ownerMatch[1] : '';

  // og:title shape: "Display Name on Instagram: "<caption>""
  const captionMatch = decodedTitle.match(/on Instagram:\s*[""]?(.+?)[""]?$/s);
  const caption = captionMatch ? captionMatch[1].trim() : decodedTitle;
  const title = (caption || (owner ? `@${owner} on Instagram` : 'Instagram video')).slice(0, 200);

  return {
    platform: 'instagram',
    media_type: 'video',
    title,
    // *.cdninstagram.com URLs serve `Access-Control-Allow-Origin: *` and accept
    // requests with no Referer / no cookie / any UA. Browser fetches direct.
    cover: decodedImage.replace(/^http:/, 'https:'),
    item_id: shortcode,
    video_id: shortcode,
    vid: shortcode,
    resolvedCdnUrl: videoUrl,
  };
}

// -------- Module-scope cache --------
// In-process Map that lives as long as a warm function instance (Netlify
// typically keeps instances hot for ~5-15 min). Absorbs repeat hits on the
// same share URL within the same instance. Different concurrent instances
// have their own cache; for cross-instance / cross-region sharing the
// Netlify edge HTTP cache (Cache-Control headers on /parse) does the work.
//
// TTL per platform is chosen to be SAFELY shorter than the CDN URL's own
// signed expiry, so a cache hit always returns a URL the client can still
// fetch. Getting this wrong = handing out expired URLs = silent 403s.

const CACHE_TTL_SEC = {
  twitter:   24 * 60 * 60,  // 24h — twimg URLs cache-control max-age=604800 (1 week)
  tiktok:         4 * 60,   // 4 min — CDN signed expire ~5 min
  douyin:         4 * 60,   // 4 min — CDN signed expire ~5 min
  instagram:     25 * 60,   // 25 min — IG URLs signed oe= ~30+ min
};

const parseCache = new Map();
const CACHE_MAX_SIZE = 500;

function cacheGet(key) {
  const entry = parseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { parseCache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value, ttlSec) {
  parseCache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  // Naive LRU-ish: if over cap, drop oldest insertion (Map iterates in insert order).
  if (parseCache.size > CACHE_MAX_SIZE) {
    const oldest = parseCache.keys().next().value;
    parseCache.delete(oldest);
  }
}

// Expose per-platform TTL to the HTTP handlers so they can set matching
// Cache-Control headers — keeping module-scope cache and edge cache in sync.
export function cacheTtlForPlatform(platform) {
  return CACHE_TTL_SEC[platform] || 0;
}

// -------- Entry points --------

export async function parseShareLink(rawText) {
  const url = extractUrl(rawText);
  if (!url) throw new Error('未识别到有效链接');

  const hit = cacheGet(url);
  if (hit) return hit;

  let platform = detectPlatform(url);
  if (platform === 'unknown') {
    // Short URL may need redirect resolution before we know the host.
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': MOBILE_UA } });
      platform = detectPlatform(r.url);
    } catch { /* ignore */ }
  }

  let result;
  if (platform === 'douyin') result = await parseDouyin(url);
  else if (platform === 'tiktok') result = await parseTikTok(url);
  else if (platform === 'twitter') result = await parseTwitter(url);
  else if (platform === 'instagram') result = await parseInstagram(url);
  else throw new Error('不支持的链接 / Unsupported link (Douyin / TikTok / Twitter / Instagram only)');

  const ttl = CACHE_TTL_SEC[result.platform];
  if (ttl > 0) cacheSet(url, result, ttl);
  return result;
}
