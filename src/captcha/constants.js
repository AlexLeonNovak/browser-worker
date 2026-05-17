export const TURNSTILE = 'turnstile';
export const RECAPTCHA_V2 = 'recaptcha-v2';
export const RECAPTCHA_V3 = 'recaptcha-v3';
export const HCAPTCHA = 'hcaptcha';
export const CLOUDFLARE_CHALLENGE = 'cloudflare-challenge';

export const SUPPORTED_TYPES = [TURNSTILE, RECAPTCHA_V2, RECAPTCHA_V3, HCAPTCHA, CLOUDFLARE_CHALLENGE];

// CapSolver's AntiCloudflareTask only accepts Chrome-on-Windows UAs.
// Using this as the session default also keeps cf_clearance valid (the cookie
// is bound to the UA used during the solve).
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
