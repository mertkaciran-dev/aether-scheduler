export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string, id?: string) =>
  new HttpError(404, 'not_found', id ? `${what} "${id}" not found` : `${what} not found`);

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);

export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Job timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}
