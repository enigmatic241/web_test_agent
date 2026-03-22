import { chromium } from 'playwright';
import type { PageConfig } from '../config/pages.js';
import { NETWORK_PROFILES, type NetworkProfileName } from '../config/network-profiles.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logAgent } from '../utils/logger.js';
import { runLighthouseMedianAtPort } from '../utils/lighthouse-helpers.js';
import type { WebVitalsAgentMeasurement } from './web-vitals-agent.js';

const PHASE2_TIMEOUT_MS = 8 * 60 * 1000;

const PROFILES: NetworkProfileName[] = ['4G', 'SLOW_4G', 'SLOW_3G', 'EDGE'];

async function runProfile(
  page: PageConfig,
  runId: string,
  profileName: NetworkProfileName,
  basePort: number
): Promise<Result<WebVitalsAgentMeasurement>> {
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${basePort}`],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await context.route('**/*doubleclick.net*', (r) => r.abort());
    await context.route('**/*googlesyndication.com*', (r) => r.abort());
    const pwPage = await context.newPage();
    pwPage.on('console', () => undefined);
    pwPage.on('pageerror', () => undefined);

    const cdp = await context.newCDPSession(pwPage);
    await cdp.send('Network.enable');
    const prof = NETWORK_PROFILES[profileName];
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: prof.downloadThroughput,
      uploadThroughput: prof.uploadThroughput,
      latency: prof.latency,
    });

    const port = basePort;
    const metrics = await runLighthouseMedianAtPort(page.url, port);

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: -1,
      uploadThroughput: -1,
      latency: 0,
    });

    await context.close();

    return ok({
      pageSlug: page.slug,
      network: profileName,
      runId,
      ...metrics,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { profile: profileName, page: page.slug });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export interface NetworkSimResult {
  pageSlug: string;
  results: Record<string, Result<WebVitalsAgentMeasurement>>;
  degradation: { lcp4gToSlow3gRatio: number | null; concerning: boolean };
}

/**
 * Runs median Lighthouse metrics under each CDP network profile (parallel).
 */
export async function runNetworkSimAgent(
  page: PageConfig,
  runId: string
): Promise<Result<NetworkSimResult>> {
  const started = Date.now();
  logAgent('info', 'network-sim start', { agent: 'network-sim', pageSlug: page.slug, runId });

  try {
    const ports = [9232, 9233, 9234, 9235];
    const settled = await Promise.allSettled(
      PROFILES.map((name, i) => runProfile(page, runId, name, ports[i] ?? 9232 + i))
    );

    const results: Record<string, Result<WebVitalsAgentMeasurement>> = {};
    PROFILES.forEach((name, i) => {
      const s = settled[i];
      if (s.status === 'fulfilled') {
        results[name] = s.value;
      } else {
        results[name] = err(s.reason instanceof Error ? s.reason.message : String(s.reason));
      }
    });

    const lcp4g =
      results['4G']?.success && results['4G'].data.lcpMs != null ? results['4G'].data.lcpMs : null;
    const lcpSlow =
      results['SLOW_3G']?.success && results['SLOW_3G'].data.lcpMs != null
        ? results['SLOW_3G'].data.lcpMs
        : null;
    let lcp4gToSlow3gRatio: number | null = null;
    if (lcp4g !== null && lcpSlow !== null && lcp4g > 0) {
      lcp4gToSlow3gRatio = lcpSlow / lcp4g;
    }
    const concerning = lcp4gToSlow3gRatio !== null && lcp4gToSlow3gRatio > 3;

    logAgent('info', 'network-sim done', {
      agent: 'network-sim',
      pageSlug: page.slug,
      runId,
      duration_ms: Date.now() - started,
    });

    return ok({
      pageSlug: page.slug,
      results,
      degradation: { lcp4gToSlow3gRatio, concerning },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { page: page.slug, runId });
  }
}

export function networkSimTimeoutMs(): number {
  return PHASE2_TIMEOUT_MS;
}
