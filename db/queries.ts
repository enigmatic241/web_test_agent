import type { PoolClient } from 'pg';
import { getPool } from './pool.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';
import { THRESHOLDS } from '../config/thresholds.js';

/** Severity for regressions and alerts */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface VitalsMeasurement {
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
  rawJson: unknown | null;
}

export interface BaselineStats {
  pageSlug: string;
  hasData: boolean;
  lcpMedian: number | null;
  clsMedian: number | null;
  inpMedian: number | null;
  fcpMedian: number | null;
  ttfbMedian: number | null;
  tbtMedian: number | null;
  speedIndexMedian: number | null;
  lighthousePerformanceMedian: number | null;
}

export interface RunRow {
  runId: string;
  triggeredAt: Date;
  triggerType: 'deploy' | 'scheduled' | 'manual';
  deploySha: string | null;
  status: string;
  completedAt: Date | null;
}

export interface MetricDelta {
  pageSlug: string;
  currentRunId: string;
  previousRunId: string | null;
  metrics: Record<
    string,
    { before: number | null; after: number | null; deltaPct: number | null }
  >;
}

export interface MetricRegression {
  metric: string;
  currentValue: number | null;
  baselineValue: number | null;
  deltaPct: number | null;
  deltaAbsolute: number | null;
  severity: Severity;
}

export interface RegressionReport {
  hasRegression: boolean;
  regressions: MetricRegression[];
  severity: Severity;
  isFirstRun: boolean;
}

