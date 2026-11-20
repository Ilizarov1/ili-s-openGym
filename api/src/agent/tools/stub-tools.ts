/* Two read-only stub tools. Their only data source is the account's agent
 * document, which is already bound by the run context. */
import type { AgentStore } from '../agent.store.js';

export function createStubTools(store: AgentStore) {
  const calls = new Map<string, number>();
  const note = (id: string) => calls.set(id, (calls.get(id) || 0) + 1);
  return {
    calls,
    tools: [
      {
        id: 'get_stub_fact',
        description: 'Read one stub fact and its current version.',
        argsSchema: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
        resultSchema: {
          type: 'object',
          properties: {
            objectId: { type: 'string' },
            version: { type: 'integer' },
            content: { type: 'object' },
          },
          required: ['objectId', 'version', 'content'],
        },
        target(args: { id: string }) {
          return args.id;
        },
        run(args: { id: string }, options: { context: { scope: string } }) {
          note('get_stub_fact');
          const data = store.read(options.context.scope);
          const target = data.stub.targets[args.id];
          if (!target) return { objectId: args.id, version: 0, content: {} };
          return {
            objectId: args.id,
            version: target.version,
            content: { value: target.value, fact: data.stub.facts[args.id] ?? null },
          };
        },
      },
      {
        id: 'get_stub_target',
        description: 'Read a stub write target and its current version.',
        argsSchema: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
          additionalProperties: false,
        },
        resultSchema: {
          type: 'object',
          properties: {
            objectId: { type: 'string' },
            version: { type: 'integer' },
            content: { type: 'object' },
          },
          required: ['objectId', 'version', 'content'],
        },
        target(args: { id: string }) {
          return args.id;
        },
        run(args: { id: string }, options: { context: { scope: string } }) {
          note('get_stub_target');
          const data = store.read(options.context.scope);
          const target = data.stub.targets[args.id];
          return {
            objectId: args.id,
            version: target?.version ?? 0,
            content: { value: target?.value ?? null },
          };
        },
      },
    ],
  };
}
