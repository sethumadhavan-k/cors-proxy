# CORS Solver Proxy

A tiny, production-ready CORS "solver" that forwards any request (headers, cookies, params, body, files) to a target URL and returns the upstream response. Works for any HTTP method and supports WebSocket upgrade.

## Features
- Forwards everything: method, path, query, headers, cookies, body (streamed), files
- Preflight (OPTIONS) handling with configurable CORS headers
- Per-request target via path-embedded `/https://...`
- Path prefix stripping and path forwarding control
- Adds standard `X-Forwarded-*` headers
- WebSocket proxying

## Quick start
1. Copy `env.example` to `.env` and edit as needed:

```
cp env.example .env
```

2. Install dependencies and start:

```
npm install
npm start
```

By default it listens on `http://localhost:8080` and proxies to `TARGET_URL` from `.env`.

## Configure
Environment variables (see `env.example`):

- `PORT`: Server port (default: 8080)
- `TARGET_URL`: Default upstream base. Example: `https://api.example.com`.
- `ALLOWED_ORIGINS`: Comma-separated origins or `*`.
- `CORS_ALLOW_CREDENTIALS`: `true|false`. If `true`, `Access-Control-Allow-Origin` will echo the request `Origin` when allowed.
- `CORS_MAX_AGE`: Preflight cache seconds (default: 600).
- `ALLOW_TARGET_HEADER`: Enable header override via `x-target-url` (default: false).
- `ALLOW_TARGET_QUERY`: Enable query override via `?url=` (default: false).
- `PATH_TARGET_MODE`: Allow embedding full target URL in the path `/https://...` (default: true).
- `FORWARD_PATH`: Append incoming path and query to the target (default: true).
- `STRIP_PREFIX`: Optional path prefix to remove from incoming path before joining.
- `SECURE_PROXY`: Verify upstream TLS (default: true). Set `false` to allow self-signed.
- `PROXY_TIMEOUT_MS`: Upstream timeout in ms (default: 30000).

## How target is chosen
Order of precedence per request:
1. Path-embedded `/<full-url>` (when `PATH_TARGET_MODE=true`)
2. `TARGET_URL` from environment

If `FORWARD_PATH=true`, the incoming path and query are appended to the target base. Use `STRIP_PREFIX` to remove a leading prefix from the incoming path before joining.

## Usage examples
- Fixed upstream (env):
  - `.env`: `TARGET_URL=https://api.example.com`
  - Client: `GET /v1/users?active=true` → `GET https://api.example.com/v1/users?active=true`
- Path-embedded target (best for simple client-side use like `cors.utilitytool.app/<url>`):
  - Raw (works in curl, but browsers often require encoding):
    - `curl "http://localhost:8080/https://httpbin.org/anything?x=1"`
  - Percent-encoded (safe for browsers):
    - `encodeURIComponent('https://httpbin.org/anything?x=1')` → `https%3A%2F%2Fhttpbin.org%2Fanything%3Fx%3D1`
    - `https://your-proxy/https%3A%2F%2Fhttpbin.org%2Fanything%3Fx%3D1`

Notes:
- When path-embedding, any query string on the proxy URL will be merged onto the target URL.
- Do not attach body parsers (like `express.json()`) to avoid buffering; bodies stream directly to the upstream.
- To proxy self-signed TLS upstreams, set `SECURE_PROXY=false`. For development-only you can also set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
