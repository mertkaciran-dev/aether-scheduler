import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { config } from '../config';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Keys are stored as SHA-256 digests and compared in constant time. */
const digests = config.apiKeys.map(sha256);

export function verifyApiKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) return false;
  const candidate = sha256(key);
  let ok = false;
  for (const d of digests) {
    // Deliberately no early exit, so timing does not reveal which key matched.
    if (timingSafeEqual(d, candidate)) ok = true;
  }
  return ok;
}

export function extractApiKey(req: Request): string | undefined {
  const header = req.header('x-api-key');
  if (header) return header;
  const auth = req.header('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return undefined;
}

export const requireApiKey: RequestHandler = (req, res, next) => {
  if (verifyApiKey(extractApiKey(req))) return next();
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="aether"')
    .json({ error: { code: 'unauthorized', message: 'Missing or invalid API key. Send it as "X-API-Key" or "Authorization: Bearer <key>".' } });
};
