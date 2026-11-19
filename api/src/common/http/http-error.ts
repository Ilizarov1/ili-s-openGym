/* A request the caller got wrong.
 *
 * Mirrors the private HttpError of the legacy entry: the global exception
 * filter answers it with `{ error: message }` and the status, never a 500.
 * `extra` adds business fields (code, retryAfter) and `headers` adds response
 * headers such as Retry-After.
 */
export interface HttpErrorOptions {
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  headers: Record<string, string>;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.status = status;
    this.extra = options.extra || {};
    this.headers = options.headers || {};
  }
}

export function badRequest(message = 'bad request'): never {
  throw new HttpError(400, message);
}