const METRIC_KEYS = [
  'lcpMs',
  'clsScore',
  'inpMs',
  'fcpMs',
  'ttfbMs',
  'tbtMs',
  'speedIndex',
  'lighthousePerformanceScore',
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

function severityFromRules(params: {
  metric: string;
  current: number | null;
  network: string;
}): Severity {
  const { metric, current, network } = params;
  if (current === null) {
    return 'LOW';
  }
  if (metric === 'lcpMs') {
    const s = current / 1000;
    if (network === '4G' && s > 4) {
      return 'CRITICAL';
    }
    if (s > 4) {
      return 'CRITICAL';
    }
    if (s >= 2.5 && s <= 4) {
      return 'HIGH';
    }
  }
  if (metric === 'clsScore') {
    if (current > 0.25) {
      return 'CRITICAL';
    }
    if (current >= 0.1) {
      return 'HIGH';
    }
  }
  if (metric === 'lighthousePerformanceScore') {
    if (current < 50) {
      return 'CRITICAL';
    }
    if (current < 70) {
      return 'HIGH';
    }
  }
  return 'LOW';
}

/**
 * Compare current measurement to 7-day baseline medians and apply project thresholds.
 */
export function detectRegression(
  current: VitalsMeasurement,
  baseline: BaselineStats
): RegressionReport {
  if (!baseline.hasData) {
    return {
      hasRegression: false,
      regressions: [],
      severity: 'LOW',
      isFirstRun: true,
    };
  }

  const regressions: MetricRegression[] = [];

  const check = (
    key: MetricKey,
    threshold:
      | { kind: 'pct'; value: number }
      | { kind: 'abs'; value: number }
      | { kind: 'points'; value: number }
  ): void => {
    const cur = current[key];
    const base =
      key === 'lcpMs'
        ? baseline.lcpMedian
        : key === 'clsScore'
          ? baseline.clsMedian
          : key === 'inpMs'
            ? baseline.inpMedian
            : key === 'fcpMs'
              ? baseline.fcpMedian
              : key === 'ttfbMs'
                ? baseline.ttfbMedian
                : key === 'tbtMs'
                  ? baseline.tbtMedian
                  : key === 'speedIndex'
                    ? baseline.speedIndexMedian
                    : baseline.lighthousePerformanceMedian;

    if (cur === null || base === null) {
      return;
    }

    let fires = false;
    let deltaPct: number | null = null;
    let deltaAbsolute: number | null = null;

    if (threshold.kind === 'pct') {
      if (base === 0) {
        return;
      }
      deltaPct = ((cur - base) / Math.abs(base)) * 100;
      fires = deltaPct > threshold.value;
    } else if (threshold.kind === 'abs') {
      deltaAbsolute = cur - base;
      fires = deltaAbsolute > threshold.value;
    } else {
      deltaAbsolute = base - cur;
      fires = cur < base - threshold.value;
      deltaPct = base !== 0 ? ((cur - base) / Math.abs(base)) * 100 : null;
    }

    if (!fires) {
      return;
    }

    const sev = severityFromRules({
      metric: key,
      current: cur,
      network: current.network,
    });

    regressions.push({
      metric: key,
      currentValue: cur,
      baselineValue: base,
      deltaPct,
      deltaAbsolute,
      severity: sev,
    });
  };

  check('lcpMs', { kind: 'pct', value: THRESHOLDS.lcpRegressionPct });
  check('clsScore', { kind: 'abs', value: THRESHOLDS.clsAbsoluteIncrease });
  check('inpMs', { kind: 'pct', value: THRESHOLDS.inpRegressionPct });
  check('tbtMs', { kind: 'pct', value: THRESHOLDS.tbtRegressionPct });
  check('lighthousePerformanceScore', { kind: 'points', value: THRESHOLDS.lighthouseScoreDrop });

  const severityOrder: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  let maxSev: Severity = 'LOW';
  for (const r of regressions) {
    if (severityOrder.indexOf(r.severity) > severityOrder.indexOf(maxSev)) {
      maxSev = r.severity;
    }
  }

  return {
    hasRegression: regressions.length > 0,
    regressions,
    severity: maxSev,
    isFirstRun: false,
  };
}

/**
 * Insert a vitals row for a completed agent run.
 */
export async function insertMeasurement(data: VitalsMeasurement): Promise<Result<void>> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO vitals_measurements (
        page_slug, network, run_id,
        lcp_ms, cls_score, inp_ms, fcp_ms, ttfb_ms, tbt_ms, speed_index,
        lighthouse_performance_score, lighthouse_accessibility_score,
        lcp_element_selector, raw_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [
        data.pageSlug,
        data.network,
        data.runId,
        data.lcpMs,
        data.clsScore,
        data.inpMs,
        data.fcpMs,
        data.ttfbMs,
        data.tbtMs,
        data.speedIndex,
        data.lighthousePerformanceScore,
        data.lighthouseAccessibilityScore,
        data.lcpElementSelector,
        data.rawJson === null || data.rawJson === undefined
          ? null
          : JSON.stringify(data.rawJson),
      ]
    );
    return ok(undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { data });
  }
}

/**
 * Median metrics for a page over the last `days` days (4G network by default).
 */
export async function getBaseline(
  pageSlug: string,
  days: number,
  network = '4G'
): Promise<Result<BaselineStats>> {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lcp_ms) AS lcp_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY cls_score) AS cls_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY inp_ms) AS inp_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY fcp_ms) AS fcp_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfb_ms) AS ttfb_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY tbt_ms) AS tbt_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY speed_index) AS si_median,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lighthouse_performance_score) AS lh_median,
        COUNT(*)::int AS cnt
      FROM vitals_measurements
      WHERE page_slug = $1
        AND network = $2
        AND measured_at >= NOW() - ($3::int * INTERVAL '1 day')`,
      [pageSlug, network, String(days)]
    );
    const row = res.rows[0] as {
      lcp_median: number | null;
      cls_median: number | null;
      inp_median: number | null;
      fcp_median: number | null;
      ttfb_median: number | null;
      tbt_median: number | null;
      si_median: number | null;
      lh_median: number | null;
      cnt: number;
    };
    const hasData = row.cnt > 0;
    return ok({
      pageSlug,
      hasData,
      lcpMedian: row.lcp_median,
      clsMedian: row.cls_median,
      inpMedian: row.inp_median,
      fcpMedian: row.fcp_median,
      ttfbMedian: row.ttfb_median,
      tbtMedian: row.tbt_median,
      speedIndexMedian: row.si_median,
      lighthousePerformanceMedian: row.lh_median,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { pageSlug, days });
  }
}

export async function getRecentRuns(limit: number): Promise<Result<RunRow[]>> {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT run_id, triggered_at, trigger_type, deploy_sha, status, completed_at
       FROM runs
       ORDER BY triggered_at DESC
       LIMIT $1`,
      [limit]
    );
    const rows: RunRow[] = res.rows.map((r) => ({
      runId: r.run_id as string,
      triggeredAt: r.triggered_at as Date,
      triggerType: r.trigger_type as RunRow['triggerType'],
      deploySha: r.deploy_sha as string | null,
      status: r.status as string,
      completedAt: r.completed_at as Date | null,
    }));
    return ok(rows);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { limit });
  }
}

