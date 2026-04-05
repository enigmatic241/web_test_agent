/**
 * scripts/sitemap-preview.ts
 *
 * Dry-run utility: shows what URLs would be sampled from a sitemap
 * WITHOUT launching any browser or running Lighthouse.
 *
 * Usage:
 *   npm run sitemap:preview -- --sitemap https://www.indiamart.com/company/fcp-sitemap-ssl.xml
 *   npm run sitemap:preview -- --sitemap ./my-sitemap.xml --sample 10
 *   npm run sitemap:preview -- --sitemap ./my-sitemap.xml --sample all --types product,category
 */

import '../utils/load-env.js';
import { loadFromSitemap } from '../utils/sitemap-loader.js';
import { logger } from '../utils/logger.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseArgs() {
  const source = getArg('--sitemap');
  if (!source) {
    console.error('Usage: npm run sitemap:preview -- --sitemap <url-or-file> [--sample <N|all>] [--max-sitemaps <N|all>] [--types <type1,type2>]');
    process.exit(1);
  }

  const sampleArg = getArg('--sample') ?? '15';
  const samplePerType: number | 'all' =
    sampleArg === 'all' ? 'all' : Math.max(1, parseInt(sampleArg, 10));

  const maxArg = getArg('--max-sitemaps') ?? '20';
  const maxChildSitemaps: number | 'all' =
    maxArg === 'all' ? 'all' : Math.max(1, parseInt(maxArg, 10));

  const typesArg = getArg('--types');
  const includeTypes = typesArg ? typesArg.split(',').map((t) => t.trim()) : [];

  return { source, samplePerType, maxChildSitemaps, includeTypes };
}

// ── Pretty table printer ──────────────────────────────────────────────────────

const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW= '\x1b[33m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';

function printTable(
  typeCounts: Record<string, { total: number; sampled: number }>,
  pages: Array<{ slug: string; url: string; name: string }>,
  opts: { source: string; samplePerType: number | 'all'; childSitemapCount: number; maxChildSitemaps: number | 'all' }
): void {
  const totalUrls = Object.values(typeCounts).reduce((s, v) => s + v.total, 0);

  console.log(`\n${BOLD}${CYAN}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  IndiaMart Perf Suite — Sitemap Preview${RESET}`);
  console.log(`${CYAN}══════════════════════════════════════════════════════${RESET}`);
  console.log(`  ${DIM}Source         :${RESET} ${opts.source}`);
  console.log(`  ${DIM}Child sitemaps :${RESET} ${opts.childSitemapCount} total, fetched ${opts.maxChildSitemaps === 'all' ? 'all' : opts.maxChildSitemaps}`);
  console.log(`  ${DIM}URLs in sample :${RESET} ${totalUrls}`);
  console.log(`  ${DIM}Sample/type    :${RESET} ${opts.samplePerType}`);
  console.log(`  ${DIM}Will test      :${RESET} ${pages.length} pages\n`);

  // Type breakdown table
  console.log(`${BOLD}  Page Type Breakdown:${RESET}`);
  console.log(`  ${'Type'.padEnd(14)} ${'Total'.padStart(8)} ${'Sampled'.padStart(9)}`);
  console.log(`  ${'-'.repeat(33)}`);
  for (const [type, counts] of Object.entries(typeCounts)) {
    const pct = ((counts.sampled / counts.total) * 100).toFixed(0);
    console.log(
      `  ${CYAN}${type.padEnd(14)}${RESET}` +
      ` ${String(counts.total).padStart(8)}` +
      ` ${GREEN}${String(counts.sampled).padStart(9)}${RESET}` +
      ` ${DIM}(${pct}%)${RESET}`
    );
  }

  // Sample of URLs that will be tested
  console.log(`\n${BOLD}  URLs that will be tested (first 20 shown):${RESET}`);
  const preview = pages.slice(0, 20);
  for (const p of preview) {
    console.log(`  ${DIM}[${p.slug}]${RESET} ${p.url}`);
  }
  if (pages.length > 20) {
    console.log(`  ${DIM}… and ${pages.length - 20} more${RESET}`);
  }

  // Cost estimate
  const lighthousePerPage = 3; // median runs
  const approxSecondsPerPage = 45;
  const totalSecs = pages.length * approxSecondsPerPage;
  const mins = Math.ceil(totalSecs / 60);
  console.log(`\n${BOLD}  Estimated Runtime (Phase 1, sequential):${RESET}`);
  console.log(`  ${YELLOW}~${mins} minutes${RESET} (${pages.length} pages × ${lighthousePerPage} Lighthouse runs × ~${approxSecondsPerPage}s)`);

  if (pages.length > 50) {
    console.log(`\n  ${YELLOW}⚠  Large run — consider --sample 10 or --types product,category to reduce scope.${RESET}`);
  }

  console.log(`\n${CYAN}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  To run these pages:${RESET}`);
  console.log(`  ${GREEN}RUN_PHASE=1 npm run test:perf -- --sitemap ${opts.source} --sample ${opts.samplePerType}${RESET}`);
  console.log(`${CYAN}══════════════════════════════════════════════════════${RESET}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  logger.info('sitemap-preview: loading sitemap…');

  const result = await loadFromSitemap(args);

  printTable(result.typeCounts, result.pages, {
    source: args.source,
    samplePerType: args.samplePerType,
    childSitemapCount: result.childSitemapCount,
    maxChildSitemaps: args.maxChildSitemaps,
  });
}

main().catch((e) => {
  logger.error('sitemap-preview failed', {
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
