# browser-worker

Stateful browser worker for n8n.
**Browser runs in Browserless** — worker is a thin HTTP↔CDP client (~150MB image).

## Architecture

```
n8n ──REST──► browser-worker ──WS/CDP──► browserless ──► Chromium
              (NO browser)               (separate container)
```

## Quick Start

```bash
# 1. Copy .env.example → .env and set your token
cp .env.example .env

# 2. Start
docker compose up -d --build

# 3. Verify
curl http://localhost:3001/health
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSERLESS_URL` | — | ws://browserless:3000 |
| `BROWSERLESS_TOKEN` | — | Browserless token |
| `PORT` | 3001 | Worker port |

## REST API

### POST /execute

Execute one or more browser actions in a single request. Creates a new session if `sessionId` is not provided.

**Request:**
```json
{
  "sessionId": "optional-uuid",
  "ttl": 300000,
  "stealth": true,
  "steps": [
    { "action": "goto", "params": { "url": "https://example.com" } },
    { "action": "fill", "params": { "selector": "#email", "value": "test@example.com" } },
    { "action": "click", "params": { "selector": "#submit" } }
  ],
  "stopOnError": true
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "uuid-here",
  "created": true,
  "completedSteps": 3,
  "totalSteps": 3,
  "results": [
    { "action": "goto", "ok": true, "result": { "url": "https://example.com" } },
    { "action": "fill", "ok": true, "result": { "filled": "#email" } },
    { "action": "click", "ok": true, "result": { "clicked": "#submit" } }
  ],
  "finalUrl": "https://example.com"
}
```

**Available Actions:**

| Action | Params | Result |
|--------|--------|--------|
| `goto` | `{ url, waitUntil? }` | `{ url }` |
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

List active sessions.

**Response:**
```json
{
  "count": 2,
  "sessions": [
    { "sessionId": "uuid-1", "ttl": 300000, "url": "https://example.com" },
    { "sessionId": "uuid-2", "ttl": 300000, "url": "https://other.com" }
  ]
}
```

### GET /sessions/:id

Get session state.

**Response:**
```json
{
  "ok": true,
  "sessionId": "uuid-here",
  "url": "https://example.com",
  "ttl": 300000
}
```

### DELETE /sessions/:id

Close session and release resources.

**Response:**
```json
{
  "ok": true,
  "closed": "uuid-here"
}
```

### GET /health

Health check.

**Response:**
```json
{
  "ok": true,
  "activeSessions": 2,
  "browserless": "ws://browserless:3000"
}
```

## Example n8n Flow

```
[POST /execute: goto + login] → [sessionId stored]
       ↓
[POST /execute with sessionId: fill OTP + click] → [screenshot] → [DELETE session]
```

## URL in n8n nodes

```
http://browser-worker:3001/execute
```

Request body:
```json
{
  "sessionId": "{{ $json.sessionId }}",
  "steps": [
    { "action": "fill", "params": { "selector": "#otp", "value": "123456" } },
    { "action": "click", "params": { "selector": "#submit" } }
  ]
}
```
