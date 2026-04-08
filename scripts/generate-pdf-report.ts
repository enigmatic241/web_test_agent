/**
 * scripts/generate-pdf-report.ts
 *
 * Reads Lighthouse JSON files from raw-reports/{run-id}/
 * and produces a polished PDF performance report using Playwright.
 *
 * Usage:
 *   npm run report:pdf                          # latest run
 *   npm run report:pdf -- --run-id <uuid>       # specific run
 *   npm run report:pdf -- --run-id <uuid> --out ./my-report.pdf
 *
 * Output: reports/{run-id}/performance-report.pdf
 */

import '../utils/load-env.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright';
import { logger } from '../utils/logger.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ── Lighthouse JSON extraction ────────────────────────────────────────────────

interface LHRAudit {
  numericValue?: number;
  score?: number | null;
  displayValue?: string;
}

interface LHR {
  finalDisplayedUrl?: string;
  requestedUrl?: string;
  fetchTime?: string;
  categories?: {
    performance?: { score: number | null };
    accessibility?: { score: number | null };
    'best-practices'?: { score: number | null };
    seo?: { score: number | null };
  };
  audits?: Record<string, LHRAudit>;
}

interface PageMetrics {
  slug: string;
  url: string;
  runNumber: number;
  fetchTime: string;
  perfScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  tbtMs: number | null;
  speedIndex: number | null;
}

