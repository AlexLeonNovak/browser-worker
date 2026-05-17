import { TwoCaptchaSolver } from './providers/two-captcha.js';
import { CapSolverSolver } from './providers/capsolver.js';
import { AntiCaptchaSolver } from './providers/anti-captcha.js';
import { FlareSolverrSolver } from './providers/flaresolverr.js';

/**
 * Resolves captcha solver config from optional per-request body and ENV defaults.
 * Returns { provider, apiKey?, url? } — fields may be missing if nothing is configured.
 *
 * Resolution order for each field:
 *   provider: body.provider → CAPTCHA_PROVIDER → "2captcha"
 *   apiKey:   body.apiKey   → CAPTCHA_API_KEY_<PROVIDER> (per chosen provider)
 *   url:      body.url      → FLARESOLVERR_URL (flaresolverr only)
 *
 * So with both CAPTCHA_API_KEY_2CAPTCHA and CAPTCHA_API_KEY_CAPSOLVER in env,
 * a request can pick either provider just by passing { provider: "..." }
 * (no apiKey needed in body).
 */
export function resolveCaptchaConfig(bodyConfig) {
  const envProvider = process.env.CAPTCHA_PROVIDER || '2captcha';
  const provider = bodyConfig?.provider || envProvider;

  if (provider === 'flaresolverr') {
    const url = bodyConfig?.url || process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191';
    return { provider, url };
  }

  const envKeyByProvider = {
    '2captcha': process.env.CAPTCHA_API_KEY_2CAPTCHA,
    'capsolver': process.env.CAPTCHA_API_KEY_CAPSOLVER,
    'anti-captcha': process.env.CAPTCHA_API_KEY_ANTI_CAPTCHA
  };
  const apiKey = bodyConfig?.apiKey || envKeyByProvider[provider];
  return { provider, apiKey };
}

export function createSolver(config) {
  if (!config) return null;
  if (config.provider === '2captcha' && config.apiKey) return new TwoCaptchaSolver(config.apiKey);
  if (config.provider === 'capsolver' && config.apiKey) return new CapSolverSolver(config.apiKey);
  if (config.provider === 'anti-captcha' && config.apiKey) return new AntiCaptchaSolver(config.apiKey);
  if (config.provider === 'flaresolverr' && config.url) return new FlareSolverrSolver(config.url);
  return null;
}
