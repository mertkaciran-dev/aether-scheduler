import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from '../config';

/**
 * Outbound HTTP used by webhooks and the `http.request` job type.
 *
 * Because users control the target URL, this is an SSRF surface. Defences:
 *  - only http(s), no embedded credentials
 *  - private / loopback / link-local / metadata addresses are blocked unless
 *    WEBHOOK_ALLOW_PRIVATE=true (checked on IP literals AND on every DNS answer at connect
 *    time, which also defeats DNS-rebinding)
 *  - redirects are never followed
 *  - response bodies are size-capped and every request has a hard timeout
 */

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
    return false;
  }
  if (!net.isIPv4(ip)) return true; // unknown format: be safe
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

/** Synchronous URL validation (shape + IP literal). Used at enqueue time and before each request. */
export function assertSafeUrl(raw: string, allowPrivate = config.allowPrivateTargets): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError('Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new UnsafeTargetError('URLs with embedded credentials are not allowed');
  }
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) {
      throw new UnsafeTargetError('Target address is private or reserved');
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      throw new UnsafeTargetError('Target host is not allowed');
    }
  }
  return url;
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
}

export async function safeRequest(rawUrl: string, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
  const allowPrivate = opts.allowPrivate ?? config.allowPrivateTargets;
  const url = assertSafeUrl(rawUrl, allowPrivate);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? config.webhookTimeoutMs;
  const started = Date.now();

  const lookup = (hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void): void => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (!allowPrivate) {
        const answers = Array.isArray(address) ? address : [{ address, family }];
        for (const a of answers) {
          if (isPrivateAddress(a.address)) {
            return callback(new UnsafeTargetError(`Target resolves to a private address (${a.address})`));
          }
        }
      }
      callback(null, address, family);
    });
  };

  return new Promise<SafeResponse>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        lookup: lookup as any,
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
            ),
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            durationMs: Date.now() - started,
          });
        res.on('end', done);
        res.on('close', () => (truncated ? done() : undefined));
        res.on('error', (e) => (truncated ? done() : reject(e)));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
