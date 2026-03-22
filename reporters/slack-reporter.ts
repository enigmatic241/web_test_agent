import type { PageConfig } from '../config/pages.js';
import type { RegressionReport, MetricRegression } from '../db/queries.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { logger } from '../utils/logger.js';

function severityEmoji(sev: string): string {
  switch (sev) {
    case 'CRITICAL':
      return '🔴';
    case 'HIGH':
      return '🟠';
    case 'MEDIUM':
      return '🟡';
    case 'LOW':
    default:
      return '⚪';
  }
}

function metricLabel(key: string): string {
  const map: Record<string, string> = {
    lcpMs: 'LCP (ms)',
    clsScore: 'CLS',
    inpMs: 'INP (ms)',
    fcpMs: 'FCP (ms)',
    ttfbMs: 'TTFB (ms)',
    tbtMs: 'TBT (ms)',
    speedIndex: 'Speed Index',
    lighthousePerformanceScore: 'LH Perf',
  };
  return map[key] ?? key;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function postWithRetry(
  url: string,
  body: unknown,
  maxAttempts = 3
): Promise<Result<void>> {
  let attempt = 0;
  let lastErr = 'unknown';
  while (attempt < maxAttempts) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        throw new Error(lastErr);
      }
      return ok(undefined);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      attempt += 1;
      const backoff = 500 * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }
  return err(`Slack post failed after ${maxAttempts} attempts: ${lastErr}`);
}

function regressionRows(regressions: MetricRegression[]): string {
  return regressions
    .map((r) => {
      const pct =
        r.deltaPct !== null ? `${r.deltaPct.toFixed(1)}%` : r.deltaAbsolute !== null ? String(r.deltaAbsolute) : '—';
      return `• *${metricLabel(r.metric)}*: ${r.baselineValue ?? '—'} → ${r.currentValue ?? '—'} (${pct})`;
    })
    .join('\n');
}

/**
 * Sends a Slack Block Kit message for a performance regression.
 */
export async function sendRegressionAlert(
  report: RegressionReport,
  page: PageConfig,
  runId: string,
  options: {
    lcpElementSelector?: string | null;
    deploySha?: string | null;
    grafanaUrl?: string;
    rawReportUrl?: string;
    jiraTicketUrl?: string | null;
  } = {}
): Promise<Result<void>> {
  const mainUrl = process.env.SLACK_WEBHOOK_URL_PERF_ALERTS ?? process.env.SLACK_WEBHOOK_URL;
  const logUrl = process.env.SLACK_WEBHOOK_URL_PERF_LOG ?? process.env.SLACK_WEBHOOK_URL;

  if (!report.hasRegression) {
    return ok(undefined);
  }

  const emoji = severityEmoji(report.severity);
  const header = `${emoji} *${page.name}* — performance regression (${report.severity})`;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: header, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Run ID:* \`${runId}\`\n${regressionRows(report.regressions)}`,
      },
    },
  ];

  if (options.lcpElementSelector) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*LCP element:* \`${options.lcpElementSelector}\``,
      },
    });
  }

  const links: string[] = [];
  if (options.grafanaUrl) {
    links.push(`<${options.grafanaUrl}|Grafana>`);
  }
  if (options.rawReportUrl) {
    links.push(`<${options.rawReportUrl}|Raw Lighthouse JSON>`);
  }
  if (options.jiraTicketUrl) {
    links.push(`<${options.jiraTicketUrl}|Jira>`);
  }
  if (links.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: links.join(' · ') },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Deploy: ${options.deploySha ?? 'n/a'} · ${new Date().toISOString()}`,
      },
    ],
  });

  const payload = { blocks, text: header };

  if (report.severity === 'HIGH' || report.severity === 'CRITICAL') {
    if (!mainUrl) {
      return err('SLACK_WEBHOOK_URL (or PERF_ALERTS) not set');
    }
    return postWithRetry(mainUrl, payload);
  }

  if (report.severity === 'MEDIUM') {
    if (!logUrl) {
      logger.warn('Slack MEDIUM regression but no webhook; logging only', { page: page.slug });
      return ok(undefined);
    }
    return postWithRetry(logUrl, payload);
  }

  logger.info('LOW severity regression — file log only', { page: page.slug, runId });
  return ok(undefined);
}
