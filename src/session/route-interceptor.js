import { resolveAdPatterns } from '../ad-patterns.js';

/**
 * Wires the session's context.route('**') handler for ad-blocking + force-HTTP.
 * No-op when neither feature is enabled (keeps the route table empty).
 */
export async function setupRoutes(session) {
  const { context, sessionId, forceHttp, forceHttpHosts, blockAds } = session;

  // Remove existing routes to prevent duplicates on session reuse
  await context.unroute('**/*');

  const patterns = resolveAdPatterns(blockAds);
  const adBlockingEnabled = patterns !== null;
  const forceHttpActive = forceHttp === true || forceHttpHosts.size > 0;

  if (!forceHttpActive && !adBlockingEnabled) {
    return;
  }

  await context.route('**/*', async (route) => {
    const urlStr = route.request().url();
    const urlLower = urlStr.toLowerCase();

    // AdBlock
    const isAd = adBlockingEnabled && patterns.some(p => urlLower.includes(p));
    if (isAd) {
      console.log(`[session:${sessionId}] AdBlock: ${urlStr}`);
      return route.abort();
    }
    let url = null;
    try { url = new URL(urlStr); } catch {}
    const hostname = url?.hostname?.toLowerCase();

    // ForceHTTP — check if this hostname should be forced
    const shouldForceHttp = forceHttp === true || (hostname && forceHttpHosts.has(hostname));
    if (shouldForceHttp && url.protocol === 'https:') {
      const httpUrl = urlStr.replace(/^https:/, 'http:');
      console.log(`[session:${sessionId}] ForceHTTP: ${urlStr} → ${httpUrl}`);
      try {
        const response = await route.fetch({ url: httpUrl });
        await route.fulfill({ response });
        return;
      } catch (e) {
        console.log(`[session:${sessionId}] ForceHTTP failed: ${e.message}`);
      }
    }

    route.continue();
  });

  const hostInfo = forceHttp === true ? 'all hosts' : `hosts: ${[...forceHttpHosts].join(', ') || 'none'}`;
  console.log(`[session:${sessionId}] Routes setup — forceHttp: ${hostInfo}, adBlock: ${adBlockingEnabled}`);
}
