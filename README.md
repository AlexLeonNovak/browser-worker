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

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/sessions` | Create session (connect to Browserless) |
| GET | `/sessions` | List active sessions |
| GET | `/sessions/:id` | Session state |
| POST | `/sessions/:id/step` | Execute browser action |
| POST | `/sessions/:id/extend` | Reset TTL (before Wait Node!) |
| DELETE | `/sessions/:id` | Close session |
| GET | `/health` | Health status |

## Example n8n Flow

```
[Create Session] → [goto] → [fill email] → [click submit]
       ↓ sessionId stored in field
[extend TTL] → [Wait Node] → [fill OTP] → [click] → [screenshot] → [DELETE session]
```

## URL in n8n nodes

```
http://browser-worker:3001/sessions/{{ $('Create Session').item.json.sessionId }}/step
```
