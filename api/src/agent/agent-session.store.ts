/* User-visible conversations. A deleted session keeps its tombstone so a late
 * run cannot recreate it, and its derived summary is deleted with it. */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { AgentError } from '../../agent-runtime/errors.js';
import type { AgentMessage, AgentSessionSummary, AgentStoredSession } from './agent.types.js';
import { AgentStore } from './agent.store.js';

const MAX_MESSAGE = 8000;

function summaryOf(session: AgentStoredSession): AgentSessionSummary {
  return {
    id: session.id,
    title: session.title,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
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

  async ensure(uid: string, sessionId: string, title = 'Agent session'): Promise<AgentStoredSession> {
    return this.store.update(uid, data => {
      const current = data.sessions[sessionId];
      if (current?.deletedAt) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
      if (current) return current;
      const at = Date.now();
      const session: AgentStoredSession = {
        id: sessionId,
        title: String(title || 'Agent session').slice(0, 120),
        version: 1,
        createdAt: at,
        updatedAt: at,
        messages: [],
      };
      data.sessions[sessionId] = session;
      return session;
    });
  }

  async append(uid: string, sessionId: string, messages: AgentMessage[]): Promise<AgentStoredSession> {
    if (!Array.isArray(messages) || !messages.length) {
      throw new AgentError('invalid_request', 'messages are required');
    }
    return this.store.update(uid, data => {
      const session = data.sessions[sessionId];
      if (!session) throw new AgentError('invalid_request', 'session does not exist', { details: { sessionId } });
      if (session.deletedAt) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
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
        });
      }
      session.version = (session.version || 0) + 1;
      session.updatedAt = Date.now();
      return session;
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
