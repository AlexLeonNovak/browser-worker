# browser-worker

Stateful browser worker for automation tools like n8n.
---
**Worker runs in Node.js** — exposes a REST API for browser automation.

**Browser runs in Browserless** — worker is a thin HTTP↔CDP client.

## Architecture

```
Client ──REST──► browser-worker ──WS/CDP──► browserless ──► Chromium
 (n8n)           (Express API)               (separate container)
```

## Quick Start

```bash
# 1. Copy .env.example → .env and set your BROWSERLESS_URL
cp .env.example .env

# 2. Start
docker compose up -d --build

# 3. Verify
curl http://localhost:3001/health
```

## REST API

### POST /execute

Execute one or more browser actions in a single request. Creates a new session if `sessionId` is not provided.

**Request Body Parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sessionId` | `optional` | UUID of an existing session. |
| `ttl` | `30000` | Time-to-live in ms. Also used as Browserless session timeout. |
| `stealth` | `true` | Enable stealth mode to avoid detection. |
| `blockAds` | `false` | Enable Browserless built-in ad blocker. |
| `disableSecurity` | `false` | Disable web security, ignore SSL errors, and bypass CSP. |
| `forceHttp` | `false` | Force HTTP by intercepting HTTPS requests and downgrading them. |
| `steps` | `[]` | Array of actions to execute. |
| `stopOnError` | `true` | Stop execution if a step fails. |

**Example Request:**
```json
{
  "steps": [
    { "action": "goto", "params": { "url": "http://example.com" } },
    { "action": "getContent" }
  ],
  "disableSecurity": true,
  "forceHttp": true,
  "ttl": 60000
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "uuid-here",
  "created": true,
  "results": [
    { "action": "goto", "ok": true, "result": { "url": "http://example.com" } },
    { "action": "getContent", "ok": true, "result": { "html": "<html>...</html>" } }
  ],
  "finalUrl": "http://example.com"
}
```

**Available Actions:**

| Action | Params | Result |
|--------|--------|--------|
| `goto` | `{ url, waitUntil?, timeout? }` | `{ url }` |
| `reload` | `{ waitUntil? }` | `{ url }` |
| `getUrl` | — | `{ url }` |
| `getContent` | — | `{ html }` |
| `click` | `{ selector, timeout? }` | `{ clicked }` |
| `fill` | `{ selector, value }` | `{ filled }` |
| `type` | `{ selector, text, delay? }` | `{ typed }` |
| `select` | `{ selector, value }` | `{ selected }` |
| `check` | `{ selector, state? }` | `{ checked }` |
| `keyboard` | `{ key }` | `{ pressed }` |
| `hover` | `{ selector }` | `{ hovered }` |
| `wait` | `{ ms }` | `{ waited }` |
| `waitForSelector` | `{ selector, state?, timeout? }` | `{ found }` |
| `waitForNavigation` | `{ waitUntil? }` | `{ url }` |
| `evaluate` | `{ script }` | `{ value }` |
| `getText` | `{ selector }` | `{ text }` |
| `getAttribute` | `{ selector, attr }` | `{ value }` |
| `screenshot` | `{ selector?, fullPage? }` | `{ screenshot: base64 }` |
| `getCookies` | — | `{ cookies }` |
| `setCookies` | `{ cookies }` | `{ set }` |
| `getLocalStorage` | `{ key }` | `{ value }` |

### GET /sessions
List all active sessions with their current URLs and TTLs.

### GET /sessions/:id
Get detailed state of a specific session (URL, TTL, status).

### DELETE /sessions/:id
Close a specific session and release its browser resources.

### GET /health
Basic health check showing the number of active sessions.

## Features

- **Stateful Sessions**: Maintain browser state (cookies, local storage, auth) between multiple requests using `sessionId`.
- **Security Bypass**: Use `disableSecurity: true` to bypass SSL errors, Content Security Policy (CSP), and standard web security (SOP).
- **HTTP Enforcement**: Use `forceHttp: true` to stay on HTTP even if the server tries to redirect to HTTPS.
- **Stealth mode**: Integrated evasion techniques to bypass bot detection.
- **Dynamic Session Management**: Control session lifetime via `ttl` per request.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSERLESS_URL` | — | WebSocket URL (e.g., `ws://browserless:3000`) |
| `BROWSERLESS_TOKEN` | — | Optional Browserless API token |
| `PORT` | `3001` | Server port |
