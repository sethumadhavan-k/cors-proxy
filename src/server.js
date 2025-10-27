/* eslint-disable no-console */
const http = require('http');
const url = require('url');
const express = require('express');
const httpProxy = require('http-proxy');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

// Configuration
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const DEFAULT_TARGET_URL = process.env.TARGET_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const ALLOW_CREDENTIALS = (process.env.CORS_ALLOW_CREDENTIALS || 'false').toLowerCase() === 'true';
const MAX_AGE = process.env.CORS_MAX_AGE ? Number(process.env.CORS_MAX_AGE) : 600;
const ALLOW_TARGET_HEADER = (process.env.ALLOW_TARGET_HEADER || 'true').toLowerCase() === 'true';
const ALLOW_TARGET_QUERY = (process.env.ALLOW_TARGET_QUERY || 'true').toLowerCase() === 'true';
const PATH_TARGET_MODE = (process.env.PATH_TARGET_MODE || 'true').toLowerCase() === 'true';
const STRIP_PREFIX = (process.env.STRIP_PREFIX || '').replace(/\/$/, '');
const FORWARD_PATH = (process.env.FORWARD_PATH || 'true').toLowerCase() === 'true';
const SECURE_PROXY = (process.env.SECURE_PROXY || 'true').toLowerCase() === 'true';
const PROXY_TIMEOUT_MS = process.env.PROXY_TIMEOUT_MS ? Number(process.env.PROXY_TIMEOUT_MS) : 30_000;

// Logging
app.use(morgan('tiny'));

// Serve static index page
app.use(express.static('public', {extensions: ['html']}));

// Expose minimal env config to the client
app.get('/env.js', (req, res) => {
  res.type('application/javascript');
  const linkedin = process.env.LINKEDIN_URL || 'https://www.linkedin.com/';
  const github = process.env.GITHUB_URL || 'https://github.com/';
  const payload = { linkedin, github };
  res.send(`window.__CONFIG=Object.assign(window.__CONFIG||{},${JSON.stringify(payload)});`);
});

// Helper: compute allowed origin
function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) {
    return ALLOW_CREDENTIALS ? '' : '*';
  }
  const wildcard = ALLOWED_ORIGINS.includes('*');
  if (wildcard) {
    return ALLOW_CREDENTIALS ? requestOrigin : '*';
  }
  const matched = ALLOWED_ORIGINS.includes(requestOrigin);
  return matched ? requestOrigin : (ALLOW_CREDENTIALS ? '' : '');
}

// Set CORS headers for all responses
app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowedOrigin = getAllowedOrigin(requestOrigin);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  if (ALLOW_CREDENTIALS) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  // Reflect requested headers for preflight and allow varied caching
  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  next();
});

// Handle preflight
app.options('*', (req, res) => {
  const acrm = req.headers['access-control-request-method'];
  const acrh = req.headers['access-control-request-headers'];
  if (acrm) {
    res.setHeader('Access-Control-Allow-Methods', acrm);
  } else {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
  }
  if (acrh) {
    res.setHeader('Access-Control-Allow-Headers', acrh);
  } else {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, *');
  }
  if (Number.isFinite(MAX_AGE) && MAX_AGE > 0) {
    res.setHeader('Access-Control-Max-Age', String(MAX_AGE));
  }
  res.status(204).end();
});

// Attempt to extract a full target URL embedded in the request path
function tryExtractPathEmbeddedTarget(req) {
  if (!PATH_TARGET_MODE) return '';
  const parsed = url.parse(req.url, true);
  let incomingPath = parsed.pathname || '/';
  if (STRIP_PREFIX && incomingPath.startsWith(STRIP_PREFIX)) {
    incomingPath = incomingPath.slice(STRIP_PREFIX.length) || '/';
  }
  // Remove the leading slash and decode once
  let candidate = incomingPath.startsWith('/') ? incomingPath.slice(1) : incomingPath;
  if (!candidate) return '';
  try {
    candidate = decodeURIComponent(candidate);
  } catch (_) {
    // ignore decode errors and use raw
  }
  // Accept only http(s) scheme
  if (!/^https?:\/\//i.test(candidate)) {
    return '';
  }
  // Validate as URL
  let base;
  try {
    base = new URL(candidate);
  } catch (_) {
    return '';
  }
  // If the proxy request itself has a query string (e.g., raw form without percent-encoding), append it.
  const incomingQuery = new url.URLSearchParams(parsed.query || '');
  if (incomingQuery.toString()) {
    const full = new URL(base);
    const hasExisting = !!full.search && full.search.length > 1;
    const sep = hasExisting ? '&' : '?';
    full.search = (hasExisting ? full.search.substring(1) + '&' : '') + incomingQuery.toString();
    return full.toString();
  }
  return base.toString();
}

