const KEY_STORAGE = 'aether.apiKey';

export function getStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function storeKey(key: string): void {
  try {
    key ? localStorage.setItem(KEY_STORAGE, key) : localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable: key lives in memory only */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let apiKey = getStoredKey();
let onUnauthorized: (() => void) | undefined;

export const setApiKey = (k: string) => (apiKey = k);
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(method: string, path: string, body?: unknown, keyOverride?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'x-api-key': keyOverride ?? apiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the Aether API');
  }
  if (res.status === 401 && keyOverride === undefined) onUnauthorized?.();
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = json?.error;
    const detail = Array.isArray(e?.details) && e.details[0]?.message ? ` — ${e.details[0].path ? e.details[0].path + ': ' : ''}${e.details[0].message}` : '';
    throw new ApiError(res.status, e?.code ?? 'error', `${e?.message ?? res.statusText}${detail}`, e?.details);
  }
  return json as T;
}
