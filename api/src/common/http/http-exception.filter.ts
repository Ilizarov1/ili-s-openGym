/* Maps every escaped error onto the legacy JSON shapes. */
import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { BusyError } from '../../../password.js';
import { MediaError } from '../../../media.js';
import { HttpError } from './http-error.js';
import { json } from './reply.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('api');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    const req = host.switchToHttp().getRequest<{ method?: string; url?: string }>();
    const key = `${req.method || ''} ${req.url || ''}`;

    if ((exception as { clientGone?: boolean })?.clientGone) {
      console.warn(key, 'client went away mid-body:', (exception as Error).message);
      return;
    }

    if (res.headersSent) return;

    if (exception instanceof HttpError) {
      json(res, exception.status, { error: exception.message, ...exception.extra }, exception.headers);
      return;
    }

    if (exception instanceof MediaError) {
      json(
        res,
        exception.status,
        { error: exception.message, code: exception.code, ...(exception.extra || {}) },
        exception.headers as Record<string, string>,
      );
      return;
    }

    if (exception instanceof BusyError) {
      json(
        res,
        503,
        { error: 'the server is busy, try again in a moment', code: 'busy' },
        { 'Retry-After': '2' },
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) {
        json(res, 404, { error: 'not found' });
        return;
      }
      const payload = exception.getResponse();
      if (payload && typeof payload === 'object' && 'error' in (payload as object)) {
        json(res, status, payload);
        return;
      }
      json(res, status, { error: (payload as string) || exception.message });
      return;
    }

    this.logger.error(key, exception instanceof Error ? exception.stack : String(exception));
    json(res, 500, { error: 'server error' });
  }
}
