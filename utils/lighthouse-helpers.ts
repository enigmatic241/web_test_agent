import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import type { Config as LHConfig, Result as LHResult } from 'lighthouse/types/lh.js';

/**
 * Shared Lighthouse desktop config: CPU x4, ad blocking, desktop emulation.
 */
export function buildLighthouseConfig(): LHConfig {
  const throttling = {
    ...(desktopConfig.settings?.throttling ?? {}),
    cpuSlowdownMultiplier: 4,
  };
  return {
    extends: 'lighthouse:default',
    settings: {
      ...desktopConfig.settings,
      throttling,
      blockedUrlPatterns: ['*doubleclick.net*', '*googlesyndication.com*'],
    },
  };
}

export function numericAudit(lhr: LHResult, id: string): number | null {
  const v = lhr.audits[id]?.numericValue;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function median3(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function lcpSelectorFromLhr(lhr: LHResult): string | null {
  const audit = lhr.audits['largest-contentful-paint-element'];
  const details = audit?.details as { type?: string; items?: Array<{ node?: { selector?: string } }> } | undefined;
  if (details?.type !== 'table' || !details.items?.length) {
    return null;
  }
  return details.items[0]?.node?.selector ?? null;
}

/**
 * Run Lighthouse three times on a URL using an existing Chrome debugging port.
 */
export async function runLighthouseMedianAtPort(
  url: string,
  port: number,
  onEachLhr?: (lhr: LHResult, index: number) => Promise<void>
): Promise<{
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  tbtMs: number | null;
  speedIndex: number | null;
  lighthousePerformanceScore: number | null;
  lighthouseAccessibilityScore: number | null;
  lcpElementSelector: string | null;
  rawJson: unknown;
}> {
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
  let lastLcpSelector: string | null = null;
  const rawRuns: unknown[] = [];

  for (let i = 0; i < 3; i++) {
    const runnerResult = await lighthouse(
      url,
      { port, logLevel: 'error', output: 'json' },
      config
    );
    if (!runnerResult?.lhr) {
      throw new Error('Lighthouse returned no LHR');
    }
    const lhr = runnerResult.lhr;
    rawRuns.push(lhr);
    if (onEachLhr) {
      await onEachLhr(lhr, i);
    }
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
    if (typeof perf === 'number') {
      perfScores.push(Math.round(perf * 100));
    }
    if (typeof a11y === 'number') {
      a11yScores.push(Math.round(a11y * 100));
    }
    lastLcpSelector = lcpSelectorFromLhr(lhr) ?? lastLcpSelector;
  }

  const clean = (arr: number[]) => arr.filter((n) => Number.isFinite(n));

  return {
    lcpMs: median3(clean(lcpSamples)),
    clsScore: median3(clean(clsSamples)),
    inpMs: median3(clean(inpSamples)),
    fcpMs: median3(clean(fcpSamples)),
    ttfbMs: median3(clean(ttfbSamples)),
    tbtMs: median3(clean(tbtSamples)),
    speedIndex: median3(clean(siSamples)),
    lighthousePerformanceScore: median3(clean(perfScores.map(Number))),
    lighthouseAccessibilityScore: median3(clean(a11yScores.map(Number))),
    lcpElementSelector: lastLcpSelector,
    rawJson: { runs: rawRuns.length, medianOf: 3 },
  };
}
