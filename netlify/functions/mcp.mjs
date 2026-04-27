// Streamable HTTP MCP server exposing the digitaldialogue parser as a tool.
// Single POST endpoint at /mcp, stateless, JSON-RPC 2.0 over HTTP.
//
// Connect from Claude.ai: customize/connectors → Add custom connector →
//   https://digitaldialogue.com.au/mcp
// Connect from Claude Code / Cursor / Cline / any MCP-supporting client:
//   add to MCP config as type "http" with the same URL.
//
// No auth — the underlying API is already public (it's the same parser as
// /api/info). Zero-bandwidth too: tool calls return the CDN URL; the AI
// (or its user) fetches video bytes straight from the platform CDN.

import { parseShareLink, MOBILE_UA, DESKTOP_UA, cacheTtlForPlatform } from './_lib.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'digitaldialogue',
  title: 'Douyin / TikTok / X / Instagram Video Downloader',
  version: '1.0.0',
};
const CAPABILITIES = { tools: {} };

const TOOLS = [
  {
    name: 'download_video',
    title: 'Download video from Douyin / TikTok / X / Instagram',
    description: [
      'Resolves a share link from Douyin (抖音), TikTok, X (Twitter), or Instagram',
      "to its watermark-free MP4 URL on the platform's CDN. Returns metadata (title,",
      'platform, video ID, cover image) plus the direct CDN URL.',
      '',
      'Zero-bandwidth: this server only does a small (~1 KB) HTML/JSON parse — the',
      'caller fetches the actual video bytes directly from the platform CDN. CDN URLs',
      'are valid for ~5 min (Douyin / TikTok signed), ~30 min (Instagram), or 1 week',
      '(X / Twitter video.twimg.com).',
      '',
      'Supports share-link hosts: v.douyin.com, www.douyin.com, www.tiktok.com,',
      'vm.tiktok.com (short), x.com, twitter.com, t.co (tweet redirects),',
      'www.instagram.com /p/, /reel/, /reels/.',
      '',
      'Common failure modes: Instagram rate-limits shared-IP traffic at its graphql',
      'endpoint — error message will mention "Instagram 风控中" / "10-30 分钟" /',
      '"rate-limit" / "require_login". This is documented platform behavior; retry',
      'in 10-30 min. TikTok private videos and IG private / region-locked content',
      'are not retrievable. Carousel posts: returns the first video child.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        share_url: {
          type: 'string',
          description: 'A share link from one of the supported platforms. Can be a short URL (v.douyin.com/XXX, t.co/YYY, vm.tiktok.com/ZZZ) — the server follows redirects automatically.',
        },
      },
      required: ['share_url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['douyin', 'tiktok', 'twitter', 'instagram'] },
        title: { type: 'string' },
        cdn_url: { type: 'string', description: "Direct video URL on the platform's CDN. Fetch with no cookies and no Referer (the recommended_user_agent below works for the resolution step but the CDN itself accepts any UA)." },
        cover_image_url: { type: 'string' },
        video_id: { type: 'string' },
        item_id: { type: 'string' },
        recommended_user_agent: { type: 'string' },
        cdn_lifetime_seconds: { type: 'integer', description: "Conservative TTL — actual platform signed-URL expiry is slightly longer." },
        suggested_filename: { type: 'string' },
      },
      required: ['platform', 'title', 'cdn_url'],
    },
  },
];

async function callDownloadVideo({ share_url }) {
  if (!share_url || typeof share_url !== 'string') {
    return toolError('share_url is required and must be a string');
  }
  let parsed;
  try {
    parsed = await parseShareLink(share_url);
  } catch (err) {
    return toolError(err.message || 'Unknown parse error');
  }
  if (!parsed.resolvedCdnUrl) {
    return toolError('Parse succeeded but no CDN URL was resolved (rare — usually a transient platform glitch; retry once).');
  }

  const result = {
    platform: parsed.platform,
    title: parsed.title,
    cdn_url: parsed.resolvedCdnUrl,
    cover_image_url: parsed.cover || '',
    video_id: parsed.video_id || '',
    item_id: parsed.item_id || '',
    recommended_user_agent: parsed.platform === 'douyin' ? MOBILE_UA : DESKTOP_UA,
    cdn_lifetime_seconds: cacheTtlForPlatform(parsed.platform),
    suggested_filename: `${parsed.platform}_${parsed.item_id || parsed.video_id || 'video'}.mp4`,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `ERROR: ${message}` }],
  };
}

const TOOL_HANDLERS = {
  download_video: callDownloadVideo,
};

async function handleRpc(rpc) {
  // Notifications (no `id`) get no response.
  const isNotification = rpc.id === undefined || rpc.id === null;

  switch (rpc.method) {
    case 'initialize':
      return reply(rpc, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
      return null;

    case 'ping':
      return reply(rpc, {});

    case 'tools/list':
      return reply(rpc, { tools: TOOLS });

    case 'tools/call': {
      const params = rpc.params || {};
      const handler = TOOL_HANDLERS[params.name];
      if (!handler) {
        return errorReply(rpc, -32602, `Unknown tool: ${params.name}`);
      }
      try {
        const result = await handler(params.arguments || {});
        return reply(rpc, result);
      } catch (err) {
        return reply(rpc, toolError(`Tool execution failed: ${err.message || err}`));
      }
    }

    default:
      if (isNotification) return null;
      return errorReply(rpc, -32601, `Method not found: ${rpc.method}`);
  }
}

function reply(rpc, result) {
  return { jsonrpc: '2.0', id: rpc.id, result };
}

function errorReply(rpc, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: rpc.id ?? null, error };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // GET returns a tiny manifest — useful for humans poking the endpoint and
  // for clients that probe the URL before opening a session.
  if (req.method === 'GET') {
    return jsonResponse(200, {
      name: SERVER_INFO.name,
      title: SERVER_INFO.title,
      version: SERVER_INFO.version,
      protocol: 'mcp-streamable-http',
      protocol_version: PROTOCOL_VERSION,
      transport: 'POST application/json (JSON-RPC 2.0); single endpoint',
      tools: TOOLS.map((t) => t.name),
      docs: 'https://github.com/shineyear/douyin-tiktok-downloader#mcp',
    });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  // JSON-RPC 2.0 supports batch requests (array of messages).
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(handleRpc));
    const filtered = responses.filter((r) => r !== null);
    if (filtered.length === 0) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }
    return jsonResponse(200, filtered);
  }

  const response = await handleRpc(body);
  if (response === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return jsonResponse(200, response);
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}
