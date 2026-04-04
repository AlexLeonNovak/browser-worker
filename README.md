# browser-worker

Stateful browser worker for automation tools like n8n.

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
| `ttl` | `30000` | Time-to-live in ms. Sets the worker-side expiration timer. |
| `stealth` | `true` | Enable stealth mode to avoid detection. |
| `blockAds` | `false` | Block ads and trackers. Accepts `true` (default 50+ patterns), an array (extends defaults), or an object `{ useDefaults?: boolean, custom?: string[] }`. |
| `disableSecurity` | `false` | Disable web security, ignore SSL errors, and bypass CSP. |
| `forceHttp` | `false` | Force HTTP by intercepting HTTPS requests and downgrading them. |
| `addCSS` | `''` | Inject custom CSS into all pages via `<style>` tag before page load. |
| `addJS` | `''` | Inject custom JS into all pages via `<script>` tag before page load. Use `DOMContentLoaded` listener if DOM access is needed. |
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
  "addCSS": ".ad-banner { display: none !important; }",
  "addJS": "document.addEventListener('DOMContentLoaded', () => { console.log('injected'); })",
  "ttl": 600000
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

### blockAds Examples

| Input | Worker patterns | Browserless native |
|-------|----------------|-------------------|
| `true` | default 50+ | ✅ |
| `["foo.com"]` | default + custom | ✅ |
| `{ custom: ["foo.com"] }` | default + custom | ✅ |
| `{ useDefaults: false }` | none | ✅ |
| `{ useDefaults: false, custom: ["foo.com"] }` | custom only | ✅ |
| `false` (default) | none | ❌ |

```jsonc
// Default 50+ patterns
{ "blockAds": true, "steps": [...] }

// Extend defaults with custom patterns
{ "blockAds": ["my-ads.com", "/custom-path/"], "steps": [...] }

// Custom patterns only (no defaults)
{ "blockAds": { "useDefaults": false, "custom": ["my-ads.com"] }, "steps": [...] }

// No defaults, no custom (effectively disables worker-side blocking)
{ "blockAds": { "useDefaults": false }, "steps": [...] }
```

## Session Management & Timeouts

### Dynamic TTL and Extensions
The `ttl` (Time-To-Live) parameter controls how long a session stays active in the worker's memory after the last request.

- **Initial TTL**: Set when the session is created. Default is 30 seconds.
- **Session Extension**: Every request to an existing `sessionId` resets the timer using the session's current `ttl`.
- **Updating TTL**: You can update the `ttl` for an existing session by providing a new `ttl` value in any `/execute` request.

### Browserless Integration
To allow for long-running and extendable sessions, the worker manages browser lifecycles explicitly:
- **Heartbeat**: A lightweight `page.evaluate(() => 1)` ping runs every 30 seconds to keep the Browserless WebSocket connection alive. Without this, Browserless closes sessions when it detects no active clients (`keep-until: 0`).
- **Buffer Timeout**: When connecting to Browserless, the worker requests a high session timeout (at least 1 hour) as a buffer.
- **Explicit Cleanup**: When the worker's internal `ttl` timer expires, it calls `browser.close()` explicitly. This immediately signals Browserless to release all associated resources (Chromium processes, data dirs, etc.), ensuring efficient resource management.

---

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
List all active sessions with their current URLs and stored TTL values.

### GET /sessions/:id
Get detailed state of a specific session.

### DELETE /sessions/:id
Immediately close a session and release its browser resources.

### GET /health
Basic health check showing the number of active sessions.

## Features

- **Stateful Sessions**: Maintain browser state (cookies, local storage, authentication) between requests.
- **Heartbeat Keep-Alive**: Automatic 30s heartbeat (`page.evaluate`) keeps the Browserless WebSocket connection alive between requests, preventing premature session closure.
- **Security Bypass**: Use `disableSecurity: true` to bypass SSL errors, Content Security Policy (CSP), and standard web security (SOP).
- **HTTP Enforcement**: Use `forceHttp: true` to force the browser to stay on HTTP even if the server redirects to HTTPS.
- **Ad & Tracker Blocking**: Use `blockAds: true` to block 50+ ad, analytics, and tracking domains. Custom patterns can be passed as an array or object.
- **Custom CSS/JS Injection**: Inject styles and scripts into every page before load using `addCSS` and `addJS`.
- **Stealth mode**: Built-in evasion techniques to avoid bot detection.
- **Extendable Lifecycles**: Dynamically adjust session duration per request.
- **Customizable Ad Patterns**: Edit `src/ad-patterns.js` to add or remove blocking rules.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSERLESS_URL` | — | WebSocket URL (e.g., `ws://browserless:3000`) |
| `BROWSERLESS_TOKEN` | — | Optional Browserless API token |
| `PORT` | `3001` | Server port |
