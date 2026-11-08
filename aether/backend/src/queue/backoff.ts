import type { RetryPolicy } from '../types';

/**
 * Delay (ms) before retrying after the Nth failed attempt (1-based).
 *
 *   exponential: base * 2^(attempt-1), capped at maxDelayMs
 *   fixed:       base
 *
 * With jitter enabled the delay is multiplied by a factor in [0.8, 1.2] so that a burst of
 * jobs failing together (e.g. a downstream outage) does not retry in lock-step and
 * stampede the recovering dependency. The result is always clamped to maxDelayMs.
 */
export function computeBackoff(attempt: number, policy: RetryPolicy, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = policy.strategy === 'fixed' ? policy.baseDelayMs : policy.baseDelayMs * 2 ** (n - 1);
  const capped = Math.min(raw, policy.maxDelayMs);
  const jittered = policy.jitter ? capped * (0.8 + 0.4 * rand()) : capped;
  return Math.max(0, Math.min(Math.round(jittered), policy.maxDelayMs));
}
