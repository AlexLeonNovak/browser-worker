/**
 * Public surface of the captcha module. Server-side code imports from here only.
 *
 * Layout:
 *   constants.js   — captcha type constants, DEFAULT_USER_AGENT
 *   utils.js       — small helpers (sleep, proxy format conversion)
 *   config.js      — resolveCaptchaConfig + createSolver factory
 *   page-helpers.js — DOM utilities run via page.evaluate()
 *   providers/     — one file per backend (2captcha, capsolver, anti-captcha, flaresolverr)
 */
export { SUPPORTED_TYPES, DEFAULT_USER_AGENT } from './constants.js';
export { proxyToCapsolverString } from './utils.js';
export { resolveCaptchaConfig, createSolver } from './config.js';
export {
  waitForCloudflareCookie,
  autoDetectSiteKey,
  injectCaptchaToken
} from './page-helpers.js';
export {
  solveCloudflareChallenge,
  CF_STRATEGY_NAMES,
  CF_DEFAULT_AUTO_ORDER
} from './cloudflare-challenge.js';
