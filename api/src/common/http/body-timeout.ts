/* Request deadline handling from the legacy entry.
 *
 * A socket waiting for its body is cut after BODY_TIMEOUT_MS unless the media
 * upload route lifts it with allowSlowBody() after session and quota checks.
 */
import type { IncomingMessage } from 'node:http';

declare module 'node:http' {
  interface IncomingMessage {
    allowSlowBody?: () => void;
    mediaHash?: string;
    session?: unknown;
    user?: unknown;
  }
}

export function bodyDeadline(req: IncomingMessage, timeoutMs: number): void {
  if (req.complete) return;
  const socket = req.socket;
  const timer = setTimeout(() => {
    if (!req.complete) socket.destroy();
  }, timeoutMs);
  timer.unref();
  const clear = () => clearTimeout(timer);
  req.once('end', clear);
  req.allowSlowBody = clear;
}