/**
 * Before/after style delta vs the most recent prior measurement for the same page + network.
 */
export async function getDelta(
  pageSlug: string,
  currentRunId: string,
  network = '4G'
): Promise<Result<MetricDelta>> {
  try {
    const pool = getPool();
    const prev = await pool.query(
      `SELECT run_id, lcp_ms, cls_score, inp_ms, fcp_ms, ttfb_ms, tbt_ms, speed_index,
              lighthouse_performance_score
       FROM vitals_measurements
       WHERE page_slug = $1 AND network = $2 AND run_id <> $3::uuid
       ORDER BY measured_at DESC
       LIMIT 1`,
      [pageSlug, network, currentRunId]
    );
    const cur = await pool.query(
      `SELECT run_id, lcp_ms, cls_score, inp_ms, fcp_ms, ttfb_ms, tbt_ms, speed_index,
              lighthouse_performance_score
       FROM vitals_measurements
       WHERE page_slug = $1 AND network = $2 AND run_id = $3::uuid
       ORDER BY measured_at DESC
       LIMIT 1`,
      [pageSlug, network, currentRunId]
    );

    const beforeRow = prev.rows[0] as Record<string, unknown> | undefined;
    const afterRow = cur.rows[0] as Record<string, unknown> | undefined;

    const metrics: MetricDelta['metrics'] = {};

    const keys = [
      ['lcpMs', 'lcp_ms'],
      ['clsScore', 'cls_score'],
      ['inpMs', 'inp_ms'],
      ['fcpMs', 'fcp_ms'],
      ['ttfbMs', 'ttfb_ms'],
      ['tbtMs', 'tbt_ms'],
      ['speedIndex', 'speed_index'],
      ['lighthousePerformanceScore', 'lighthouse_performance_score'],
    ] as const;

    for (const [outKey, col] of keys) {
      const b = beforeRow ? (beforeRow[col] as number | null) : null;
      const a = afterRow ? (afterRow[col] as number | null) : null;
      let deltaPct: number | null = null;
      if (b !== null && a !== null && b !== 0) {
        deltaPct = ((a - b) / Math.abs(b)) * 100;
      }
      metrics[outKey] = { before: b, after: a, deltaPct };
    }

    return ok({
      pageSlug,
      currentRunId,
      previousRunId: beforeRow ? (beforeRow.run_id as string) : null,
      metrics,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message, { pageSlug, currentRunId });
  }
}

export async function insertRun(
  client: PoolClient,
  row: {
    runId: string;
    triggerType: RunRow['triggerType'];
    deploySha: string | null;
    status: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO runs (run_id, trigger_type, deploy_sha, status)
     VALUES ($1::uuid, $2, $3, $4)`,
    [row.runId, row.triggerType, row.deploySha, row.status]
  );
}

export async function updateRunStatus(
  client: PoolClient,
  runId: string,
  status: string,
  completedAt: Date | null
): Promise<void> {
  await client.query(
    `UPDATE runs SET status = $2, completed_at = $3 WHERE run_id = $1::uuid`,
    [runId, status, completedAt]
  );
}
