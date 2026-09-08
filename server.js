"use strict";
/**
 * NKYS Tube Pro — ローカル / Render / Railway 用サーバー
 * （Vercel では api/public/px.js + 静的 index.html が使われます）
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, "index.html");

/* プロキシを許可するホスト（Invidious 系のみ / SSRF 対策） */
const ALLOW = [
  /(^|\.)omada\.cafe$/i, /(^|\.)nadeko\.net$/i, /(^|\.)nerdvpn\.de$/i, /(^|\.)jing\.rocks$/i,
  /(^|\.)yewtu\.be$/i, /(^|\.)privacyredirect\.com$/i, /(^|\.)materialio\.us$/i,
  /(^|\.)melmac\.space$/i, /(^|\.)reallyaweso\.me$/i, /(^|\.)googlevideo\.com$/i,
  /(^|\.)ytimg\.com$/i, /(^|\.)siawase\.online$/i, /(^|\.)siatube\.uk$/i,
];
const allowed = (h) => ALLOW.some((r) => r.test(h));

function proxy(req, res, target, depth = 0) {
  if (depth > 5) { res.writeHead(508).end("too many redirects"); return; }
  let u;
  try { u = new URL(target); } catch (_) { res.writeHead(400).end("bad url"); return; }
  if (u.protocol !== "https:" || !allowed(u.hostname)) { res.writeHead(403).end("host not allowed"); return; }

  const headers = { "user-agent": "Mozilla/5.0", accept: req.headers.accept || "*/*" };
  if (req.headers.range) headers.range = req.headers.range;

  const upstream = https.request(u, { method: req.method === "HEAD" ? "HEAD" : "GET", headers }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      return proxy(req, res, new URL(r.headers.location, u).toString(), depth + 1);
    }
    const out = { "access-control-allow-origin": "*", "cache-control": "public, max-age=60" };
    ["content-type", "content-length", "content-range", "accept-ranges", "last-modified"].forEach((k) => {
      if (r.headers[k]) out[k] = r.headers[k];
    });
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  upstream.setTimeout(20000, () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("upstream error"); });
  upstream.end();
}

const handler = (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "OPTIONS") {
    return res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "range,content-type",
      "access-control-allow-methods": "GET,HEAD,OPTIONS",
    }).end();
  }
  if (url.pathname === "/health") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (url.pathname === "/px" || url.pathname === "/api/px" || url.pathname === "/api/public/px") {
    const t = url.searchParams.get("u");
    if (!t) return res.writeHead(400).end("missing u");
    return proxy(req, res, t);
  }
  if (url.pathname === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");

  /* それ以外は SPA として単一HTMLを返す */
  fs.readFile(INDEX, (e, buf) => {
    if (e) return res.writeHead(500).end("index.html not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(buf);
  });
};

module.exports = handler;

if (require.main === module) {
  http.createServer(handler).listen(PORT, () =>
    console.log("NKYS Tube Pro on http://localhost:" + PORT)
  );
}
