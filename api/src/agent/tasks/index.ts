/* Server task registry. The runtime core owns the task contract; this map is
 * how a host chooses a task and the tools and session projection that belong
 * to it. */
import { createExerciseSearchTask, EXERCISE_SEARCH_TASK_ID } from '../../../agent-runtime/index.js';
import type { TaskDefinition } from '../../../agent-runtime/contracts.js';
import type { AgentStore } from '../agent.store.js';
import { createStubTask, STUB_TASK_ID } from './stub-task.js';
import { createStubTools } from '../tools/stub-tools.js';

export interface TaskMessage {
  user: { content: string; meta?: Record<string, unknown> };
  assistant: { content: string; meta?: Record<string, unknown> };
}

export interface RegisteredTask {
  task: TaskDefinition;
  tools: Record<string, unknown>[];
  messageOf(input: Record<string, unknown>, result: unknown): TaskMessage;
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
  return new Map<string, RegisteredTask>([
    [STUB_TASK_ID, {
      task: stubTask,
      tools: stubTools.tools as unknown as Record<string, unknown>[],
      messageOf: (input, result) => messageOf(stubTask, input, result),
    }],
    [EXERCISE_SEARCH_TASK_ID, {
      task: exerciseTask,
      tools: [],
      messageOf: (input, result) => messageOf(exerciseTask, input, result),
    }],
  ]);
}

export { STUB_TASK_ID, EXERCISE_SEARCH_TASK_ID };
