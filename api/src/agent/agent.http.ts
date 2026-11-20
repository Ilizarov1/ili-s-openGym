/* One translation from shared AgentError to the API's HttpError. */
import type { IncomingMessage } from 'node:http';
import { AgentError } from '../../agent-runtime/errors.js';
import { HttpError } from '../common/http/http-error.js';
import { SessionService } from '../auth/session.service.js';

export function agentUid(req: IncomingMessage, sessions: SessionService): string {
  const user = sessions.readSession(req);
  if (!user) throw new HttpError(401, 'not signed in');
  return user.id;
}

export function agentHttpError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof AgentError) {
    throw new HttpError(error.status, error.message, {
      extra: { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) },
    });
  }
  throw new HttpError(500, error instanceof Error ? error.message : 'agent request failed', {
    extra: { code: 'invalid_request' },
  });
}

export async function agentCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    agentHttpError(error);
  }
}
