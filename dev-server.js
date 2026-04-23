// Minimal local dev server: serves index.html, /.netlify/functions/parse
// (classic exports.handler), and /.netlify/functions/video (v2 export default
// with streaming Response). Lets us iterate without installing netlify-cli.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const parseFn = require('./netlify/functions/parse.js');

const PORT = process.env.PORT || 8888;
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;
const ROOT = __dirname;

let videoFn; // loaded lazily via dynamic import (ESM)

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function handleClassic(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const event = { httpMethod: req.method, headers: req.headers, body };
  try {
    const result = await parseFn.handler(event);
    send(res, result.statusCode, result.body, result.headers || {});
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err.message }), { 'Content-Type': 'application/json' });
  }
}

async function handleV2(req, res, handler) {
  // Adapt Node req -> Web Request
  const proto = 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  const webReq = new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers: req.headers,
  });

  let webResp;
  try {
    webResp = await handler(webReq);
  } catch (err) {
    send(res, 500, `handler error: ${err.message}`);
    return;
  }

  // Adapt Web Response -> Node res, streaming the body
  const headers = {};
  webResp.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(webResp.status, headers);

  if (!webResp.body) return res.end();
  const reader = webResp.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (err) {
    res.destroy(err);
  }
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
                   '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': type });
  });
}

async function handler(req, res) {
  if (req.url.startsWith('/.netlify/functions/parse')) return handleClassic(req, res);
  if (req.url.startsWith('/.netlify/functions/video')) {
    if (!videoFn) videoFn = (await import('./netlify/functions/video.mjs')).default;
    return handleV2(req, res, videoFn);
  }
  serveStatic(req, res);
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  console.log(`[douyin] HTTP  http://localhost:${PORT}`);
});

const certDir = path.join(__dirname, '.certs');
if (fs.existsSync(path.join(certDir, 'cert.pem'))) {
  const tls = {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
  };
  https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`[douyin] HTTPS https://localhost:${HTTPS_PORT} (self-signed)`);
  });
}