// Build full target URL for a request
function resolveTargetUrl(req) {
  // 1) Path-embedded target takes top priority when enabled
  const embedded = tryExtractPathEmbeddedTarget(req);
  if (embedded) {
    return embedded;
  }

  // 2) Header, then 3) query param, then 4) default
  let targetBase = '';
  if (ALLOW_TARGET_HEADER && typeof req.headers['x-target-url'] === 'string') {
    targetBase = String(req.headers['x-target-url']);
  }
  if (!targetBase && ALLOW_TARGET_QUERY) {
    const parsed = url.parse(req.url, true);
    if (parsed.query && typeof parsed.query.url === 'string') {
      targetBase = parsed.query.url;
    }
  }
  if (!targetBase) {
    targetBase = DEFAULT_TARGET_URL;
  }
  if (!targetBase) {
    return '';
  }

  // Normalize and combine with incoming path and query
  let incomingUrl = url.parse(req.url);
  let incomingPath = incomingUrl.pathname || '/';
  if (STRIP_PREFIX && incomingPath.startsWith(STRIP_PREFIX)) {
    incomingPath = incomingPath.slice(STRIP_PREFIX.length) || '/';
  }

  // Remove control query param `url` if present
  const incomingQuery = new url.URLSearchParams(incomingUrl.query || '');
  if (incomingQuery.has('url')) incomingQuery.delete('url');
  const queryString = incomingQuery.toString();

  // Ensure target base is a valid URL
  let base;
  try {
    base = new URL(targetBase);
  } catch (e) {
    return '';
  }

  // If not forwarding path, just use base
  if (!FORWARD_PATH) {
    return base.toString();
  }

  // Join paths carefully
  const basePath = base.pathname || '/';
  const joinedPath = [basePath.endsWith('/') ? basePath.slice(0, -1) : basePath, incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`]
    .join('');

  const full = new URL(base);
  full.pathname = joinedPath;
  if (queryString) {
    full.search = queryString;
  }
  return full.toString();
}

// Create proxy instance
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: SECURE_PROXY,
  ignorePath: true,
  ws: true,
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS
});

proxy.on('error', (err, req, res) => {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/json');
  }
  const status = 502;
  const message = 'Bad Gateway: upstream error';
  try {
    res.writeHead(status);
  } catch (_) {}
  try {
    res.end(JSON.stringify({ error: message, details: err.message }));
  } catch (_) {}
});

// Forward everything
app.all('*', (req, res) => {
  const targetUrl = resolveTargetUrl(req);
  if (!targetUrl) {
    res.status(400).json({ error: 'Target URL is not configured or invalid. Provide TARGET_URL, x-target-url header, url query, or embed the full URL in the path.' });
    return;
  }

  // Add standard proxy headers
  const host = req.headers.host || '';
  req.headers['x-forwarded-host'] = host;
  req.headers['x-forwarded-proto'] = req.protocol || (req.connection && req.connection.encrypted ? 'https' : 'http');
  req.headers['x-forwarded-for'] = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '');

  proxy.web(req, res, { target: targetUrl });
});

const server = http.createServer(app);

// WebSocket upgrade handling
server.on('upgrade', (req, socket, head) => {
  const targetUrl = resolveTargetUrl(req);
  if (!targetUrl) {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: targetUrl });
});

server.listen(PORT, () => {
  console.log(`CORS Solver Proxy listening on http://0.0.0.0:${PORT}`);
  if (DEFAULT_TARGET_URL) {
    console.log(`Default target: ${DEFAULT_TARGET_URL}`);
  }
});
