/* Account-scoped long-term memories. Models only propose; a person confirms,
 * and a deletion applies to the next context assembly immediately. */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { AgentError } from '../../agent-runtime/errors.js';
import { isMemoryCategory } from '../../agent-runtime/contracts.js';
import type { AgentAccountData, AgentMemory, AgentProposal } from './agent.types.js';
import { AgentStore } from './agent.store.js';

const MAX_VALUE = 4000;

function assertValue(value: unknown): void {
  let size = 0;
  try {
    size = JSON.stringify(value)?.length || 0;
  } catch {
    throw new AgentError('invalid_request', 'the memory value is not JSON');
  }
  if (size > MAX_VALUE) throw new AgentError('invalid_request', 'the memory value is too large');
}

@Injectable()
export class AgentMemoryStore {
  constructor(private readonly store: AgentStore) {}

  async list(uid: string): Promise<AgentMemory[]> {
    return Object.values(this.store.read(uid).memories)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async create(uid: string, body: Record<string, unknown>): Promise<AgentMemory> {
    const category = String(body.category || '');
    if (!isMemoryCategory(category)) throw new AgentError('invalid_request', 'unknown memory category');
    if (body.value === undefined) throw new AgentError('invalid_request', 'a memory needs a value');
    assertValue(body.value);
    return this.store.update(uid, data => {
      const at = Date.now();
      const memory: AgentMemory = {
        id: crypto.randomUUID(),
        category: category as AgentMemory['category'],
        value: body.value,
        ...(typeof body.source === 'string' && body.source ? { source: body.source.slice(0, 200) } : {}),
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
      data.memories[memory.id] = memory;
      return memory;
    });
  }

  async update(uid: string, memoryId: string, body: Record<string, unknown>): Promise<AgentMemory> {
    return this.store.update(uid, data => {
      const current = data.memories[memoryId];
      if (!current) throw new AgentError('memory_not_found', undefined, { details: { memoryId } });
      const category = body.category === undefined ? current.category : String(body.category);
      if (!isMemoryCategory(category)) throw new AgentError('invalid_request', 'unknown memory category');
      if (body.value !== undefined) assertValue(body.value);
      const next: AgentMemory = {
        ...current,
        category: category as AgentMemory['category'],
        ...(body.value === undefined ? {} : { value: body.value }),
        ...(typeof body.source === 'string' ? { source: body.source.slice(0, 200) } : {}),
        updatedAt: Date.now(),
        version: (current.version || 0) + 1,
      };
      data.memories[memoryId] = next;
      return next;
    });
  }

  async remove(uid: string, memoryId: string): Promise<boolean> {
    return this.store.update(uid, data => {
      if (!data.memories[memoryId]) return false;
      delete data.memories[memoryId];
      return true;
    });
  }

  /** Called inside AgentStore.update by the proposal store, so confirmation is atomic. */
  applyInData(data: AgentAccountData, proposal: AgentProposal): AgentMemory {
    const change = Array.isArray(proposal.changes) ? proposal.changes[0] as Record<string, unknown> : null;
    if (!change || change.op !== 'save' || typeof change.category !== 'string' || !isMemoryCategory(change.category)) {
      throw new AgentError('invalid_request', 'the memory proposal is invalid');
    }
    if (change.value === undefined) throw new AgentError('invalid_request', 'the memory proposal has no value');
    assertValue(change.value);
    const at = Date.now();
    const memory: AgentMemory = {
      id: crypto.randomUUID(),
      category: change.category as AgentMemory['category'],
      value: change.value,
      ...(typeof change.source === 'string' && change.source ? { source: change.source.slice(0, 200) } : {}),
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    data.memories[memory.id] = memory;
    return memory;
  }
}
