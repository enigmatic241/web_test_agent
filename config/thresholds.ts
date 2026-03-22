/**
 * Regression alert thresholds — align with .cursor/rules alerting section.
 * With 2+ weeks of p50/p75/p95 data, use PROMPT U-04 to tune false-positive rate.
 */
export const THRESHOLDS = {
  /** LCP: alert if regression vs 7-day median exceeds this % */
  lcpRegressionPct: 10,
  /** CLS: absolute increase vs baseline */
  clsAbsoluteIncrease: 0.05,
  /** INP: regression % vs baseline */
  inpRegressionPct: 15,
  /** TBT: regression % vs baseline */
  tbtRegressionPct: 20,
  /** Lighthouse performance score: point drop */
  lighthouseScoreDrop: 5,
  /** Jank: dropped frames % */
  jankDroppedFramesPct: 8,
} as const;
