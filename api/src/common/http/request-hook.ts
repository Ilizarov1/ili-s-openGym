/* Pre-routing request handling, equivalent to the head of the legacy
 * http.createServer callback.
 *
 * NodeAdapter accepts trailing slashes and maps HEAD onto GET; the legacy
 * table matched exactly, so both are answered 404 here. It also answers a
 * malformed target itself with its own body, so the URL checks run before the
 * router sees the request.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../../config/runtime-config.js';
import { bodyDeadline } from './body-timeout.js';
import { json } from './reply.js';

const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);

type HookRequest = IncomingMessage & { originalUrl?: string };
type Done = (err?: Error) => void;
type Hook = (req: HookRequest, res: ServerResponse, done: Done) => Promise<void> | void;

@Injectable()
export class RequestHook {
  private closing = false;
  private readonly active = new Set<ServerResponse>();
  private readonly idleWaiters: Array<() => void> = [];

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape) {}

  setClosing(): void {
    this.closing = true;
  }

  get isClosing(): boolean {
    return this.closing;
  }

  private track(res: ServerResponse): void {
    this.active.add(res);
    const finish = () => {
      if (this.active.delete(res) && !this.active.size) {
        for (const waiter of this.idleWaiters.splice(0)) waiter();
      }
    };
    res.once('finish', finish);
    res.once('close', finish);
  }

  /** Response lifetime includes downloads and incomplete incoming bodies. */
  drain(): Promise<void> {
    if (!this.active.size) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  abortActive(): void {
    for (const res of this.active) res.destroy();
  }

  get inFlight(): number {
    return this.active.size;
  }

  hook: Hook = (req, res, done) => {
    bodyDeadline(req, this.config.bodyTimeoutMs);

    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      const pna =
        String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true' &&
        APP_ORIGINS.has(String(origin));
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret',
        'Access-Control-Max-Age': '86400',
        ...(pna ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
      });
      res.end();
      return;
    }

    if (this.closing) {
      res.setHeader('Connection', 'close');
      json(res, 503, { error: 'server is shutting down', code: 'closing' });
      return;
    }

    const target = req.originalUrl ?? req.url ?? '';
    let url: URL;
    try {
      url = new URL(target, 'http://x');
    } catch {
      json(res, 400, { error: 'bad request' });
      return;
    }

    const sent = target.split('?')[0];
    if (sent.startsWith('/') && sent !== url.pathname) {
      json(res, 400, { error: 'bad request' });
      return;
    }

    // The legacy table had no trailing-slash entries and no HEAD entries.
    if (req.method === 'HEAD' || (url.pathname.length > 1 && url.pathname.endsWith('/'))) {
      json(res, 404, { error: 'not found' });
      return;
    }

    const media = /^\/api\/media\/([0-9a-f]{64})$/.exec(url.pathname);
    if (media) {
      req.mediaHash = media[1];
      url.pathname = '/api/media/{hash}';
    } else if (url.pathname.startsWith('/api/media/') && !/^\/api\/media\/(missing|sweep)$/.test(url.pathname)) {
      // Uppercase or anything that is not a lowercase SHA-256 never reached
      // the media handler in the legacy entry; it is a 404, not a bad request.
      json(res, 404, { error: 'not found' });
      return;
    }

    this.track(res);
    done();
  };

  attach(adapter: { setOnRequestHook(hook: Hook): void }): void {
    adapter.setOnRequestHook(this.hook);
  }
}
