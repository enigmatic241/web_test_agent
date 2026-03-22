import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright';
import type { PageConfig } from '../config/pages.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logAgent } from '../utils/logger.js';

export type ScriptKind = 'analytics' | 'advertising' | 'chat' | 'cdn' | 'social' | 'unknown';

export interface ScriptEntry {
  url: string;
  domain: string;
  type: ScriptKind;
  sizeKb: number;
  blockingTimeMs: number;
  isRenderBlocking: boolean;
  isThirdParty: boolean;
}

export interface ScriptInventory {
  totalThirdPartySizeKb: number;
  totalBlockingTimeMs: number;
  scripts: ScriptEntry[];
}

function classify(domain: string, url: string): ScriptKind {
  const d = domain.toLowerCase();
  const u = url.toLowerCase();
  if (u.includes('doubleclick') || u.includes('googlesyndication') || u.includes('adservice')) {
    return 'advertising';
  }
  if (d.includes('google-analytics') || d.includes('analytics') || d.includes('segment')) {
    return 'analytics';
  }
  if (d.includes('zendesk') || d.includes('intercom') || d.includes('drift')) {
    return 'chat';
  }
  if (d.includes('cdn') || d.includes('cloudflare') || d.includes('jsdelivr')) {
    return 'cdn';
  }
  if (d.includes('facebook') || d.includes('twitter') || d.includes('linkedin')) {
    return 'social';
  }
  return 'unknown';
}

function isIndiaMartHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'indiamart.com' || h.endsWith('.indiamart.com');
}

interface HarEntry {
  request: { url: string; method: string };
  response?: {
    content?: { size?: number; mimeType?: string };
    bodySize?: number;
    headersSize?: number;
    _transferSize?: number;
  };
  timings?: Record<string, number | undefined>;
}

interface HarLog {
  log: { entries: HarEntry[] };
}

/**
 * Records a HAR, parses scripts, and ranks third-party cost.
 */
export async function runScriptAuditAgent(
  page: PageConfig,
  runId: string
): Promise<Result<ScriptInventory>> {
  const started = Date.now();
  logAgent('info', 'script-audit start', { agent: 'script-audit', pageSlug: page.slug, runId });

  const harDir = path.join(process.cwd(), 'har', runId);
  await fs.mkdir(harDir, { recursive: true });
  const harPath = path.join(harDir, `${page.slug}.har`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      recordHar: { path: harPath },
    });
    const pw = await context.newPage();
    await pw.goto(page.url, { waitUntil: 'networkidle', timeout: 30000 });
    await context.close();

    const raw = await fs.readFile(harPath, 'utf8');
    const har = JSON.parse(raw) as HarLog;
    const scripts: ScriptEntry[] = [];
    let totalThirdPartySizeKb = 0;
    let totalBlockingTimeMs = 0;

    for (const e of har.log.entries) {
      const url = e.request.url;
      if (!url.endsWith('.js') && !url.includes('.js?')) {
        continue;
      }
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      const isThirdParty = !isIndiaMartHost(host);
      const sizeBytes =
        e.response?.content?.size ??
        e.response?.bodySize ??
        e.response?._transferSize ??
        0;
      const sizeKb = sizeBytes / 1024;
      const blocked = (e.timings?.blocked ?? 0) + (e.timings?.dns ?? 0) + (e.timings?.connect ?? 0);
      const wait = e.timings?.wait ?? 0;
      const blockingTimeMs = blocked + wait;
      const type = classify(host, url);
      const isRenderBlocking = e.request.method === 'GET' && url.includes('head') === false;

      const entry: ScriptEntry = {
        url,
        domain: host,
        type,
        sizeKb,
        blockingTimeMs,
        isRenderBlocking,
        isThirdParty,
      };
      scripts.push(entry);
      if (isThirdParty) {
        totalThirdPartySizeKb += sizeKb;
        totalBlockingTimeMs += blockingTimeMs;
      }
    }

    scripts.sort((a, b) => b.blockingTimeMs - a.blockingTimeMs);

    logAgent('info', 'script-audit done', {
      agent: 'script-audit',
      pageSlug: page.slug,
      runId,
      duration_ms: Date.now() - started,
    });

    return ok({
      totalThirdPartySizeKb,
      totalBlockingTimeMs,
      scripts,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { page: page.slug, runId });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function highRiskScripts(inv: ScriptInventory, limit = 5): ScriptEntry[] {
  return inv.scripts
    .filter((s) => s.isRenderBlocking && s.sizeKb > 30)
    .slice(0, limit);
}
