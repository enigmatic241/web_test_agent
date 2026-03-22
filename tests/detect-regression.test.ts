import { describe, it, expect } from 'vitest';
import { detectRegression } from '../db/queries.js';
import type { VitalsMeasurement, BaselineStats } from '../db/queries.js';

describe('detectRegression', () => {
  it('returns no regression on first baseline', () => {
    const current: VitalsMeasurement = {
      pageSlug: 'homepage',
      network: '4G',
      runId: '00000000-0000-4000-8000-000000000001',
      lcpMs: 2000,
      clsScore: 0.05,
      inpMs: 100,
      fcpMs: 1000,
      ttfbMs: 200,
      tbtMs: 100,
      speedIndex: 3000,
      lighthousePerformanceScore: 90,
      lighthouseAccessibilityScore: 90,
      lcpElementSelector: 'div',
      rawJson: null,
    };
    const baseline: BaselineStats = {
      pageSlug: 'homepage',
      hasData: false,
      lcpMedian: null,
      clsMedian: null,
      inpMedian: null,
      fcpMedian: null,
      ttfbMedian: null,
      tbtMedian: null,
      speedIndexMedian: null,
      lighthousePerformanceMedian: null,
    };
    const r = detectRegression(current, baseline);
    expect(r.isFirstRun).toBe(true);
    expect(r.hasRegression).toBe(false);
  });

  it('flags LCP regression above threshold', () => {
    const current: VitalsMeasurement = {
      pageSlug: 'homepage',
      network: '4G',
      runId: '00000000-0000-4000-8000-000000000002',
      lcpMs: 3000,
      clsScore: 0.05,
      inpMs: 100,
      fcpMs: 1000,
      ttfbMs: 200,
      tbtMs: 100,
      speedIndex: 3000,
      lighthousePerformanceScore: 90,
      lighthouseAccessibilityScore: 90,
      lcpElementSelector: null,
      rawJson: null,
    };
    const baseline: BaselineStats = {
      pageSlug: 'homepage',
      hasData: true,
      lcpMedian: 2000,
      clsMedian: 0.05,
      inpMedian: 100,
      fcpMedian: 1000,
      ttfbMedian: 200,
      tbtMedian: 100,
      speedIndexMedian: 3000,
      lighthousePerformanceMedian: 90,
    };
    const r = detectRegression(current, baseline);
    expect(r.hasRegression).toBe(true);
    expect(r.regressions.some((x) => x.metric === 'lcpMs')).toBe(true);
  });
});
