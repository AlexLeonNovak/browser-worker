# browser-worker

REST API browser worker for automation and scraping tasks.

**Browser runs locally in the same container** — worker is a thin REST API around a patched Chromium ([Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)) with built-in anti-detection.

## Architecture

```
Client ──REST──► browser-worker ──Patchright──► Chromium
 (n8n)           (Express API)                  (same container)
```

> **Note on stealth:** Patchright provides native low-level anti-detection (no `--enable-automation`, fixed `Runtime.enable` / `Console.enable` leaks, etc.). This **reduces the chance a captcha appears** but does not solve visible captchas (reCAPTCHA v2, hCaptcha). For solving visible captchas, a separate solver (2Captcha / CapSolver) integration is planned.

## Quick Start

```bash
# 1. Copy .env.example → .env (optional)
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
| `headless` | `true` | Run the browser headless. Set to `false` for headful via Xvfb — better stealth, more resources. |
| `userAgent` | Windows Chrome | Per-session UA string. Defaults to Chrome 146 on Windows 10 — required by CapSolver's `AntiCloudflareTask` and a generally safe fingerprint. Override if you need a different OS/version. |
| `proxy` | `null` | Per-session proxy object: `{ server, username?, password?, bypass? }`. See [Proxy Examples](#proxy-examples). |
| `captchaSolver` | `null` | Per-session captcha solver override: `{ provider: "2captcha"\|"capsolver", apiKey }`. Falls back to ENV defaults. See [Captcha Solving](#captcha-solving). |
| `blockAds` | `false` | Block ads and trackers. Accepts `true` (default 50+ patterns), an array (extends defaults), or an object `{ useDefaults?: boolean, custom?: string[] }`. |
| `disableSecurity` | `false` | Disable web security, ignore SSL errors, and bypass CSP. |
| `forceHttp` | `false` | Force HTTP by downgrading HTTPS requests. Accepts `true` (all domains) or an array of specific hostnames (e.g., `["legacy.com"]`). URLs starting with `http://` in `goto` automatically add their hostname to the list. |
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

### Proxy Examples

Per-session proxy via Playwright's native [proxy options](https://playwright.dev/docs/api/class-browser#browser-new-context-option-proxy). Each session gets its own proxy — different sessions can use different proxies.

```jsonc
// Anonymous HTTP/HTTPS proxy
{
  "proxy": { "server": "http://proxy.example.com:8080" },
  "steps": [{ "action": "goto", "params": { "url": "https://api.ipify.org" } }, { "action": "getContent" }]
}

// Authenticated proxy
{
  "proxy": {
    "server": "http://proxy.example.com:8080",
    "username": "user",
    "password": "pass"
  },
  "steps": [...]
}

// SOCKS5 proxy (no auth — Playwright limitation)
{ "proxy": { "server": "socks5://1.2.3.4:1080" }, "steps": [...] }

// Bypass list — comma-separated hosts that skip the proxy
{
  "proxy": {
    "server": "http://proxy.example.com:8080",
    "bypass": "*.internal.lan,localhost"
  },
  "steps": [...]
}
```

> **Note:** Proxy is bound to the session at creation. Subsequent `/execute` calls with an existing `sessionId` reuse the original proxy and will silently ignore any new `proxy` field in the request.

### forceHttp Examples

| Input | Behavior |
|-------|----------|
| `true` | All HTTPS → HTTP |
| `["legacy.com"]` | Only these hostnames |
| Auto-detected from `http://` in goto | Hostname added automatically |

```jsonc
// All domains: HTTPS → HTTP
{ "forceHttp": true, "steps": [
  { "action": "goto", "params": { "url": "http://example.com" } }
]}

// Specific hostnames only
{ "forceHttp": ["legacy.com", "old.local"], "steps": [
  { "action": "goto", "params": { "url": "http://legacy.com/page" } }
]}

// Auto-detect: http:// URL adds its hostname to the force list automatically
{ "forceHttp": [], "steps": [
  { "action": "goto", "params": { "url": "http://auto-detected.com" } }
]}
```

