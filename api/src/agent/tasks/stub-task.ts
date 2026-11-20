/* The first task: prove the runtime without a real business flow. */
import type { AgentStore } from '../agent.store.js';

export const STUB_TASK_ID = 'stub.v1';

export function createStubTask(store: AgentStore) {
  return {
    id: STUB_TASK_ID,
    version: 1,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 2000 },
        fixtureCase: { type: 'string', enum: ['text', 'tool', 'proposal', 'error', 'late'] },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        proposal: { type: 'object' },
      },
      additionalProperties: true,
    },
    requiredCapabilities: ['text', 'image', 'tools'],
    budgets: { rounds: 3, toolCalls: 4, contextChars: 24000, historyItems: 8, memoryItems: 8 },
    steps: [
      { id: 'read_facts' },
      { id: 'model', tools: ['get_stub_fact', 'get_stub_target'] },
      { id: 'propose' },
    ],
    targetScope() {
      return ['target-1', 'target-2'];
    },
    readFacts(input: Record<string, unknown>, context: { scope: string }) {
      const data = store.read(context.scope);
      const wanted = input.fixtureCase === 'proposal' ? ['target-1'] : ['target-1', 'target-2'];
      return wanted.map(id => {
        const target = data.stub.targets[id];
        return {
          source: 'stub.target',
          objectId: id,
          version: target.version,
          content: {
            id,
            version: target.version,
            value: target.value,
            ...(data.stub.facts[id] ? { fact: data.stub.facts[id] } : {}),
          },
        };
      });
    },
    instructions() {
      return [
        'This is the openGym agent runtime stub task.',
        'Answer from the supplied facts and tools only.',
        'For a change, return {"proposal":{"kind":"stub.write","targetId":"target-1","targetVersion":<seen version>,"changes":[{"field":"value","value":"..."}]}}.',
      ].join('\n');
    },
    userText(input: Record<string, unknown>) {
      return String(input.prompt || '');
    },
    fixtureCase(input: Record<string, unknown>) {
      return typeof input.fixtureCase === 'string' ? input.fixtureCase : undefined;
    },
  };
}
