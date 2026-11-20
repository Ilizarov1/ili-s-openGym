/* Deterministic fixtures shared by the agent runtime tests.
 *
 * Two accounts, two workspaces, one object with two versions, a record that
 * only exists locally, a 1x1 PNG and a fixed model script. No dates, no random
 * values and no network: a test failure is a code change, not a flaky day.
 */

export const AGENT_SCHEMA_VERSION = 1;

export const ACCOUNTS = Object.freeze({
  owner: Object.freeze({ uid: 'u_agent_owner', name: 'Owner' }),
  other: Object.freeze({ uid: 'u_agent_other', name: 'Other' }),
});

export const WORKSPACES = Object.freeze({
  localA: 'practice',
  localB: 'https://gym.example|u_agent_other',
  serverOwner: `https://gym.example|${ACCOUNTS.owner.uid}`,
});

export const TARGETS = Object.freeze({
  'target-1': Object.freeze({
    id: 'target-1',
    version: 1,
    value: 'first version',
    owner: ACCOUNTS.owner.uid,
  }),
  'target-1@2': Object.freeze({
    id: 'target-1',
    version: 2,
    value: 'second version',
    owner: ACCOUNTS.owner.uid,
  }),
  'target-2': Object.freeze({
    id: 'target-2',
    version: 1,
    value: 'other target',
    owner: ACCOUNTS.owner.uid,
  }),
  'target-foreign': Object.freeze({
    id: 'target-foreign',
    version: 1,
    value: 'belongs to somebody else',
    owner: ACCOUNTS.other.uid,
  }),
});

export const UNSYNCED_RECORD = Object.freeze({
  id: 'local-only-workout',
  objectId: 'target-1',
  version: 1,
  synced: false,
  value: 'a workout recorded on this phone and not yet uploaded',
});

export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export const PNG_1X1_DATA_URL = `data:image/png;base64,${PNG_1X1.toString('base64')}`;

/* The five model cases named by EXECUTION.md 0.4. `late` resolves only after
 * its caller's abort signal fired, so the run must discard it instead of
 * writing a proposal. */
export function fixtureModel(name, extra = {}) {
  const base = { name, text: '', structured: null, toolCalls: [] };
  switch (name) {
    case 'text':
      return { ...base, text: `fixture:${extra.prompt || 'text'}` };
    case 'tool':
      return {
        ...base,
        toolCalls: [{
          id: 'call_fixture_tool',
          name: extra.toolName || 'get_stub_fact',
          arguments: extra.arguments || { id: 'target-1' },
        }],
      };
    case 'proposal':
      return {
        ...base,
        structured: {
          text: 'A change is ready for confirmation.',
          proposal: {
            kind: 'stub.write',
            targetId: 'target-1',
            targetVersion: 1,
            changes: [{ field: 'value', value: extra.value || 'confirmed value' }],
          },
        },
      };
    case 'error':
      return { ...base, error: { code: 'model_unavailable', message: 'fixture provider refused' } };
    case 'late':
      return { ...base, text: 'this answer arrived after cancellation', late: true };
    default:
      throw new Error(`unknown fixture model case: ${name}`);
  }
}

export function fixtureCases() {
  return ['text', 'tool', 'proposal', 'error', 'late'].map(name => [name, fixtureModel(name)]);
}