## Captcha Solving

When [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)'s native anti-detection isn't enough and a captcha still appears, the worker can solve it through one of two external providers:

- **2Captcha** — slower (human + AI), broader coverage. Good for Cloudflare Turnstile.
- **CapSolver** — usually faster AI-only solver.

Both run on a unified action — `solveCaptcha` — so you can pick the provider per request and swap when one starts under-performing.

### Configuration

Defaults from `.env`:
```env
CAPTCHA_PROVIDER=2captcha           # or "capsolver"
CAPTCHA_API_KEY_2CAPTCHA=xxx
CAPTCHA_API_KEY_CAPSOLVER=yyy
```

Per-session override in the `/execute` body:
```jsonc
{
  "captchaSolver": { "provider": "capsolver", "apiKey": "zzz" },
  "steps": [...]
}
```

If `captchaSolver` is omitted, the worker uses the ENV pair matching `CAPTCHA_PROVIDER`.

### solveCaptcha Action

| Param | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"turnstile"`, `"recaptcha-v2"`, `"recaptcha-v3"`, `"hcaptcha"`, or `"cloudflare-challenge"`. |
| `siteKey` | optional | Site key. If omitted, the worker auto-detects from `[data-sitekey]` on the page. |
| `action` | optional | Cloudflare Turnstile / reCAPTCHA v3 `action` value. |
| `cdata` | optional | Cloudflare Turnstile `cData` value for Challenge pages. |
| `score` | optional | reCAPTCHA v3 minimum score (default `0.3`). |
| `url` | optional | Page URL passed to the solver. Defaults to the current page URL. |
| `inject` | optional (default `true`) | Inject the token into `cf-turnstile-response` / `g-recaptcha-response` / `h-captcha-response` inputs and fire the page's `data-callback` if present. Disable to receive the raw token only. |

### Example: Cloudflare Turnstile

```jsonc
{
  "captchaSolver": { "provider": "2captcha", "apiKey": "..." },
  "steps": [
    { "action": "goto", "params": { "url": "https://protected.example.com/login" } },
    { "action": "solveCaptcha", "params": { "type": "turnstile" } },
    { "action": "click", "params": { "selector": "button[type=submit]" } }
  ],
  "ttl": 120000
}
```

### Example: Cloudflare Challenge ("Just a moment…")

This is the JS-challenge interstitial Cloudflare shows before letting you reach the real page. Different from Turnstile — instead of a token, the solver returns the `cf_clearance` cookie which the worker installs on the session. Then a fresh `goto` / `reload` passes through.

**Requirements:**
- Provider **must** be `capsolver` (2Captcha doesn't return `cf_clearance` directly).
- The session **must** have a `proxy` — CapSolver requires the cookie to be solved from the same exit IP that will use it.
- The session UA **must** be Chrome on Windows — CapSolver's `AntiCloudflareTask` rejects anything else. This is the default (`userAgent` param), so usually no action needed.

```jsonc
{
  "proxy": {
    "server": "http://proxy.example.com:8080",
    "username": "user",
    "password": "pass"
  },
  "captchaSolver": { "provider": "capsolver", "apiKey": "..." },
  "steps": [
    { "action": "goto", "params": { "url": "https://protected.example.com" } },
    { "action": "solveCaptcha", "params": { "type": "cloudflare-challenge" } },
    { "action": "reload" },
    { "action": "getContent" }
  ],
  "ttl": 120000
}
```

Response from `solveCaptcha` for this type:
```json
{
  "solved": true,
  "type": "cloudflare-challenge",
  "provider": "capsolver",
  "elapsedMs": 18432,
  "cookies": { "cf_clearance": "..." },
  "userAgent": "Mozilla/5.0..."
}
```

### Example: explicit siteKey + reCAPTCHA v2

```jsonc
{
  "steps": [
    { "action": "goto", "params": { "url": "https://example.com" } },
    { "action": "solveCaptcha", "params": {
      "type": "recaptcha-v2",
      "siteKey": "6Lc-aPIbAAAAAJs..."
    }},
    { "action": "click", "params": { "selector": "#submit" } }
  ]
}
```

> **Note:** `solveCaptcha` is bound to the session's solver config at the moment of the call. To switch providers on an existing session, send another `/execute` with a new `captchaSolver` block — the session updates in place.

## Session Management & Timeouts

### Dynamic TTL and Extensions
The `ttl` (Time-To-Live) parameter controls how long a session stays active in the worker's memory after the last request.

- **Initial TTL**: Set when the session is created. Default is 30 seconds.
- **Session Extension**: Every request to an existing `sessionId` resets the timer using the session's current `ttl`.
- **Updating TTL**: You can update the `ttl` for an existing session by providing a new `ttl` value in any `/execute` request.
- **Explicit Cleanup**: When the worker's internal `ttl` timer expires, it calls `browser.close()` explicitly, releasing all resources.

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
| `solveCaptcha` | `{ type, siteKey?, action?, cdata?, score?, url?, inject? }` | `{ solved, type, provider, elapsedMs, tokenLength, token }` |

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
- **Local Chromium**: Browser runs in the same container — no external dependencies, no WebSocket timeouts.
- **Patchright Anti-Detection**: Patched Chromium with `Runtime.enable`/`Console.enable` leak fixes and automation flag removal — built in at native level.
- **Per-Session Proxy**: Each session can be bound to its own HTTP/HTTPS/SOCKS5 proxy via `proxy` param.
- **Headless / Headful**: `headless: false` runs through Xvfb inside the container for stronger anti-detection where needed.
- **Captcha Solving**: Built-in `solveCaptcha` action with switchable backend — `2captcha` or `capsolver` — supports Cloudflare Turnstile, reCAPTCHA v2/v3, hCaptcha, and Cloudflare Challenge (`cf_clearance` cookie, CapSolver only). ENV defaults with per-session override.
- **Security Bypass**: Use `disableSecurity: true` to bypass SSL errors, Content Security Policy (CSP), and standard web security (SOP).
- **HTTP Enforcement**: Use `forceHttp: true` to force the browser to stay on HTTP even if the server redirects to HTTPS.
- **Ad & Tracker Blocking**: Use `blockAds: true` to block 50+ ad, analytics, and tracking domains. Custom patterns can be passed as an array or object.
- **Custom CSS/JS Injection**: Inject styles and scripts into every page before load using `addCSS` and `addJS`.
- **Extendable Lifecycles**: Dynamically adjust session duration per request.
- **Customizable Ad Patterns**: Edit `src/ad-patterns.js` to add or remove blocking rules.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `CAPTCHA_PROVIDER` | `2captcha` | Default solver when `captchaSolver` is not passed in body. `2captcha` or `capsolver`. |
| `CAPTCHA_API_KEY_2CAPTCHA` | — | API key used when provider is `2captcha`. |
| `CAPTCHA_API_KEY_CAPSOLVER` | — | API key used when provider is `capsolver`. |

## Diagrams

- **[Session Lifecycle](./diagrams/session-lifecycle.md)** — Full lifecycle from session creation through TTL expiry and cleanup
- **[Request Interception Flow](./diagrams/request-interception.md)** — How ad blocking and force-HTTP request routing works

## Support

If this project is useful to you, you can support ongoing maintenance here:

- [Support on Ko-fi](https://ko-fi.com/alexnovak)
- [Support on Donatello](https://donatello.to/alexnovak)
- [Support on Monobank](https://send.monobank.ua/jar/68tMxnVGqk)

Your support helps fund maintenance, fixes, documentation, and future improvements.

## License

MIT. See [LICENSE](./LICENSE) for details.