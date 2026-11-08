import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UnsafeTargetError, assertSafeUrl, isPrivateAddress, safeRequest } from './safeRequest';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111'])(
    'allows %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('assertSafeUrl', () => {
  it('rejects non-http schemes, credentials and garbage', () => {
    expect(() => assertSafeUrl('file:///etc/passwd', false)).toThrow(UnsafeTargetError);
    expect(() => assertSafeUrl('gopher://x', false)).toThrow(UnsafeTargetError);
    expect(() => assertSafeUrl('http://user:pw@example.com', false)).toThrow(/credentials/);
    expect(() => assertSafeUrl('not a url', false)).toThrow(UnsafeTargetError);
  });

  it('rejects private literals and localhost when the guard is on', () => {
    for (const u of ['http://127.0.0.1/', 'http://localhost:3000', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://10.0.0.5/x', 'http://foo.localhost/']) {
      expect(() => assertSafeUrl(u, false), u).toThrow(UnsafeTargetError);
    }
  });

  it('allows public hosts, and private ones when explicitly enabled', () => {
    expect(() => assertSafeUrl('https://example.com/hook', false)).not.toThrow();
    expect(() => assertSafeUrl('http://127.0.0.1:9000/', true)).not.toThrow();
  });
});

describe('safeRequest', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      } else if (req.url === '/big') {
        res.end('x'.repeat(500_000));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2000);
      } else {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => res.end(JSON.stringify({ method: req.method, body, sig: req.headers['x-test'] })));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('blocks loopback targets by default', async () => {
    await expect(safeRequest(`${base}/`, { allowPrivate: false })).rejects.toBeInstanceOf(UnsafeTargetError);
  });

  describe('DNS rebinding / private resolution', () => {
    const realLookup = dns.lookup;
    afterEach(() => {
      (dns as any).lookup = realLookup;
    });
    const fakeDns = (answers: Array<{ address: string; family: number }>) => {
      (dns as any).lookup = (_h: string, opts: any, cb: any) =>
        opts?.all ? cb(null, answers) : cb(null, answers[0].address, answers[0].family);
    };

    it('blocks a public-looking hostname that resolves to a private address', async () => {
      fakeDns([{ address: '10.0.0.9', family: 4 }]);
      await expect(safeRequest('http://totally-public.example/hook', { allowPrivate: false })).rejects.toThrow(/private address \(10\.0\.0\.9\)/);
    });

    it('blocks when ANY answer is private (mixed A records)', async () => {
      fakeDns([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
      await expect(safeRequest('http://mixed.example/', { allowPrivate: false })).rejects.toBeInstanceOf(UnsafeTargetError);
    });

    it('connects when the hostname resolves to loopback and private targets are allowed', async () => {
      fakeDns([{ address: '127.0.0.1', family: 4 }]);
      const port = new URL(base).port;
      const res = await safeRequest(`http://allowed.example:${port}/echo`, { allowPrivate: true });
      expect(res.status).toBe(200);
    });
  });

  it('sends method, body and headers when allowed', async () => {
    const res = await safeRequest(`${base}/echo`, { allowPrivate: true, method: 'POST', body: 'hi', headers: { 'x-test': 'abc' } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ method: 'POST', body: 'hi', sig: 'abc' });
  });

  it('does not follow redirects', async () => {
    const res = await safeRequest(`${base}/redirect`, { allowPrivate: true });
    expect(res.status).toBe(302);
  });

  it('caps response size', async () => {
    const res = await safeRequest(`${base}/big`, { allowPrivate: true, maxBytes: 1024 });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(1024);
  });

  it('times out slow responses', async () => {
    await expect(safeRequest(`${base}/slow`, { allowPrivate: true, timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });
});
