import * as fs from 'fs/promises';
import * as path from 'path';
import { launch as launchChrome } from 'chrome-launcher';
import type { PageConfig } from '../config/pages.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logAgent } from '../utils/logger.js';
import type { VitalsMeasurement } from '../db/queries.js';
import { runLighthouseMedianAtPort } from '../utils/lighthouse-helpers.js';

const PHASE1_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Convert agent measurement to DB insert shape.
 */
export function webVitalsToDbRow(w: WebVitalsAgentMeasurement): VitalsMeasurement {
  return {
    pageSlug: w.pageSlug,
    network: w.network,
    runId: w.runId,
    lcpMs: w.lcpMs,
    clsScore: w.clsScore,
    inpMs: w.inpMs,
    fcpMs: w.fcpMs,
    ttfbMs: w.ttfbMs,
    tbtMs: w.tbtMs,
    speedIndex: w.speedIndex,
    lighthousePerformanceScore: w.lighthousePerformanceScore,
    lighthouseAccessibilityScore: w.lighthouseAccessibilityScore,
    lcpElementSelector: w.lcpElementSelector,
    rawJson: w.rawJson,
  };
}

export interface WebVitalsAgentMeasurement {
  pageSlug: string;
  network: string;
  runId: string;
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
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

/**
 * Runs Lighthouse programmatically three times and returns median metrics plus raw reports on disk.
 */
export async function runWebVitalsAgent(
  page: PageConfig,
  runId: string
): Promise<Result<WebVitalsAgentMeasurement>> {
  const started = Date.now();
  const rawDir = path.join(process.cwd(), 'raw-reports', runId);

  logAgent('info', 'web-vitals start', { agent: 'web-vitals', pageSlug: page.slug, runId });

  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;

  try {
    const metrics = await withTimeout(
      (async () => {
        chrome = await launchChrome({
          chromeFlags: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'],
        });
        const port = chrome.port;

        const m = await runLighthouseMedianAtPort(page.url, port, async (lhr, i) => {
          const outPath = path.join(rawDir, `${page.slug}-${i + 1}.json`);
          await fs.mkdir(path.dirname(outPath), { recursive: true });
          await fs.writeFile(outPath, JSON.stringify(lhr), 'utf8');
        });

        return m;
      })(),
      PHASE1_TIMEOUT_MS,
      'runWebVitalsAgent'
    );

    const measurement: WebVitalsAgentMeasurement = {
      pageSlug: page.slug,
      network: '4G',
      runId,
      ...metrics,
    };

    logAgent('info', 'web-vitals done', {
      agent: 'web-vitals',
      pageSlug: page.slug,
      runId,
      duration_ms: Date.now() - started,
    });

    return ok(measurement);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logAgent('error', `web-vitals failed: ${message}`, {
      agent: 'web-vitals',
      pageSlug: page.slug,
      runId,
    });
    return err(message, { page: page.slug, runId });
  } finally {
    if (chrome) {
      try {
        await chrome.kill();
      } catch {
        /* ignore */
      }
    }
  }
}
