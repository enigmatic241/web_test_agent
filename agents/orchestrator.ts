import '../utils/load-env.js';
import { randomUUID } from 'crypto';
import { PAGES, type PageConfig } from '../config/pages.js';
import { loadFromSitemap } from '../utils/sitemap-loader.js';
import {
  insertMeasurement,
  insertRun,
  updateRunStatus,
  getBaseline,
  detectRegression,
  getDelta,
} from '../db/queries.js';
import { getPool, hasDbConfig } from '../db/pool.js';
import { webVitalsToDbRow, runWebVitalsAgent } from './web-vitals-agent.js';
import { runNetworkSimAgent } from './network-sim-agent.js';
import { runVisualQAAgent } from './visual-qa-agent.js';
import { runScriptAuditAgent } from './script-audit-agent.js';
import { runAnalysisAgent } from './analysis-agent.js';
import { sendRegressionAlert } from '../reporters/slack-reporter.js';
import { createOrCommentPerfIssue } from '../reporters/jira-reporter.js';
import { logger } from '../utils/logger.js';

type RunPhase = 1 | 2 | 3;

function parseArgs(argv: string[]): {
  dryRun: boolean;
  pageSlug?: string;
  sitemapSource?: string;
  samplePerType: number | 'all';
  maxChildSitemaps: number | 'all';
  concurrency: number;
} {
  const dryRun = argv.includes('--dry-run');

  let pageSlug: string | undefined;
  const pi = argv.indexOf('--page');
  if (pi >= 0 && argv[pi + 1]) pageSlug = argv[pi + 1];

  let sitemapSource: string | undefined;
  const si = argv.indexOf('--sitemap');
  if (si >= 0 && argv[si + 1]) sitemapSource = argv[si + 1];

  const sampleArg = (() => {
    const idx = argv.indexOf('--sample');
    return idx >= 0 ? argv[idx + 1] : '15';
  })();
  const samplePerType: number | 'all' =
    sampleArg === 'all' ? 'all' : Math.max(1, parseInt(sampleArg ?? '15', 10));

  const maxArg = (() => {
    const idx = argv.indexOf('--max-sitemaps');
    return idx >= 0 ? argv[idx + 1] : '20';
  })();
  const maxChildSitemaps: number | 'all' =
    maxArg === 'all' ? 'all' : Math.max(1, parseInt(maxArg ?? '20', 10));

  const concurrencyArg = (() => {
    const idx = argv.indexOf('--concurrency');
    return idx >= 0 ? argv[idx + 1] : '1';
  })();
  const concurrency = Math.max(1, parseInt(concurrencyArg ?? '1', 10));

  return { dryRun, pageSlug, sitemapSource, samplePerType, maxChildSitemaps, concurrency };
}

function getPhase(): RunPhase {
  const raw = process.env.RUN_PHASE ?? '1';
  const n = Number.parseInt(raw, 10);
  if (n === 2) {
    return 2;
  }
  if (n === 3) {
    return 3;
  }
  return 1;
}

function assertProductionAllowed(): void {
  const target = process.env.TARGET_ENV ?? 'staging';
  const allow = process.env.ALLOW_PRODUCTION_RUNS === 'true';
  if (target === 'production' && !allow) {
    throw new Error(
      'TARGET_ENV=production requires ALLOW_PRODUCTION_RUNS=true (safety gate)'
    );
  }
}

async function runPagePhase12(
  page: PageConfig,
  runId: string,
  phase: RunPhase
): Promise<{
  vitals: Awaited<ReturnType<typeof runWebVitalsAgent>>;
  network?: Awaited<ReturnType<typeof runNetworkSimAgent>>;
  visual?: Awaited<ReturnType<typeof runVisualQAAgent>>;
}> {
  if (phase < 2) {
    const vitals = await runWebVitalsAgent(page, runId);
    return { vitals };
  }

  const settled = await Promise.allSettled([
    runWebVitalsAgent(page, runId),
    runNetworkSimAgent(page, runId),
    runVisualQAAgent(page, runId),
  ]);

  const vitals =
    settled[0]?.status === 'fulfilled'
      ? settled[0].value
      : { success: false as const, error: String(settled[0]?.reason) };

  const network =
    settled[1]?.status === 'fulfilled'
      ? settled[1].value
      : { success: false as const, error: String(settled[1]?.reason) };

  const visual =
    settled[2]?.status === 'fulfilled'
      ? settled[2].value
      : { success: false as const, error: String(settled[2]?.reason) };

  return { vitals, network, visual };
}

/**
 * Main orchestrator — Phase 1–3, DB, Slack, Jira, CLI flags.
 */
