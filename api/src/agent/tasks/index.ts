/* Server task registry. The runtime core owns the task contract; this map is
 * how a host chooses a task and the tools and session projection that belong
 * to it. */
import fs from 'node:fs';
import {
  createCatalogueSearchTool,
  createExerciseSearchTask,
  EXERCISE_SEARCH_TASK_ID,
} from '../../../agent-runtime/index.js';
import type { TaskDefinition } from '../../../agent-runtime/contracts.js';
import type { AgentStore } from '../agent.store.js';
import { createStubTask, STUB_TASK_ID } from './stub-task.js';
import { createStubTools } from '../tools/stub-tools.js';
import { assertExerciseSearchV2Output, createExerciseSearchV2Task, EXERCISE_SEARCH_V2_TASK_ID, type ExerciseSearchHistory } from './exercise-search-v2.js';

let cachedCatalogueEntries: Array<Record<string, unknown>> | null = null;
function loadCatalogueEntries(): Array<Record<string, unknown>> {
  if (!cachedCatalogueEntries) {
    cachedCatalogueEntries = JSON.parse(
      fs.readFileSync(new URL('../../../agent-runtime/tasks/exercise-search-catalogue.json', import.meta.url), 'utf8'),
    ) as Array<Record<string, unknown>>;
  }
  return cachedCatalogueEntries;
}

export interface TaskMessage {
  user: { content: string; meta?: Record<string, unknown> };
  assistant: { content: string; meta?: Record<string, unknown> };
}

export interface RegisteredTask {
  task: TaskDefinition;
  tools: Record<string, unknown>[];
  validatePostProcessed?(result: unknown): void;
  messageOf(input: Record<string, unknown>, result: unknown, history?: ExerciseSearchHistory): TaskMessage;
}

function messageOf(task: TaskDefinition, input: Record<string, unknown>, result: unknown): TaskMessage {
  const user = typeof task.userMessage === 'function'
    ? task.userMessage(input)
    : String(input.prompt || '');
  if (typeof task.assistantMessage === 'function') {
    const assistant = task.assistantMessage(result as never, input);
    return {
      user: { content: user },
      assistant: {
        content: String(assistant?.content || ''),
        ...(assistant?.meta ? { meta: assistant.meta } : {}),
      },
    };
  }
  const payload = result && typeof result === 'object' && 'result' in result
    ? (result as { result?: unknown }).result
    : result;
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const content = typeof record.text === 'string'
    ? record.text
    : record.structured
      ? JSON.stringify(record.structured)
      : '';
  return { user: { content: user }, assistant: { content } };
}

export function createTaskRegistry({ store }: { store: AgentStore }): Map<string, RegisteredTask> {
  const stubTask = createStubTask(store) as unknown as TaskDefinition;
  const stubTools = createStubTools(store);
  const exerciseTask = createExerciseSearchTask() as unknown as TaskDefinition;
  const catalogue = loadCatalogueEntries();
  const searchCatalogueTool = createCatalogueSearchTool({ entries: catalogue });
  const publicIds = new Set(catalogue.map(entry => String(entry.id)));
  return new Map<string, RegisteredTask>([
    [STUB_TASK_ID, {
      task: stubTask,
      tools: stubTools.tools as unknown as Record<string, unknown>[],
      messageOf: (input, result) => messageOf(stubTask, input, result),
    }],
    [EXERCISE_SEARCH_TASK_ID, {
      task: exerciseTask,
      tools: [searchCatalogueTool] as unknown as Record<string, unknown>[],
      messageOf: (input, result) => messageOf(exerciseTask, input, result),
    }],
    [EXERCISE_SEARCH_V2_TASK_ID, {
      task: createExerciseSearchV2Task(exerciseTask),
      tools: [],
      validatePostProcessed: result => assertExerciseSearchV2Output(result, publicIds),
      messageOf: (input, result, history) => {
        const run = result as { structured?: { fallback: unknown }; result?: { structured?: { fallback: unknown } } };
        const structured = run.result?.structured ?? run.structured;
        const candidates = (history?.matches ?? []).map(match => ({
          name: match.nameZh || match.nameEn,
          nameEn: match.nameEn,
        }));
        return messageOf(exerciseTask, input, { structured: { candidates, fallback: structured?.fallback } });
      },
    }],
  ]);
}

export { STUB_TASK_ID, EXERCISE_SEARCH_TASK_ID };
