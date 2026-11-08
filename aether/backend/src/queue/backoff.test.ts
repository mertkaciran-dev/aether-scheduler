import { describe, expect, it } from 'vitest';
import type { RetryPolicy } from '../types';
import { computeBackoff } from './backoff';

const base: RetryPolicy = { attempts: 5, strategy: 'exponential', baseDelayMs: 1000, maxDelayMs: 30_000, jitter: false };

describe('computeBackoff', () => {
  it('doubles each attempt', () => {
    expect([1, 2, 3, 4].map((n) => computeBackoff(n, base))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoff(10, base)).toBe(30_000);
    expect(computeBackoff(1000, base)).toBe(30_000);
  });

  it('fixed strategy never grows', () => {
    const p = { ...base, strategy: 'fixed' as const };
    expect([1, 5, 9].map((n) => computeBackoff(n, p))).toEqual([1000, 1000, 1000]);
  });

  it('jitter stays within ±20% and never exceeds the cap', () => {
    const p = { ...base, jitter: true };
    expect(computeBackoff(3, p, () => 0)).toBe(3200);
    expect(computeBackoff(3, p, () => 1)).toBe(4800);
    for (let i = 0; i < 500; i++) {
      const v = computeBackoff(10, p);
      expect(v).toBeLessThanOrEqual(30_000);
      expect(v).toBeGreaterThanOrEqual(24_000);
    }
  });

  it('treats attempt < 1 as the first attempt', () => {
    expect(computeBackoff(0, base)).toBe(1000);
    expect(computeBackoff(-3, base)).toBe(1000);
  });
});
