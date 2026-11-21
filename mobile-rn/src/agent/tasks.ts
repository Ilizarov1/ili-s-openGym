// The local stub task reads the current workspace snapshot, including records
// that have not reached a server yet.
import type { LocalState } from '../storage';
import type { AgentTask, AgentTool } from './shared';

export const LOCAL_TASK_ID = 'stub.local.v1';
export const LOCAL_PROFILE = 'local-profile';
export const LOCAL_QUEUE = 'local-queue';

/** The version a target had when this run read it. The runtime wires this to
 *  the agent_kv store so a proposal made after a confirmed write names the
 *  new version instead of a stale one. */
export type TargetVersionReader = (id: string) => number;

export function createLocalTask(data: LocalState, options: { targetVersion?: TargetVersionReader } = {}): AgentTask {
  const versionOf = options.targetVersion ?? ((): number => 1);
  return {
    id: LOCAL_TASK_ID,
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
      properties: { text: { type: 'string' }, proposal: { type: 'object' } },
      additionalProperties: true,
    },
    requiredCapabilities: ['text', 'image', 'tools'],
    budgets: { rounds: 3, toolCalls: 4, contextChars: 24000, historyItems: 8, memoryItems: 8 },
    steps: [
      { id: 'read_facts' },
      { id: 'model', tools: ['get_workspace_fact', 'get_workspace_target'] },
      { id: 'propose' },
    ],
    targetScope() {
      return [LOCAL_PROFILE, LOCAL_QUEUE];
    },
    readFacts() {
      const profileAt = versionOf(LOCAL_PROFILE);
      const queueAt = versionOf(LOCAL_QUEUE);
      return [
        {
          source: 'workspace.profile',
          objectId: LOCAL_PROFILE,
          version: profileAt,
          content: {
            version: profileAt,
            routines: (data.profile.routines || []).map(routine => ({ id: routine.id, name: routine.name })),
            workouts: (data.profile.workouts || []).length,
            routinesCount: (data.profile.routines || []).length,
          },
        },
        {
          source: 'workspace.queue',
          objectId: LOCAL_QUEUE,
          version: queueAt,
          content: {
            version: queueAt,
            pending: (data.queue || []).map(item => ({ id: item.workout.id, name: item.workout.name, day: item.workout.d })),
          },
        },
      ];
    },
    instructions() {
      return [
        'You are the openGym local agent stub.',
        'Use the workspace facts and tools supplied in this run only.',
        'The workspace may contain records not yet synced to a server; that is expected.',
        'For a change, return {"proposal":{"kind":"workspace.write","targetId":"local-profile","targetVersion":<seen version>,"changes":[{"field":"note","value":"..."}]}}.',
      ].join('\n');
    },
    userText(input) {
      return String(input.prompt || '');
    },
    fixtureCase(input) {
      return typeof input.fixtureCase === 'string' ? input.fixtureCase : undefined;
    },
  };
}

export function createLocalTools(data: LocalState, options: { targetVersion?: TargetVersionReader } = {}) {
  const versionOf = options.targetVersion ?? ((): number => 1);
  const calls = new Map<string, number>();
  const note = (id: string) => calls.set(id, (calls.get(id) || 0) + 1);
  const fact = (id: string) => {
    if (id === LOCAL_PROFILE) {
      return { objectId: id, version: versionOf(id), content: { routines: (data.profile.routines || []).length, workouts: (data.profile.workouts || []).length } };
    }
    if (id === LOCAL_QUEUE) {
      return { objectId: id, version: versionOf(id), content: { pending: data.queue?.length || 0 } };
    }
    return { objectId: id, version: 0, content: {} };
  };
  const tool = (id: string, description: string): AgentTool => ({
    id,
    description,
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
    target(args) {
      return String(args.id || '');
    },
    run(args) {
      note(id);
      return fact(String(args.id || ''));
    },
  });
  return {
    calls,
    tools: [
      tool('get_workspace_fact', 'Read one fact from this phone workspace, including unsynced records.'),
      tool('get_workspace_target', 'Read the stub write target and its current version.'),
    ] as AgentTool[],
  };
}