function numVal(audits: Record<string, LHRAudit> | undefined, id: string): number | null {
  const v = audits?.[id]?.numericValue;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function score(audits: Record<string, LHRAudit> | undefined, id: string): number | null {
  const v = audits?.[id]?.score;
  return typeof v === 'number' ? Math.round(v * 100) : null;
}

function catScore(lhr: LHR, cat: string): number | null {
  const raw = (lhr.categories as Record<string, { score: number | null } | undefined>)?.[cat]?.score;
  return typeof raw === 'number' ? Math.round(raw * 100) : null;
}

function extractMetrics(slug: string, runNumber: number, lhr: LHR): PageMetrics {
  return {
    slug,
    url: lhr.finalDisplayedUrl ?? lhr.requestedUrl ?? '—',
    runNumber,
    fetchTime: lhr.fetchTime ? new Date(lhr.fetchTime).toLocaleString() : '—',
    perfScore: catScore(lhr, 'performance'),
    accessibilityScore: catScore(lhr, 'accessibility'),
    bestPracticesScore: catScore(lhr, 'best-practices'),
    seoScore: catScore(lhr, 'seo'),
    lcpMs: numVal(lhr.audits, 'largest-contentful-paint'),
    clsScore: numVal(lhr.audits, 'cumulative-layout-shift'),
    inpMs: numVal(lhr.audits, 'interaction-to-next-paint') ?? numVal(lhr.audits, 'experimental-interaction-to-next-paint'),
    fcpMs: numVal(lhr.audits, 'first-contentful-paint'),
    ttfbMs: numVal(lhr.audits, 'server-response-time'),
    tbtMs: numVal(lhr.audits, 'total-blocking-time'),
    speedIndex: numVal(lhr.audits, 'speed-index'),
  };
}

// ── Per-page median (across runs) ─────────────────────────────────────────────

interface MedianPageMetrics {
  slug: string;
  url: string;
  fetchTime: string;
  runs: number;
  perfScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  tbtMs: number | null;
  speedIndex: number | null;
}

function medianOf(nums: (number | null)[]): number | null {
  const clean = nums.filter((n): n is number => n !== null);
  if (!clean.length) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function aggregateRuns(runs: PageMetrics[]): MedianPageMetrics {
  const first = runs[0]!;
  return {
    slug: first.slug,
    url: first.url,
    fetchTime: first.fetchTime,
    runs: runs.length,
    perfScore: medianOf(runs.map(r => r.perfScore)),
    accessibilityScore: medianOf(runs.map(r => r.accessibilityScore)),
    bestPracticesScore: medianOf(runs.map(r => r.bestPracticesScore)),
    seoScore: medianOf(runs.map(r => r.seoScore)),
    lcpMs: medianOf(runs.map(r => r.lcpMs)),
    clsScore: medianOf(runs.map(r => r.clsScore)),
    inpMs: medianOf(runs.map(r => r.inpMs)),
    fcpMs: medianOf(runs.map(r => r.fcpMs)),
    ttfbMs: medianOf(runs.map(r => r.ttfbMs)),
    tbtMs: medianOf(runs.map(r => r.tbtMs)),
    speedIndex: medianOf(runs.map(r => r.speedIndex)),
  };
}

// ── HTML report generation ────────────────────────────────────────────────────

function scoreColor(score: number | null): string {
  if (score === null) return '#94a3b8';
  if (score >= 90) return '#22c55e';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

function metricStatus(metric: string, value: number | null): string {
  if (value === null) return 'na';
  if (metric === 'lcp') return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor';
  if (metric === 'cls') return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
  if (metric === 'inp') return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor';
  if (metric === 'fcp') return value <= 1800 ? 'good' : value <= 3000 ? 'needs-improvement' : 'poor';
  if (metric === 'ttfb') return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor';
  if (metric === 'tbt') return value <= 200 ? 'good' : value <= 600 ? 'needs-improvement' : 'poor';
  return 'na';
}

function fmt(value: number | null, unit: string, decimals = 0): string {
  if (value === null) return '—';
  return `${value.toFixed(decimals)}${unit}`;
}

function scoreGauge(score: number | null): string {
  const color = scoreColor(score);
  const display = score !== null ? String(score) : '—';
  return `<div class="gauge" style="--color:${color}">
    <svg viewBox="0 0 36 36"><path class="gauge-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" stroke-width="3"/>
    <path class="gauge-fill" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${score ?? 0}, 100" stroke-linecap="round"/></svg>
    <span>${display}</span></div>`;
}

function generateHtml(runId: string, pages: MedianPageMetrics[], generatedAt: string): string {
  const totalPages = pages.length;
  const avgPerf = medianOf(pages.map(p => p.perfScore));
  const goodLcp = pages.filter(p => metricStatus('lcp', p.lcpMs) === 'good').length;
  const goodCls = pages.filter(p => metricStatus('cls', p.clsScore) === 'good').length;

  const pageRows = pages.map(p => `
    <div class="page-card">
      <div class="page-header">
        <div class="page-info">
          <h2 class="page-slug">${p.slug}</h2>
          <a class="page-url" href="${p.url}">${p.url}</a>
          <span class="runs-badge">${p.runs} Lighthouse run${p.runs !== 1 ? 's' : ''} · median</span>
        </div>
        <div class="scores-row">
          <div class="score-item">${scoreGauge(p.perfScore)}<span class="score-label">Performance</span></div>
          <div class="score-item">${scoreGauge(p.accessibilityScore)}<span class="score-label">Accessibility</span></div>
          <div class="score-item">${scoreGauge(p.bestPracticesScore)}<span class="score-label">Best Practices</span></div>
          <div class="score-item">${scoreGauge(p.seoScore)}<span class="score-label">SEO</span></div>
        </div>
      </div>
      <table class="metrics-table">
        <thead><tr><th>Metric</th><th>Value</th><th>Threshold</th><th>Status</th></tr></thead>
        <tbody>
          <tr class="${metricStatus('lcp', p.lcpMs)}">
            <td><strong>LCP</strong> <span class="metric-desc">Largest Contentful Paint</span></td>
            <td class="metric-value">${fmt(p.lcpMs! / 1000, 's', 2)}</td>
            <td class="threshold">≤ 2.5s</td>
            <td><span class="badge badge-${metricStatus('lcp', p.lcpMs)}">${metricStatus('lcp', p.lcpMs).replace('-', ' ')}</span></td>
          </tr>
          <tr class="${metricStatus('cls', p.clsScore)}">
            <td><strong>CLS</strong> <span class="metric-desc">Cumulative Layout Shift</span></td>
            <td class="metric-value">${fmt(p.clsScore, '', 3)}</td>
            <td class="threshold">≤ 0.1</td>
            <td><span class="badge badge-${metricStatus('cls', p.clsScore)}">${metricStatus('cls', p.clsScore).replace('-', ' ')}</span></td>
          </tr>
          <tr class="${metricStatus('inp', p.inpMs)}">
            <td><strong>INP</strong> <span class="metric-desc">Interaction to Next Paint</span></td>
            <td class="metric-value">${fmt(p.inpMs, 'ms')}</td>
            <td class="threshold">≤ 200ms</td>
            <td><span class="badge badge-${metricStatus('inp', p.inpMs)}">${metricStatus('inp', p.inpMs).replace('-', ' ')}</span></td>
          </tr>
          <tr class="${metricStatus('fcp', p.fcpMs)}">
            <td><strong>FCP</strong> <span class="metric-desc">First Contentful Paint</span></td>
            <td class="metric-value">${fmt(p.fcpMs! / 1000, 's', 2)}</td>
            <td class="threshold">≤ 1.8s</td>
            <td><span class="badge badge-${metricStatus('fcp', p.fcpMs)}">${metricStatus('fcp', p.fcpMs).replace('-', ' ')}</span></td>
          </tr>
          <tr class="${metricStatus('ttfb', p.ttfbMs)}">
            <td><strong>TTFB</strong> <span class="metric-desc">Time to First Byte</span></td>
            <td class="metric-value">${fmt(p.ttfbMs, 'ms')}</td>
            <td class="threshold">≤ 800ms</td>
            <td><span class="badge badge-${metricStatus('ttfb', p.ttfbMs)}">${metricStatus('ttfb', p.ttfbMs).replace('-', ' ')}</span></td>
          </tr>
          <tr class="${metricStatus('tbt', p.tbtMs)}">
            <td><strong>TBT</strong> <span class="metric-desc">Total Blocking Time</span></td>
            <td class="metric-value">${fmt(p.tbtMs, 'ms')}</td>
            <td class="threshold">≤ 200ms</td>
            <td><span class="badge badge-${metricStatus('tbt', p.tbtMs)}">${metricStatus('tbt', p.tbtMs).replace('-', ' ')}</span></td>
          </tr>
          <tr class="na">
            <td><strong>Speed Index</strong> <span class="metric-desc">Visual load speed</span></td>
            <td class="metric-value">${fmt(p.speedIndex! / 1000, 's', 2)}</td>
            <td class="threshold">≤ 3.4s</td>
            <td><span class="badge badge-na">info</span></td>
          </tr>
        </tbody>
      </table>
    </div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Performance Report — ${runId.slice(0, 8)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#f8fafc;color:#0f172a;font-size:13px;line-height:1.5}
  a{color:#3b82f6;text-decoration:none}

  /* Cover */
  .cover{background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);color:#fff;padding:48px 52px;display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0;page-break-after:always}
  .cover-left h1{font-size:26px;font-weight:700;letter-spacing:-0.5px;margin-bottom:6px}
  .cover-left .subtitle{color:#94a3b8;font-size:13px;margin-bottom:24px}
  .cover-meta{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .cover-meta-item{display:flex;gap:12px;font-size:12px}
  .cover-meta-item .label{color:#64748b;min-width:80px}
  .cover-meta-item .value{color:#e2e8f0;font-weight:500}
  .cover-right{text-align:right}
  .cover-score{font-size:56px;font-weight:700;color:#fff;line-height:1}
  .cover-score-label{color:#64748b;font-size:12px;margin-top:4px}

  /* Summary cards */
  .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 32px;background:#fff;border-bottom:1px solid #e2e8f0}
  .stat-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px}
  .stat-card .stat-value{font-size:28px;font-weight:700;color:#0f172a;line-height:1}
  .stat-card .stat-label{font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px}

  /* Page cards */
  .pages{padding:24px 32px;display:flex;flex-direction:column;gap:24px}
  .page-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;page-break-inside:avoid}
  .page-header{padding:20px 24px;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .page-info{flex:1;min-width:0}
  .page-slug{font-size:16px;font-weight:700;color:#1e293b;margin-bottom:2px}
  .page-url{font-size:11px;color:#64748b;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px}
  .runs-badge{font-size:10px;background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:99px}

  /* Score gauges */
  .scores-row{display:flex;gap:16px;flex-shrink:0}
  .score-item{display:flex;flex-direction:column;align-items:center;gap:4px}
  .score-label{font-size:9px;color:#94a3b8;text-align:center;white-space:nowrap}
  .gauge{position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center}
  .gauge svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
  .gauge span{position:relative;font-size:12px;font-weight:700;color:#0f172a}

  /* Metrics table */
  .metrics-table{width:100%;border-collapse:collapse}
  .metrics-table th{background:#f8fafc;color:#64748b;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:8px 16px;text-align:left;border-bottom:1px solid #e2e8f0}
  .metrics-table td{padding:10px 16px;border-bottom:1px solid #f8fafc;vertical-align:middle}
  .metrics-table tr:last-child td{border-bottom:none}
  .metrics-table tr:hover td{background:#fafafa}
  .metric-desc{color:#94a3b8;font-size:11px;font-weight:400;margin-left:6px}
  .metric-value{font-weight:600;font-size:14px;font-variant-numeric:tabular-nums}
  .threshold{color:#94a3b8;font-size:11px}

  /* Row highlight */
  .metrics-table tr.good td:first-child{border-left:3px solid #22c55e}
  .metrics-table tr.needs-improvement td:first-child{border-left:3px solid #f59e0b}
  .metrics-table tr.poor td:first-child{border-left:3px solid #ef4444}
  .metrics-table tr.na td:first-child{border-left:3px solid #e2e8f0}

  /* Badges */
  .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:600;text-transform:capitalize}
  .badge-good{background:#dcfce7;color:#166534}
  .badge-needs-improvement{background:#fef9c3;color:#854d0e}
  .badge-poor{background:#fee2e2;color:#991b1b}
  .badge-na{background:#f1f5f9;color:#64748b}

  /* Footer */
  .footer{padding:16px 32px;text-align:center;color:#94a3b8;font-size:10px;border-top:1px solid #e2e8f0;background:#fff;margin-top:8px}

  @media print{
    body{background:#fff}
    .cover{-webkit-print-color-adjust:exact;print-color-adjust:exact;color-adjust:exact}
    .badge,.gauge,.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style>
</head>
<body>

<!-- Cover page -->
<div class="cover">
  <div class="cover-left">
    <h1>Performance Report</h1>
    <p class="subtitle">IndiaMart Perf Suite · Lighthouse Audit</p>
    <div class="cover-meta">
      <div class="cover-meta-item"><span class="label">Run ID</span><span class="value">${runId}</span></div>
      <div class="cover-meta-item"><span class="label">Generated</span><span class="value">${generatedAt}</span></div>
      <div class="cover-meta-item"><span class="label">Pages</span><span class="value">${totalPages} page${totalPages !== 1 ? 's' : ''} audited</span></div>
      <div class="cover-meta-item"><span class="label">Method</span><span class="value">Lighthouse median of 3 runs</span></div>
    </div>
  </div>
  <div class="cover-right">
    <div class="cover-score">${avgPerf !== null ? avgPerf : '—'}</div>
    <div class="cover-score-label">Avg Performance Score</div>
  </div>
</div>

<!-- Summary stats -->
<div class="summary">
  <div class="stat-card">
    <div class="stat-value">${totalPages}</div>
    <div class="stat-label">Pages Audited</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" style="color:${scoreColor(avgPerf)}">${avgPerf ?? '—'}</div>
    <div class="stat-label">Avg Perf Score</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" style="color:${goodLcp === totalPages ? '#22c55e' : goodLcp > 0 ? '#f59e0b' : '#ef4444'}">${goodLcp}/${totalPages}</div>
    <div class="stat-label">Good LCP</div>
  </div>
  <div class="stat-card">
    <div class="stat-value" style="color:${goodCls === totalPages ? '#22c55e' : goodCls > 0 ? '#f59e0b' : '#ef4444'}">${goodCls}/${totalPages}</div>
    <div class="stat-label">Good CLS</div>
  </div>
</div>

<!-- Per-page detail cards -->
<div class="pages">
${pageRows}
</div>

<div class="footer">
  IndiaMart Perf Suite · Report generated ${generatedAt} · Run ID: ${runId}
</div>

</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function getLatestRunId(rawReportsDir: string): Promise<string> {
  const entries = await fs.readdir(rawReportsDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  if (!dirs.length) throw new Error('No runs found in raw-reports/');
  // Sort by creation time of the directory
  const withStats = await Promise.all(
    dirs.map(async (d) => ({ d, mtime: (await fs.stat(path.join(rawReportsDir, d))).mtime }))
  );
  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return withStats[0]!.d;
}

async function main(): Promise<void> {
  const rawReportsRoot = path.join(process.cwd(), 'raw-reports');
  const reportsRoot = path.join(process.cwd(), 'reports');

  let runId = getArg('--run-id');
  const customOut = getArg('--out');

  if (!runId) {
    runId = await getLatestRunId(rawReportsRoot);
    logger.info(`report:pdf: no --run-id given, using latest run: ${runId}`);
  }

  const runDir = path.join(rawReportsRoot, runId);
  const outDir = path.join(reportsRoot, runId);
  await fs.mkdir(outDir, { recursive: true });

  // Read all JSON files in this run
  const files = (await fs.readdir(runDir)).filter(f => f.endsWith('.json'));
  if (!files.length) {
    throw new Error(`No JSON files found in ${runDir}`);
  }

  logger.info(`report:pdf: reading ${files.length} JSON files from run ${runId}`);

  // Parse and extract metrics, group by slug
  const bySlug: Record<string, PageMetrics[]> = {};
  for (const file of files) {
    const json = await fs.readFile(path.join(runDir, file), 'utf8');
    // File naming: {slug}-{run-number}.json
    const match = file.match(/^(.+)-(\d+)\.json$/);
    if (!match) continue;
    const slug = match[1]!;
    const runNumber = parseInt(match[2]!, 10);
    const lhr = JSON.parse(json) as LHR;
    if (!bySlug[slug]) bySlug[slug] = [];
    bySlug[slug].push(extractMetrics(slug, runNumber, lhr));
  }

  // Aggregate to median per page
  const pages: MedianPageMetrics[] = Object.entries(bySlug).map(([, runs]) =>
    aggregateRuns(runs)
  );

  logger.info(`report:pdf: aggregated ${pages.length} pages, generating HTML…`);

  const generatedAt = new Date().toLocaleString('en-IN', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });

  const html = generateHtml(runId, pages, generatedAt);
  const htmlPath = path.join(outDir, 'performance-report.html');
  await fs.writeFile(htmlPath, html, 'utf8');

  // Launch Playwright and print to PDF
  logger.info('report:pdf: launching Playwright to render PDF…');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'networkidle' });

  const pdfPath = customOut ?? path.join(outDir, 'performance-report.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });

  await browser.close();

  logger.info(`report:pdf: PDF saved`, { path: pdfPath });

  console.log(`\n✔  PDF report generated:`);
  console.log(`   ${pdfPath}`);
  console.log(`   HTML copy: ${htmlPath}\n`);
}

main().catch((e) => {
  logger.error('report:pdf failed', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
