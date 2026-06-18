/**
 * Document-start init script (runs in the page MAIN world) enabled by the
 * `interceptTurnstile` session flag.
 *
 * Many sites mount Cloudflare Turnstile via an explicit `turnstile.render(el, {
 * sitekey, callback, ... })` call from their JS bundle instead of a
 * `<div class="cf-turnstile" data-sitekey="...">`. In that case:
 *   - the sitekey lives only in JS (no data-sitekey to auto-detect), and
 *   - the response is delivered to the page through the render `callback`, which
 *     typically updates framework state (e.g. a React/Inertia controlled field).
 *     Writing the hidden input's value directly does NOT update that state.
 *
 * This shim replaces window.turnstile so that `render()` captures the sitekey and
 * the callback. Because patchright runs page.evaluate in an ISOLATED world that
 * can't read main-world globals, the sitekey is mirrored onto a hidden DOM node
 * (the DOM is shared across worlds); the callback stays in the main world and is
 * fired later via a <script> bridge once the solver returns a token.
 */
export function turnstileInterceptInit() {
  if (window.__cfTurnstileInterceptInstalled) return;
  window.__cfTurnstileInterceptInstalled = true;

  const state = { params: null, token: null, n: 0 };
  window.__cfTurnstile = state;

  const mirror = (p) => {
    try {
      let el = document.getElementById('__cf_turnstile_bridge');
      if (!el) {
        el = document.createElement('div');
        el.id = '__cf_turnstile_bridge';
        el.style.display = 'none';
        (document.documentElement || document).appendChild(el);
      }
      el.setAttribute('data-captured', '1');
      el.setAttribute('data-sitekey', p.sitekey || '');
      el.setAttribute('data-action', p.action || '');
      el.setAttribute('data-cdata', p.cdata || '');
    } catch (e) { /* DOM not ready yet — autoDetect's script fallback still covers us */ }
  };

  const capture = (container, params) => {
    params = params || {};
    state.params = {
      sitekey: params.sitekey,
      action: params.action,
      cdata: params.cdata,
      chlPageData: params.chlPageData,
      callback: typeof params.callback === 'function' ? params.callback : null
    };
    mirror(state.params);
    return 'cf-solver-widget-' + (++state.n);
  };

  const shim = {
    render: capture,
    execute: capture,
    reset() { state.token = null; },
    remove() {},
    getResponse() { return state.token || ''; },
    isExpired() { return false; },
    ready(cb) { try { if (typeof cb === 'function') cb(); } catch (e) {} }
  };

  try {
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      get() { return shim; },
      set() { /* swallow the real api.js assignment; the shim stays in control */ }
    });
  } catch (e) {
    window.turnstile = shim;
  }
}