export async function main(): Promise<void> {
  assertProductionAllowed();
  const { dryRun, pageSlug, sitemapSource, samplePerType, maxChildSitemaps, concurrency } =
    parseArgs(process.argv.slice(2));
  const phase = getPhase();

  // ── Resolve page list ─────────────────────────────────────────────────────
  let pages: PageConfig[];

  if (sitemapSource) {
    // Sitemap mode — ignore --page flag when --sitemap is set
    const sitemapResult = await loadFromSitemap({
      source: sitemapSource,
      samplePerType,
      maxChildSitemaps,
    });
    pages = sitemapResult.pages;
    logger.info('orchestrator: sitemap mode', {
      source: sitemapSource,
      samplePerType,
      totalPages: pages.length,
      typeCounts: sitemapResult.typeCounts,
    });
    if (pages.length === 0) {
      throw new Error('Sitemap loaded but no URLs were selected — check --sample and --types flags.');
    }
  } else {
    // Default curated-pages mode
    pages = pageSlug ? PAGES.filter((p) => p.slug === pageSlug) : PAGES;
    if (pages.length === 0) {
      throw new Error(`No page found for slug: ${pageSlug}`);
    }
  }

  const runId = randomUUID();
  const triggerType =
    (process.env.TRIGGER_TYPE as 'deploy' | 'scheduled' | 'manual') ?? 'manual';
  const deploySha = process.env.GITHUB_SHA ?? process.env.DEPLOY_SHA ?? null;

  if (hasDbConfig()) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await insertRun(client, {
        runId,
        triggerType,
        deploySha,
        status: 'running',
      });
    } finally {
      client.release();
    }
  }

  let passed = 0;
  let failed = 0;
  let regressions = 0;

  const grafanaBase = process.env.GRAFANA_BASE_URL ?? '';
  const rawBase = process.env.RAW_REPORTS_BASE_URL ?? '';

  // ── Run pages (sequential or concurrent batches) ──────────────────────────
  const runPage = async (page: PageConfig) => {
    const pageResult = await runPagePhase12(page, runId, phase);

    if (pageResult.vitals.success) {
      passed += 1;
      const v = pageResult.vitals.data;

      if (!dryRun && hasDbConfig()) {
        const ins = await insertMeasurement(webVitalsToDbRow(v));
        if (!ins.success) {
          logger.warn('vitals insert failed', { error: ins.error });
        }

        const baseline = await getBaseline(page.slug, 7);
        if (baseline.success) {
          const report = detectRegression(webVitalsToDbRow(v), baseline.data);
          if (report.hasRegression) {
            regressions += 1;
          }
          if (report.hasRegression && !dryRun) {
            const grafanaUrl = grafanaBase
              ? `${grafanaBase}/d/page-${page.slug}`
              : undefined;
            const rawUrl = rawBase
              ? `${rawBase}/${runId}/${page.slug}-1.json`
              : undefined;
            await sendRegressionAlert(report, page, runId, {
              lcpElementSelector: v.lcpElementSelector,
              deploySha,
              grafanaUrl,
              rawReportUrl: rawUrl,
            });
          }
        }
      }
    } else {
      failed += 1;
    }

    if (phase >= 3 && pageResult.vitals.success) {
      const scriptRes = await runScriptAuditAgent(page, runId);
      const netRes =
        pageResult.network && pageResult.network.success
          ? pageResult.network.data
          : {
              pageSlug: page.slug,
              results: {},
              degradation: { lcp4gToSlow3gRatio: null as number | null, concerning: false },
            };

      if (!dryRun && scriptRes.success && hasDbConfig()) {
        const deltaRes = await getDelta(page.slug, runId);
        if (deltaRes.success) {
          const analysisRes = await runAnalysisAgent(deltaRes.data, {
            runId,
            pageSlug: page.slug,
            deploySha: deploySha ?? 'unknown',
            previousSha: process.env.PREVIOUS_SHA ?? deploySha ?? 'HEAD~1',
            scriptInventory: scriptRes.data,
            networkSim: netRes,
          });

          if (analysisRes.success) {
            const a = analysisRes.data;
            if (
              (a.severity === 'HIGH' || a.severity === 'CRITICAL') &&
              hasDbConfig()
            ) {
              const metricMd = Object.entries(deltaRes.data.metrics)
                .map(
                  ([k, v]) =>
                    `| ${k} | ${v.before ?? '—'} | ${v.after ?? '—'} | ${v.deltaPct?.toFixed(1) ?? '—'} |`
                )
                .join('\n');
              await createOrCommentPerfIssue({
                page,
                runId,
                deploySha: deploySha ?? 'unknown',
                analysis: a,
                metricTableMarkdown: metricMd,
                networkSummary: `ratio ${netRes.degradation.lcp4gToSlow3gRatio ?? 'n/a'}`,
                worstScript: scriptRes.data.scripts[0],
              });
            }
          }
        }
      }
    }
  };

  // Process in batches of `concurrency`
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = pages.slice(i, i + concurrency);
    if (concurrency > 1) {
      logger.info(`orchestrator: running batch ${Math.floor(i / concurrency) + 1}`, {
        pages: batch.map((p) => p.slug),
        concurrency,
      });
      await Promise.allSettled(batch.map(runPage));
    } else {
      for (const page of batch) {
        await runPage(page);
      }
    }
  }

  if (hasDbConfig()) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await updateRunStatus(client, runId, failed > 0 ? 'partial' : 'completed', new Date());
    } finally {
      client.release();
    }
  }

  logger.info('orchestrator summary', {
    runId,
    phase,
    pages: pages.length,
    passed,
    failed,
    regressions,
    dryRun,
  });
}

main().catch((e) => {
  logger.error('orchestrator failed', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
