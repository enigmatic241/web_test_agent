import { launch as launchChrome } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import type { PageConfig } from '../config/pages.js';
import { NETWORK_PROFILES, type NetworkProfileName } from '../config/network-profiles.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logAgent } from '../utils/logger.js';
import { buildLighthouseConfig, numericAudit, median3, lcpSelectorFromLhr } from '../utils/lighthouse-helpers.js';
import type { WebVitalsAgentMeasurement } from './web-vitals-agent.js';

const PHASE2_TIMEOUT_MS = 8 * 60 * 1000;

const PROFILES: NetworkProfileName[] = ['4G', 'SLOW_4G', 'SLOW_3G', 'EDGE'];

/**
 * Runs Lighthouse once under a specific CDP network profile using a dedicated Chrome instance.
 * Chrome-launcher gives us the debugging port; we apply CDP throttling before running Lighthouse.
 */
async function runProfile(
  page: PageConfig,
  runId: string,
  profileName: NetworkProfileName
): Promise<Result<WebVitalsAgentMeasurement>> {
  const chrome = await launchChrome({
    chromeFlags: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const port = chrome.port;
    const prof = NETWORK_PROFILES[profileName];

    // Apply CDP network throttling directly to the Chrome instance
    const cdpResponse = await fetch(
      `http://localhost:${port}/json/new`
    );
    if (!cdpResponse.ok) throw new Error('Failed to open CDP target');
    const { webSocketDebuggerUrl } = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };

    // Use WebSocket to send CDP Network.emulateNetworkConditions
    const { WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      ws.once('open', () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Network.emulateNetworkConditions',
          params: {
            offline: false,
            downloadThroughput: prof.downloadThroughput,
            uploadThroughput: prof.uploadThroughput,
            latency: prof.latency,
          },
        }));
      });
      ws.once('message', () => { ws.close(); resolve(); });
      ws.once('error', reject);
    });

    const config = buildLighthouseConfig();
    const lcpSamples: number[] = [];
    const clsSamples: number[] = [];
    const inpSamples: number[] = [];
    const fcpSamples: number[] = [];
    const ttfbSamples: number[] = [];
    const tbtSamples: number[] = [];
    const siSamples: number[] = [];
    const perfScores: number[] = [];
    const a11yScores: number[] = [];
    let lcpSelector: string | null = null;

    // Run Lighthouse once per profile (not 3× — network sim adds time fast)
    const runnerResult = await lighthouse(
      page.url,
      { port, logLevel: 'error', output: 'json' },
      config
    );
    if (!runnerResult?.lhr) throw new Error('Lighthouse returned no LHR');
    const lhr = runnerResult.lhr;

    lcpSamples.push(numericAudit(lhr, 'largest-contentful-paint') ?? NaN);
    clsSamples.push(numericAudit(lhr, 'cumulative-layout-shift') ?? NaN);
    inpSamples.push(
      numericAudit(lhr, 'interaction-to-next-paint') ??
        numericAudit(lhr, 'experimental-interaction-to-next-paint') ??
        NaN
    );
    fcpSamples.push(numericAudit(lhr, 'first-contentful-paint') ?? NaN);
    ttfbSamples.push(numericAudit(lhr, 'server-response-time') ?? NaN);
    tbtSamples.push(numericAudit(lhr, 'total-blocking-time') ?? NaN);
    siSamples.push(numericAudit(lhr, 'speed-index') ?? NaN);
    const perf = lhr.categories.performance?.score;
    const a11y = lhr.categories.accessibility?.score;
    if (typeof perf === 'number') perfScores.push(Math.round(perf * 100));
    if (typeof a11y === 'number') a11yScores.push(Math.round(a11y * 100));
    lcpSelector = lcpSelectorFromLhr(lhr);

    const clean = (arr: number[]) => arr.filter((n) => Number.isFinite(n));
    return ok({
      pageSlug: page.slug,
      network: profileName,
      runId,
      lcpMs: median3(clean(lcpSamples)),
      clsScore: median3(clean(clsSamples)),
      inpMs: median3(clean(inpSamples)),
      fcpMs: median3(clean(fcpSamples)),
      ttfbMs: median3(clean(ttfbSamples)),
      tbtMs: median3(clean(tbtSamples)),
      speedIndex: median3(clean(siSamples)),
      lighthousePerformanceScore: median3(clean(perfScores.map(Number))),
      lighthouseAccessibilityScore: median3(clean(a11yScores.map(Number))),
      lcpElementSelector: lcpSelector,
      rawJson: { profile: profileName },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { profile: profileName, page: page.slug });
  } finally {
    try { chrome.kill(); } catch { /* ignore */ }
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
    const settled = await Promise.allSettled(
      PROFILES.map((name) => runProfile(page, runId, name))
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
