/* The in-repo fixture provider.
 *
 * It exists so the whole path can be exercised without a model account: text,
 * a tool request, a structured proposal, a provider error and a deliberately
 * late answer. It never touches the network.
 */
import { AgentError } from '../errors.js';

const CASES = new Set(['text', 'tool', 'proposal', 'error', 'late']);

function caseOf(options, input) {
  const raw = options.case || options.fixtureCase || input?.profile?.fixtureCase
    || input?.modelInput?.user?.fixtureCase || 'text';
  if (!CASES.has(raw)) throw new AgentError('invalid_request', `unknown fixture case: ${raw}`);
  return raw;
}

export function createFixtureProvider(options = {}) {
  let calls = 0;
  const sequence = Array.isArray(options.sequence) ? [...options.sequence] : null;
  const lateDelayMs = Math.max(0, Number(options.lateDelayMs) || 250);

  return {
    id: 'fixture',
    capabilities: { text: true, image: true, tools: true },
    get calls() {
      return calls;
    },
    async invoke(input = {}) {
      calls++;
      if (sequence && sequence.length) {
        const next = sequence.length > 1 ? sequence.shift() : sequence[0];
        if (next && typeof next === 'object') return next;
        return fixtureAnswer(String(next), input, options);
      }
      return fixtureAnswer(caseOf(options, input), input, options);
    },
  };
}

async function fixtureAnswer(name, input, options) {
  const prompt = input.modelInput?.user?.text || '';
  switch (name) {
    case 'text':
      return { text: `fixture:${prompt || 'text'}` };
    case 'tool':
      return {
        text: '',
        toolCalls: [{
          id: 'call_fixture_tool',
          name: options.toolName || 'get_stub_fact',
          arguments: options.arguments || { id: 'target-1' },
        }],
      };
    case 'proposal': {
      // Use the first supplied fact as the target, so the fixture proposal is
      // inside whatever scope the host task declared (server target-1, RN
      // local-profile) instead of a hard-coded server id.
      const fact = Array.isArray(input.modelInput?.facts) ? input.modelInput.facts[0] : null;
      const targetId = options.targetId || fact?.objectId || 'target-1';
      const targetVersion = fact?.version ?? 1;
      return {
        structured: {
          text: 'A change is ready for confirmation.',
          proposal: {
            kind: 'stub.write',
            targetId,
            targetVersion,
            changes: [{ field: 'value', value: options.value || 'confirmed value' }],
          },
        },
        toolCalls: [],
      };
    }
    case 'error':
      return { error: { code: 'model_unavailable', message: options.errorMessage || 'fixture provider refused' } };
    case 'late':
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(options.lateDelayMs) || 250)));
      return { text: 'this answer arrived after cancellation' };
    default:
      throw new AgentError('invalid_request', `unknown fixture case: ${name}`);
  }
}
