import { AgentError, assertValid, EQUIPMENT_SLUGS, EXERCISE_SEARCH_INPUT_SCHEMA, EXERCISE_SEARCH_OUTPUT_SCHEMA } from '../../../agent-runtime/index.js';
import type { TaskDefinition } from '../../../agent-runtime/contracts.js';

export const EXERCISE_SEARCH_V2_TASK_ID = 'exercise-search.v2';
const MAX_RANKED = 10;
const exerciseId = { type: 'string', minLength: 1, maxLength: 64 };

const V2_INPUT_SCHEMA = {
  ...EXERCISE_SEARCH_INPUT_SCHEMA,
  properties: {
    ...EXERCISE_SEARCH_INPUT_SCHEMA.properties,
    confirmedEquipment: { type: 'string', enum: EQUIPMENT_SLUGS },
  },
};

export const EXERCISE_SEARCH_V2_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    rankedIds: { type: 'array', maxItems: MAX_RANKED, items: exerciseId },
    items: {
      type: 'array',
      maxItems: MAX_RANKED,
      items: {
        type: 'object',
        properties: {
          id: exerciseId,
          level: { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    fallback: EXERCISE_SEARCH_OUTPUT_SCHEMA.properties.fallback,
    clarifications: EXERCISE_SEARCH_OUTPUT_SCHEMA.properties.clarifications,
  },
  required: ['rankedIds', 'fallback'],
  additionalProperties: false,
};

export interface ExerciseSearchHistory {
  matches: Array<{ id: string; nameEn: string; nameZh: string }>;
}

export function createExerciseSearchV2Task(recognizer: TaskDefinition): TaskDefinition {
  return { ...recognizer, id: EXERCISE_SEARCH_V2_TASK_ID, version: 2, inputSchema: V2_INPUT_SCHEMA };
}

export function assertExerciseSearchV2Output(value: unknown, publicIds: ReadonlySet<string>): void {
  assertValid(EXERCISE_SEARCH_V2_OUTPUT_SCHEMA, value, '$.result.structured', 'retrieval_unavailable');
  const { rankedIds, items } = value as { rankedIds: string[]; items?: { id: string }[] };
  const uniqueIds = new Set(rankedIds);
  if (uniqueIds.size !== rankedIds.length || rankedIds.some(id => !publicIds.has(id))
    || (items && (items.length !== rankedIds.length || items.some((item, index) => item.id !== rankedIds[index])))) {
    throw new AgentError('retrieval_unavailable', 'The retrieval result did not match the public catalogue.');
  }
}
