/**
 * utils/sitemap-loader.ts
 *
 * Loads URLs from a sitemap index (2-level) or a plain sitemap XML.
 * Supports local file paths and remote http/https URLs.
 *
 * Flow:
 *   1. Fetch/read the root sitemap
 *   2. If it's a <sitemapindex>, fetch each child sitemap in parallel
 *   3. Extract all <loc> URLs from child sitemaps
 *   4. Classify each URL by page type (via regex patterns)
 *   5. Fisher-Yates shuffle + sample N per type (or return all)
 *   6. Convert to PageConfig[] for the orchestrator
 */

import * as fs from 'fs/promises';
import { logger } from './logger.js';
import type { PageConfig } from '../config/pages.js';

// ── URL classification ────────────────────────────────────────────────────────

interface PageTypeRule {
  type: string;
  pattern: RegExp;
}

/**
 * Rules applied in order — first match wins.
 * Tune these patterns to match IndiaMart's URL structure.
 */
const PAGE_TYPE_RULES: PageTypeRule[] = [
  { type: 'homepage',  pattern: /^https?:\/\/[^/]+\/?$/ },
  { type: 'search',    pattern: /\/search\.mp|\/search\//i },
  { type: 'product',   pattern: /\/proddetail\//i },
  { type: 'category',  pattern: /\/[a-z][a-z0-9-]+-\d{4}\.html/i },
  { type: 'supplier',  pattern: /\/companyname\/|\/[a-z0-9-]+\/?$/ },
];
const FALLBACK_TYPE = 'other';

function classifyUrl(url: string): string {
  for (const rule of PAGE_TYPE_RULES) {
    if (rule.pattern.test(url)) return rule.type;
  }
  return FALLBACK_TYPE;
}

// ── XML helpers (no external dependency) ─────────────────────────────────────

/** Extract all <loc>…</loc> values from XML text. */
function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*(https?:\/\/[^\s<]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

/** Returns true if this XML is a <sitemapindex> (not a <urlset>). */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

// ── Fetch / read ──────────────────────────────────────────────────────────────

async function fetchXml(source: string): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source, {
      headers: { 'User-Agent': 'IndiaMart-PerfSuite/1.0 sitemap-loader' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${source}`);
    }
    return res.text();
  }
  // Local file
  return fs.readFile(source, 'utf8');
}

// ── Sampling ──────────────────────────────────────────────────────────────────

/** In-place Fisher-Yates shuffle, then slice. */
function sample<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return n >= a.length ? a : a.slice(0, n);
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface SitemapLoadOptions {
  /** Path to a local XML file, or a remote http/https URL. */
  source: string;
  /**
   * Number of URLs to sample per page-type bucket.
   * Pass 'all' to skip sampling and return every URL.
   */
  samplePerType: number | 'all';
  /**
   * Only include these page types. Leave empty to include all types.
   * e.g. ['product', 'category']
   */
  includeTypes?: string[];
  /**
   * Max number of child sitemaps to fetch from a sitemap index.
   * Shuffled randomly before capping so sampling is representative.
   * Pass 'all' to fetch every child sitemap (can be very slow for large indexes).
   * Default: 20
   */
  maxChildSitemaps?: number | 'all';
}

export interface SitemapLoadResult {
  /** PageConfig[] ready to feed into the orchestrator. */
  pages: PageConfig[];
  /** Per-type counts before sampling (for the preview script). */
  typeCounts: Record<string, { total: number; sampled: number }>;
  /** Total child sitemaps fetched. */
  childSitemapCount: number;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function loadFromSitemap(
  opts: SitemapLoadOptions
): Promise<SitemapLoadResult> {
  const { source, samplePerType, includeTypes = [] } = opts;

  logger.info('sitemap-loader: fetching root', { source });
  const rootXml = await fetchXml(source);

  // Collect all page URLs from child sitemaps (or directly if plain sitemap)
  let allUrls: string[] = [];
  let childSitemapCount = 0;

  if (isSitemapIndex(rootXml)) {
    const allChildUrls = extractLocs(rootXml);
    childSitemapCount = allChildUrls.length;
    logger.info(`sitemap-loader: index found — ${childSitemapCount} child sitemaps`);

    // Cap how many child sitemaps we fetch (shuffle first for representative sampling)
    const maxChild = opts.maxChildSitemaps ?? 20;
    let childUrlsToFetch: string[];
    if (maxChild === 'all') {
      childUrlsToFetch = allChildUrls;
    } else if (maxChild >= allChildUrls.length) {
      childUrlsToFetch = allChildUrls;
    } else {
      // Shuffle the child sitemap list so we sample across the index
      childUrlsToFetch = sample(allChildUrls, maxChild);
      logger.info(
        `sitemap-loader: capping to ${maxChild} of ${childSitemapCount} child sitemaps (shuffle-sampled). Pass maxChildSitemaps='all' to fetch all.`
      );
    }

    // Fetch capped child sitemaps in parallel batches
    const CONCURRENCY = 5;
    for (let i = 0; i < childUrlsToFetch.length; i += CONCURRENCY) {
      const batch = childUrlsToFetch.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(fetchXml));
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        if (r.status === 'fulfilled') {
          allUrls.push(...extractLocs(r.value));
        } else {
          logger.warn(`sitemap-loader: failed to fetch child sitemap: ${batch[j]}`, {
            error: r.reason,
          });
        }
      }
      logger.info(
        `sitemap-loader: fetched ${Math.min(i + CONCURRENCY, childUrlsToFetch.length)}/${childUrlsToFetch.length} child sitemaps`
      );
    }
  } else {
    // Plain <urlset> sitemap
    childSitemapCount = 1;
    allUrls = extractLocs(rootXml);
  }

  logger.info(`sitemap-loader: ${allUrls.length} total URLs extracted`);

  // Classify into buckets
  const buckets: Record<string, string[]> = {};
  for (const url of allUrls) {
    const type = classifyUrl(url);
    if (!buckets[type]) buckets[type] = [];
    buckets[type].push(url);
  }

  // Build result
  const typeCounts: SitemapLoadResult['typeCounts'] = {};
  const pages: PageConfig[] = [];
  let idx = 0;

  for (const [type, urls] of Object.entries(buckets)) {
    if (includeTypes.length > 0 && !includeTypes.includes(type)) {
      continue;
    }
    const sampled =
      samplePerType === 'all' ? urls : sample(urls, samplePerType);
    typeCounts[type] = { total: urls.length, sampled: sampled.length };

    for (const url of sampled) {
      idx++;
      pages.push({
        slug: `${type}-${idx}`,
        url,
        name: `${capitalize(type)} #${idx}`,
      });
    }
  }

  logger.info(`sitemap-loader: ${pages.length} pages selected for testing`, {
    typeCounts,
  });

  return { pages, typeCounts, childSitemapCount };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
