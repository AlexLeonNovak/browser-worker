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
| `proxy` | env default | Per-session proxy `{ server, username?, password?, bypass? }`. Falls back to `PROXY_*` env vars when omitted. Pass `null` to opt out of the env default for one request. See [Proxy Examples](#proxy-examples). |
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

You can also set a **default proxy** in `.env` — every session uses it unless the request overrides:
```env
PROXY_SERVER=http://proxy.example.com:8080
PROXY_USERNAME=user
PROXY_PASSWORD=pass
PROXY_BYPASS=*.internal.lan,localhost
```

Resolution order: `body.proxy === null` → no proxy for this request; `body.proxy` present → use as-is; otherwise → fall back to env.

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

When [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)'s native anti-detection isn't enough and a captcha still appears, the worker can solve it through one of four backends:

- **2Captcha** — slower (human + AI), broad coverage of token-based captchas.
- **CapSolver** — usually faster AI-only solver. Only one that returns `cf_clearance` directly (needs proxy).
- **Anti-Captcha** — another paid API, useful as a tie-breaker when 2Captcha/CapSolver under-perform.
- **FlareSolverr** — self-hosted, free Cloudflare bypass. Only handles `cloudflare-challenge`. Bundled as a sibling service in `docker-compose.yml`.

All run on a unified action — `solveCaptcha` — so you can pick the provider per request and swap when one starts under-performing. For `cloudflare-challenge` specifically there's also an `auto` strategy that tries free options first and only escalates to paid providers if they fail.

### Configuration

Defaults from `.env` (populate every key you might use — the worker picks whichever provider the request asks for):
```env
CAPTCHA_PROVIDER=2captcha            # "2captcha" | "capsolver" | "anti-captcha" | "flaresolverr"
CAPTCHA_API_KEY_2CAPTCHA=xxx
CAPTCHA_API_KEY_CAPSOLVER=yyy
CAPTCHA_API_KEY_ANTI_CAPTCHA=zzz
FLARESOLVERR_URL=http://flaresolverr:8191
```

`CAPTCHA_PROVIDER` is only the **default** when the request body doesn't specify one. Per-request you can switch freely:

```jsonc
// Use the default provider from env (2captcha here)
{ "steps": [...] }

// Switch to capsolver for this request — apiKey is picked up from
// CAPTCHA_API_KEY_CAPSOLVER, no need to re-send it in the body.
{ "captchaSolver": { "provider": "capsolver" }, "steps": [...] }

// Override the apiKey explicitly (useful for client-supplied keys)
{ "captchaSolver": { "provider": "capsolver", "apiKey": "zzz" }, "steps": [...] }

// FlareSolverr — no apiKey, url defaults to FLARESOLVERR_URL
{ "captchaSolver": { "provider": "flaresolverr" }, "steps": [...] }
```

### solveCaptcha Action

| Param | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"turnstile"`, `"recaptcha-v2"`, `"recaptcha-v3"`, `"hcaptcha"`, or `"cloudflare-challenge"`. |
| `siteKey` | optional | Site key. If omitted, the worker auto-detects from `[data-sitekey]` on the page. |
| `action` | optional | Cloudflare Turnstile / reCAPTCHA v3 `action` value. |
| `cdata` | optional | Cloudflare Turnstile `cData` value for Challenge pages. |
| `score` | optional | reCAPTCHA v3 minimum score (default `0.3`). |
| `url` | optional | Page URL passed to the solver. Defaults to the current page URL. |
| `inject` | optional (default `true`) | Inject the token / cookies back into the page and fire the `data-callback` if present. Disable to receive the raw token/cookies only. |
| `strategy` | optional, `cloudflare-challenge` only | `"auto"` (default), one of `"wait"` / `"flaresolverr"` / `"capsolver"` / `"2captcha"` / `"anti-captcha"`, **or** an array of those names in custom order. See [CF Strategies](#cloudflare-challenge-strategies). |
| `waitTimeoutMs` | optional, `cloudflare-challenge` only | How long the `wait` strategy polls for `cf_clearance` (default `15000`). |
| `widgetWaitTimeoutMs` | optional, `cloudflare-challenge` only | After injecting a Turnstile token (2Captcha / Anti-Captcha strategies), how long to wait for the page to set `cf_clearance` (default `20000`). |

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

### Cloudflare Challenge Strategies

The `"cloudflare-challenge"` type has five ways to obtain `cf_clearance`:

| Strategy | Needs | Cost | Notes |
|---|---|---|---|
| `wait` | nothing | free | Polls cookies until `cf_clearance` shows up. Works for invisible / non-interactive CF challenges that Patchright passes on its own. |
| `flaresolverr` | running FlareSolverr container | free | Hands the URL to FlareSolverr, gets `cf_clearance` + UA back. Works for most CF challenges; doesn't need a session proxy. **⚠ See "Cookie portability" below.** |
| `capsolver` | CapSolver apiKey + **session proxy** + Windows Chrome UA | paid | `AntiCloudflareTask`. Strict requirements but very reliable. Cookie is issued for **your** UA + proxy IP, so it's portable to downstream HTTP clients (n8n HTTP node, curl, etc.) — preferred when the goal is to feed cookies outside the browser. |
| `2captcha` | 2Captcha apiKey + visible Turnstile widget on the page | paid | Solves the Turnstile token via 2Captcha, injects it, waits for the page to set `cf_clearance` itself. |
| `anti-captcha` | Anti-Captcha apiKey + visible Turnstile widget on the page | paid | Same approach as 2Captcha, via Anti-Captcha's `TurnstileTaskProxyless`. Useful tie-breaker. |
| `auto` *(default)* | — | varies | Default order: `wait → flaresolverr → capsolver → 2captcha → anti-captcha`. Returns the first success and skips strategies that aren't configured. |

#### Custom strategy chain

Pass an array to `strategy` to use your own order:

```jsonc
{ "action": "solveCaptcha", "params": {
  "type": "cloudflare-challenge",
  "strategy": ["wait", "anti-captcha", "capsolver"]   // skip flaresolverr, prefer anti-captcha over capsolver
}}
```

Each strategy is tried in order and the first success returns. Strategies that aren't configured (no apiKey, no proxy, etc.) fail fast with a clear error and the chain continues.

#### Cookie portability — why strategy choice matters for downstream HTTP calls

Cloudflare binds `cf_clearance` to the **(IP, UA, TLS fingerprint)** of the client that solved the challenge, not just to the cookie value.

| Strategy | Cookie issued for | Portable to a separate HTTP client (n8n HTTP node, curl, axios)? |
|---|---|---|
| `wait` | your browser session | ✅ — same UA + same proxy IP |
| `capsolver` | your UA + session proxy IP (you pass them in) | ✅ — same as above |
| `flaresolverr` | **FlareSolverr's** Linux Chrome UA + its TLS | ⚠ Only works if the next request **also** matches FlareSolverr's UA, comes through the same IP, **and** the consumer can produce a Chrome-like TLS fingerprint (Node's default TLS is detectable and usually rejected). |
| `2captcha` / `anti-captcha` | your browser session (token is injected, page issues cookie itself) | ✅ |

For pure browser-worker workflows the worker auto-handles UA-sync via CDP, so any strategy works. But if you plan to pass `cf_clearance` to an **n8n HTTP node**, a Python `requests`, or any other non-browser client — **prefer `capsolver`** (or `wait` / token-widget strategies). FlareSolverr cookies tend to be rejected by the host page on the second request unless you also impersonate Chrome's TLS, which most HTTP libraries can't do out of the box.

> **Even with `capsolver`, an external HTTP client may still be rejected** because Cloudflare also validates the TLS / HTTP-2 fingerprint of the connection, and Node.js / Python TLS stacks look nothing like Chrome. The reliable workaround is to make follow-up calls through the worker itself via the [`httpRequest` action](#calling-protected-apis-after-solving-cf--httprequest-action) — that way the request leaves the container as actual Chrome traffic.

### Calling protected APIs after solving CF — `httpRequest` action

A solved `cf_clearance` is bound to the **TLS / HTTP-2 fingerprint** of the browser that solved it, not just to the cookie value. Passing the cookie to an n8n HTTP Request node (or any Node.js / Python HTTP library) usually still gets blocked, because the request's JA3 fingerprint reveals it's not Chrome.

The `httpRequest` action runs `fetch()` **inside the same browser context** that solved the challenge — same TLS, same cookies, same UA — so Cloudflare can't tell it apart from a normal page request.

```jsonc
{
  "sessionId": "<existing session that already solved CF>",
  "steps": [
    {
      "action": "httpRequest",
      "params": {
        "method": "POST",
        "url": "https://example.com/api/login",
        "headers": { "Content-Type": "application/json" },
        "body": { "username": "x", "password": "y" },
        "responseType": "json"
      }
    }
  ]
}
```

Response:
```jsonc
{
  "ok": true,
  "results": [{
    "action": "httpRequest",
    "ok": true,
    "result": {
      "status": 200,
      "ok": true,
      "statusText": "OK",
      "headers": { "content-type": "application/json", ... },
      "body": { "token": "..." },
      "finalUrl": "https://example.com/api/login"
    }
  }]
}
```

**Params:**

| Param | Default | Description |
|---|---|---|
| `url` | required | Absolute http(s) URL. |
| `method` | `"GET"` | Any HTTP verb. |
| `headers` | `{}` | Object — case as you want it sent. |
| `body` | — | String passed through verbatim, **or** an object (JSON-stringified automatically + `Content-Type` set if absent). |
| `credentials` | `"include"` | `"include"` keeps the session cookies; `"omit"` runs without them. |
| `responseType` | `"text"` | `"text"` → `body` is a string; `"json"` → parsed object. |
| `timeoutMs` | `30000` | Aborts via AbortController. |

**Why this works where n8n HTTP node doesn't:** the request leaves the container as **real Chrome traffic** (Chrome handles the TLS handshake, HTTP/2 framing, header ordering). Cloudflare sees the same fingerprint that received the cookie, so it lets the request through.

### Example: Cloudflare Challenge — auto strategy

This is the recommended setup. Cheap options fire first, paid solvers are the fallback.

```jsonc
{
  "proxy": { "server": "http://proxy.example.com:8080", "username": "u", "password": "p" },
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

### Example: free path only (wait + FlareSolverr)

Useful if you don't want to spend on solvers.

```jsonc
{
  "captchaSolver": { "provider": "flaresolverr" },
  "steps": [
    { "action": "goto", "params": { "url": "https://protected.example.com" } },
    { "action": "solveCaptcha", "params": { "type": "cloudflare-challenge", "strategy": "auto" } },
    { "action": "getContent" }
  ]
}
```

The `auto` strategy first waits up to 15s for the challenge to pass passively (often it does, thanks to Patchright), and only then asks FlareSolverr.

### Response shape (cloudflare-challenge)

```json
{
  "solved": true,
  "type": "cloudflare-challenge",
  "strategy": "flaresolverr",
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
| `getContent` | `{ shadow? }` | `{ html }` |
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
| `httpRequest` | `{ url, method?, headers?, body?, credentials?, responseType?, timeoutMs? }` | `{ status, ok, statusText, headers, body, finalUrl }` |

> **Shadow DOM.** Selector-based actions (`click`, `fill`, `getText`, `getAttribute`, …) already reach into shadow roots: Playwright pierces **open** roots and patchright additionally pierces **closed** ones at the driver level — no extra option needed. `getContent` is the exception: `page.content()` does not serialize shadow trees, so pass `{ "shadow": true }` to inline every **open** shadow root as declarative shadow DOM (`<template shadowrootmode="open">…</template>`). Closed roots are invisible to page-side serialization and are omitted.

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
- **Captcha Solving**: Built-in `solveCaptcha` action with four switchable backends — `2captcha`, `capsolver`, `anti-captcha`, `flaresolverr` — supports Cloudflare Turnstile, reCAPTCHA v2/v3, hCaptcha, and Cloudflare Challenge (`cf_clearance` cookie) with a configurable strategy chain. ENV defaults with per-session override.
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
| `CAPTCHA_API_KEY_ANTI_CAPTCHA` | — | API key used when provider is `anti-captcha`. |
| `FLARESOLVERR_URL` | `http://flaresolverr:8191` | URL of the FlareSolverr sibling service. |
| `PROXY_SERVER` | — | Default proxy server (e.g. `http://proxy.example.com:8080`). Applied to every session unless body overrides. |
| `PROXY_USERNAME` | — | Default proxy username. |
| `PROXY_PASSWORD` | — | Default proxy password. |
| `PROXY_BYPASS` | — | Default proxy bypass list, comma-separated. |

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