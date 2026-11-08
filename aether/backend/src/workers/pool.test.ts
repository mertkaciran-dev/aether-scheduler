import { afterAll, describe, expect, it } from 'vitest';
import { ThreadPool } from './pool';

describe('ThreadPool', () => {
  const pool = new ThreadPool(2);
  afterAll(() => pool.destroy());

  it('computes prime counts off the main thread', async () => {
    expect(await pool.run('primes', { limit: 100 })).toEqual({ count: 25, largest: 97 });
    expect(await pool.run('primes', { limit: 1_000_000 })).toEqual({ count: 78498, largest: 999983 });
  });

  it('runs more tasks than threads, in parallel', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => pool.run<{ count: number }>('primes', { limit: 200_000 })));
    expect(results.every((r) => r.count === 17984)).toBe(true);
  });

  it('rejects unknown tasks without killing the pool', async () => {
    await expect(pool.run('nope', {})).rejects.toThrow(/Unknown thread task/);
    expect((await pool.run<{ count: number }>('primes', { limit: 10 })).count).toBe(4);
  });

  it('terminates a runaway task on timeout and recovers', async () => {
    const t = Date.now();
    await expect(pool.run('primes', { limit: 2_000_000_000 }, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t).toBeLessThan(3000);
    expect((await pool.run<{ count: number }>('primes', { limit: 100 })).count).toBe(25);
  });

  it('honours AbortSignal', async () => {
    const ac = new AbortController();
    const p = pool.run('primes', { limit: 2_000_000_000 }, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error('cancelled')), 100);
    await expect(p).rejects.toThrow('cancelled');
  });
});
