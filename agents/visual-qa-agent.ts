import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { PageConfig } from '../config/pages.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logAgent } from '../utils/logger.js';

const JANK_DROP_PCT = 5;

/** Fixed timeline captures — required by visual QA spec (not arbitrary page polling). */
async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export interface FlickerResult {
  hasFlicker: boolean;
  flickerFrames: number[];
  worstDrop: number;
  note?: string;
}

export interface JankResult {
  jankScore: number;
  droppedFramePct: number;
  hasJank: boolean;
}

export interface LayoutShiftEvidence {
  diffPixelCounts: number[];
  diffPaths: string[];
}

export interface VisualQAResult {
  flicker: FlickerResult;
  jank: JankResult;
  layoutShift: LayoutShiftEvidence;
}

function comparePngBuffers(a: Buffer, b: Buffer): { diffCount: number; diffPng: PNG } {
  const imgA = PNG.sync.read(a);
  const imgB = PNG.sync.read(b);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw new Error('Screenshot size mismatch');
  }
  const diff = new PNG({ width: imgA.width, height: imgA.height });
  const num = pixelmatch(imgA.data, imgB.data, diff.data, imgA.width, imgA.height, {
    threshold: 0.1,
    diffColor: [255, 0, 0],
  });
  return { diffCount: num, diffPng: diff };
}

/**
 * Layout shift pixel diffs, scroll jank estimate, and placeholder flicker note (ffmpeg optional).
 */
export async function runVisualQAAgent(
  page: PageConfig,
  runId: string
): Promise<Result<VisualQAResult>> {
  const started = Date.now();
  logAgent('info', 'visual-qa start', { agent: 'visual-qa', pageSlug: page.slug, runId });

  const diffDir = path.join(process.cwd(), 'diffs', runId);
  await fs.mkdir(diffDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      recordVideo: { dir: path.join(process.cwd(), 'recordings', runId, page.slug) },
    });
    await context.route('**/*doubleclick.net*', (r) => r.abort());
    await context.route('**/*googlesyndication.com*', (r) => r.abort());

    const pw = await context.newPage();
    pw.on('console', () => undefined);
    pw.on('pageerror', () => undefined);
    await pw.goto(page.url, { waitUntil: 'networkidle', timeout: 30000 });

    const delays = [500, 1000, 2000, 3000];
    const shots: Buffer[] = [];
    let elapsed = 0;
    for (const step of delays) {
      await delay(step - elapsed);
      elapsed = step;
      shots.push(await pw.screenshot({ fullPage: true }));
    }

    const diffPixelCounts: number[] = [];
    const diffPaths: string[] = [];
    for (let i = 0; i < shots.length - 1; i++) {
      const { diffCount, diffPng } = comparePngBuffers(shots[i]!, shots[i + 1]!);
      diffPixelCounts.push(diffCount);
      const p = path.join(diffDir, `${page.slug}_layout_${i}_${i + 1}_diff.png`);
      await fs.writeFile(p, PNG.sync.write(diffPng));
      diffPaths.push(p);
    }

    const jank = await pw.evaluate(() => {
      return new Promise<{ droppedPct: number; jankScore: number }>((resolve) => {
        const durationMs = 3000;
        let frames = 0;
        let longFrames = 0;
        let last = performance.now();
        let first = true;
        const endAt = last + durationMs;
        const onFrame = (t: number) => {
          if (first) {
            first = false;
            last = t;
            requestAnimationFrame(onFrame);
            return;
          }
          const delta = t - last;
          last = t;
          frames += 1;
          if (delta > 32) {
            longFrames += 1;
          }
          if (t < endAt) {
            requestAnimationFrame(onFrame);
          } else {
            const droppedPct = frames > 0 ? (longFrames / frames) * 100 : 0;
            resolve({ droppedPct, jankScore: droppedPct });
          }
        };
        requestAnimationFrame(onFrame);
      });
    });

    await pw.close();
    await context.close();

    const flicker: FlickerResult = {
      hasFlicker: false,
      flickerFrames: [],
      worstDrop: 0,
      note: 'Install ffmpeg and extract video frames for SSIM flicker scoring',
    };

    logAgent('info', 'visual-qa done', {
      agent: 'visual-qa',
      pageSlug: page.slug,
      runId,
      duration_ms: Date.now() - started,
    });

    return ok({
      flicker,
      jank: {
        jankScore: jank.jankScore,
        droppedFramePct: jank.droppedPct,
        hasJank: jank.droppedPct > JANK_DROP_PCT,
      },
      layoutShift: { diffPixelCounts, diffPaths },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { page: page.slug, runId });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
