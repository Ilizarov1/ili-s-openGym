/* User-visible conversations. A deleted session keeps its tombstone so a late
 * run cannot recreate it, and its derived summary is deleted with it. */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { AgentError } from '../../agent-runtime/errors.js';
import type { AgentMessage, AgentSessionSummary, AgentStoredSession } from './agent.types.js';
import { AgentStore } from './agent.store.js';

const MAX_MESSAGE = 8000;
export const AI_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function summaryOf(session: AgentStoredSession): AgentSessionSummary {
  return {
    id: session.id,
    title: session.title,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    ...(session.taskId ? { taskId: session.taskId } : {}),
  };
}

@Injectable()
export class AgentSessionStore {
  constructor(private readonly store: AgentStore) {}

  async list(uid: string): Promise<AgentSessionSummary[]> {
    const data = this.store.read(uid);
    return Object.values(data.sessions)
      .filter(session => !session.deletedAt)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(summaryOf);
  }

  async get(uid: string, sessionId: string, includeDeleted = false): Promise<AgentStoredSession | null> {
    const session = this.store.read(uid).sessions[sessionId];
    if (!session) return null;
    if (session.deletedAt && !includeDeleted) return null;
    return session;
  }

  async ensure(
    uid: string,
    sessionId: string,
    options: { taskId?: string; executionLocation?: 'local' | 'server'; title?: string } = {},
  ): Promise<AgentStoredSession> {
    return this.store.update(uid, data => {
      const current = data.sessions[sessionId];
      if (current?.deletedAt) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
      if (current) {
        if (options.taskId && current.taskId && current.taskId !== options.taskId) {
          throw new AgentError('session_conflict', 'this conversation belongs to another task', {
            details: { sessionId, taskId: current.taskId, requested: options.taskId },
          });
        }
        if (!current.taskId && options.taskId) current.taskId = options.taskId;
        if (!current.executionLocation && options.executionLocation) current.executionLocation = options.executionLocation;
        return current;
      }
      const at = Date.now();
      const session: AgentStoredSession = {
        id: sessionId,
        title: String(options.title || 'Agent session').slice(0, 120),
        version: 1,
        createdAt: at,
        updatedAt: at,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.executionLocation ? { executionLocation: options.executionLocation } : {}),
        messages: [],
      };
      data.sessions[sessionId] = session;
      return session;
    });
  }

  async append(
    uid: string,
    sessionId: string,
    messages: AgentMessage[],
    expectedVersion?: number,
  ): Promise<AgentStoredSession> {
    if (!Array.isArray(messages) || !messages.length) {
      throw new AgentError('invalid_request', 'messages are required');
    }
    return this.store.update(uid, data => {
      const session = data.sessions[sessionId];
      if (!session) throw new AgentError('invalid_request', 'session does not exist', { details: { sessionId } });
      if (session.deletedAt) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
      if (expectedVersion !== undefined && session.version !== expectedVersion) {
        throw new AgentError('session_conflict', 'the conversation changed while this run was in flight', {
          details: { sessionId, expected: expectedVersion, current: session.version },
        });
      }
      for (const message of messages) {
        if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
          throw new AgentError('invalid_request', 'message role must be user or assistant');
        }
        const content = String(message.content || '').slice(0, MAX_MESSAGE);
        session.messages.push({
          id: message.id || crypto.randomUUID(),
          role: message.role,
          content,
          createdAt: message.createdAt || Date.now(),
          ...(message.runId ? { runId: message.runId } : {}),
          ...(message.meta ? { meta: message.meta } : {}),
        });
      }
      session.version = (session.version || 0) + 1;
      session.updatedAt = Date.now();
      return session;
    });
  }

  /** Submitted runs for one task/session; failed and cancelled runs count, so
   *  a retry cannot get around the follow-up budget. */
  turnCount(uid: string, taskId: string, sessionId: string): number {
    const data = this.store.read(uid);
    return Object.values(data.runs).filter(run => run.taskId === taskId && run.sessionId === sessionId).length;
  }

  /** Temporary AI conversations are removed after two idle hours. Stub
   *  conversations keep the old behaviour. */
  async purgeExpired(uid: string, now = Date.now()): Promise<number> {
    return this.store.update(uid, data => {
      let removed = 0;
      for (const session of Object.values(data.sessions)) {
        if (session.deletedAt || !session.taskId?.startsWith('exercise-search.')) continue;
        if (now - (session.updatedAt || session.createdAt || 0) < AI_SESSION_TTL_MS) continue;
        session.deletedAt = now;
        session.version = (session.version || 0) + 1;
        session.messages = [];
        delete session.summary;
        removed++;
      }
      return removed;
    });
  }

  async remove(uid: string, sessionId: string): Promise<boolean> {
    return this.store.update(uid, data => {
      const session = data.sessions[sessionId];
      if (!session) return false;
      if (session.deletedAt) return true;
      session.deletedAt = Date.now();
      session.version = (session.version || 0) + 1;
      session.messages = [];
      delete session.summary;
      return true;
    });
  }
}
